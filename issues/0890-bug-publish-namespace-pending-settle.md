# publishNamespace の送信待ちの間に Session が終了すると待ちが settle しない

- Created: 2026-11-02
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-publish-namespace-pending-settle
- Polished: 2026-11-03

## 目的

`Session.publishNamespace` の戻り値の Promise は、ストリームの作成と `PUBLISH_NAMESPACE` の書き込みが終わってから `namespacePublications` に登録される。この登録前の await の間に Session が終了すると、`sessionRejectPendingRequests` の reject 対象にまだ入っていないため、待ちの settle がストリームの読み取りエラーに依存する。WebTransport ではストリームの読み取りが失敗して settle する想定だが、ライブラリとして「Session が終了したら未確立の待ちは reject する」契約を保証できていない。

## 現状

`src/session/namespaces.ts` の `namespacesPublishNamespace` は `async` 関数であり、次の順で進む。

1. `createBidirectionalStream` と `writer.write` を await する
2. その後に `new Promise` を作り、`session.namespacePublications.set(requestId, ...)` で登録する
3. その Promise を return し、内部ループ (`namespaceStartPublicationStreamLoop`) が `REQUEST_OK` / `REQUEST_ERROR` / 読み取り失敗を処理する

`src/session/lifecycle.ts` の `sessionRejectPendingRequests` は `session.namespacePublications` を走査して、確立前の `reject` を呼ぶ。登録前の待ちはこの走査に入らない。

### 登録を送信の前に移すだけでは足りない (設計上の要点)

呼び出し元が待つのは `namespacesPublishNamespace` (async 関数) が返す外側の Promise である。`async` 関数は `await` の途中で return できないため、送信の await が終わるまで内側の Promise (登録する `reject` の対象) は作られず、外側の Promise も返らない。「先に登録する」だけでは、登録した reject は「まだ return されていない内側の Promise」しか settle できず、呼び出し元の待ちは settle しない。実際に `await` 中の async 関数の外側 Promise が、後から作られる内側 Promise の reject で settle しないことは JS の仕様どおりである (検証用の小さなスクリプトで確認済み)。

そのため、送信の前に登録するだけでなく、**送信を detached な async 処理にし、Promise を先に返す**必要がある。

### 同型の窓が購読系にもある (本 issue の対象外)

`namespacesSubscribeNamespace` と `namespacesSubscribeTracks` も `await writer.write` の後に `new Promise` を作って `namespaceSubscriptions` / `tracksSubscriptions` に登録する。しかも両者は `sessionRejectPendingRequests` の走査対象にすら入っていない (対象は `namespacePublications` のみ)。本 issue は `publishNamespace` の窓に限定し、購読系の窓は follow-up issue の候補として扱う。

### 既存テストと docs の現状

`src/session.test.ts` の「Session の close で未確立の待ちが reject する」「ピア起点の close で未確立の待ちが reject する」は、登録を待つヘルパー (`waitForNamespacePublicationRegistered`) を使ってから close しており、登録前の窓は固定していない。テストのコメントにも「登録前に Session を終了すると reject の対象が無い」と書いてある。テスト用の `createPendingNamespaceTransport` は `writable` の `write` が即座に解決するため、窓を作るには `createBidirectionalStream` または `write` が解決しない transport を使う必要がある。

`docs/LOW_LEVEL_API.md` の「Namespace 系の扱い」は現在「... (ストリーム作成 / write の await 中に終了した場合は読み取りの失敗で settle する)」と、読み取りの失敗への依存を明記している。`Session.publishNamespace` の JSDoc は「登録済みの未確立の Promise を reject する」と書いている。修正後は、両方を「送信待ちの間の Session 終了でも reject する」契約に合わせる。

## 設計方針

1. **検証・encode と Promise の登録を送信より前に置く**
   - `validateTrackNamespaceForSend` と `encodePublishNamespacePayload` など throw し得る処理を先に行う (`src/session/requests.ts` の `requestsPublish` / `requestsSubscribe` と同じ)
   - `requestId` を採番し、`new Promise` を作って `reject` を登録する。この時点ではストリームが無いため、`NamespacePublicationState` のフィールドを optional にせず、**送信前の reject だけを持つ専用の Map** (`pendingNamespacePublication: Map<bigint, { reject }>` など) を `SessionInternal` に足す (`pendingPublish` と同じ形)。`sessionRejectPendingRequests` がこの Map を走査して reject する
2. **Promise を即座に return し、送信は detached な async 処理にする**
   - `namespacesPublishNamespace` を `async` 関数から通常の関数に変え、`Promise<NamespacePublication>` を同期的に return する。`Session.publishNamespace` は `async` のままでよい (`async` 関数は return した Promise を adopt するため、await を挟まなければ呼び出し元へ即座に Promise が返る)
   - 同期の検証で throw した場合は、`Session.publishNamespace` の async 境界が rejection に変換する (登録前なので後始末は不要)
   - 送信処理は `void sendPublishNamespace(...)` のような別の async 関数に切り出し、`createBidirectionalStream` / `writer.write` を await する。その間の Session 終了は 1 の reject で呼び出し元へ届く
   - 送信が成功したら、`pendingNamespacePublication` から削除し、`namespacePublications` に実体を登録してから `namespaceStartPublicationStreamLoop` を開始する。送信が失敗したら `namespacesCleanupSendFailure` でストリームを解放し、`pendingNamespacePublication` から削除して reject する (未処理 rejection を残さない)
   - 送信の await の後に Session が閉じている場合は、ストリームを解放して登録を削除し、reject は既に Session 終了側が行っているため二重 settle を避ける (Promise の settle は 1 回だけ)
3. **テスト**
   - `createBidirectionalStream` または `write` が解決しない transport を使い、送信待ちの間に `close()` / ピア起点の close を起こして、呼び出し元の Promise が reject することを固定する
   - 送信失敗時に `pendingNamespacePublication` とストリームが残らないことも固定する
4. **docs**: `docs/LOW_LEVEL_API.md` の「Namespace 系の扱い」と `Session.publishNamespace` の JSDoc を、「送信待ちの間の Session 終了でも reject する」契約に書き換える

## 完了条件

- `createBidirectionalStream` / `writer.write` の await 中に Session を close した場合でも、呼び出し元の `publishNamespace` の Promise が reject して待ち続けない (テストで固定する)。テストは `createBidirectionalStream` または `write` が解決しない transport を使う (`createPendingNamespaceTransport` の `write` は即座に解決するため、そのままでは窓を作れない)
- ピア起点の close でも同じく待ちが settle する
- 送信待ちの間に Session が終了した場合も、ストリームの reader / writer が残らない (登録の削除とストリームの解放の両方を確かめる)
- 送信が失敗した場合に、`pendingNamespacePublication` のエントリと予約した認可トークンが残らず、呼び出し元の Promise が元のエラーで reject する (既存の `namespacesCleanupSendFailure` の経路を壊さない)
- `docs/LOW_LEVEL_API.md` の「Namespace 系の扱い」と `Session.publishNamespace` の JSDoc を、送信待ちの間の Session 終了でも reject する契約に書き換える (現在の「読み取りの失敗で settle する」という記述を直す)
- `npx vp check` と `npx vp test --run` が通る

`CHANGES.md` は MOQT RFC ドラフト中のため更新しない (`CODEBASE.md` の特別ルール)。

## 解決方法

{未着手}

## 参照

- `src/session/namespaces.ts` の `namespacesPublishNamespace` / `namespacesCleanupSendFailure`
- `src/session/requests.ts` の `requestsPublish` / `requestsSubscribe` (「Promise の作成と登録 → 送信」の先例)
- `src/session/lifecycle.ts` の `sessionRejectPendingRequests` / `sessionClose`
- `src/session/namespaceLoops.ts` の `namespaceStartPublicationStreamLoop`
- `src/session/types.ts` の `NamespacePublicationState.reject`
- `src/session.test.ts` の `createPendingNamespaceTransport` / `waitForNamespacePublicationRegistered` と publishNamespace のテスト
- `docs/LOW_LEVEL_API.md` の「Namespace 系の扱い」
- `src/session.ts` の `Session.publishNamespace`
- draft-ietf-moq-transport-22 §6.6
