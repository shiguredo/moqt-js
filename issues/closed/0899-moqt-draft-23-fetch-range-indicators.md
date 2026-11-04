# FETCH の End of Range を delta 符号化し Gone を受理する

- Created: 2026-11-03
- Completed: 2026-11-04
- Branch: feature/change-moqt-draft-23
- Polished: 2026-11-03

## 目的

draft 23 §11.4.2 は End of Range の Group / Object ID を文脈依存の delta にし、End of Gone Range (0x40C) を追加した。現在はどの indicator も絶対 ID として読むため、2 件目以降の範囲とその後の Object を誤読する。

## 現状

- `src/dataStream/fetch.ts` の `decodeEndOfRange` / `encodeFetchObjectFields` は Group ID と Object ID を常に絶対値として扱う
- `FetchSerializationFlags` と `EndOfRangeType` は non_existent / unknown / timed_out のみ
- `src/session/stream.ts` の `processFetchObjects` は indicator を Object として配送せず、文脈だけ更新する

## 設計方針

- FETCH_HEADER 直後の先頭エントリーが indicator の場合だけ、Group / Object ID を絶対値とする。通常 Object の後で初めて現れる indicator も含め、それ以外では直前の Object / indicator を基準にする。Group ID は Ascending で prior + Group Delta、Descending で prior - Group Delta とし、通常 Object の Group Delta の +1 を加えない。Group Delta=0 の Object ID は prior + Object Delta + 1、Group 変更時は絶対 Object ID とする
- 直前の Object だけでなく直前の indicator も ID の基準にする。Priority / Subgroup ID は最後の実 Object から保持し、実 Object が無い継承参照を拒否する
- Gone (0x40C) を Unknown / Timed-Out / Does Not Exist と区別する。Gone は別の配信元から後で Object が届いても矛盾にならない
- indicator に Payload Length やダミー Object を追加しない。負数・上限超過は DELTA_ENCODING_OVERFLOW にする
- UNKNOWN_OBJECT_STATUS reset の定数・正規化からの削除は 0915 が担当する。moqt-js に上流 FETCH を行う relay を追加しない

## 完了条件

- 4 種の indicator、FETCH_HEADER 直後、通常 Object の後に初めて現れる indicator、連続、Group Delta=0 / 非 0、両 Group Order を固定ワイヤで検証する
- indicator 後の通常 Object の ID / Priority / Subgroup が正しく復元される
- Gone 後の実 Object を受理し、非存在との矛盾は 0901 の判定へ接続する
- 不完全な indicator と arithmetic overflow を検証する

## 参照

- `refs/moq/draft-ietf-moq-transport-23.txt` §2.1.2 / §3.2.2 / §3.2.3 / §11.4.2
- `src/dataStream/fetch.ts`、`src/session/stream.ts`、`src/session/dataStreamIncoming.ts`

## 解決方法

- `src/dataStream/fetch.ts` の `decodeEndOfRange` を draft-23 §11.4.2 / §11.4.2.1 に合わせ、Group ID と Object ID を文脈依存の delta として復号するようにした。FETCH_HEADER 直後の先頭エントリー (context が null) だけが両方とも絶対 ID で、それ以外は直前の Object または直前の End of Range indicator の復号値を基準にする。
- Group ID は Ascending で prior + Group ID Delta、Descending で prior - Group ID Delta とし、通常 Object の Group ID Delta が表す +1 を加えない。Object ID は Group ID Delta が 0 なら prior + Object ID Delta + 1、Group が変わるときは新しい Group の絶対 Object ID とする。通常 Object の +2 とは共通化しない。
- `END_OF_GONE_RANGE` (0x40C) を追加し、`EndOfRangeType` に "gone" を加えた。判定と種別変換は `END_OF_RANGE_TYPES` の 1 つの表から引き、未知の種別が "unknown" に落ちないようにした。Gone は Unknown / Timed-Out / Non-Existent と区別して復号し、Gone 後の実 Object は拒否しない (§2.1.2)。
- indicator は直前の Object / indicator の復号位置だけを context に反映し、Subgroup ID / Priority は最後の実 Object の値を保持する。実 Object が無い状態で prior の Subgroup ID / Priority を参照するフラグは拒否する (§11.4.2.2)。
- indicator の wire は Flags + Group ID Delta + Object ID Delta の 3 フィールドのみとし、Object Payload Length やダミー Object を追加しない (§11.4.2 に Payload Length の明文は無いが、通常 Object の形式との対比から持たないものとして扱う)。`encodeFetchObjectFields` も対称の delta 形式にし、表現できない Group 移動・Object ID 増分・範囲外の ID は送信前に拒否する。
- 負数・2^64-1 超過は現行どおり ProtocolViolationError (PROTOCOL_VIOLATION) とし、draft-23 の DELTA_ENCODING_OVERFLOW への分類移行はセッションエラー分類の移行に委ねる旨をコメントに明記した。
- `src/session/stream.ts` の `processFetchObjects` は indicator を配送も統計計上もせず、復号した Location だけを後続に引き継ぐ。コメントを delta / Gone に合わせて更新した (ロジック変更なし)。
- テストは 4 種の indicator、FETCH_HEADER 直後 (絶対 ID)、通常 Object 後の初出 (delta)、連続 indicator、Group ID Delta 0 / 非 0、Ascending / Descending、indicator 後の Object の ID / Priority / Subgroup 復元、Gone 後の実 Object の受理、不完全 indicator と未消費バイト、decode の算術 overflow 3 経路、encode の表現不能 delta 拒否、分割 feed を固定ワイヤで検証する。PBT では 4 種 × 両 Group Order × Group Delta 0 / 非 0 の往復と連続 indicator の prior 連鎖を検証する。テスト補助の統計は `src/testSupport/streamStats.ts` に集約した。

### 既知の制限

- End of Range が Object Payload Length を持たないという前提は §11.4.2 の明文ではなく、通常 Object の形式との対比による推論である。実リレー E2E で EOR の直後に通常 Object が続くストリームを確認する必要がある。
- 負数・上限超過は DELTA_ENCODING_OVERFLOW (0x400) ではなく現行の PROTOCOL_VIOLATION で閉じる (分類移行は別途対応)。
- Gone / 非存在範囲と実 Object の矛盾検出は未実装であり、Track 単位の状態追跡で行う予定である。
- End of Group (0x80) / End of Track (0x81) は未対応のため、128 以上の未対応値として拒否する。
- 統合ブランチのため ALPN は moqt-22 のままで、実リレー E2E は移行完了後に確認する。

### 残課題 (別 issue で扱う)

- End of Group / End of Track indicator (0900)
- 非存在と受信済み Object の矛盾検出 (0901)
- セッションエラー分類の移行 (0902)
- UNKNOWN_OBJECT_STATUS reset の削除 (0915)
