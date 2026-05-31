# Stream Reset エラーコードを全リクエストストリームに一般化する

Created: 2026-05-13
Model: Opus 4.7

## 概要

draft-18 で Stream Reset エラーコードが再編成され、全リクエストストリームに対して統一されたコード体系が導入された。
draft-17 での DataStreamErrorCode (Subgroup Stream 用のエラーコード) が拡張・再構成されている。

> INTERNAL_ERROR (0x0): An implementation specific error.
> CANCELLED (0x1): The stream was cancelled by either endpoint.
> DELIVERY_TIMEOUT (0x2): A delivery timeout (Section 8) was exceeded for this stream.
> SESSION_CLOSED (0x3): The session is being closed.
> GOING_AWAY (0x4): The endpoint is rejecting this request because it has sent or received a GOAWAY.
> TOO_FAR_BEHIND (0x5): The corresponding subscription has exceeded the publisher's resource limits ...
> UNKNOWN_OBJECT_STATUS (0x6): In response to a FETCH, the publisher is unable to determine the status ...
> EXPIRED_AUTH_TOKEN (0x7): The authorization token for the request has expired.
> EXCESSIVE_LOAD (0x9): The endpoint is overloaded and is resetting this stream.
> MALFORMED_TRACK (0x12): A relay publisher detected that the track was malformed ...
>
> -- draft-ietf-moq-transport-18 §3.3.3 (Stream Reset Error Codes)

> INTERNAL_ERROR (0x0): An implementation specific or generic error occurred.
> UNAUTHORIZED (0x1): The subscriber is no longer authorized to subscribe to the given track.
> TRACK_ENDED (0x2): The track is no longer being published.
> SUBSCRIPTION_ENDED (0x3): The publisher reached the end of an associated subscription filter.
> GOING_AWAY (0x4): The subscriber or publisher issued a GOAWAY message.
> TOO_FAR_BEHIND (0x5): The publisher's queue of objects to be sent to the given subscriber exceeds its implementation defined limit.
> EXPIRED (0x6): The publisher reached the timeout specified in SUBSCRIBE_OK.
> UPDATE_FAILED (0x8): REQUEST_UPDATE failed on this subscription (see Section 10.9).
> EXCESSIVE_LOAD (0x9): The publisher is overloaded and is terminating the subscription.
> MALFORMED_TRACK (0x12): A relay publisher detected that the track was malformed ...
>
> -- draft-ietf-moq-transport-18 §10.11 (PUBLISH_DONE)

## 変更内容

- draft-18 §3.3.3 の新しいエラーコード体系に合わせて `DataStreamErrorCode` を更新する
- `GOING_AWAY` (0x4), `UNKNOWN_OBJECT_STATUS` (0x6), `EXPIRED_AUTH_TOKEN` (0x7) を追加する
- `PublishDoneStatusCode` が draft-18 §10.11 のコードと一致していることを確認する

## 該当ファイル

| ファイル              | 変更内容                                                    |
| --------------------- | ----------------------------------------------------------- |
| `src/error.ts:96-115` | `DataStreamErrorCode` を draft-18 §3.3.3 と照合する         |
| `src/error.ts:78-89`  | `PublishDoneCode` を draft-18 §10.11 と照合する             |
| `src/session.ts`      | Stream reset 時のエラーコード使用箇所を draft-18 に合わせる |

## テスト

- `DataStreamErrorCode` / `PublishDoneCode` の値が draft-18 と一致することを確認する
