# 同一リクエストストリーム上の重複 GOAWAY 未検出を修正する

- Priority: High
- Created: 2026-06-03
- Model: deepseek-v4-pro
- Branch: feature/draft-18
- Polished: 2026-06-03
- Relations: #0257 (制御ストリーム GOAWAY 検証), #0258 (リクエストストリーム GOAWAY 検証)

## 目的

単一のリクエストストリーム上で 2 回以上の GOAWAY を受信した場合、仕様では MUST で PROTOCOL_VIOLATION によりセッションを閉じることが規定されているが、現在の実装では重複検出が行われていない。

draft-ietf-moq-transport-18 §10.4 (GOAWAY):

> The endpoint MUST close the session with a PROTOCOL_VIOLATION
> (Section 3.5) if it receives more than one GOAWAY on the control
> stream or on a single request stream.

Moqt-rs-private の `src/session/goaway.rs:360-367` では `self.goaway.request_stream_received` Set でリクエストストリームごとに GOAWAY 受信を追跡し、重複時は PROTOCOL_VIOLATION で閉じている。

## 優先度根拠

仕様の MUST 要件違反を検出できない。プロトコル完全性に関わる致命的な欠落。

## 現状

- 制御ストリーム上の重複 GOAWAY は `src/session.ts:3208-3215` の `handleGoaway` で正しく検出されている
- リクエストストリーム上の GOAWAY 受信箇所（全 3 箇所）には重複検出ロジックが一切ない:
  - `src/session/bidi.ts:528-548` (`bidiReadRequestStreamMessages` の GOAWAY case)
  - `src/session.ts:1842-1858` (namespace stream loop)
  - `src/session.ts:2290-2301` (namespace publication stream loop)
- `bidiReadRequestStreamMessages` では GOAWAY 受信後に `return` するため同一チャンク内に 2 つの GOAWAY が含まれるケースでは事実上 2 つ目が処理されないが、明示的な PROTOCOL_VIOLATION 送出はない

## 設計方針

リクエストストリーム単位で GOAWAY 受信済みフラグを管理する。SessionImpl に `private goawayReceivedOnRequestStreams = new Set<bigint>()` を追加し、重複時は PROTOCOL_VIOLATION でセッションを閉じる。3 箇所（bidi.ts の bidiReadRequestStreamMessages / session.ts の namespace stream loop / namespace publication stream loop）で共通の検出文言を使用する。

```typescript
if (this.goawayReceivedOnRequestStreams.has(requestId)) {
  this.closeWithError(
    new SessionError(
      "received duplicate goaway on request stream",
      SessionErrorCode.PROTOCOL_VIOLATION,
    ),
  );
  return;
}
this.goawayReceivedOnRequestStreams.add(requestId);
```

## 完了条件

- 各リクエストストリーム上で GOAWAY 重複受信時に PROTOCOL_VIOLATION でセッションが閉じられること
- 制御ストリームの重複検出 (`handleGoaway`) と一貫した検出ロジックであること

## テスト戦略

1. 初回 GOAWAY → 正常に goawayCallback / reject
2. 2 回目 GOAWAY → PROTOCOL_VIOLATION でセッションクローズ

## 解決方法

1. `SessionImpl` に `goawayReceivedOnRequestStreams: Set<bigint>` を追加する
2. 3 箇所のリクエストストリーム GOAWAY 受信箇所で重複チェックを追加する
3. テストを追加する
