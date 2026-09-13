# 2^64-1 の重複定数を MAX_VARINT に統一する

- Created: 2026-08-07
- Updated: 2026-09-05
- Completed: 2026-09-14
- Branch: feature/refactor-unify-max-varint-constant
- Polished: {YYYY-MM-DD}

## 目的

`src/varint.ts` に export される `MAX_VARINT`（2^64-1）が導入されたのに伴い、同じ値を持つ重複定数・インライン定数を `MAX_VARINT` 参照に統一する。closed issue 0243 の設計方針（「`2n ** 64n - 1n` を表す定数を共用で定義する」）で計画された定数共用化が未達のまま残っており、その回収を行う。

## 現状

- `src/session/publish.ts` の objectId 上限チェックがインラインの `(1n << 64n) - 1n` を直接使用している。
- `src/session/stream.ts` と `src/dataStream.ts` がそれぞれモジュールローカル定数 `maxObjectId = (1n << 64n) - 1n` を定義している。
- `src/varint.prop.ts` の `MAX_VARINT` 統一は 0363 作業時に実施済み (`src/varint.ts` の export 定数を import 参照)。
- 前提: `MAX_VARINT` の定義と export は `issues/closed/0363-bug-varint-overflow-wrap.md` (Closed、2026-08-13 完了) で実施済みのため、本 issue 単独で着手可。

## 設計方針

- 上記 3 箇所 (生産コード) の定数・インライン定数を `src/varint.ts` の `MAX_VARINT` 参照に置き換える。
- `src/message/authorizationToken.prop.ts` の `MAX_VARINT`（Number.MAX_SAFE_INTEGER）はテスト生成上限として別値のため置き換えない。ただし、同ファイルのコメント（「varint は 62bit まで表現可能」）は誤解を招く記述のため、テスト生成上限である旨に修正する。`src/loc.prop.ts` は `src/varint.ts` の `MAX_VARINT` を import 参照済みのため対象外。
- テストファイルのインライン `(1n << 64n) - 1n`（`src/moqlog.prop.ts` / `src/moqmetrics.prop.ts` / `src/dataStream.prop.ts` / `src/dataStream.fetch.test.ts` 等）は対象外とする（テスト内の値生成上限であり、`MAX_VARINT` 参照への統一は必須ではない）。

## 完了条件

- 生産コード（`src/session/publish.ts` / `src/session/stream.ts` / `src/dataStream.ts`）の 2^64-1 表現が `MAX_VARINT` 参照になっていること。
- `src/message/authorizationToken.prop.ts` のコメントがテスト生成上限である旨に修正されていること。
- `CHANGES.md` の `## develop` に `[REFACTOR]` があること。
- `vp check` / `tsc --noEmit` / `vp test run` が通る。

## 参照

- 関連: `issues/closed/0243-draft-18-fix-object-group-id-overflow-checks.md`（定数共用化の設計方針。完了条件には含まれず未達のまま）
- 関連: `issues/closed/0363-bug-varint-overflow-wrap.md`（`MAX_VARINT` の定義と上限検証。Closed 済みのため本 issue 単独で着手可）

## 解決方法

実装した。

### 生産コードの統一

`src/session/stream.ts` と `src/dataStream.ts` がそれぞれ定義していたモジュールローカル定数 `maxObjectId = (1n << 64n) - 1n` を削除し、使用箇所を `src/varint.ts` の `MAX_VARINT` 参照に置き換えた (`src/dataStream.ts` は `encodeSubgroupHeader` 側と `encodeObjectDatagram` 側の 2 箇所、`src/session/stream.ts` は `processSubgroupObjects` 内の 1 箇所)。

定数の別名 (`const maxObjectId = MAX_VARINT`) は残さず、使用箇所で直接 `MAX_VARINT` を参照する形にした。重複していたのは値の定義そのものであり、別名を残すと同じ値を持つ名前が 2 つ残るためである。`maxObjectId` の doc コメントが持っていた「Object ID / Group ID の上限が 2^64-1 である根拠」(§11.3.1 / §11.4.1.1 Table 9) は、いずれも各使用箇所に既に同じ引用があったため、上限が varint の最大値と同一である旨の 1 行を足して使用箇所側に残した。

`src/session/publish.ts` は既に `MAX_VARINT` を import 参照しており (objectId / groupId の検証)、変更していない。

### テストファイルの扱い

issue の設計方針どおり、テストファイルの `(1n << 64n) - 1n` (`src/moqlog.prop.ts` / `src/moqmetrics.prop.ts` / `src/dataStream.prop.ts` / `src/dataStream.fetch.test.ts`) は値生成の上限であり対象外とした。

`src/message/authorizationToken.prop.ts` のコメントを修正した。元の「varint は 62bit まで表現可能なので、フィールドは 2^53-1 で打ち切り」は varint の上限 (9 バイトで 2^64-1) を誤って説明していた。同ファイルの `MAX_VARINT` はテストの値生成上限であることを明記し、実装の上限ではないと分かるようにした。定数の名前と値は issue の指示どおり変更していない。

### 完了条件の `[REFACTOR]` について

完了条件は `CHANGES.md` の `## develop` に `[REFACTOR]` を求めているが、`shiguredo-changelog` スキルが定める変更種別は `[CHANGE]` / `[ADD]` / `[UPDATE]` / `[FIX]` の 4 種で `[REFACTOR]` は存在しない。既存の refactor 作業 (テストヘルパー集約) も `[UPDATE]` で記録されているため、本 issue も `[UPDATE]` で記録した。

### 検証

- `vp check` / `tsc --noEmit` 通過
- `vp test run`: 70 ファイル / 2,122 テスト全通過
- `rg "1n << 64n" src/` の生産コード側の一致が 0 件であること (`src/**/*.prop.ts` と `*.test.ts` の値生成のみ残る)
