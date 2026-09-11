# bidi.test.ts をメッセージ種別ごとに分割し、共通ヘルパーを抽出する

- Created: 2026-09-12
- Completed: {YYYY-MM-DD}
- Branch: feature/refactor-bidi-test-split
- Polished: {YYYY-MM-DD}

## 目的

`src/session/bidi.test.ts` は 10,797 行 / 266 テストに達し、単一ファイルとして保守限界を超えている。テスト対象は双方向ストリームの全メッセージ処理（PUBLISH 応答 / SUBSCRIBE 応答 / FETCH 応答 / TRACK_STATUS 応答 / REQUEST_UPDATE / namespace 購読 / malformed cancel 等）に広がり、変更時の影響範囲とテストの所在が読み取りにくい。cross-cancel テストのように 1 件で 150 行のセットアップを持つテストでは peer フィクスチャの重複も蓄積している。ファイル分割と共通ヘルパー抽出で保守性を回復する。

## 現状

- `src/session/bidi.test.ts` は 10,797 行 / 266 テスト。テスト対象の本体 `src/session/bidi.ts` は 3,589 行であり、テストファイルが本体の約 3 倍に達している。
- ファイル内はセクションコメントで区切られているが、単一ファイルのため目的のテストを探すのに全体を辿る必要がある。
- 今回追加した cross-cancel テスト 2 件は、peer の生成・Map 登録・cancel 観測用ストリームの配線がほぼ同一で、約 120 行が重複している。
- `createCancelObservableResponseContext` などのヘルパーがテスト本体と同じファイルにあり、分割時の共有方法が未整理である。

## 設計方針

1. ファイル内のセクション見出し（`bidiHandlePublishDone` / `readPublishResponse` / `readSubscribeResponse` / `readFetchResponse` / `readTrackStatusResponse` / requestUpdate / namespace / `cancelMalformedTrackPeers` 等）を基準に、メッセージ種別ごとのテストファイルに分割する。
2. `createCancelObservableResponseContext` 等の共通ヘルパーは共有モジュール（例: `bidi.test.helpers.ts`）に抽出し、各テストファイルから参照する。
3. cross-cancel 系テストの peer フィクスチャ（同一 Track / 別 Track の購読 / FETCH、cancel 観測用ストリーム）を共通関数化する。
4. テスト総数と検証内容は変えない。分割は移動と抽出のみで、テストの削除・統合は行わない。

## 完了条件

- 分割後の各テストファイルが 1,500 行以下であること。
- テスト総数 (266 件) が変わらないこと。
- 共通ヘルパーが共有モジュールに集約されていること。
- `vp test run` が通ること。

## 関連

- `src/session/bidi.ts`（テスト対象の本体）
- `createCancelObservableResponseContext` / cross-cancel テスト（`src/session/bidi.test.ts`）
- `issues/0498-refactor-bidi-namespace-dedup.md`（bidi 応答読み取りと namespace ループの重複除去）
- `issues/0497-refactor-session-impl-split.md`（SessionImpl の分割）
