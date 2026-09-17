# session 系モジュールに Property-Based Testing がない

- Created: 2026-09-06
- Completed: 2026-09-17
- Branch: feature/test-session-pbt
- Polished: 2026-09-17

## 目的

`src/session/` 配下は例示ベースの単体テストのみで、encode / decode 対称性や連鎖不変条件を横断的に検証できない。PBT で実現できるものは PBT で書く規約に従う必要がある。

## 現状

- `src/session/params.ts` (`mergeRangeFilters` / `build*Parameters` / filter 解決連携)、`stream.ts` (`processFetchObjects` / `processSubgroupObjects`)、`bidi.ts`、`namespaceLoops.ts`、`incoming.ts`、`publish.ts` に対応する `*.prop.ts` がない。
- バッチ内複数オブジェクトの連鎖不変条件 (例: subgroup 先頭判定の退行) は PBT があれば検出可能だった。

## 設計方針

1. 対象モジュールごとに `*.prop.ts` を新設し、round-trip と連鎖不変条件を検証する (既存 `*.prop.ts` の流儀を踏襲)。
2. PBT でカバーできた固定値テストは単体側から削除する。

## 完了条件

- 対象モジュールに `*.prop.ts` が追加され、`vp test run` で実行されること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 解決方法

`src/session/` の 6 モジュールに対応する `*.prop.ts` を新設し、round-trip と連鎖不変条件を fast-check で検証するようにした。

### 追加した PBT (120 件)

- `src/session/params.prop.ts` (41 件): `mergeRangeFilters` の削除・置換・不変 (仕様から導いた期待列との一致、キーの一意性、冪等性)、`validateRangeFilterLimits` / `validateRangeFilterSpecs` の受理と拒否、`buildRangeFilterParameters` / `buildFetchParameters` / `buildSubscribeTracksParameters` / `buildTrackStatusParameters` / `buildSubscribeNamespaceParameters` / `buildSubscribeParameters` (fill を含む) の encode / decode round-trip と未指定パラメータが現れないこと、`compareLocations` の順序公理と辞書式順序、`resolveFetchStartLocation`、`matchNamespacePrefix` / `namespacePrefixesOverlap` / `validateNamespacePrefixUpdate`、`validateTrackNamespaceForSend`、`clampTimeoutMs`
- `src/session/stream.prop.ts` (9 件): 一括 feed と分割 feed の等価性 (バッチ境界をまたぐ subgroup 先頭判定の退行を検出する)、Object ID の連鎖、`resolvedSubgroupId` の確定と引き継ぎ、delivery timeout の抽出が subgroup 先頭に限られること、未完成 Object の残バッファと消費バイトの整合、`END_OF_GROUP` の最終 Object ID が後退しないこと、`processFetchObjects` の一括 / 分割一致、`concatChunks`
- `src/session/bidi.prop.ts` (26 件): 保留中 REQUEST_UPDATE の解決 / 拒否 / 未対応 REQUEST_OK の消費、`restoreIncomingRequestUpdateCount` / `clearPriorGapTrackingIfUnused` / fill 関連付け削除の後始末、`cancelMalformedTrackPeers` / `notifySubscriberFailure`、`bidiHandlePublishDone` / `bidiHandlePublishStateNotify` の状態遷移
- `src/session/namespaceLoops.prop.ts` (14 件): `rejectPendingNamespaceUpdates`、NAMESPACE / NAMESPACE_DONE 追跡の active 集合モデルとの一致、チャンク分割不変性、3 ループのリーク検査、REQUEST_UPDATE 応答 (REQUEST_OK / REQUEST_ERROR / 応答未達 FIN) の連鎖
- `src/session/incoming.prop.ts` (19 件): `incomingClassifyFirstBidiMessage` / `incomingValidateRequestId`、datagram / subgroup / fetch の入力順と分割不変性、Prior Gap 追跡、`incomingWaitForFetcher` の解決
- `src/session/publish.prop.ts` (11 件): 送信した Subgroup を受信側の実装 (`processSubgroupObjects`) で読み戻す round-trip、Object ID Delta の連鎖、Group 切替、delivery timeout、`publishCloseSubgroupStream` / `publishClosePublisherStream` / `publishResetPublisherStream`、datagram の round-trip、公開経路の FIN / RESET 選択

### 単体テストの削除

PBT でカバーできた固定値テスト 136 件を `src/session/*.test.ts` から削除した。削除した範囲は各 `*.prop.ts` の先頭 JSDoc に列挙している。エラーパス・境界値・仕様の MUST 検証・異常系は PBT の領分ではないため単体テストに残した。

### PBT 化しなかったもの

- `bidi.ts` の非同期 I/O (`bidiSendRequestOnBidiStream` / `bidiRead*Response` / `bidiReadRequestStreamMessages` / `bidiSendRequestUpdate` など) は、ストリームの読み書き順序とタイミングに性質が依存し `fc.property` の同期述語に載せられないため対象外とした
- `incomingSendRequestErrorAndClose` / `incomingHandleFirstBidiMessage` は実ストリーム I/O と固定値の非同期応答が主で、任意入力に対する不変条件を作れないため対象外とした
- `namespaceLoops.ts` は `matchNamespacePrefix` / `namespacePrefixesOverlap` / `validateNamespacePrefixUpdate` を呼ばないため、これらの性質は `params.prop.ts` で検証している

### 検証

- `vp check` 通過
- `tsc --noEmit` 通過
- `vp test run`: 114 ファイル / 2,396 テスト全通過 (PBT 120 件を追加、固定値テスト 136 件を削除)
- `vp run build` 通過
