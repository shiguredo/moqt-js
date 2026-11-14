# 非有限数の encode エラーが "got object" になり原因が伝わらない

- Created: 2026-10-14
- Completed: {YYYY-MM-DD}
- Branch: feature/update-non-finite-number-error-message
- Polished: 2026-11-15

## 目的

`encodeCatalog` は作った JSON を decode 側の検証に通す (issues/closed/0693-bug-encode-catalog-validation.md) ため、NaN / ±Infinity のフィールドは `JSON.stringify` が `null` にした後で型検証に掛かり、たとえば「must be a number per §5.2.22, got object」という文言になる。呼び出し側が渡した値は `NaN` であり、`object` と言われても原因に辿り着けない。非有限数であることが分かる文言にする。

## 現状

- 実測: `createCatalog([{name: "v", packaging: "loc", isLive: true, bitrate: Number.NaN}])` は `invalid track 'v': bitrate must be a number per §5.2.22, got object` を投げる。`targetLatency: Number.POSITIVE_INFINITY` は `invalid track 'v': targetLatency must be a number per §5.2.8, got object`、`buffers: {target: Number.NaN}` は `invalid track 'v': buffers.target must be a number per §5.2.9, got object`、`trackDuration: Number.NaN` (isLive=false) は `invalid track 'v': trackDuration must be a number per §5.2.35, got object` になる。`publishTracks` の track でも同じ文言になる
- root の `generatedAt` も同じ経路である。実測: `createCatalog([], {generatedAt: Number.NaN})` は `invalid catalog: generatedAt must be a number per §5.1.2, got object` を投げる
- decode 経路は `1e999` を `assertFiniteNumber` で `invalid track 'v': bitrate must be a finite number per §5.2.22, got Infinity` として拒否する。encode 経路では内部の `NaN` が wire 化の時点で `null` になっており、この文言に到達しない
- `src/msf/catalogCodec.ts` の `buildCatalogBytes` は template の形 (`validateMediaTimelineTemplate`) を除き、内部表現をそのまま検証せず、`JSON.stringify` したバイト列だけを decode 側の検証に通す (検証対象と送る対象を一致させるため)。そのため template 以外の非有限数の情報は wire 化の時点で失われる
- `src/msf/json.ts` の `assertFiniteNumber` は wire 化の前に呼べば `got NaN` / `got Infinity` を出せる

## 設計方針

- encode の自己検証 (wire の decode) の前に、内部表現の数値フィールドを `assertFiniteNumber` で走査する方式を採る。wire 値が `null` のときだけ文言を補足する方式は、`pickOptionalNumber` を共有する decode の `null` の文言まで変えるか、encode 専用のエラー付け替えが必要になるため採らない。自己 decode は残し、走査はその前段の追加検証として行う
- 走査は `src/msf/catalogCodec.ts` の `buildCatalogBytes` で `catalog.tracks` / `catalog.publishTracks` の各 track と root の `generatedAt` に対して行う。`createCatalog` は `assertCatalogEncodable` 経由で同じ `buildCatalogBytes` を通るため、追加の変更は不要
- どのフィールドが数値かは `src/msf/catalogTrackValidation.ts` が持つ情報を共有する。`pickOptionalNumber` / `pickLatencyAndBuffers` / `validateBuffers` / `pickTrackDuration` / `assertTemplateNumber` が扱う数値フィールド (targetLatency / buffers の target・min・max / renderGroup / altGroup / temporalId / spatialId / framerate / timescale / bitrate / avgBitrate / maxGopDuration / maxGroupDuration / width / height / samplerate / displayWidth / displayHeight / trackDuration / template の数値) を対象にする。一覧は現在の `pickOptionalNumber` の呼び出し順に並べ、decode の検証順を変えない。`template` は既存の `validateMediaTimelineTemplate` で wire 化前に検証済みのため、その経路を維持する
- 走査は非有限数の number だけを拒否し、`undefined` / 文字列 / object などの型違反は wire の自己 decode に委ねる。`JSON.stringify` が `undefined` を落とすことと整合させるため、`typeof value === "number" && !Number.isFinite(value)` のときだけ `assertFiniteNumber` を呼ぶ。配列でない `tracks` / `publishTracks`、object でない要素、`name` / `packaging` / `isLive` の型が正しくない track は走査を skip し、wire の構造検証の文言を保つ。`targetLatency` と `buffers` が併存するときは「併存してはならない」の文言を保つため両方の非有限数検査を skip し、`trackDuration` は `isLive === true` のとき「含めてはならない」の文言を保つため skip する。`toJSON` が非有限数を有限値に変換する track も、内部表現の走査では拒否する (呼び出し側が渡した値が非有限数であるため)。wire の自己 decode は残すので、`toJSON` を含む変換の検証は引き続き wire 側で行う
- `serializeTrackForJson` は `encodeCatalogDelta` の add / clone からも呼ばれるため、走査を `serializeTrackForJson` に置くと delta の受理集合も変わる。本 issue は full catalog の `encodeCatalog` / `createCatalog` だけを対象にし、delta の内容検証は 0849 の責務とする
- decode の文言 (`must be a number ... got object`) と受理集合は変えない。受信した JSON では `null` が実際の値であり、`1e999` は `assertFiniteNumber` が別の文言で扱う
- 対象は `src/msf/catalogCodec.ts` / `src/msf/catalogTrackValidation.ts` / `src/msf/json.ts` / `src/msf.test.ts`。`catalogTrackValidation.ts` は数値フィールド一覧の共有のため

## 完了条件

- 非有限数を持つ track または root の `generatedAt` を `encodeCatalog` / `createCatalog` に渡したときのエラーが、値が非有限数であることを示す (`got NaN` / `got Infinity` など)。対象は `tracks` / `publishTracks` の数値フィールド (§5.2.8 / §5.2.9 / §5.2.11 / §5.2.12 / §5.2.16 / §5.2.17 / §5.2.20 / §5.2.21 / §5.2.22 / §5.2.23 / §5.2.24 / §5.2.25 / §5.2.26 / §5.2.27 / §5.2.28 / §5.2.30 / §5.2.31 / §5.2.35 / §7.4.1) と root の `generatedAt` (§5.1.2)
- 本 issue では `encodeCatalogDelta` の受理集合は変えない (delta の内容検証は 0849 の責務)
- decode の文言と受理集合は変わらない
- `src/msf.test.ts` の「Catalog: encodeCatalog は非有限数のフィールドを reject する」と「createCatalog: 非有限数のフィールドを reject する」が新しい文言に追従し、`targetLatency` / `buffers` / `trackDuration` / `generatedAt` / `publishTracks` のケースが追加される
- 非有限数以外の違反だけを持つ入力 (targetLatency と buffers の併存、isLive=true の trackDuration、name / packaging / isLive の型違反など) のエラー文言と順序は変わらない。非有限数と他の違反が同時にある場合は、非有限数のエラーを先に返してよい
- `npx vp check` / `npx tsc --noEmit` / `npx vp test --run` が通る

## 参照

- ECMA-262 の `JSON.stringify` (非有限数を null にする) / `JSON.parse` (桁あふれした数値リテラルを Infinity にする)
- draft-ietf-moq-msf-01 §5.1.2 / §5.2.8 / §5.2.9 / §5.2.11 / §5.2.12 / §5.2.16 / §5.2.17 / §5.2.20〜§5.2.31 / §5.2.35 / §7.4.1。本文は `refs/moq/draft-ietf-moq-msf-01.txt`
- `src/msf/json.ts` の `assertFiniteNumber`
- `src/msf/catalogCodec.ts` の `buildCatalogBytes` / `serializeTracksForJson`
- `src/msf/catalogValidation.ts` の `validateCatalog` (root の `generatedAt` の decode 検証)
- `src/msf/catalogTrackValidation.ts` の `pickOptionalNumber` / `pickLatencyAndBuffers` / `validateBuffers` / `pickTrackDuration` / `assertTemplateNumber` (数値フィールド一覧を共有する)
- closed `0693-bug-encode-catalog-validation.md` (「残した課題」に本件がある)
- open `0849-bug-encode-catalog-delta-content-validation.md` (delta の内容検証。本 issue は delta の受理集合を変えない)

## 解決方法

{未着手}
