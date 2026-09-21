# createMediaSubscriber の stop() がリソースを解放せず再開もできない

- Created: 2026-09-21
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-media-subscriber-stop-lifecycle
- Polished: {YYYY-MM-DD}

## 目的

`src/createMediaSubscriber.ts` の `stop` は購読を解除するだけで、AudioContext / デコーダ / MediaStreamTrackGenerator を保持したまま `"stopped"` になる。`start` は `"created"` 以外から呼ぶと throw するため再開できない。`src/createMediaPublisher.ts` の `stop` は `disposeAllResources` で解放し `"stopped"` から再 start できるため、高レベル API として非対称である。

## 現状

- `src/createMediaSubscriber.ts` の `stop` は `catalogSubscriber` / `audioSubscriber` / `videoSubscriber` を unsubscribe して `setState("stopped")` するだけである
- `src/createMediaSubscriber.ts` の `close` は `audioDecoder` / `videoDecoder` / `videoWriter` / `audioContext` / `session` を解放して `"closed"` にする。解放処理はここにしかない
- `src/createMediaSubscriber.ts` の `start` は `this.currentState !== "created"` で throw するため、`"stopped"` から再開できない
- `src/createMediaPublisher.ts` の `stop` は `disposeAllResources()` を呼び、`start` は `"created"` と `"stopped"` の両方を受け付ける。JSDoc にも「再 start 可能な完全停止であり、確保済みを残さない」と書かれている
- `docs/HIGH_LEVEL_API.md` の MediaSubscriber の状態遷移図は `stopped` を終端として描いており、`stopped` から出る辺が無い

## 設計方針

- (A) `stop` で解放するか、(B) `stop` を一時停止として再開可能にするかを決める。(A) は `close` と同じ解放を `stop` で行い `"stopped"` から再 start できるようにする。(B) はリソースを保持したまま再開する経路を `start` に足す
- どちらを選んでも `docs/HIGH_LEVEL_API.md` の状態遷移と `stop` / `start` / `close` の JSDoc を実装に合わせて更新し、`"stopped"` の意味 (再開可能か終端か) を明記する
- (A) を選ぶ場合は `close` との重複を避けて解放処理を 1 箇所にまとめる。`audioContext` と `MediaStreamTrackGenerator` は再開時に作り直す必要がある
- 非同期の解放処理と `setState` の順序は `src/createMediaPublisher.ts` の `stop` に揃える

## 完了条件

- 状態遷移とリソースの扱いが `docs/HIGH_LEVEL_API.md`・実装・テストで一致する
- `"stopped"` の意味 (再開可能か終端か) が JSDoc と docs に明記される
- `src/createMediaSubscriber.test.ts` で固定される
- `npx vp check` / `npx vp test --run` が通る

## 解決方法

{未着手}
