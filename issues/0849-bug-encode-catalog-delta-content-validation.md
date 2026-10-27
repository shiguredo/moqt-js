# encodeCatalogDelta が delta の中身を検証せず、自分の decode が拒否する delta を送信できる

- Created: 2026-10-14
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-encode-catalog-delta-content-validation
- Polished: 2026-10-27

## 目的

`encodeCatalogDelta` が検証するのは、`operations` が配列であること・空でないこと、各 operation が object であること、`generatedAt` の型と有限数、add / clone の template の形だけであり、operation の `type` / `tracks` の型と、template 以外の track の中身を検証しない。手組みの delta を渡すと、自分の `decodeCatalogMessage` が拒否する delta を wire に出せる (相互接続の相手も拒否する)。`encodeCatalog` は issues/closed/0693-bug-encode-catalog-validation.md で「送るバイト列を自分で decode して検証する」方式にしたが、delta は対象外のまま残っている。

## 現状

- `src/msf/catalogCodec.ts` の `encodeCatalogDelta` が検証するのは、`operations` が配列であること・空でないこと (§5.3)、各 operation が object であること、`generatedAt` の型と有限数 (§5.1.2) だけである。operation の `type` (wire では `op`) が `add` / `remove` / `clone` のいずれかであること、`tracks` が配列であることも検証しない (§5.1.6 の MUST。decode は `decodeCatalogDeltaOperation` で拒否する)。add / clone の tracks は `serializeTracksForJson` を通すため template の形 (§5.2.15 / §7.4.1) は検証されるが、それ以外の track 単位の MUST は検証しない
- 実測 (すべて encode は成功し、そのバイト列を自分の `decodeCatalogMessage` が拒否する)
  - add に `packaging: "moqlog"` で role が `log` でない track → `invalid track 'log': moqlog track must have role='log' per §9.4, got 'video'`
  - add に `role: "video"` で codec が無い track → `invalid track 'v': video track must include codec per §5.2.18`
  - add に `bitrate: NaN` の track → wire では `null` になり `invalid track 'v': bitrate must be a number per §5.2.22, got object`
  - remove に name / namespace 以外のフィールドを持つ track → `invalid remove track at op[0].tracks[0]: unexpected field 'packaging', remove tracks accept only name and namespace per §5.1.6`
  - operation の `type` が `add` / `remove` / `clone` でない (例: `"foo"`) → `invalid catalog delta operation at index 0: unknown op 'foo', expected one of [add, remove, clone]`
  - operation の `tracks` が配列でない (例: `null`) → `invalid catalog delta operation at index 0: tracks must be an array per §5.1.6, got object`
- `decodeCatalogMessage` は decode した delta を op ごとに `validateCatalogTrack` (`ctx.source` は `"add"` / `"clone"`) と `validateRemoveTrack` で検証し、`applyCatalogDelta` は合成後の packaging / role / audio codec の MUST、clone の parent 存在、remove 対象の存在、(name, namespace) の uniqueness、initRef の参照切れなどを検証する
- `encodeCatalogDelta` は `src/msf.ts` と `src/index.ts` の公開 API である。ライブラリ自身は delta を送らない (`src/createMediaPublisher.ts` は catalog を full で送る)。`src/msf/catalogCodec.ts` の JSDoc は「track 単位の MUST の検証は行わない」と明記しており、本件の修正でこの記述も更新する必要がある

## 設計方針

- 自己 decode により、delta の add / clone の track に `validateCatalogTrack` (`ctx.source` はそれぞれ `"add"` / `"clone"`)、remove の track に `validateRemoveTrack` が適用され、decode した delta と同じ検証を encode でも行う。operation の `type` (wire では `op`) が `add` / `remove` / `clone` のいずれかであること、`tracks` が配列であることも §5.1.6 の MUST として decode が検証する。decode と同一の関数を使うため、違反時のエラー文言も受信側と揃う
- 合成後にしか決まらない clone の継承属性 (packaging / role / audio codec に依存する samplerate / channelConfig など) は対象外のままとする (`applyCatalogDelta` の責務)。clone の parent の存在、clone 名が parent と異なること、継承値との targetLatency / buffers の併存なども `applyCatalogDelta` が検証する。clone は parent から属性を継承するため、clone 自身が packaging / role / codec を明示していても、継承値との組み合わせで条件付き MUST の成否が変わり得るため、同じ扱いとする
- 検証の入口は encode したバイト列を `decodeCatalogMessage` に通す方式 (0693 の `encodeCatalog` と同じ) とする。内部表現を `validateCatalogTrack` で検証すると、JSON 化で落ちる任意フィールドの `undefined` プロパティを誤って拒否し、`toJSON` が返す値の違反を見逃す (実測: `toJSON` が `packaging: "moqlog"`, `role: "video"` を返す add の track は内部表現の検証を通るが、wire の decode は §9.4 で拒否する)。自己 decode は実際に送るバイト列を検証するため、このずれが無い。`decodeCatalogMessage` は delta を `applyCatalogDelta` に適用しないため、合成後に決まる属性の検証は行われない (clone の扱いと両立する)
- 従来 encode できていた違反 delta (track 単位 MUST だけでなく、operation の `type` / `tracks` の型違反も含む) を拒否する破壊的変更になる。`CHANGES.md` は CODEBASE.md の「MOQT RFC ドラフト中の特別ルール」に従い更新しない
- 対象は `src/msf/catalogCodec.ts` / `src/msf.test.ts` / `src/msf.prop.ts`。`encodeCatalogDelta` の JSDoc の「track 単位の MUST の検証は行わない」から「本関数では対象外とする」までの記述と、「それ以外の track 単位の MUST と、`tracks` が配列でない場合は wire に載せて decode の検証に委ねる」を削除し、自己 decode で検証することを書く

## 完了条件

- `encodeCatalogDelta` が operation の `type` (wire では `op`) が `add` / `remove` / `clone` 以外であること、`tracks` が配列でないことを decode と同じ文言の plain `Error` で reject する (§5.1.6 / §5.3)
- `encodeCatalogDelta` が add の track について track 単体で決まる §9.4 / §10.4 / §5.2.x の違反 (必須フィールド・型・packaging / role / audio codec の条件付き MUST) を reject する (エラー文言は decode 側と同一)。§5.2.3 の (name, namespace) の uniqueness と §5.2.13 の initRef の参照切れは base catalog と合成後の tracks に依存するため、`applyCatalogDelta` の合成後検証に委ねる
- `encodeCatalogDelta` が clone の track について、delta 単体で決まる §5.1.6 / §5.2.33 / §5.2.34 の clone 固有の違反 (name / parentName / 各フィールドの型など) を reject する。clone で継承され得る条件付き MUST (packaging / role / audio codec の samplerate / channelConfig)、parent の存在、clone 名が parent と異なること、継承値との targetLatency / buffers の併存などは encode では検証せず、`applyCatalogDelta` の合成後検証に委ねる
- `encodeCatalogDelta` が remove の track について、object でない track、name / namespace 以外のフィールドを持つ track、name / namespace の型が正しくない track を reject する (§5.1.6)
- encode に成功した delta は `decodeCatalogMessage` で decode できる (自己 decode 方式で保証する)。`applyCatalogDelta` は base catalog に依存する検証 (clone の parent 存在、remove 対象の存在、(name, namespace) の uniqueness、initRef、合成後の条件付き MUST など) を行うため、encode の成功は apply の成功を保証しない。encode の責務は「encode に成功した delta が自分の decode で拒否されないこと」までとする
- 正しい delta (decode 由来 / PBT 由来) は従来どおり encode できる。`src/msf.prop.ts` の delta round-trip PBT が通る
- `src/msf.ts` / `src/index.ts` の公開 API のシグネチャは変わらない (throw が増えるだけ)
- `npx vp check` / `npx tsc --noEmit` / `npx vp test --run` が通る

## 参照

- draft-ietf-moq-msf-01 §5.1.2 (generatedAt) / §5.1.6 (delta update の op と add / remove / clone、op / tracks の MUST) / §5.2.3 (name の一意性) / §5.2.13 (initRef) / §5.2.15 / §7.4.1 (template) / §5.2.18 / §5.2.22 / §5.2.28 / §5.2.29 / §5.2.33 / §5.2.34 / §5.3 (wire 形式) / §9.4 / §10.4 (packaging 別 MUST)
- `src/msf/catalogCodec.ts` の `encodeCatalogDelta` / `decodeCatalogMessage` / `decodeCatalogDelta` / `decodeCatalogDeltaOperation` / `serializeTracksForJson`
- `src/msf/catalogDelta.ts` の `applyCatalogDelta`
- `src/msf/catalogValidation.ts` の `validateCatalogTrack` / `validateRemoveTrack`
- closed `0693-bug-encode-catalog-validation.md` (encodeCatalog の自己検証。delta は「対象外」として残した。「残した課題」に本件がある。自己 decode 方式の先例)

## 解決方法

{未着手}
