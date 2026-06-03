# GOAWAY の Request ID パリティが送信側・受信側両方で誤っている

- Priority: High
- Created: 2026-06-03
- Model: deepseek-v4-pro
- Branch: feature/draft-18
- Polished: 2026-06-03

## 目的

GOAWAY の Request ID パリティが送信側 (`sendGoaway`) と受信側 (`handleGoaway`) の両方で誤っている。

送信側: クライアント自身の Request ID (偶数パリティ) を送信しているが、GOAWAY の Request ID は peer の Request ID (サーバーの奇数パリティ) である必要がある。
受信側: 受信した GOAWAY の Request ID が奇数であることを期待しているが、サーバーから届く GOAWAY の Request ID はクライアント自身の空間 (偶数パリティ) を指すため、偶数が正しい。

両方の不具合により、サーバー/クライアント間で GOAWAY のパリティチェックに失敗し INVALID_REQUEST_ID (0x4) で接続断になる。

## 優先度根拠

サーバー側が GOAWAY 受信時にパリティチェックを行うと、クライアントからの GOAWAY は INVALID_REQUEST_ID で拒否される。逆に、正当なサーバーからの GOAWAY (偶数 Request ID) をクライアントが INVALID_REQUEST_ID で拒否する。相互運用性に致命的な影響がある。

## 現状

### 送信側 (sendGoaway)

`src/session.ts:2467`:
```typescript
requestId: this.nextRequestId,
```
`this.nextRequestId` はクライアント自身の Request ID (偶数パリティ)。しかし §10.4 の GOAWAY Request ID は "peer Request ID" であり、クライアントから送る場合はサーバーの Request ID 空間 (奇数パリティ) を指すべき。

### 受信側 (handleGoaway)

`src/session.ts:3330`:
```typescript
if (msg.requestId % 2n !== 0n) {
  this.closeWithError(new SessionError(
    `GOAWAY request ID parity mismatch: ${msg.requestId} (expected odd)`,
    SessionErrorCode.INVALID_REQUEST_ID,
  ));
}
```
サーバーから送られる GOAWAY の Request ID はクライアント自身の空間 (偶数パリティ) を指すため、チェックは `% 2n !== 0n` (odd) ではなく `=== 0n` (even でない) が正しい。

draft-ietf-moq-transport-18 §10.4:
> The smallest peer Request ID that was not or might not have been
> processed prior to sending the GOAWAY. If no requests have been
> processed, this is 0 (at a server) or 1 (at a client). If the parity
> of the Request ID does not match the receiver's parity, the endpoint
> MUST close the session with INVALID_REQUEST_ID.

## 設計方針

### 送信側

- クライアントからの GOAWAY は常に `requestId: 1n` とする
- moqt-js はクライアント専用であり、サーバー側の Request ID を追跡する仕組みがないため、最小値 1 を常に使用する

### 受信側

- パリティチェックを `msg.requestId % 2n !== 0n` (odd 期待) から `msg.requestId % 2n === 0n` (even 期待) に修正する
- コメントの `expected odd` を `expected even` に修正する
- クライアントのパリティが even であることをコメントに明記する

## 完了条件

- `sendGoaway()` が `requestId: 1n` を送信する
- `handleGoaway()` のパリティチェックが `msg.requestId % 2n === 0n` で even を期待する
- テストが追加されている
