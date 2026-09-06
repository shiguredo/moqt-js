# Publisher の stop / 再 start と start 失敗時の後片付け漏れ

- Created: 2026-09-06
- Completed: YYYY-MM-DD
- Branch: feature/fix-publisher-lifecycle
- Polished: 2026-09-06

## 目的

起動のたびにエンコーダとフォールバック用 video 要素 (`src/frameSource.ts` の `createVideoFrameSourceWithCallback` が生成) がリークし、`start` 失敗時に session が開いたまま残る。ライフサイクル全体で後片付けする必要がある。

## 現状

- `src/createMediaPublisher.ts` の `stop` は reader 取消と音声・映像 Publisher の `done` のみで、`catalogPublisher` の `done`、`session` の close、エンコーダ・`audioTrackProcessor`・`videoFrameSource` の破棄がない。再 `start` 時の `connectToServer` / `createPublishers` / `setupEncoders` は旧インスタンスを破棄せず上書きする。
- `close` は reader 取消・`videoFrameSource` 破棄・encoders close・`session` close を行うが、`audioTrackProcessor` の破棄と `catalogPublisher` の `done` がない。
- `start` の `catch` は通知と再 throw のみで、失敗点別の残留 (`connect` 後は session、`createPublishers` 後は session + Publishers、`setupEncoders` 後は encoders / processors / readers まで) を巻き戻さない。`createPublishers` / `setupEncoders` 内部の部分成功も同様である。

## 設計方針

1. `stop` を再 `start` 可能な完全停止にする。音声・映像 Publisher に加え `catalogPublisher` の `done`、encoders / `videoFrameSource` の `close`、`audioTrackProcessor` 由来 reader を含む reader の `cancel` を行い参照を `null` 化する。`session` は閉じて再 `start` 時に再接続する (再利用しない)。`close` は `stop` を内包し、以後 `start` 不可の終端とする。二重破棄は冪等操作のみで行う。
2. `start` 失敗時は確保済みを逆順に巻き戻す (`setupEncoders` 後は方針 1 と同一破棄、`createPublishers` 後は Publishers の `done`、`connect` 後は `session.close`。内部の部分成功も同順)。失敗後の state は変えず、再 `start` 可能にする。

## 完了条件

- start / stop 繰り返し後に encoder・source・reader・Publisher・session が残存しないこと (参照 null と `state` で検証)。
- `start` 失敗時に確保済みリソースが巻き戻り、再 `start` できること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。
