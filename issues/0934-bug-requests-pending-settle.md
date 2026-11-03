# requestsPublish / requestsSubscribe / requestsFetch の送信待ちの間に Session が終了すると待ちが settle しない

- Created: 2026-11-03
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-requests-pending-settle
- Polished: {YYYY-MM-DD}

## 目的

`Session.publish()` / `subscribe()` / `fetch()` / `trackStatus()` は、保留中の Promise を送信より前に `pendingPublish` などへ登録するが、呼び出し元が待つのは `async` 関数が返す外側の Promise である。`async` 関数は送信の await を終えるまで return しないため、送信待ちの間に Session が終了すると、登録済みの reject は「まだ return されていない内側の Promise」しか settle できず、呼び出し元の待ちは settle しない。publishNamespace では送信を detached にして外側の Promise を先に返す形にした (0890) が、requests 系の各 API には同じ窓が残っている。

## 現状

- `src/session/requests.ts` の `requestsPublish` / `requestsSubscribe` / `requestsFetch` / `requestsTrackStatus` は `async` 関数である
- 送信前に `pendingPublish` / `pendingSubscribe` / `pendingFetch` / `pendingTrackStatus` へ `reject` を登録するが、`return` は送信の await の後になる
- `src/session/lifecycle.ts` の `sessionRejectPendingRequests` はこれらの Map を走査する

## 設計方針

publishNamespace (0890) と同じ形にする。

- 各 API を同期関数にして Promise を送信より先に return し、送信を detached な async 処理に切り出す
- 送信が完了したら受信ループを開始する。Session が終了していれば登録を削除して reject し、取得済みリソースを解放する
- 送信失敗時は元のエラーで reject してから後始末する
- 同期検証・パラメータ構築・encode は Promise の作成より前に済ませる
- 公開 API の JSDoc を新しい契約に合わせる

対象は `publish` / `subscribe` / `fetch` / `trackStatus` の 4 API とする。

## 完了条件

- ストリーム作成 / write の await 中に Session を close しても、各 API の Promise が reject する
- ピア起点の close でも待ちが settle する
- 送信失敗時に pending のエントリと予約した認可トークンが残らず、元のエラーで reject する
- JSDoc を新しい契約に合わせる
- `vp check` と `vp test --run` が通る

`CHANGES.md` は MOQT RFC ドラフト中のため更新しない (`CODEBASE.md` の特別ルール)。

## 参照

- `src/session/requests.ts` の `requestsPublish` / `requestsSubscribe` / `requestsFetch` / `requestsTrackStatus` / `requestsSendRequestOnBidiStream`
- `src/session/lifecycle.ts` の `sessionRejectPendingRequests`
- `src/session/namespaces.ts` の `namespacesPublishNamespace` (0890 の形)
- draft-ietf-moq-transport-22 §6.6 / §9.8 / §9.6 / §10.12
