# PUBLISH_DONE を制御ストリームではなく双方向ストリームで送信する

Created: 2026-03-29
Model: Claude Opus 4.6

## 問題

`src/session.ts` の `sendPublishDone()` が `sendControlMessage()` で制御ストリームに送信している。
draft-17 では PUBLISH_DONE から Request ID が削除されており、サブスクリプションの特定は双方向ストリームのコンテキストに依存する。

## 根拠

refs/moq/draft-ietf-moq-transport-17.txt Section 9.13 (line 3724-3732):

> A publisher sends a PUBLISH_DONE message as the final message before
> closing the subscription's bidi stream to indicate it is done
> publishing Objects for that subscription.

## 再現手順

1. Publisher が `sendPublishDone()` を呼び出す
2. PUBLISH_DONE が制御ストリームに送信される
3. 受信側はどのサブスクリプションに対する PUBLISH_DONE か特定できない

## 期待される動作

PUBLISH_DONE はサブスクリプションの双方向ストリーム上で送信されるべき。

Completed: 2026-03-29

## 解決方法

`sendPublishDone()` を `sendControlMessage()` (制御ストリーム) から `requestStreams` の双方向ストリームへの書き込みに変更した。
