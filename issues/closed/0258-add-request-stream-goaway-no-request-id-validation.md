# リクエストストリーム上 GOAWAY で Request ID 存在の検証を追加する

- Priority: High
- Created: 2026-06-03
- Model: deepseek-v4-pro
- Completed: 2026-06-03
- Branch: feature/draft-18
- Polished: 2026-06-03

## 目的

リクエストストリーム上の GOAWAY には Request ID フィールドが存在してはならない（Request ID は制御ストリーム上の GOAWAY にのみ存在する）。現在の実装では、リクエストストリーム上の GOAWAY で誤って Request ID が含まれていた場合に何も検知されない。

draft-ietf-moq-transport-18 §10.4 (GOAWAY):

> Request ID: Present only when sent on the control stream.

リクエストストリーム上の GOAWAY に Request ID が含まれているのはプロトコル違反である。

Moqt-rs-private の `src/session/goaway.rs:371-378` では `msg.request_id.is_some()` の場合に PROTOCOL_VIOLATION でセッションを閉じるよう実装されている。

## 優先度根拠

仕様の MUST 要件違反を検出できない。制御ストリーム / リクエストストリームの区別があいまいになり、プロトコル実装の堅牢性が損なわれる。

## 現状

リクエストストリーム上の GOAWAY 受信箇所は 3 箇所:

- `src/session/bidi.ts:534` (`bidiReadRequestStreamMessages` の GOAWAY case)
- `src/session.ts:1845` (namespace stream loop)
- `src/session.ts:2291` (namespace publication stream loop)

いずれも `decodeGoawayPayload(msg.payload)` の結果の `requestId` を全くチェックしていない。

## 設計方針

各リクエストストリーム上の GOAWAY 受信箇所で、`msg.requestId !== null` の場合に PROTOCOL_VIOLATION でセッションを閉じる。共通のバリデーション関数 `validateGoawayOnRequestStream` を新設し、3 箇所に適用する。

```typescript
function validateGoawayOnRequestStream(
  decoded: Goaway,
  closeSession: (error: SessionError) => void,
): boolean {
  if (decoded.requestId !== null) {
    closeSession(
      new SessionError(
        "goaway on request stream must not include request id",
        SessionErrorCode.PROTOCOL_VIOLATION,
      ),
    );
    return false;
  }
  return true;
}
```

## 完了条件

- 全 3 箇所のリクエストストリーム GOAWAY 受信箇所で Request ID 存在チェックが実装されること
- Request ID ありの場合は PROTOCOL_VIOLATION でセッションが閉じられること

## テスト戦略

各 GOAWAY 受信箇所（bidi.ts namespace stream loop, bidi.ts publication stream loop）のテストケースとして:

1. GOAWAY に Request ID が含まれる → PROTOCOL_VIOLATION でセッションクローズ
2. GOAWAY に Request ID がなし → 正常に goawayCallback / reject

## 関連 issue

- #0257: 制御ストリーム上 GOAWAY で Request ID 不在検証（対称的）
- #0259: 同一リクエストストリーム上の重複 GOAWAY 検出

## 解決方法

1. `validateGoawayOnRequestStream` 共通関数を追加する
2. 3 箇所のリクエストストリーム GOAWAY 受信箇所に適用する
3. テストを追加する
