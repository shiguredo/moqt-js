# bidi.test.ts をメッセージ種別ごとに分割し、共通ヘルパーを抽出する

- Created: 2026-09-12
- Completed: 2026-09-14
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

## 解決方法

`src/session/bidi.test.ts` (12,115 行 / 290 テスト) を機能単位の 23 ファイルに分割し、複数ファイルで使うテストヘルパーを `src/testSupport/bidi.ts` に抽出した。移動と抽出のみで、テストの本文・タイトル・アサーションは変更していない。

### 分割後のファイル

| ファイル | 行数 | テスト数 |
| --- | --- | --- |
| `bidiPublishDone.test.ts` | 88 | 3 |
| `bidiSubscriberObject.test.ts` | 165 | 8 |
| `bidiRequestUpdateOk.test.ts` | 546 | 13 |
| `bidiGoawayValidation.test.ts` | 38 | 2 |
| `bidiSendRequestUpdateFilters.test.ts` | 80 | 2 |
| `bidiSendRequestUpdateFill.test.ts` | 870 | 24 |
| `bidiSendNamespaceRequestUpdate.test.ts` | 529 | 16 |
| `bidiReadRequestStreamMessages.test.ts` | 1,052 | 24 |
| `bidiHandlePublishRequestUpdate.test.ts` | 1,096 | 32 |
| `bidiPublishRequestUpdateConditions.test.ts` | 1,131 | 26 |
| `bidiNotifySubscriberFailure.test.ts` | 159 | 5 |
| `bidiSubscribeFinReset.test.ts` | 1,234 | 25 |
| `bidiCancelSubscription.test.ts` | 333 | 5 |
| `bidiSubscriberUpdateSuppression.test.ts` | 329 | 8 |
| `bidiPublishStateNotify.test.ts` | 390 | 8 |
| `bidiResponseUncoveredBranches.test.ts` | 233 | 4 |
| `bidiResponseScopeViolation.test.ts` | 1,039 | 28 |
| `bidiResponseCrossCancel.test.ts` | 697 | 10 |
| `bidiKeyValueFormattingError.test.ts` | 834 | 22 |
| `bidiRequestUpdateScopeAudit.test.ts` | 802 | 18 |
| `bidiTrackPropertiesValidation.test.ts` | 150 | 4 |
| `bidiCancelMalformedTrackPeers.test.ts` | 100 | 1 |
| `bidiReadTrackStatusResponse.test.ts` | 166 | 2 |

最大は `bidiSubscribeFinReset.test.ts` の 1,234 行で、全ファイルが完了条件の 1,500 行以下を満たす。

### 共有ヘルパー (`src/testSupport/bidi.ts`)

複数ファイルから使う 9 件を抽出した (本体は変更せず `export` を付けただけ)。

`createBidiSession` / `buildExceedingLocationFilterValue` / `waitForMacrotask` / `createPublishReadTestContext` / `forceSessionClosed` / `buildOverflowingLocationFilterParameter` / `createPublishOkValidationContext` / `createOkResponseReadTestContext` / `createCancelObservableResponseContext`

`createPublishReadTestContext` は 12 ファイル、`createOkResponseReadTestContext` は 6 ファイル、`createBidiSession` は 5 ファイルから使う。1 ファイル専用のヘルパー (`createNamespaceUpdateSession` / `readPublishOkWithParameters` / `setOpenPublisherStream` / `createLiveReadCancelContext` / `createFireForgetUpdateContext` / `assertNoUnhandledRejection` / `readFetchWithWaiter` 系 / `useRealRequestIdValidation` / `buildRawFillWithRanges`) は各ファイルに残した。

`src/testSupport/bidi.ts` はテストファイルを import せず、`vp pack` の出力 (`dist/`) にも含まれない。

### 検証

- `vp test run`: 98 ファイル / 2,177 テスト全通過 (分割前は 76 ファイル / 2,177 テスト。テスト数は不変)
- 分割前の 290 テストと分割後の 290 テストを機械的に照合し、タイトル集合・本文 (空白正規化後)・アサーション数がすべて一致することを確認した
- 抽出した 9 ヘルパーも元の定義と本体一致を確認した
- `vp check` / `tsc --noEmit` / `vp pack` 通過
- `CHANGES.md` の `## develop` の `### misc` に `[UPDATE]` を追加した
