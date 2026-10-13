# encodeCatalogDelta が delta の中身を検証せず、自分の decode が拒否する delta を送信できる

- Created: 2026-10-14
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-encode-catalog-delta-content-validation

## 目的

`encodeCatalogDelta` は `operations` と各 operation の型だけを検証し、track の中身を検証しない。手組みの delta を渡すと、自分の `decodeCatalogMessage` が拒否する delta を wire に出せる (相互接続の相手も拒否する)。`encodeCatalog` は issues/closed/0693-bug-encode-catalog-validation.md で「送るバイト列を自分で decode して検証する」方式にしたが、delta は対象外のまま残っている。

## 現状

- `src/msf/catalogCodec.ts` の `encodeCatalogDelta` が検証するのは、`operations` が配列であること・空でないこと (§5.3)、各 operation が object であること、`generatedAt` の型と有限数 (§5.1.2) だけである。add / clone の tracks は `serializeTracksForJson` を通すため template の形 (§5.2.15 / §7.4.1) は検証されるが、それ以外の track 単位の MUST は検証しない
- 実測 (すべて encode は成功し、そのバイト列を自分の `decodeCatalogMessage` が拒否する)
  - add に `packaging: "moqlog"` で role が `log` でない track → `moqlog track must have role='log' per §9.4`
  - add に `role: "video"` で codec が無い track → `video track must include codec per §5.2.18`
  - add に `bitrate: NaN` の track → wire では `null` になり `bitrate must be a number per §5.2.22, got object`
  - remove に name 以外のフィールドを持つ track → `remove track must not hold other fields per §5.1.6`
- `decodeCatalogMessage` は decode した delta を op ごとに `validateCatalogTrack` (`ctx.source` は `"add"` / `"clone"`) と `validateRemoveTrack` で検証し、`applyCatalogDelta` は合成後の packaging / role の MUST と (name, namespace) の uniqueness、initRef の参照切れを検証する
- `encodeCatalogDelta` は `src/msf.ts` と `src/index.ts` の公開 API である。ライブラリ自身は delta を送らない (`src/createMediaPublisher.ts` は catalog を full で送る)

## 設計方針

- delta の add / clone の track に `validateCatalogTrack` (`ctx.source` はそれぞれ `"add"` / `"clone"`)、remove の track に `validateRemoveTrack` を適用し、decode した delta と同じ検証を encode でも行う。decode と同一の関数を使うため、違反時のエラー文言も受信側と揃う
- 合成後にしか決まらない clone の継承属性 (packaging / role) は対象外のままとする (`applyCatalogDelta` の責務)
- 検証の入口は encode したバイト列を `decodeCatalogMessage` に通す方式 (0693 の `encodeCatalog` と同じ) でもよいが、delta は「delta 単体で決まる属性」と「合成後に決まる属性」が混在するため、op ごとの検証を明示的に呼ぶ方を第一候補とする。どちらを採るかは実装時に決める
- 従来 encode できていた違反 delta を拒否する破壊的変更になる。`CHANGES.md` は CODEBASE.md の「MOQT RFC ドラフト中の特別ルール」に従い更新しない
- 対象は `src/msf/catalogCodec.ts` / `src/msf.test.ts` / `src/msf.prop.ts`

## 完了条件

- `encodeCatalogDelta` が §9.4 / §10.4 / §5.2.x の違反を持つ add / clone の track を reject する (エラー文言は decode 側と同一の関数が出す)
- `encodeCatalogDelta` が name 以外のフィールドを持つ remove の track を reject する
- encode に成功した delta は `decodeCatalogMessage` で decode でき、`applyCatalogDelta` を通せる
- 正しい delta (decode 由来 / PBT 由来) は従来どおり encode できる
- `npx vp check` / `npx tsc --noEmit` / `npx vp test --run` が通る

## 参照

- draft-ietf-moq-msf-01 §5.1.6 (delta update の op と add / remove / clone) / §5.3 (wire 形式) / §9.4 / §10.4 (packaging 別 MUST)
- `src/msf/catalogCodec.ts` の `encodeCatalogDelta` / `decodeCatalogDelta` / `decodeCatalogDeltaOperation` / `serializeTracksForJson`
- `src/msf/catalogDelta.ts` の `applyCatalogDelta`
- `src/msf/catalogValidation.ts` の `validateCatalogTrack` / `validateRemoveTrack`
- closed `0693-bug-encode-catalog-validation.md` (encodeCatalog の自己検証。delta は「対象外」として残した。「残した課題」に本件がある)

## 解決方法

{未着手}
