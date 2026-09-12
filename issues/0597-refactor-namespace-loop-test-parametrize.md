# namespace 系 3 ループの鏡写しテストを共通化する

- Created: 2026-09-12
- Completed: {YYYY-MM-DD}
- Branch: feature/refactor-namespace-loop-test-parametrize
- Polished: {YYYY-MM-DD}

## 目的

`src/session/namespaceLoops.test.ts` は 2700 行を超え、3 ループ (Namespace / Tracks / Publication) について同じシナリオを鏡写しにしたテストが多数ある。1 つの仕様変更が 3 箇所のテスト修正になる。3 ループの実装を共通ループに畳む `issues/0577-refactor-namespace-loop-dedup.md` の完了後に、テストもループ種別をパラメータ化して 1 箇所保守にする。

## 現状

- 同一シナリオのテストが `namespaceStartNamespaceStreamLoop: ...` / `namespaceStartTracksStreamLoop: ...` / `namespaceStartPublicationStreamLoop: ...` の 3 本に分かれ、本文とアサーションがほぼ同一のものが複数ある (確立前 REQUEST_ERROR、malformed な REQUEST_OK、error コールバックの throw など)。
- テストコンテキストのハーネスは `createNamespaceLoopTestContext(kind)` と `createPublicationLoopTestContext()` に分かれており、戻り値の形も揃っていない。
- このファイルに `test.each` などのテーブル駆動の前例は無い。
- 実施順の前提: `issues/0577-refactor-namespace-loop-dedup.md` を先に完了させる。3 ループの実装が 1 本の共通ループになることで、同じシナリオのテストも自然に畳める。

## 設計方針

1. `issues/0577-refactor-namespace-loop-dedup.md` の完了後に着手する。0577 が共通ループ + ハンドラ注入にするため、テストもループ種別のパラメータ (state 型・追加メッセージ・ループ条件・後始末) を注入する形に寄せる。
2. ハーネスを 1 つに統一し、ループ種別ごとの差 (subscription / publication、Map の種類、pendingRequestUpdate の有無) をパラメータで表す。
3. 検証内容は変えない。テスト名は失敗時にループ種別が判別できる形 (パラメータを含む) にする。
4. 鏡写しのまま残すべきテスト (ループ固有の挙動を固定するもの) は残し、共通シナリオのみを畳む。

## 完了条件

- 3 ループ共通のシナリオがパラメータ化されたテストに統合され、1 箇所の修正で 3 ループ分が更新されること。
- 検証内容が変わらないこと (畳む前後で同じ挙動を検証していること)。
- ループ固有の挙動のテストが残っていること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。
- `CHANGES.md` の `### misc` に `[UPDATE]` があること。

## 参照

- `src/session/namespaceLoops.test.ts`
- `createNamespaceLoopTestContext` / `createPublicationLoopTestContext` (`src/session/namespaceLoops.test.ts`。テストハーネス)
- `issues/0577-refactor-namespace-loop-dedup.md` (先に完了させる)
