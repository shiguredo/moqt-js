# moqlog / moqmetrics の track が publishTracks 配列に無くても受理される

- Created: 2026-10-14
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-moqlog-metrics-publishtracks-placement

## 目的

§9.4 と §10.4 は「A log track MUST be declared in the publishTracks array of the catalog」と定める (packaging が `moqlog` で role が `log`、packaging が `moqmetrics` で role が `metrics`)。実装は packaging と role の対応だけを検証し、track がどちらの配列に置かれたかを見ないため、`tracks` 配列に `packaging: "moqlog", role: "log"` を置いた Catalog を encode も decode も受理する。仕様違反の Catalog をライブラリ自身が送れる経路になり、相手が拒否し得る。

## 現状

- `src/msf/catalogTrackValidation.ts` の `validatePackagingSpecificRules` は packaging が `moqlog` / `moqmetrics` のとき role を検証するが、track が `tracks` と `publishTracks` のどちらに置かれたかを見ない
- `src/msf/catalogValidation.ts` の `validateCatalogTrack` は `ctx.source` に `"root"` / `"publishTracks"` / `"add"` / `"clone"` を持つが、packaging 別 MUST は source を見ない
- 実測: `{version: "draft-01", tracks: [{name: "log", packaging: "moqlog", role: "log", isLive: true}]}` は `decodeCatalogMessage` も `encodeCatalog` も通る
- `src/msf.prop.ts` の `catalogTrackArb` は packaging に `moqlog` / `moqmetrics` を含み、`tracks` 配列にも生成する (`catalogArb` は `tracks` と `publishTracks` の両方に同じ arbitrary を使う)。位置の検証を入れる場合は arbitrary も位置の制約を満たすよう直す必要がある
- encode は issues/closed/0693-bug-encode-catalog-validation.md の自己検証により decode と同じ関数を通るため、検証を足せば両方向で同じ受理集合になる

## 設計方針

- `validatePackagingSpecificRules` (または `buildValidatedCatalogTrack`) に「packaging が `moqlog` / `moqmetrics` の track は `publishTracks` にだけ置ける」検証を足し、`ctx.source` が `"publishTracks"` 以外のときは拒否する。`"clone"` は親から packaging を継承するため合成後に判定される (`applyCatalogDelta` が再検証する) ことと整合させる
- 文言は `must be declared in the publishTracks array per §9.4` の形にし、decode と encode で同じ関数を使う
- 従来受理していた Catalog を拒否する破壊的変更になる。`CHANGES.md` は CODEBASE.md の「MOQT RFC ドラフト中の特別ルール」に従い更新しない
- 対象は `src/msf/catalogTrackValidation.ts` / `src/msf.prop.ts` / `src/msf.test.ts` / `src/msf.prop.ts`

## 完了条件

- `tracks` 配列に `moqlog` / `moqmetrics` の track を置いた Catalog を `decodeCatalogMessage` / `encodeCatalog` / `createCatalog` が reject する
- `publishTracks` 配列に置いた `moqlog` / `moqmetrics` の track は従来どおり受理される
- PBT (`catalogArb` の round-trip) が位置の制約を満たす入力を生成して通る
- `npx vp check` / `npx tsc --noEmit` / `npx vp test --run` が通る

## 参照

- draft-ietf-moq-msf-01 §9.4 (Log track catalog requirements。publishTracks に宣言 MUST) / §10.4 (Metrics track catalog requirements) / §5.1.4 (tracks) / §5.1.5 (publishTracks) / §5.2.4 (packaging) / §5.2.6 (role)
- `src/msf/catalogTrackValidation.ts` の `validatePackagingSpecificRules` / `buildValidatedCatalogTrack`
- `src/msf/catalogValidation.ts` の `validateCatalogTrack` (`ctx.source`) / `ValidationContext`
- `src/msf/catalogDelta.ts` の `applyCatalogDelta` (clone 合成後の再検証)
- closed `0693-bug-encode-catalog-validation.md` (「残した課題」に本件がある)

## 解決方法

{未着手}
