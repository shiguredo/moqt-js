# GOAWAY メッセージから Request ID フィールドを削除する (draft-19 追従)

- Priority: High
- Created: 2026-07-07
- Model: Fable 5
- Branch: feature/change-draft-19-goaway-remove-request-id
- Polished: {YYYY-MM-DD}

## 目的

draft-ietf-moq-transport-19 Section 10.4 (GOAWAY) で、GOAWAY メッセージから Request ID フィールドが削除された (draft-18 → 19 変更履歴 "Remove Request ID from GOAWAY (#1623)")。

draft-19 Section 10.4 のワイヤフォーマット:

> ```
> GOAWAY Message {
>   Type (vi64) = 0x10,
>   Length (16),
>   New Session URI Length (vi64),
>   New Session URI (..),
>   Timeout (vi64),
> }
> ```

draft-18 Section 10.4 では末尾に `[Request ID (vi64)]` があり、「制御ストリーム上の GOAWAY には Request ID が必須で、パリティ不一致は INVALID_REQUEST_ID でセッションを閉じる」という段落が存在したが、draft-19 ではフィールドごと削除された。

moqt-js は draft-18 準拠で Request ID を送信・要求しているため、draft-19 準拠ピアとの GOAWAY 交換で相互運用が壊れる。

## 優先度根拠

ワイヤフォーマットの破壊的変更であり、実害が明確なため High。

- 受信: draft-19 準拠サーバーは Request ID なしの GOAWAY を送るが、moqt-js は「制御ストリーム上の GOAWAY に Request ID がない」として誤って PROTOCOL_VIOLATION でセッションを切断する (`src/session.ts:3528-3536`)
- 送信: moqt-js は常に Request ID を付けて送るため (`src/session.ts:2583`)、draft-19 準拠ピアには余分な末尾バイトとして解釈され拒否され得る

## 現状

- `src/message/session.ts:39-52`: `Goaway` 型が `requestId: bigint | null` を保持
- `src/message/session.ts:197-216`: `encodeGoawayPayload` が `requestId !== null` の場合に Request ID を追記
- `src/message/session.ts:225-256`: `decodeGoawayPayload` が Timeout の後に残バイトがあれば Request ID として読む
- `src/message/session.ts:258-274`: `isValidGoawayRequestIdParity` (even パリティ検証)
- `src/session.ts:2559-2603`: `goaway()` 送信。`src/session.ts:2583` で常に `requestId: 1n` を付与
- `src/session.ts:3512-3552`: `handleGoaway` 受信。3528-3536 で Request ID 欠落を PROTOCOL_VIOLATION、3544-3552 でパリティ不一致を INVALID_REQUEST_ID としてセッションを閉じる

## 設計方針

- `Goaway` 型から `requestId` フィールドを削除する
- `encodeGoawayPayload` / `decodeGoawayPayload` から Request ID の処理を削除する。Timeout の後に残バイトがある場合は不正な長さとして ProtocolViolationError にする
- `isValidGoawayRequestIdParity` を削除する
- `handleGoaway` の Request ID 欠落チェックとパリティ検証を削除する
- 関連する仕様参照コメントを draft-19 Section 10.4 の文言に更新する
- 既存テスト (`src/message/session.prop.ts` / `src/message/session.ts` 関連テスト) を新フォーマットに追従させる

## 完了条件

- Request ID を含まない GOAWAY のエンコード・デコードが draft-19 Section 10.4 のワイヤフォーマットと一致すること
- Timeout の後に余分なバイトを持つ GOAWAY の受信が ProtocolViolationError になるテストがあること
- `requestId` / パリティ検証に関するコード・テスト・コメントが残っていないこと
- lint / build / typecheck / 既存テストが通ること
