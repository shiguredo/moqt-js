# クライアント送信 GOAWAY の Request ID パリティが誤っている

- Priority: High
- Created: 2026-06-03
- Model: deepseek-v4-pro
- Branch: feature/draft-18

## 目的

`sendGoaway()` がクライアント自身の Request ID 空間 (偶数パリティ) の値を送信しているが、仕様が要求する GOAWAY の Request ID は peer Request ID (サーバーの Request ID 空間、奇数パリティ) である。このパリティ不一致によりサーバー側で INVALID_REQUEST_ID エラーが発生し接続断になる可能性がある。

## 優先度根拠

サーバー側が GOAWAY 受信時にパリティチェックを行うと INVALID_REQUEST_ID (0x4) で接続断になる相互運用性問題。

## 現状

`src/session.ts:2467`:
```typescript
const payload = encodeGoawayPayload({
  type: MessageType.GOAWAY,
  newSessionUri: "",
  timeout: goawayTimeout,
  requestId: this.nextRequestId,
});
```

`this.nextRequestId` はクライアント自身の Request ID (偶数パリティ) である。

draft-ietf-moq-transport-18 §10.4:
> The smallest peer Request ID that was not or might not have been
> processed prior to sending the GOAWAY. If no requests have been
> processed, this is 0 (at a server) or 1 (at a client). If the parity
> of the Request ID does not match the receiver's parity, the endpoint
> MUST close the session with INVALID_REQUEST_ID.

## 設計方針

- クライアントからの GOAWAY は常に Request ID = 1n または受信済みの最大リクエスト ID + 2n を計算する実装に修正する
- moqt-rs-private の実装を参考にする

## 完了条件

- クライアント送信 GOAWAY の Request ID が奇数パリティ (1 または peer の未処理最小 ID) になっている
- テストが追加されている
