# notifyGoaway が close 後や旧セッションの遅延 GOAWAY を通知し得る

- Created: 2026-11-03
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-goaway-notify-state-guard
- Polished: {YYYY-MM-DD}

## 目的

高レベル API の `notifyGoaway` は Session の状態や世代を見ずに `onGoaway` を呼ぶ。そのため `close()` / `stop()` の完了後や、旧セッションのコールバックが遅延して届いた場合にも `onGoaway` が呼ばれ得る。docs と JSDoc は「`onGoaway` の後に `onClose` が続くことがある」と書くが、`onClose` の後に `onGoaway` が届くことは契約に無く、アプリが再接続を二重に始める恐れがある。

## 現状

- `src/createMediaSubscriber.ts` / `src/createMediaPublisher.ts` の `notifyGoaway` は `lastGoawayUri` と比較するだけで、state や `sessionGeneration` を見ない
- `connectToServer` は接続の開始時に `lastGoawayUri` を戻すが、旧セッションのコールバックを識別しない
- 低レベルの制御ループは `await reader.read()` の後で状態を再確認しないため、close 中に読めた GOAWAY が `onClose` の後に届く余地がある
- テストで `publisher.close()` の後に `notifySessionGoaway` を呼ぶと `onGoaway` が呼ばれることを確認済み

## 設計方針

`notifyGoaway` の入口で状態と世代を確認し、終端状態や旧世代の通知を捨てる。

- `this.state` が終端 (`"closed"`) なら捨てる
- `connectToServer` の `startGeneration` を `onSessionGoaway` の閉包とリクエストストリームの callbacks に捕捉し、現在の世代と一致しない通知を捨てる
- 捨てた理由を debug 記録に残すかを決める (低レベルの `namespaceNotifyError` は記録する)
- close 後にも通知が届き得ることを契約に残す場合は、docs と JSDoc を更新する

## 完了条件

- close 後と旧世代の GOAWAY が `onGoaway` に届かない (または届き得る契約が docs に明記されている)
- 現行の接続での GOAWAY の通知と抑止は変わらない
- 上記をテストで固定する
- `vp check` と `vp test --run` が通る

`CHANGES.md` は MOQT RFC ドラフト中のため更新しない (`CODEBASE.md` の特別ルール)。

## 参照

- `src/createMediaSubscriber.ts` / `src/createMediaPublisher.ts` の `notifyGoaway` / `connectToServer` / `handleSessionClose`
- `src/session/lifecycle.ts` の制御ループと `sessionHandleGoaway`
- `docs/HIGH_LEVEL_API.md` の「GOAWAY の扱い」
- `src/session/publicTypes.ts` の `ConnectCallbacks.goaway`
