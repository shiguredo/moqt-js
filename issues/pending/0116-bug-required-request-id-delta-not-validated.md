# Required Request ID Delta の受信時 MUST 検証が未実装で送信値も常に 0 固定

Created: 2026-05-02
Model: Opus 4.7

## 概要

draft-17 で導入された Required Request ID Delta フィールド (§9.2) はワイヤフォーマット上の追加が `0007-breaking-required-request-id-delta` で完了しているが、

1. 送信側はすべての箇所で `requiredRequestIdDelta: 0n` を固定送信している (依存関係を表現する手段が欠落)
2. 受信側は仕様の MUST 検証 (`2 × Required Request ID Delta > Request ID` のときセッションを `INVALID_REQUIRED_REQUEST_ID` で終了) を一切行っていない

の 2 点が未対応である。

## RFC 根拠

draft-ietf-moq-transport-17 Section 9.2 (Required Request ID):

> Each request that creates state on the receiver carries a Required Request ID Delta that is used to indicate other requests that this request depends on.

> An endpoint MUST close the session with INVALID_REQUIRED_REQUEST_ID if it receives a delta where 2 × Required Request ID Delta exceeds the Request ID.

エラーコード `INVALID_REQUIRED_REQUEST_ID` (0x7) は `src/error.ts:22` に定義されているが、`error.ts` 以外で使われている箇所が存在しない (grep 確認済)。

## 該当箇所

### 送信側 (常に 0 固定)

- `src/session.ts:1111` (PUBLISH_NAMESPACE)
- `src/session.ts:1300` (SUBSCRIBE)
- `src/session.ts:1393` (REQUEST_UPDATE)
- `src/session.ts:1456` (TRACK_STATUS)
- `src/session.ts:1523` (FETCH)
- `src/session.ts:1728` (SUBSCRIBE_NAMESPACE)
- `src/session.ts:2627, 2698` (派生 FETCH 等)

### 受信側 (検証なし)

- `src/message/subscribe.ts:113-120` (SUBSCRIBE)
- `src/message/subscribe.ts:248-252` (REQUEST_UPDATE)
- `src/message/publish.ts` の各 decode
- `src/message/fetch.ts` の各 decode
- `src/message/namespace.ts` の各 decode
- `src/message/trackstatus.ts` の各 decode

すべて `decodeVarint` で読むだけで `2 × delta > requestId` チェックが無い。

## 期待される動作

### 送信側

依存元の Request ID を保持し、送出時に `currentRequestId - dependentRequestId` を計算して `requiredRequestIdDelta` に設定する API を追加する。すべての箇所で 0n 固定にしない。最低限 Joining Fetch のように依存関係が明確なケースは適切な delta を計算する。

### 受信側

制御メッセージループの decode 後、以下を `Subscribe` / `Publish` / `Fetch` / `RequestUpdate` / `Namespace` 系すべてに適用する。

```ts
if (msg.requiredRequestIdDelta > 0n && (msg.requiredRequestIdDelta * 2n) > msg.requestId) {
  closeWithError(SessionErrorCode.INVALID_REQUIRED_REQUEST_ID, ...);
  return;
}
```

加えて delta が指す依存元 Request ID が未完了であれば、当該リクエストの処理を依存完了まで保留するロジックも `0007` のフォローアップとして必要だが、これは別 issue として切り出してもよい。

## 優先度

重大。受信側 MUST 検証が無いため、不正な peer が送ってきた延滞リクエストでセッション状態が壊れる。送信側の常時 0 は機能不足だが互換性ベースでは害はない。

## 追記: draft-18 での削除

draft-ietf-moq-transport-18 で Required Request ID Delta フィールドは
**削除された** (Appendix A.1: "Remove Required Request ID (#1615)")。

これに伴い:

- ワイヤフォーマットから `requiredRequestIdDelta` が除去された
- `INVALID_REQUIRED_REQUEST_ID` (0x7) エラーコードも削除された
- 受信側の MUST 検証も不要になった

したがって本 issue は **draft-18 ベースの moqt-js では実装不要** である。
draft-17 との互換性を維持する必要が生じた場合にのみ再検討する。

## pending にした理由

現在のクライアント専用実装では対応が難しいため。

### 受信検証について

Required Request ID Delta はリクエストメッセージにのみ含まれる。仕様書 Section 9.1 (line 2591-2595):

> Each SUBSCRIBE, PUBLISH, FETCH, SUBSCRIBE_NAMESPACE, PUBLISH_NAMESPACE, REQUEST_UPDATE, and TRACK_STATUS message consumes a Request ID. Only request messages include a Request ID; response messages do not, since they are sent on the same bidirectional stream as the request.

Section 9.2 (line 2603-2604):

> Every request message includes a Required Request ID Delta field that specifies a dependency on a prior request.

moqt-js はクライアント専用実装のため、リクエストメッセージを受信しない。Therefore、受信検証は不要。

### 送信値固定 0 について

現在の実装では依存関係がないため 0 が正しい。将来的に Joining Fetch 等で依存関係を表現する際は別 issue で対応する。
