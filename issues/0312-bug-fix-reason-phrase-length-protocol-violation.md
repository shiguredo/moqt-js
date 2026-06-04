# decodeRequestErrorPayload / decodePublishDonePayload の Reason Phrase 長超過を ProtocolViolationError に是正する

- Priority: Medium
- Created: 2026-06-05
- Model: Opus 4.8
- Branch: feature/fix-reason-phrase-length-protocol-violation
- Reporter: @voluntas

## 目的

`decodeRequestErrorPayload` と `decodePublishDonePayload` は Reason Phrase 長が上限超過のときプレーンな `Error` を throw している。仕様は PROTOCOL_VIOLATION を MUST で要求しているため、`ProtocolViolationError` を throw するよう是正する。これにより #0298 / #0311 で整備した受信ループの `ProtocolViolationError` ハンドリングが Reason Phrase 長超過にも効くようになる。

## 優先度根拠

draft-ietf-moq-transport-18 §1.4.4 は Reason Phrase Length について明示的に MUST を規定している。

> The reason phrase length has a maximum value of 1024 bytes. If an endpoint receives a length exceeding the maximum, it MUST close the session with a PROTOCOL_VIOLATION

現状はプレーンな `Error` を throw するため、受信ループの catch (#0298 / #0311 で `ProtocolViolationError` のみ `PROTOCOL_VIOLATION` 化する設計) では捕捉されず、セッションが閉じられない MUST 違反となる。ただし発火条件が「Reason Phrase が 1024 バイト超過」という比較的稀かつ敵対的な入力に限られ、現状でも当該ストリーム / サブスクリプションはローカルにクローズされるため、影響範囲は #0298 / #0311 (Redirect・GOAWAY URI など常用経路) より狭い。よって Medium。

## 現状

同一モジュール内で MUST 違反の表現が不整合になっている。`decodeRequestErrorPayload` は GOAWAY URI 長超過 (`src/message/session.ts:234`) や Redirect 後続データ (`:395` / `:408`) には `ProtocolViolationError` を使うのに、Reason Phrase 長超過だけプレーン `Error` を使っている。

```typescript
// src/message/session.ts:379-382 (decodeRequestErrorPayload)
if (Number(reasonLen) > MAX_REASON_PHRASE_LENGTH) {
  throw new Error(
    `reason phrase length exceeds maximum: ${reasonLen} > ${MAX_REASON_PHRASE_LENGTH}`,
  );
}
```

```typescript
// src/message/publish.ts:185-188 (decodePublishDonePayload)
if (Number(reasonLen) > MAX_REASON_PHRASE_LENGTH) {
  throw new Error(
    `reason phrase length exceeds maximum: ${reasonLen} > ${MAX_REASON_PHRASE_LENGTH}`,
  );
}
```

`MAX_REASON_PHRASE_LENGTH` は `src/message/parameter.ts:64` で `1024` と定義されており、仕様の上限値と一致している。

これらの decode 関数は `bidiReadRequestStreamMessages` (#0298 で修正)・namespace 系ループ (#0311 で修正予定) から呼ばれるが、プレーン `Error` のため `toProtocolViolationSessionError` の `instanceof ProtocolViolationError` 判定に該当せず、セッションは閉じられない。

## 仕様根拠

draft-ietf-moq-transport-18:

- **§1.4.4 (Reason Phrase Structure)**: "The reason phrase length has a maximum value of 1024 bytes. If an endpoint receives a length exceeding the maximum, it MUST close the session with a PROTOCOL_VIOLATION"
- **§3.5 (Termination)**: PROTOCOL_VIOLATION (0x3) の定義。

参考 URL: https://www.ietf.org/archive/id/draft-ietf-moq-transport-18.html#section-1.4.4

## 設計方針

両 decode 関数の Reason Phrase 長超過 throw を `new Error(...)` から `new ProtocolViolationError(...)` に変更する。エラーメッセージは現状を維持する (期待値と実際値を含む英語、末尾ピリオドなし)。

他にも Reason Phrase を読む decode 関数が同じプレーン `Error` パターンを持つ場合は、横断検索して同様に是正する。

是正後、受信ループ側の修正なしで #0298 / #0311 のハンドリングが効くようになる。

## 完了条件

- `decodeRequestErrorPayload` / `decodePublishDonePayload` の Reason Phrase 長超過が `ProtocolViolationError` を throw する
- Reason Phrase を読む他の decode 関数も同じ是正がされている (横断確認の結果を記載する)
- Reason Phrase 長超過時に `ProtocolViolationError` が throw されることを検証する単体テストが追加されている
- 既存の全テストが PASS する
- `CHANGES.md` に `[FIX]` エントリを追記する

## 解決方法

(対応時に記載する)
