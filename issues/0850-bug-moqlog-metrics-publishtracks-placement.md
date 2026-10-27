# moqlog / moqmetrics の track が publishTracks 配列に無くても受理される

- Created: 2026-10-14
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-moqlog-metrics-publishtracks-placement
- Polished: 2026-10-27

## 目的

§9.4 と §10.4 は、それぞれ log track / metrics track を catalog の `publishTracks` 配列に宣言することを MUST と定める (packaging が `moqlog` で role が `log`、packaging が `moqmetrics` で role が `metrics`)。実装は packaging と role の対応だけを検証し、track がどちらの配列に置かれたかを見ないため、`tracks` 配列に `packaging: "moqlog", role: "log"` を置いた Catalog を encode も decode も受理する。仕様違反の Catalog をライブラリ自身が送れる経路になり、相手が拒否し得る。

## 現状

- `src/msf/catalogTrackValidation.ts` の `validatePackagingSpecificRules` は packaging が `moqlog` / `moqmetrics` のとき role を検証するが、track が `tracks` と `publishTracks` のどちらに置かれたかを見ない
- `src/msf/catalogValidation.ts` の `validateCatalogTrack` は `ctx.source` に `"root"` / `"publishTracks"` / `"add"` / `"clone"` を持つが、packaging 別 MUST は source を見ない。`validatePackagingSpecificRules` と `buildValidatedCatalogTrack` は `ctx` を受け取らないため、配置の判定には source を新たに渡す必要がある
- 実測: `{version: "draft-01", tracks: [{name: "log", packaging: "moqlog", role: "log", isLive: true}]}` は `decodeCatalogMessage` / `encodeCatalog` / `createCatalog` のすべてが通る (`createCatalog` は `src/msf/tracks.ts` の `assertCatalogEncodable` 経由で同じ自己 decode を通る)
- `src/msf.prop.ts` の `catalogTrackArb` は packaging に `moqlog` / `moqmetrics` を含み、`tracks` 配列にも生成する (`catalogArb` は `tracks` と `publishTracks` の両方に同じ arbitrary を使う)。`catalogTrackArb` は `uniqueCatalogTrackArrayArb` 経由で `createCatalog` の PBT と `applyCatalogDelta` の remove PBT に使われ、`applyCatalogDelta` の add PBT と `deltaArb` の add operation には直接使われる。位置の制約を入れると、`tracks` / `add` 側の入力は `moqlog` / `moqmetrics` を含められない
- `src/msf/catalogDelta.ts` の `applyCatalogDelta` は clone の合成後に `validatePackagingSpecificRules` を呼ぶが、clone の合成結果は `tracks` に追加される。clone で packaging を `moqlog` / `moqmetrics` に上書きした track は、合成後の packaging が `moqlog` / `moqmetrics` のまま `tracks` に入るため、配置違反になる。既存の clone テストは role 欠落を期待しており、role 検証を先に行えば文言は変わらない
- `src/msf/catalogCodec.ts` の `decodeCatalogMessage` は delta の add を `validateCatalogTrack` の source `"add"` で検証する。`encodeCatalogDelta` は track 単位の MUST を検証しない (0693 の対象外) ため、add に `moqlog` / `moqmetrics` を置いた delta は現状 encode も decode も通る。配置検証を足すと、encode は従来どおり通るが decode は拒否する
- encode は issues/closed/0693-bug-encode-catalog-validation.md の自己検証により decode と同じ関数を通るため、検証を足せば `encodeCatalog` と `createCatalog` も同じ受理集合になる

## 設計方針

- `src/msf/catalogTrackValidation.ts` の `validatePackagingSpecificRules` に `source: ValidationContext["source"]` を追加し、packaging が `moqlog` / `moqmetrics` のとき `source !== "publishTracks"` なら拒否する。`buildValidatedCatalogTrack` も `source` を受け取り、`validateCatalogTrack` から `ctx.source` を渡す。`validateCloneCatalogTrack` は `source: "clone"` を渡す (`skipPackagingRequiredFields: true` のため packaging 別 MUST は skip される)
- `src/msf/catalogDelta.ts` の `applyCatalogDelta` は clone 合成後の `validatePackagingSpecificRules` 呼び出しに `source: "root"` を渡す。clone の合成結果は `tracks` に追加されるため、合成後の packaging が `moqlog` / `moqmetrics` なら配置違反として拒否する。add operation は decode 時に source `"add"` で検証済みであり、`applyCatalogDelta` では追加の配置検証を行わない (0693 と同じく delta 単体の検証は対象外)
- 検証順は、既存の clone テストの文言を変えないため、`moqlog` / `moqmetrics` の role 検証を先に行い、配置検証を後に足す。role が欠落・不一致なら従来どおり role のエラー、role が正しくても `tracks` 側なら配置のエラーにする
- 文言は既存の `invalid track '${name}': ...` の形に合わせ、`moqlog` は `invalid track '${name}': moqlog track must be declared in the publishTracks array per §9.4`、`moqmetrics` は `invalid track '${name}': moqmetrics track must be declared in the publishTracks array per §10.4` とする。decode と encode は同じ関数を通るため、同じ文言になる
- `src/msf.prop.ts` の arbitrary を tracks 側と publishTracks 側に分ける。tracks 用の arbitrary (packaging は `loc` のみ) を `uniqueCatalogTrackArrayArb` と `catalogArb` の `tracks` に使い、`addOpArb` と `applyCatalogDelta` の add PBT には tracks 用の `catalogTrackArb` を使う。publishTracks 用の arbitrary (packaging は `loc` / `moqlog` / `moqmetrics`) は `catalogArb` の `publishTracks` に使う。`catalogTrackArb` の role 固定 (`moqlog` → `log`、`moqmetrics` → `metrics`) は publishTracks 用で維持する
- 従来受理していた Catalog を拒否する破壊的変更になる。`CHANGES.md` は CODEBASE.md の「MOQT RFC ドラフト中の特別ルール」に従い更新しない
- 対象は `src/msf/catalogTrackValidation.ts` / `src/msf/catalogValidation.ts` / `src/msf/catalogDelta.ts` / `src/msf.prop.ts` / `src/msf.test.ts`

## 完了条件

- `tracks` 配列に `moqlog` / `moqmetrics` の track を置いた Catalog を `decodeCatalogMessage` / `encodeCatalog` / `createCatalog` が reject する。`validateCatalogTrack` を source `"root"` で直接呼んだ場合も reject する
- delta の add operation に `moqlog` / `moqmetrics` の track を置いた delta を `decodeCatalogMessage` が reject する (source `"add"`)。`encodeCatalogDelta` は track 単位 MUST を検証しないため、encode 自体は従来どおり通る
- `applyCatalogDelta` で clone の合成後の packaging が `moqlog` / `moqmetrics` になった track は、`tracks` に追加されるため reject する (role が欠落・不一致なら従来どおり role のエラー)
- `publishTracks` 配列に置いた `moqlog` / `moqmetrics` の track は従来どおり受理される (`decodeCatalogMessage` / `encodeCatalog` / `createCatalog` / `validateCatalogTrack` source `"publishTracks"`)
- PBT (`catalogArb` の round-trip) が位置の制約を満たす入力を生成して通る。tracks 側の arbitrary からは `moqlog` / `moqmetrics` を除外し、publishTracks 側の arbitrary には残す
- `createCatalog` の PBT と `deltaArb` の add operation の PBT も、tracks 側の arbitrary を使って通る
- `npx vp check` / `npx tsc --noEmit` / `npx vp test --run` が通る

## 参照

- draft-ietf-moq-msf-01 §9.4 (Log track catalog requirements。publishTracks に宣言 MUST) / §10.4 (Metrics track catalog requirements) / §5.1.4 (tracks) / §5.1.5 (publishTracks) / §5.1.6 (delta update) / §5.3 (delta updates) / §5.2.4 (packaging) / §5.2.6 (role)
- `src/msf/catalogTrackValidation.ts` の `validatePackagingSpecificRules` / `buildValidatedCatalogTrack`
- `src/msf/catalogValidation.ts` の `validateCatalogTrack` (`ctx.source`) / `ValidationContext`
- `src/msf/catalogDelta.ts` の `applyCatalogDelta` (clone 合成後の再検証)
- `src/msf/catalogCodec.ts` の `encodeCatalog` (自己 decode) / `decodeCatalogMessage` (delta の add を source `"add"` で検証) / `encodeCatalogDelta` (track 単位 MUST は対象外)
- `src/msf/tracks.ts` の `createCatalog` (`assertCatalogEncodable` 経由)
- closed `0693-bug-encode-catalog-validation.md` (「残した課題」に本件がある)

## 解決方法

{未着手}
