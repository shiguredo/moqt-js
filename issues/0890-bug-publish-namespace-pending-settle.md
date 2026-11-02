# publishNamespace の送信待ちの間に Session が終了すると待ちが settle しない

- Created: 2026-11-02
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-publish-namespace-pending-settle
- Polished: {YYYY-MM-DD}

## 目的

`Session.publishNamespace` の戻り値の Promise は、ストリームの作成と `PUBLISH_NAMESPACE` の書き込みが終わってから `namespacePublications` に登録される。この登録前の await の間に Session が終了すると、`sessionRejectPendingRequests` の reject 対象にまだ入っていないため、待ちの settle がストリームの読み取りエラーに依存する。WebTransport ではストリームの読み取りが失敗して settle する想定だが、ライブラリとして「Session が終了したら未確立の待ちは reject する」契約を保証できていない。

## 現状

`src/session/namespaces.ts` の `namespacesPublishNamespace` は、次の順で進む。

1. `createBidirectionalStream` と `writer.write` を await する
2. その後に `new Promise` を作り、`session.namespacePublications.set(requestId, ...)` で登録する
3. 内部ループ (`namespaceStartPublicationStreamLoop`) が `REQUEST_OK` / `REQUEST_ERROR` / 読み取り失败を処理する

`src/session/lifecycle.ts` の `sessionRejectPendingRequests` は `session.namespacePublications` を走査して、確立前の `reject` を呼ぶ。登録前の待ちはこの走査に入らない。

`src/session.test.ts` の「Session の close で未確立の待ちが reject する」「ピア起点の close で未確立の待ちが reject する」は、登録を待つヘルパー (`waitForNamespacePublicationRegistered`) を使ってから close しており、登録前の窓は固定していない。テストのコメントにも「登録前に Session を終了すると reject の対象が無い」と書いてある。

`docs/LOW_LEVEL_API.md` の「Namespace 系の扱い」は「Session の終了時は、登録済みの未確立の `publishNamespace()` の Promise を reject する」と限定しており、登録前の扱いに触れていない。`Session.publishNamespace` の JSDoc も「登録済みの未確立の Promise を reject する」と書いている。

## 設計方針

候補は次の 2 つ。

- 保留の登録をストリーム作成の前に寄せる: `requestId` を採番した時点で `namespacePublications` へ仮のエントリを置き、`createBidirectionalStream` / `writer.write` の await の後に実体 (reader / writer) を埋める。`sessionRejectPendingRequests` は仮のエントリの `reject` を呼べるようにする。送信が失敗したら `namespacesCleanupSendFailure` と同じ後始末で登録を取り消す
- 送信の await の後に Session の状態を再確認し、閉じていれば後始末して `Error("session closed")` で reject する。この場合は「待ち続けない」ことは保証できるが、Session の `close()` が先に返っている場合に限る

`sessionRejectPendingRequests` の走査対象を広げる 1 つ目の案の方が、`close()` / ピア起点の close のどちらでも同じ経路で reject でき、既存の他の request 系 (`pendingPublish` など) の登録位置とも揃う。ただし内部ループの `loaded` が期待するフィールドとの整合、送信失敗時の後始末、二重 settle の防止を設計する必要がある。

`docs/LOW_LEVEL_API.md` と `Session.publishNamespace` の JSDoc を、修正後の契約に合わせる (登録前を含めて保証するのか、既知の窓として残すのかを明示する)。

## 完了条件

- `createBidirectionalStream` / `writer.write` の await 中に Session を close した場合でも、`publishNamespace` の Promise が reject して待ち続けない (テストで固定する)。テストは `createPendingNamespaceTransport` のような、write が完了しない transport を使って窓を作る
- ピア起点の close でも同じく待ちが settle する
- 送信の await の途中で Session が終了した場合も、ストリームの reader / writer が残らない
- `docs/LOW_LEVEL_API.md` の「Namespace 系の扱い」と `Session.publishNamespace` の JSDoc に、登録前の扱いを書く
- `npx vp check` と `npx vp test --run` が通る

`CHANGES.md` は MOQT RFC ドラフト中のため更新しない (`CODEBASE.md` の特別ルール)。

## 解決方法

{未着手}

## 参照

- `src/session/namespaces.ts` の `namespacesPublishNamespace` / `namespacesCleanupSendFailure`
- `src/session/lifecycle.ts` の `sessionRejectPendingRequests` / `sessionClose`
- `src/session/namespaceLoops.ts` の `namespaceStartPublicationStreamLoop`
- `src/session/types.ts` の `NamespacePublicationState.reject`
- `src/session.test.ts` の `createPendingNamespaceTransport` / `waitForNamespacePublicationRegistered` と publishNamespace のテスト
- `docs/LOW_LEVEL_API.md` の「Namespace 系の扱い」
- `src/session.ts` の `Session.publishNamespace`
- draft-ietf-moq-transport-22 §6.6
