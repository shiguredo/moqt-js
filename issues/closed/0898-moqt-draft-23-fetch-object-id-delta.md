# FETCH の同一 Group 内 Object ID Delta に 2 を加える

- Created: 2026-11-03
- Completed: 2026-11-04
- Branch: feature/change-moqt-draft-23
- Polished: 2026-11-03

## 目的

draft 23 §11.4.1.1 は、Group ID Delta が無く Object ID Delta がある通常 Object の ID を prior Object ID + Delta + 2 とする。現在は +2 が無く、飛び番を持つ FETCH を誤った Object ID で配送する。

## 現状

- `src/dataStream/fetch.ts` の `decodeFetchObjectFields` は同一 Group で `context.objectId + delta` とする
- `encodeFetchObjectFields` は逆に `fields.objectId - context.objectId` を書く
- `createFetchObjectFlags` と round-trip の入力生成も旧式を前提とする。round-trip だけでは送受信双方の同じ誤りを検出できない

## 設計方針

- 対象の通常 Object では decode を prior + delta + 2、encode を current - prior - 2 にする。Delta フィールド省略時の prior + 1 と、先頭 / Group 変更時の絶対 ID を維持する
- 0 / 1 の増分を誤って明示 Delta で表せないよう、フラグ生成と送信前検証を合わせる
- 0899 の End of Range は別式である。共通化のために通常 Object の +2 を範囲 indicator に適用しない
- 加算上限を DELTA_ENCODING_OVERFLOW へ接続する

## 完了条件

- prior=10、Delta=0 が Object 12 になる固定ワイヤと、Delta 省略が Object 11 になる固定ワイヤを検証する
- 先頭、Group 切替、Ascending / Descending、範囲 indicator 直後、2^64-1 境界を検証する
- encode / decode / フラグ生成の PBT が新しい式に一致する

## 参照

- `refs/moq/draft-ietf-moq-transport-23.txt` §11.4.1.1
- `src/dataStream/fetch.ts` の `encodeFetchObjectFields` / `decodeFetchObjectFields` / `createFetchObjectFlags`
- `src/dataStream.fetch.test.ts` / `src/dataStream.prop.ts`

## 解決方法

- `src/dataStream/fetch.ts` の `decodeFetchObjectFields` を draft-23 §11.4.1.1 に合わせ、Group ID Delta が無い非先頭 Object の Object ID を prior Object ID + Object ID Delta + 2 で復号するようにした。Group ID Delta がある場合と先頭 Object は絶対値、Delta 省略時は Group の有無に関わらず prior + 1 とする。
- `encodeFetchObjectFields` を逆写像 (同一 Group の明示 Delta は current - prior - 2、それ以外は絶対値) に更新した。Delta 省略時の暗黙 +1 が 2^64-1 を超える場合は送信前に拒否し、指定された Object ID の範囲もフラグの有無に関わらず検証する。
- 増分 0 / 1 を明示 Delta で表せないことを送信前に検証する。増分 1 は `createFetchObjectFlags` が Delta を省略し、増分 0 は OBJECT_ID_PRESENT を立てて encode が拒否する。Group 変更時に Delta を明示する場合は絶対 Object ID を書く。
- End of Range indicator は通常 Object とは別式 (先頭エントリーは絶対値、それ以外は Group ID Delta と +1) であり、通常 Object の +2 を共通化しない。EOR 自体の delta 復号は未実装のまま (別途対応)。
- 2^64-1 を超える計算結果は現行どおり ProtocolViolationError (PROTOCOL_VIOLATION) とし、draft-23 の DELTA_ENCODING_OVERFLOW への分類移行はセッションエラー分類の移行に委ねる旨をコメントに明記した。
- テストは prior=10 / Delta=0 → Object 12、Delta 省略 → Object 11 の固定ワイヤ、encode の Delta 0 / 1 / 8、Group 切替、Group 変更 + Delta 省略、Ascending / Descending、End of Range 復号後の prior からの +2 / +1、2^64-1 到達 / 超過、増分 0 / 1 の拒否、暗黙 +1 の成功境界、フラグ生成と encode 検証の連結を検証する。PBT では増分 1〜4 の flags / wire / decode の一致と、任意の prior / Delta からの復元・超過を検証する。

### 既知の制限

- 2 件目以降の End of Range indicator の delta 復号は未実装である。draft-23 peer が送る delta 形式の EOR とその後続 Object の ID は、EOR の delta 対応が入るまで正しく復号できない。
- DELTA_ENCODING_OVERFLOW へのエラー分類移行は未実施 (現行は PROTOCOL_VIOLATION)。
- 統合ブランチのため ALPN は moqt-22 のままで、実リレー E2E は移行完了後に確認する。

### 残課題 (別 issue で扱う)

- End of Range の delta 符号化と Gone 状態の受理 (0899)
- End of Group / End of Track indicator (0900)
- セッションエラー分類の移行 (0902)
