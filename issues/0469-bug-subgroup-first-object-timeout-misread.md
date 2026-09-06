# processSubgroupObjects の先頭判定がバッチ全体に誤適用される

- Created: 2026-09-06
- Completed: YYYY-MM-DD
- Branch: feature/fix-subgroup-timeout-first-object
- Polished: YYYY-MM-DD

## 目的

1 回の `feed` で複数オブジェクトが届いた場合、2 件目以降の Object Property (`OBJECT_DELIVERY_TIMEOUT` / `SUBGROUP_DELIVERY_TIMEOUT`) が誤って抽出される。仕様は先頭オブジェクトのみの上書きであり、誤読を修正する必要がある。

## 現状

- `src/session/stream.ts` の `processSubgroupObjects` は delivery timeout 抽出条件に仮引数 `previousObjectId` (バッチ先頭値) を参照し、ループ変数 `currentPreviousObjectId` を使っていない。
- バッチ内 2 件目以降も先頭扱いで `readDeliveryTimeoutObjectProperties` が実行される。
- 送信側 (`src/session/publish.ts` の `isFirstInSubgroup` 判定) は逐次判定で正しく、非対称である。

## 設計方針

1. デコード直前の `currentPreviousObjectId < 0n` を先頭フラグとして捕捉し、抽出条件に使う。
2. バッチ先頭・バッチ途中・batch 跨ぎの 3 パターンを単体テストで pin する。

## 完了条件

- 先頭オブジェクトのみ timeout が抽出され、2 件目以降は無視されること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 関連

- draft-ietf-moq-transport-20 §8 / §12.1 / §12.2
