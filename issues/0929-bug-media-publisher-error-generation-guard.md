# 高レベル publisher の onError が無関係な失敗で落ちる / 旧 session のエラーが届く

- Created: 2026-11-03
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-media-publisher-error-generation-guard
- Polished: {YYYY-MM-DD}

## 目的

`createMediaPublisher` の `onError` の通知条件に 2 つの問題がある。

- `sessionErrorNotifiedDuringStart` は `start()` の実行中に Session エラーが 1 度でも届くと立ち、その後の `start()` 失敗は原因が違っても `notifyStartFailure` で抑止される。Session を閉じない一時的な Session エラー (`sessionNotifyErrorIfActive` 経由の通知) でも立つため、無関係な原因の `start()` 失敗が `onError` に載らない
- `onSessionError` に世代ガードが無い。`onSessionClose` は `startGeneration` で古い通知を捨てるが、`onSessionError` は世代を見ないため、`stop()` / `close()` の後や別 session に切り替わった後に旧 session のループが `closeWithError` を呼ぶと `onError` が発火する

## 現状

- `src/createMediaPublisher.ts` の `notifyStartFailure` は `isErrorNotifiedByPublisher(error)` または `sessionErrorNotifiedDuringStart` で通知を抑止する
- `sessionErrorNotifiedDuringStart` は `connectToServer` の `onSessionError` で `startInFlight` のときに立てる
- `sessionNotifyErrorIfActive` は Session を閉じない経路でも `callbacks.error` を呼ぶ
- `connectToServer` の `onSessionClose` は `startGeneration` を比較して古い通知を捨てるが、`onSessionError` は比較しない
- `src/createMediaSubscriber.ts` にも同種の配線があるか確認する

## 設計方針

- `sessionErrorNotifiedDuringStart` を「同じ原因か」で判定できるようにする (error の由来を記録するなど)。または Session エラー通知済みでも `start()` 失敗自体は通知する設計に整理し、二重通知にならない境界を明示する
- `onSessionError` にも `onSessionClose` と同じ世代ガードを追加する
- subscriber 側に同じ問題があれば同時に直す (1 issue = 1 目的として「高レベル publisher / subscriber の onError の通知条件」に絞る)

## 完了条件

- `start()` 中に無関係な Session エラーが届いても、後続の `start()` 失敗が `onError` に通知される
- `stop()` / `close()` の後や別 session に切り替わった後に、旧 session のエラーが `onError` に届かない
- 上記 2 点を `src/createMediaPublisher.test.ts` (と必要なら subscriber のテスト) で固定する
- `vp check` と `vp test --run` が通る

`CHANGES.md` は MOQT RFC ドラフト中のため更新しない (`CODEBASE.md` の特別ルール)。

## 参照

- `src/createMediaPublisher.ts` の `notifyStartFailure` / `connectToServer` / `onSessionError` / `onSessionClose` / `handleSessionClose`
- `src/session/lifecycle.ts` の `sessionNotifyErrorIfActive` / `sessionCloseWithError`
- `src/createMediaSubscriber.ts` の接続処理
- `src/createMedia/connect.ts`
