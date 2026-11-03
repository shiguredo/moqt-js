# FETCH の同一 Group 内 Object ID Delta に 2 を加える

- Created: 2026-11-03
- Completed: {YYYY-MM-DD}
- Branch: feature/change-fetch-object-id-delta
- Polished: {YYYY-MM-DD}

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

{未着手}
