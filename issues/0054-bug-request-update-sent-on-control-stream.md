# REQUEST_UPDATE が制御ストリームで送信されている

Created: 2026-03-29
Model: Opus 4.6

## 概要

REQUEST_UPDATE メッセージが制御ストリーム上で送信されているが、draft-17 ではリクエストと同じ双方向ストリーム上で送信することが要求されている。

## RFC 根拠

draft-ietf-moq-transport-17 Section 9.10 REQUEST_UPDATE:

> The sender of a request (SUBSCRIBE, PUBLISH, FETCH, PUBLISH_NAMESPACE, SUBSCRIBE_NAMESPACE) can later send a REQUEST_UPDATE on the same bidi stream as the request to modify it. A subscriber can also send REQUEST_UPDATE to modify parameters of a subscription established with PUBLISH.
>
> The receiver of a REQUEST_UPDATE MUST respond with exactly one REQUEST_OK or REQUEST_ERROR message indicating if the update was successful.

現在の実装 (`src/session.ts` 行 2255) では `sendControlMessage` を使って制御ストリーム上に送信している。RFC はリクエストと同じ双方向ストリーム上で送信することを明確に要求しており、これはプロトコル違反である。

## 該当箇所

- `src/session.ts` 行 2255: `sendControlMessage` で REQUEST_UPDATE を送信

## 修正方針

SUBSCRIBE / PUBLISH のリクエストに使用した双方向ストリームを保持し、REQUEST_UPDATE をそのストリーム上で送信するように変更する。
