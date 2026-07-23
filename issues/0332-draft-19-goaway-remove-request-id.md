# GOAWAY メッセージから Request ID フィールドを削除する (draft-19 追従)

- Priority: High
- Created: 2026-07-07
- Model: Fable 5
- Branch: feature/change-draft-19-goaway-remove-request-id
- Polished: 2026-07-23

## 目的

draft-ietf-moq-transport-19 Section 10.4 (GOAWAY) のワイヤフォーマットから Request ID フィールドが削除された。変更履歴は Appendix A.1 `#1623` ("Remove Request ID from GOAWAY")。

draft-19 Section 10.4 のワイヤフォーマット:

```
GOAWAY Message {
  Type (vi64) = 0x10,
  Length (16),
  New Session URI Length (vi64),
  New Session URI (..),
  Timeout (vi64),
}
```

Timeout の後にフィールドは続かない。draft-18 にあった末尾の `[Request ID (vi64)]` と、「制御ストリーム上の GOAWAY には Request ID が必須で、パリティ不一致は INVALID_REQUEST_ID」という規定は draft-19 では存在しない。

moqt-js は draft-18 準拠で Request ID を送受信しているため、draft-19 準拠ピアとの GOAWAY 交換で相互運用が壊れる。

## 優先度根拠

ワイヤフォーマットの破壊的変更であり実害が明確なため High。

- 受信: draft-19 準拠ピアは Request ID なしの GOAWAY を送る。moqt-js は制御ストリーム上の GOAWAY に Request ID が無いとして PROTOCOL_VIOLATION でセッションを切断する
- 送信: moqt-js は常に Request ID を付けて送るため、draft-19 準拠ピアには余分な末尾バイトとして解釈され拒否され得る

## 現状

- `src/message/session.ts:39-52`: `Goaway` 型が `requestId: bigint | null` を保持
- `src/message/session.ts:197-216`: `encodeGoawayPayload` が `requestId !== null` のとき Request ID を追記
- `src/message/session.ts:225-256`: `decodeGoawayPayload` が Timeout 後の残バイトを Request ID として読む
- `src/message/session.ts:258-274`: `isValidGoawayRequestIdParity`
- `src/session.ts:2579-2620`: `goaway()` 送信。常に `requestId: 1n` を付与
- `src/session.ts:3532-3575`: `handleGoaway` 受信。Request ID 欠落を PROTOCOL_VIOLATION、パリティ不一致を INVALID_REQUEST_ID として閉じる
- `src/session/bidi.ts:165-179`: `validateGoawayOnRequestStream` がリクエストストリーム上の GOAWAY に Request ID があれば PROTOCOL_VIOLATION。draft-19 ではフィールド自体が無いため不要
- `src/session/bidi.ts` と `src/session.ts` に同検証の呼び出しが複数ある

## 設計方針

- `Goaway` 型から `requestId` を削除する
- `encodeGoawayPayload` / `decodeGoawayPayload` から Request ID 処理を削除する。Timeout 後に残バイトがあれば不正な長さとして ProtocolViolationError にする
- `isValidGoawayRequestIdParity` を削除する
- `validateGoawayOnRequestStream` を削除し、呼び出し箇所を除去する
- `handleGoaway` の Request ID 欠落チェックとパリティ検証を削除する
- 仕様参照コメントを draft-19 Section 10.4 (GOAWAY) に更新する
- 既存の GOAWAY ラウンドトリップテストとリクエストストリーム上 GOAWAY テストを新フォーマットに追従させる

## 完了条件

- Request ID を含まない GOAWAY のエンコード・デコードが Section 10.4 のワイヤフォーマットと一致すること
- Timeout 後に余分なバイトを持つ GOAWAY 受信が ProtocolViolationError になるテストがあること
- `requestId` / パリティ検証に関するコード・テスト・コメントが残っていないこと
- lint / build / typecheck / 既存テストが通ること
