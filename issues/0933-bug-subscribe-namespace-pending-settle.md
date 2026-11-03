# subscribeNamespace / subscribeTracks の送信待ちの間に Session が終了すると待ちが settle しない

- Created: 2026-11-03
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-subscribe-namespace-pending-settle
- Polished: {YYYY-MM-DD}

## 目的

`Session.subscribeNamespace()` と `Session.subscribeTracks()` は、双方向ストリームの作成と要求の書き込みを await した後に `new Promise` を作って `namespaceSubscriptions` / `tracksSubscriptions` に登録する。この送信待ちの間に Session が終了すると、`sessionRejectPendingRequests` の走査対象にも入っていないため、呼び出し元の Promise が settle しない。publishNamespace では送信待ちの reject を `pendingNamespacePublication` で保持するよう修正した (0890) が、購読系には同じ窓が残っている。

## 現状

- `src/session/namespaces.ts` の `namespacesSubscribeNamespace` / `namespacesSubscribeTracks` は `async` 関数であり、`createBidirectionalStream` と `writer.write` を await してから `new Promise` で登録する
- `src/session/lifecycle.ts` の `sessionRejectPendingRequests` は `pendingPublish` / `pendingSubscribe` / `pendingFetch` / `pendingRequestUpdate` / `pendingTrackStatus` / `namespacePublications` / `pendingNamespacePublication` を走査するが、`namespaceSubscriptions` / `tracksSubscriptions` は対象外
- 送信待ちの reject を保持する専用の Map も無い

## 設計方針

publishNamespace (0890) と同じ形にする。

- Promise を送信より先に作り、送信待ちの reject を専用の Map (`pendingNamespaceSubscription` など) に登録する。送信は detached な async 処理にする
- `sessionRejectPendingRequests` がこの Map を走査して reject する
- 送信完了後は pending から削除して `namespaceSubscriptions` / `tracksSubscriptions` に登録する。Session が終了していれば登録せず reject してストリームを解放する
- 送信失敗時は元のエラーで reject してから取得済みリソースを解放する
- `docs/LOW_LEVEL_API.md` の「Namespace 系の扱い」と `Session.subscribeNamespace` / `subscribeTracks` の JSDoc を新しい契約に合わせる

## 完了条件

- ストリーム作成 / write の await 中に Session を close しても、`subscribeNamespace` / `subscribeTracks` の Promise が reject する
- ピア起点の close でも待ちが settle する
- 送信待ちの間に Session が終了した場合も、reader / writer が残らない
- 送信失敗時に pending のエントリと予約した認可トークンが残らず、元のエラーで reject する
- docs と JSDoc を新しい契約に合わせる
- `vp check` と `vp test --run` が通る

`CHANGES.md` は MOQT RFC ドラフト中のため更新しない (`CODEBASE.md` の特別ルール)。

## 参照

- `src/session/namespaces.ts` の `namespacesSubscribeNamespace` / `namespacesSubscribeTracks` / `namespacesCleanupSendFailure`
- `src/session/lifecycle.ts` の `sessionRejectPendingRequests`
- `src/session/publishNamespace` の送信待ち修正 (0890) の実装
- `src/session.test.ts` の `publishNamespace: 送信待ちの間の close でも reject する` と関連テスト
- draft-ietf-moq-transport-22 §6.6 / §9.15 / §9.18
