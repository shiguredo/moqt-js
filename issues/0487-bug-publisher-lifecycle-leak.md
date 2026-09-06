# Publisher の stop / 再 start と start 失敗時の後片付け漏れ

- Created: 2026-09-06
- Completed: YYYY-MM-DD
- Branch: feature/fix-publisher-lifecycle
- Polished: YYYY-MM-DD

## 目的

起動のたびにエンコーダとフォールバック用 video 要素がリークし、`start` 失敗時に session が開いたまま残る。ライフサイクル全体で後片付けする必要がある。

## 現状

- `src/createMediaPublisher.ts` の `stop` はリーダー取消と `publisher.done` のみで、エンコーダ・`audioTrackProcessor`・`videoFrameSource` を閉じない。再 `start` 時の `setupEncoders` は旧インスタンスを上書きする。
- `start` の `catch` は通知と再 throw のみで、接続済み session や発行済み Publisher が残る。

## 設計方針

1. `stop` でエンコーダ・プロセッサ・フレームソースを閉じる (`close` との役割分担を明確化)。
2. `start` 失敗時に確保済みリソースを巻き戻す。

## 完了条件

- 繰り返し start / stop でリソースが残存しないこと。`start` 失敗時に session 等が残らないこと。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。
