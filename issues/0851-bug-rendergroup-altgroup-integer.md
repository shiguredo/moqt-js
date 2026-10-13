# renderGroup / altGroup が整数かどうかを検証していない

- Created: 2026-10-14
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-rendergroup-altgroup-integer

## 目的

§5.2.11 は renderGroup を "An integer specifying a group of tracks which are designed to be rendered together."、§5.2.12 は altGroup を "An integer specifying a group of tracks which are alternate versions of one-another." と定める。実装は number であることと有限であることだけを見るため、小数を載せた Catalog を encode も decode も受理する。受信側 (相互接続の相手) が拒否し得る値であり、ABR の選択 (`selectHighestBitrateTrack` / `selectTrackByMaxResolution` など) は番号が一致する前提で動く。

## 現状

- `src/msf/catalogTrackValidation.ts` の `pickGroupAndInitRef` は `pickOptionalNumber` で renderGroup (§5.2.11) と altGroup (§5.2.12) を pick する。`pickOptionalNumber` は number であることと有限であること (`Number.isFinite`) だけを見る
- 実測: `renderGroup: 1.5` / `altGroup: -2.5` を持つ Catalog は `decodeCatalogMessage` も `encodeCatalog` も通り、`getTracksByRenderGroup` / `getTracksByAltGroup` は一致しない番号として扱う
- `src/createMediaPublisher.ts` の `assertCatalogLatencyOptions` は renderGroup の有限性と整数性を検証しており、「decode 側は整数性を見ないため、ここが唯一の防波堤になる」と明記している。高レベル API の配信経路は守られるが、公開 API (`encodeCatalog` / `createCatalog` / `decodeCatalogMessage`) では止まらない
- 負数と 0 は仕様が明示的に禁じていない (§5.2.11 / §5.2.12 は integer とのみ定める) ため、対象は整数性だけとする

## 設計方針

- `pickOptionalNumber` に整数必須のオプションを足すか、renderGroup / altGroup 専用の検証を足して `Number.isInteger` で拒否する。文言は `renderGroup must be an integer per §5.2.11, got 1.5` の形にする
- decode と encode は同じ関数を通る (encode は issues/closed/0693-bug-encode-catalog-validation.md の自己検証により decode と同じ検証が走る) ため、両方向で同じ受理集合になる
- `assertCatalogLatencyOptions` の整数性の検証は「オプションの時点で早期に、利用者向けの文言で落とす」役割として残す (JSDoc の「唯一の防波堤」という記述は更新する)
- 従来受理していた Catalog を拒否する破壊的変更になる。`CHANGES.md` は CODEBASE.md の「MOQT RFC ドラフト中の特別ルール」に従い更新しない
- 対象は `src/msf/catalogTrackValidation.ts` / `src/msf.test.ts` / `src/createMediaPublisher.ts` (コメントのみ)

## 完了条件

- `renderGroup: 1.5` / `altGroup: -2.5` を持つ Catalog を `decodeCatalogMessage` / `encodeCatalog` / `createCatalog` が reject する
- 整数 (0 と負の整数を含む) は従来どおり受理される
- `assertCatalogLatencyOptions` の JSDoc が実態 (整数性はここが唯一ではない) に合っている
- `npx vp check` / `npx tsc --noEmit` / `npx vp test --run` が通る

## 参照

- draft-ietf-moq-msf-01 §5.2.11 (Render group。An integer) / §5.2.12 (Alternate group。An integer)
- `src/msf/catalogTrackValidation.ts` の `pickGroupAndInitRef` / `pickOptionalNumber`
- `src/createMediaPublisher.ts` の `assertCatalogLatencyOptions`
- `src/msf/tracks.ts` の `getTracksByRenderGroup` / `getTracksByAltGroup` / `selectHighestBitrateTrack`
- closed `0693-bug-encode-catalog-validation.md` (「残した課題」に本件がある)

## 解決方法

{未着手}
