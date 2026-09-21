# 高レベル API の送信失敗が握り潰されて unhandled rejection になる

- Created: 2026-09-21
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-media-send-rejection-propagation
- Polished: {YYYY-MM-DD}

## 目的

`src/createMediaPublisher.ts` は `void this.audioPublisher.sendObject(...)` と `void this.videoPublisher.sendObject(...)` で送信し、`src/publisher.ts` の `sendObject` が返す reject を捨てている。捨てられた reject は unhandled rejection として実行環境へ通知される。高レベル API の利用者は `onError` だけを見ているため、アプリ側の `unhandledrejection` ハンドラや Node.js の既定動作 (プロセス終了) を誘発する。

## 現状

- `src/publisher.ts` の `PublisherImpl.sendObject` は、`guardSend` の違反 (END_OF_TRACK 後、および END_OF_GROUP 済み Group への送信) と `validateSendStatusPayload` の違反 (非 NORMAL status に payload / properties がある) で `handleError` を呼んだうえで `Promise.reject` を返す。JSDoc にも「fail-fast で error 通知 + 返値の reject になる」と書かれている
- つまりこの 2 経路は `onError` と reject の両方で通知され、`void` で捨てた reject だけが誰にも観測されない。どちらの経路が通知を担うかの契約が決まっていないことが握り潰しの原因である
- `guardSend` は Publisher が closed のとき同期 throw する。`sendObject` はこれを包んでいないため、この経路は `void` ではなくフレーム処理ループ側の例外になる
- 委譲先 (`src/session/publish.ts` の `publishSendObject`) の失敗は `.catch` が `handleError` を呼んで resolve するため reject しない
- `src/createMediaSubscriber.ts` の `void this.audioContext.resume()` と `void this.videoDecoder?.reset()` には catch が無い。`VideoDecoderWrapper.reset` は `async reset(): Promise<void>` であり、失敗は `onError` にも届かない (`AudioDecoderWrapper` に `reset` は無い)
- 同ファイルの `reconfigureAudioDecoder` / `reconfigureVideoDecoder` は内部で catch して `onError` へ流すため、同型の握り潰しではない

## 設計方針

- 送信系は await するか catch して `onError` へ流す。どの経路が通知を担うのか (reject を捨てるなら `onError` が唯一の通知点、await するなら呼び出し元が受け取る) を JSDoc とコメントで明記する
- `audioContext.resume()` と `videoDecoder.reset()` も catch して `onError` へ流す
- フレーム処理の fire-and-forget 性は変えない。落として良いのは「後続 Object で上書きされる」ことであり「失敗を無視して良い」ことではないため、通知は行う
- `guardSend` の同期 throw を reject に揃えるか、呼び出し側で捕捉するかを決める

## 完了条件

- 送信失敗が `onError` に 1 回だけ届き、unhandled rejection が発生しない
- `src/createMediaPublisher.test.ts` / `src/createMediaSubscriber.test.ts` で固定される (`src/session.test.ts` にある `unhandledRejection` の監視と同じ方式)
- `npx vp check` / `npx vp test --run` が通る

## 解決方法

{未着手}
