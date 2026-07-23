# リクエストストリームの Graceful Closure に追従する (draft-19 追従)

- Priority: Medium
- Created: 2026-07-07
- Model: Fable 5
- Branch: feature/change-draft-19-graceful-request-stream-closure
- Polished: 2026-07-23

## 目的

draft-ietf-moq-transport-19 に Section 3.3.2 (Graceful Request Stream Closure) が新設され、リクエストストリーム上の FIN と RESET_STREAM / STOP_SENDING のセマンティクスが規定された。変更履歴は Appendix A.1 `#1698` ("Define FIN vs. RST/STOP_SENDING semantics on request streams")。

draft-19 Section 3.3.2 (Graceful Request Stream Closure):

> A FIN only indicates that an endpoint will send no further messages
> in that direction; it is not a request cancellation. An endpoint
> MUST NOT send a FIN on a direction of a request stream until it has
> sent all required messages on that direction for its request type.
> In particular, an endpoint sending a response to a request MUST send
> the corresponding response message, and the publisher of an
> Established subscription MUST send PUBLISH_DONE, before sending a
> FIN. ... An endpoint that receives a FIN before all required messages
> have arrived treats the request as failed.

draft-19 Section 3.3.3 (Request Cancellation and Rejection):

> Implementations cancel a request by abruptly terminating any
> directions of the stream that are still open, using RESET_STREAM for
> a direction they are sending and STOP_SENDING for a direction they
> are receiving.

節番号の繰り下がり:

| draft-18 | draft-19 |
| --- | --- |
| (なし) | 3.3.2 Graceful Request Stream Closure (新設) |
| 3.3.2 Request Cancellation and Rejection | 3.3.3 Request Cancellation and Rejection |
| 3.3.3 Stream Reset Error Codes | 3.3.4 Stream Reset Error Codes |

## 優先度根拠

調査時点で moqt-js は主要なセマンティクス (応答前 FIN の失敗扱い、送信方向 RESET / 受信方向 STOP_SENDING の分離) を既に満たしている。ただし「Established なサブスクリプションの publisher は FIN の前に PUBLISH_DONE を送らなければならない (MUST)」の順序保証が検証されておらず、違反していれば準拠問題になるため Medium。

## 現状

- `src/session/bidi.ts`: 応答受信前の FIN を失敗扱い。Section 3.3.2 の「FIN before required messages = failed」に整合
- `src/session/bidi.ts` (`bidiCancelSubscription` / `bidiCancelFetch`): `readable.cancel()` (STOP_SENDING 相当) + `writer.abort()` (RESET_STREAM 相当) で方向別に終了。Section 3.3.3 に整合
- 正常クローズは `writer.close()` (FIN)
- publisher 側で PUBLISH_DONE 送信と FIN 送信の順序を保証しているかは未検証
- `src/subscriber.ts` / `src/fetcher.ts`: STOP_SENDING 関連の draft-18 引用コメント (節番号が 3.3.3 / 3.3.4 に変わる)

## 設計方針

- publisher が Established なサブスクリプションのリクエストストリームに FIN を送るパスをすべて洗い出し、PUBLISH_DONE 送信 → FIN の順序を保証する (Section 3.3.2)
- FIN と PUBLISH_DONE の順序を検証するテストを追加する
- 受信側で「必要なメッセージが揃う前の FIN」を失敗扱いする経路が全リクエスト種別 (SUBSCRIBE / FETCH / TRACK_STATUS / PUBLISH / SUBSCRIBE_NAMESPACE / SUBSCRIBE_TRACKS / PUBLISH_NAMESPACE) で一貫しているかを確認する
- 仕様参照コメントを draft-19 Section 3.3.2 / 3.3.3 / 3.3.4 に更新する

## 完了条件

- publisher がサブスクリプション終了時に PUBLISH_DONE → FIN の順で送ることをテストで確認していること
- 応答前 FIN の失敗扱いが全リクエスト種別で一貫していること
- lint / build / typecheck / 既存テストが通ること
