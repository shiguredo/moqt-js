# Prior Group ID Gap 計算 helper を追加する

- Priority: Low
- Created: 2026-07-24
- Completed: YYYY-MM-DD
- Model: Composer
- Branch: feature/add-msf-prior-group-id-gap-helper
- Polished: YYYY-MM-DD

## 目的

draft-ietf-moq-msf-01 §6.1 は、publisher が restart 後に previous Group ID を知っている場合 Prior Group ID Gap を SHOULD でシグナリングする。`encodePriorGroupIdGap` は存在するが gap 計算 helper が無く、付与到達を単体で示しづらい。計算 helper と encode 経路のテストを追加する。

## 優先度根拠

Gap 付与は SHOULD（transport-19 §12.8 は optional）。高レベル `createMediaPublisher` の group 番号付け作り直しは本 issue 対象外。到達経路を単体で用意する準備作業のため Low。

## 現状

- `encodePriorGroupIdGap` / `parseProperties` は `src/properties.ts` に実装済み
- `createInitialGroupId` は `Date.now()` ベースの `bigint`（`src/msf.ts`）
- 高レベル `createMediaPublisher` は `createInitialGroupId` 未使用。`audioGroupId` / `videoGroupId` は `number` の `0` 起点。`SendObjectParams.groupId` も `number`
- gap 計算 helper は無い
- LOC 絶対 ID 連結への Prior Gap 合成は対象外（別経路）

## 設計方針

1. `src/msf.ts` の `createInitialGroupId` 近傍に `computePriorGroupIdGap(previousGroupId: bigint, newGroupId: bigint): bigint` を追加する
2. 式: `newGroupId - previousGroupId - 1n`（transport-19: previous=7 / current=10 / gap=2）
3. `newGroupId <= previousGroupId` は throw
4. 引数は `bigint` 固定。呼び出し側が `number` なら `BigInt(n)` する（本 helper は変換しない）
5. 付与到達のテスト（`encodeProperties` 経路。LOC メディア経路とは別）:

```ts
const gap = computePriorGroupIdGap(8n, 11n); // 2n
const encoded = encodeProperties([{ id: MOQTPropertyId.PRIOR_GROUP_ID_GAP, value: gap }]);
assert.equal(parseProperties(encoded).priorGroupIdGap?.gap, 2n);
```

6. `encodePriorGroupIdGap({ gap })` 単独経路は別テストでよい。`encodePriorGroupIdGap` の戻り値を `encodeProperties` に渡す API ではない
7. `createMediaPublisher` 配線・§6.1 restart MUST（`number`・0 起点の作り直し）は対象外

## 完了条件

- `computePriorGroupIdGap` + `encodeProperties` で Prior Group ID Gap を付与できることがテストで示されている
- 高レベル publisher / LOC 経路では §6.1 restart MUST は未充足のままである旨をコメントまたは CHANGES で誤認しない
- `CHANGES.md` に `[ADD]` を追記する
- `vp run test` / `vp run build` が pass する

## 解決方法

1. `src/msf.ts` に `computePriorGroupIdGap` を追加する
2. `src/msf.test.ts` または `src/properties.test.ts` に到達テストを追加する
3. `CHANGES.md` の `## develop` に `[ADD]` を追記する

## 関連

- `#0316` (closed) Prior Group ID Gap を範囲外とした先行対応
- `#0345` Catalog delta / Joining FETCH（本 helper とは独立）
- `refs/moq/draft-ietf-moq-msf-01.txt` §6.1
- `refs/moq/draft-ietf-moq-transport-19.txt` §12.8
