# FETCH の End of Range を delta 符号化し Gone を受理する

- Created: 2026-11-03
- Completed: {YYYY-MM-DD}
- Branch: feature/change-fetch-range-indicators
- Polished: {YYYY-MM-DD}

## 目的

draft 23 §11.4.2 は End of Range の Group / Object ID を文脈依存の delta にし、End of Gone Range (0x40C) を追加した。現在はどの indicator も絶対 ID として読むため、2 件目以降の範囲とその後の Object を誤読する。

## 現状

- `src/dataStream/fetch.ts` の `decodeEndOfRange` / `encodeFetchObjectFields` は Group ID と Object ID を常に絶対値として扱う
- `FetchSerializationFlags` と `EndOfRangeType` は non_existent / unknown / timed_out のみ
- `src/session/stream.ts` の `processFetchObjects` は indicator を Object として配送せず、文脈だけ更新する

## 設計方針

- 先頭 indicator は絶対値、後続は Group Order に応じた Group Delta を使う。Group Delta=0 の Object ID は prior + delta + 1、Group 変更時は絶対 Object ID とする
- 直前の Object だけでなく直前の indicator も ID の基準にする。Priority / Subgroup ID は最後の実 Object から保持し、実 Object が無い継承参照を拒否する
- Gone (0x40C) を Unknown / Timed-Out / Does Not Exist と区別する。Gone は別の配信元から後で Object が届いても矛盾にならない
- indicator に Payload Length やダミー Object を追加しない。負数・上限超過は DELTA_ENCODING_OVERFLOW にする
- UNKNOWN_OBJECT_STATUS reset の定数・正規化からの削除は 0915 が担当する。moqt-js に上流 FETCH を行う relay を追加しない

## 完了条件

- 4 種の indicator、先頭、連続、Group Delta=0 / 非 0、両 Group Order を固定ワイヤで検証する
- indicator 後の通常 Object の ID / Priority / Subgroup が正しく復元される
- Gone 後の実 Object を受理し、非存在との矛盾は 0901 の判定へ接続する
- 不完全な indicator と arithmetic overflow を検証する

## 参照

- `refs/moq/draft-ietf-moq-transport-23.txt` §2.1.2 / §3.2.2 / §3.2.3 / §11.4.2
- `src/dataStream/fetch.ts`、`src/session/stream.ts`、`src/session/dataStreamIncoming.ts`

## 解決方法

{未着手}
