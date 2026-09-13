# namespace 系 3 ループの鏡写しテストを共通化する

- Created: 2026-09-12
- Completed: 2026-09-14
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

## 解決方法

テストハーネスを `createNamespaceLoopTestContext(kind)` に統一し、3 ループ共通のシナリオをケース表 + `forEach` で生成する形にした。ループ固有の検証は個別テストのまま残している。

### ハーネスの統一

`createPublicationLoopTestContext()` を削除し、`createNamespaceLoopTestContext(kind)` に一本化した。ループ種別ごとの差は次のように吸収している。

- 対象 Map (`namespaceSubscriptions` / `tracksSubscriptions` / `namespacePublications`)
- 初期 state (subscription は `"active"`、publication は `"pending"`) と `namespacePrefix` の初期値
- `closeWithError` が保留中の更新を reject するか (publication は REQUEST_UPDATE を扱わないため対象外)
- 戻り値の別名 (`subscription` / `publication` は同一の `target` を指す)

ループ関数の呼び分けは `startLoop(kind, ...)` に集約した。

### パラメータ化したシナリオ

`LOOP_CASES` (3 ループ) と `SUBSCRIPTION_LOOP_CASES` (subscription 系 2 ループ) を回す形で 22 シナリオを統合した。テスト名は `<シナリオ>: <ループ種別> ループ` として失敗時にループ種別が判別できる。

- REQUEST_UPDATE 応答 (REQUEST_OK / REQUEST_ERROR / 未知 Mandatory Track Property / 応答前クローズ)
- GOAWAY (確立前 / 確立後 / 2 通目 / REQUEST_ERROR 後の保留更新 reject)
- 先頭メッセージガードと unknown message type
- 初期 REQUEST_OK の各種検証失敗
- error / goaway コールバックの throw で後始末が止まらないこと
- 確立前 REQUEST_ERROR での FIN + cancel、ピア FIN での自方向 FIN

ループ種別ごとの本文差はケース表側に寄せた (対象 Map、`okTypeName`、先頭メッセージ種別、`rejectsBeforeClose` フラグ)。

### 鏡写しのまま残したテスト

- namespace 固有: NAMESPACE / NAMESPACE_DONE 系 (補完通知、`this` の参照、FIN / RESET での補完)、New Session URI が空文字の GOAWAY、非空 Track Name の Redirect
- tracks 固有: PUBLISH_SKIPPED 系、初期 SUBSCRIBE_TRACKS_OK が Track Properties を運べること
- publication 固有: 確立後の 2 通目 REQUEST_OK、確立後の想定外メッセージ (先頭メッセージガードが無いため reject しない)

### 検証

- `vp test run`: 76 ファイル / 2,177 テスト全通過 (`src/session/namespaceLoops.test.ts` は 86 件)
- 旧テスト 81 件と新テストの対応を機械的に照合し、シナリオ単位でアサーション数が減っていないことを確認した。照合の過程で不足が見つかったため、旧テスト 5 件 (REQUEST_UPDATE 応答のスコープ違反 / Track Properties 非空での保留更新 reject、破損メッセージでの error コールバック throw、確立後 2 通目 REQUEST_OK の未知 Mandatory Track Property、先頭 PUBLISH_SKIPPED のガード) を復元し、未知 Mandatory Track Property の `pendingPrefix` クリア検証も戻した。テスト件数が 81 から 86 に増えているのはこの復元分である
- ファイルは 3,198 行から 2,434 行 (-764 行)
- `vp check` / `tsc --noEmit` 通過
- `CHANGES.md` の `## develop` の `### misc` に `[UPDATE]` を追加した
