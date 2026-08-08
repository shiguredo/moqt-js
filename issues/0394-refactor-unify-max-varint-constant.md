# 2^64-1 の重複定数を MAX_VARINT に統一する

- Created: 2026-08-07
- Completed: {YYYY-MM-DD}
- Branch: feature/refactor-unify-max-varint-constant
- Polished: {YYYY-MM-DD}

## 目的

`src/varint.ts` に export される `MAX_VARINT`（2^64-1）が導入されたのに伴い、同じ値を持つ重複定数・インライン定数を `MAX_VARINT` 参照に統一する。closed issue 0243 の設計方針（「`2n ** 64n - 1n` を表す定数を共用で定義する」）で計画された定数共用化が未達のまま残っており、その回収を行う。

## 現状

- `src/session/publish.ts` の objectId 上限チェックがインラインの `(1n << 64n) - 1n` を直接使用している。
- `src/session/stream.ts` と `src/dataStream.ts` がそれぞれモジュールローカル定数 `maxObjectId = (1n << 64n) - 1n` を定義している。
- `src/varint.prop.ts` がローカル定数 `MAX_VARINT = 18446744073709551615n` を定義している（値は 2^64-1 で同一）。
- 前提: `MAX_VARINT` の定義と export は issue 0363（varint の上限検証）で実施済みであること。実装順は 0363 が先。

## 設計方針

- 上記 4 箇所の定数・インライン定数を `src/varint.ts` の `MAX_VARINT` 参照に置き換える。
- `src/loc.prop.ts` の `MAX_VARINT`（2^62-1）と `src/message/authorizationToken.prop.ts` の `MAX_VARINT`（Number.MAX_SAFE_INTEGER）はテスト生成上限として別値のため置き換えない。ただし、両ファイルのコメント（「varint の最大値」「varint は 62bit まで表現可能」）は誤解を招く記述のため、テスト生成上限である旨に修正する。
- テストファイルのインライン `(1n << 64n) - 1n`（`src/moqlog.prop.ts` / `src/moqmetrics.prop.ts` / `src/dataStream.prop.ts` / `src/dataStream.fetch.test.ts` 等）は対象外とする（テスト内の値生成上限であり、`MAX_VARINT` 参照への統一は必須ではない）。

## 完了条件

- 生産コード（`src/session/publish.ts` / `src/session/stream.ts` / `src/dataStream.ts`）の 2^64-1 表現が `MAX_VARINT` 参照になっていること。
- `src/varint.prop.ts` の `MAX_VARINT` が `src/varint.ts` の export 定数を参照していること。
- `src/loc.prop.ts` / `src/message/authorizationToken.prop.ts` のコメントがテスト生成上限である旨に修正されていること。
- `CHANGES.md` の `## develop` に `[REFACTOR]` があること。
- `vp check` / `tsc --noEmit` / `vp test run` が通る。

## 参照

- 関連: `issues/closed/0243-draft-18-fix-object-group-id-overflow-checks.md`（定数共用化の設計方針。完了条件には含まれず未達のまま）
- 関連: `0363-bug-varint-overflow-wrap.md`（`MAX_VARINT` の定義と上限検証。実装順は先に 0363）

## 解決方法

未着手。
