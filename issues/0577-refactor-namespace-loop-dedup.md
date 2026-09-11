# namespaceLoops.ts の 3 ループを共通ループとハンドラ注入に畳む

- Created: 2026-09-12
- Completed: {YYYY-MM-DD}
- Branch: feature/refactor-namespace-loop-dedup
- Polished: {YYYY-MM-DD}

## 目的

`src/session/namespaceLoops.ts` の 3 ループ (Namespace / Tracks / Publication) は、done 処理・状態管理・REQUEST_OK / REQUEST_ERROR / GOAWAY の 3 分岐を複製しており、1 件の修正が 3 箇所の保守になる。共通ループとメッセージハンドラ注入に畳んで 1 箇所保守にする。

## 現状

- `namespaceStartNamespaceStreamLoop` / `namespaceStartTracksStreamLoop` / `namespaceStartPublicationStreamLoop` の 3 ループが、`resolved` / `goawayReceived` / `requestMigrated` などの状態宣言、done 節、`REQUEST_OK` / `REQUEST_ERROR` / `GOAWAY` の 3 分岐、`finally` の state 更新と Map 削除をそれぞれ複製している。
- 3 ループには次の差があり、共通化ではこれらを保持する必要がある。
  - state 型が異なる (`NamespaceSubscriptionState` / `TracksSubscriptionState` / `NamespacePublicationState`)。
  - 処理するメッセージ集合が異なる (Namespace は `NAMESPACE` / `NAMESPACE_DONE`、Tracks は `PUBLISH_SKIPPED`、Publication は追加メッセージなし)。
  - 先頭メッセージガード `namespaceValidateFirstMessage` は Namespace / Tracks のみに適用し、Publication には適用しない (§9.14 に先頭メッセージ MUST が無いため)。
  - ループ条件が異なる (Namespace / Tracks は `subscription.state === "active"`、Publication は `publication.state !== "closed"`)。
  - done 時の後始末が異なる (Namespace は `namespaceHandleNamespaceStreamDone`、Tracks はインラインの pending 更新 reject、Publication は pending 更新処理なし)。
  - `releaseLock()` を try/catch で包むのは Publication のみ。

## 設計方針

1. 3 ループを共通ループ + メッセージハンドラ注入に畳む。各ループ関数の入口 (export) は `src/session.ts` と `src/session/namespaceLoops.test.ts` から参照されているため、薄いラッパーとして残す。
2. 共通ループは状態宣言・done 節・3 分岐の骨格・finally を持ち、ループ条件、追加メッセージ、先頭メッセージガード、done 時の後始末、`releaseLock` の扱いをパラメータまたはハンドラとして注入する。
3. 3 ループの差異 (現状の 6 項目) は注入側に残し、共通ループに取り込まない。
4. 挙動を変えない。特に GOAWAY ハンドリング (先頭 GOAWAY の扱い、スプリアス PROTOCOL_VIOLATION の防止、pending 更新の reject) の差を維持する。
5. 変更対象は `src/session/namespaceLoops.ts` (3 ループと共通ループ) と `src/session/namespaceLoops.test.ts` (追従) とする。

## 完了条件

- 3 ループが 1 本の共通ループ + ハンドラ注入に置き換わり、各関数は薄いラッパーになること。
- 3 ループ固有の挙動 (state 型・追加メッセージ・先頭メッセージガード・ループ条件・done 時後始末・`releaseLock` の扱い) が変わらないこと。
- 既存テストが全て通り、テストの検証内容が変わらないこと。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。
- `CHANGES.md` の `### misc` に `[UPDATE]` を追加すること。

## 関連

- `namespaceStartNamespaceStreamLoop` / `namespaceStartTracksStreamLoop` / `namespaceStartPublicationStreamLoop` (`src/session/namespaceLoops.ts`)
- `issues/0523-refactor-namespace-validation-error.md` (初期応答検証のフォールバック整理。検証関数の API を先に確定させるため、本 issue より先に実施する)
- `issues/0498-refactor-bidi-namespace-dedup.md` (bidi 応答読み取りの共通化。分割前の 0498 から分離)
