# 制御ストリーム上 GOAWAY で Request ID 不在の検証を追加する

- Priority: High
- Created: 2026-06-03
- Model: deepseek-v4-pro
- Branch: feature/draft-18
- Polished: 2026-06-03

## 目的

制御ストリーム上で受信する GOAWAY メッセージの Request ID フィールドは MUST で存在が要求されているが、現在の実装では `requestId === null` の場合に何も検証せず素通ししている。PROTOCOL_VIOLATION でセッションを閉じるよう修正する。

draft-ietf-moq-transport-18 §10.4 (GOAWAY):

> Request ID: Present only when sent on the control stream.
> ...
> If the parity of the Request ID does not match the receiver's parity, the
> endpoint MUST close the session with INVALID_REQUEST_ID.

Moqt-rs-private の `src/session/goaway.rs:290-297` では `msg.request_id.is_none()` の場合に PROTOCOL_VIOLATION でセッションを閉じるよう実装されている。

## 優先度根拠

仕様の MUST 要件違反を検出できない。制御ストリーム上のプロトコル完全性に関わる致命的な欠落。

## 現状

- `src/session.ts` の `handleGoaway` では `requestId !== null` のときだけパリティチェックを行い、`requestId === null` の場合は何もせず処理を継続する
- `decodeGoawayPayload` はストリーム種別を意識しない低レベルデコーダであり、残りバイトがなければ requestId=null を返す。これは正常な動作であり、呼び出し元がストリーム種別に応じたバリデーションを追加する責務を負う

## 設計方針

制御ストリーム上の GOAWAY で `msg.requestId === null` の場合、PROTOCOL_VIOLATION でセッションを閉じる。不在チェックは既存のパリティチェックより前に配置する（不在はパリティ異常より根本的な違反）。

```typescript
if (msg.requestId === null) {
  this.closeWithError(
    new SessionError(
      "goaway on control stream must include request id",
      SessionErrorCode.PROTOCOL_VIOLATION,
    ),
  );
  return { error: "GOAWAY on control stream missing Request ID" };
}
```

## 完了条件

- 制御ストリーム上の GOAWAY で Request ID が null の場合、PROTOCOL_VIOLATION でセッションが閉じられること
- パリティチェックより前に不在チェックが実行されること
- テストを追加すること

## テスト戦略

`handleGoaway` のテストケースを新規に追加する。

1. 制御ストリーム上の GOAWAY で Request ID 不在 → PROTOCOL_VIOLATION でセッションが閉じられること
2. 制御ストリーム上の GOAWAY で Request ID 存在かつパリティ正常 → 正常に処理されること（リグレッション防止）

## 関連 issue

- #0258: リクエストストリーム上 GOAWAY で Request ID 存在の検証（対称的なバリデーション）
- #0259: 同一リクエストストリーム上の重複 GOAWAY 未検出を修正

## 解決方法

1. `src/session.ts` の `handleGoaway` に `requestId === null` チェックを追加する（パリティチェックよりも前）
2. `handleGoaway` のテストを追加する
