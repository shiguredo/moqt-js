# セッション close と done() の並行実行で close 失敗が誤って PROTOCOL_VIOLATION に昇格する

- Created: 2026-08-10
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-done-session-close-race
- Polished: {YYYY-MM-DD}

## 目的

`session.close()` (src/session.ts) と `publisher.done()` の並行実行で、`publishSendPublishDone` の close 失敗が PROTOCOL_VIOLATION に誤昇格し、`callbacks.error` に誤った違反通知が流れる経路を塞ぐ。

## 現状

- `session.close()` は sessionState を同期で "closed" にしてから、fire-and-forget で保持中の request stream writer を `abortWriterSafely` (src/session.ts) により abort する。
- `publishSendPublishDone` (src/session/publish.ts) は issue 0370 で sessionState ガード (closed なら return) を追加済み。ただし、これは「チェック時点で既に closed」の場合のみ有効であり、ガード通過後に session.close() の abort が走る並行レースは防げない。
- レース成立時、write / close は abort 起因のエラー (source なし) で reject し、close 失敗が PROTOCOL_VIOLATION に昇格して `closeWithError` → `callbacks.error` に通知される。セッションは既に閉じているため、この通知は誤報である。
- issue 0370 の「ピア FIN 後の requestStreams 保持」により、done() が実際に write / close を実行する機会が増え、発現面が広がった。

## 設計方針

- `publishSendPublishDone` の closeWithError 呼び出し前に sessionState を再確認する、または abort 起因の失敗 (ストリームが既に閉じている状態) を非昇格にする判定を追加する。
- セッション終了後の送信試行をガードする既存の sessionState チェック (issue 0370 で追加) と整合させる。

## 完了条件

- session.close() と publisher.done() を並行実行しても、callbacks.error に PROTOCOL_VIOLATION が通知されないこと。
- セッションが正常に閉じること。

## 解決方法

未着手。
