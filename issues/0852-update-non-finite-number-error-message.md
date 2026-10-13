# 非有限数の encode エラーが "got object" になり原因が伝わらない

- Created: 2026-10-14
- Completed: {YYYY-MM-DD}
- Branch: feature/update-non-finite-number-error-message

## 目的

`encodeCatalog` は作った JSON を decode 側の検証に通す (issues/closed/0693-bug-encode-catalog-validation.md) ため、NaN / ±Infinity のフィールドは `JSON.stringify` が `null` にした後で型検証に掛かり、「must be a number per §5.2.22, got object」という文言になる。呼び出し側が渡した値は `NaN` であり、`object` と言われても原因に辿り着けない。非有限数であることが分かる文言にする。

## 現状

- 実測: `createCatalog([{name: "v", packaging: "loc", isLive: true, bitrate: Number.NaN}])` は `invalid track 'v': bitrate must be a number per §5.2.22, got object` を投げる。`targetLatency: Number.POSITIVE_INFINITY` も同様である
- decode 経路は `1e999` を `assertFiniteNumber` で `bitrate must be a finite number per §5.2.22, got Infinity` として拒否する。encode 経路では内部の `NaN` が wire 化の時点で `null` になっており、この文言に到達しない
- `src/msf/catalogCodec.ts` の `buildCatalogBytes` は内部表現をそのまま検証せず、`JSON.stringify` したバイト列だけを検証する (検証対象と送る対象を一致させるため)。そのため非有限数の情報は wire 化の時点で失われる
- `src/msf/json.ts` の `assertFiniteNumber` は wire 化の前に呼べば `got NaN` を出せる

## 設計方針

- wire 値が `null` のときだけ「null (非有限数は JSON では null になる)」と補足する、または encode の自己検証の前に内部表現の数値を `assertFiniteNumber` で走査する。前者は文言だけの変更、後者は検証が二重になる (どのフィールドが number かは `catalogTrackValidation` が知っているため、後者を採る場合は共有できる形にする)
- decode の文言 (`must be a number ... got object`) は変えない。受信した JSON では `null` が実際の値であり、`1e999` は `assertFiniteNumber` が別の文言で扱う
- 対象は `src/msf/catalogCodec.ts` / `src/msf/json.ts` / `src/msf.test.ts`

## 完了条件

- 非有限数を持つ track を `encodeCatalog` / `createCatalog` に渡したときのエラーが、値が非有限数であることを示す
- decode の文言と受理集合は変わらない
- 既存の非有限数の reject テストが新しい文言に追従する
- `npx vp check` / `npx tsc --noEmit` / `npx vp test --run` が通る

## 参照

- ECMA-262 の `JSON.stringify` (非有限数を null にする) / `JSON.parse` (桁あふれした数値リテラルを Infinity にする)
- `src/msf/json.ts` の `assertFiniteNumber`
- `src/msf/catalogCodec.ts` の `buildCatalogBytes` / `serializeTracksForJson`
- `src/msf/catalogTrackValidation.ts` の `pickOptionalNumber` / `pickLatencyAndBuffers` / `validateBuffers` / `pickTrackDuration` / `assertTemplateNumber`
- closed `0693-bug-encode-catalog-validation.md` (「残した課題」に本件がある)

## 解決方法

{未着手}
