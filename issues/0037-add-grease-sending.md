# GREASE 送信の実装

- Priority: Low
- Created: 2026-03-23
- Completed: YYYY-MM-DD
- Model: manual
- Branch: feature/add-grease-sending
- Polished: 2026-07-30

## 目的

draft-ietf-moq-transport-19 Section 14 (Grease) で予約されている GREASE 値を送信パスに配線し、ピアが未知の値を正しく無視できることを検証可能にする。

## 現状

- `src/grease.ts` に `isGreaseValue()` と `generateGreaseValue(n: number)` が存在するが、送信パスからの参照はない。import 元はテスト (`grease.prop.ts`) のみ
- `src/message/setup.ts` の `createSetup()` は GREASE Setup Option を追加しない
- `src/session.ts` の `sendObjectInternal()` / `sendDatagram()` は呼び出し元から渡された properties をそのまま送るだけで、自動 GREASE 注入はしない

## 設計方針

### 仕様根拠

draft-ietf-moq-transport-19 Section 14:

- GREASE 値のパターン: `0x7f * N + 0x9D`（N は非負整数。例: `0x9D`, `0x11C`, `0x19B`, ..., `0x3fffffffffffffde`）
- 受信側: "implementations MUST handle unknown values gracefully" / "Endpoints MUST NOT close the session solely because they received an unknown value"
- 送信側: draft-19 本文に送信の SHOULD/MUST はなく、RFC 9170 §3.3 の参照先に委ねられている。送信は任意（opt-in）とする

### GREASE 予約を持つレジストリ（draft-19 Section 14）

| レジストリ                      | RFC セクション  | 用途                         |
| ------------------------------- | --------------- | ---------------------------- |
| Setup Options                   | Section 15.4    | SETUP メッセージのオプション |
| Properties                      | Section 15.8    | Track / Object Properties    |
| Session Termination Error Codes | Section 15.11.1 | セッション終了エラー         |
| REQUEST_ERROR Codes             | Section 15.11.2 | リクエストエラー             |
| PUBLISH_DONE Codes              | Section 15.11.3 | PUBLISH_DONE ステータス      |
| Stream Reset Error Codes        | Section 15.11.4 | ストリームリセット           |
| MOQT Auth Token Type            | -               | 認証トークン種別             |

### 実装スコープ

SETUP Option への opt-in GREASE 送信に限定する。Object / Track Properties への GREASE 注入は本 issue の必須とせず、必要なら後続 issue に分ける。

### 方針

1. `ConnectOptions`（`src/session.ts`）に GREASE Setup Option の送信を有効化するオプションを追加する
2. `createSetup()`（`src/message/setup.ts`）で GREASE Setup Option を条件付きで追加する
3. GREASE 値は既存の `generateGreaseValue(n: number)` を使い、`n` は乱数で選定する
4. GREASE Setup Option の value は任意のバイト列（仕様にセマンティクスなし）

## 完了条件

- opt-in で SETUP メッセージに GREASE Setup Option を含めて送信できる
- 既定（オプション未指定）では GREASE を送信しない（現状維持）
- `vp check` / `tsc --noEmit` / `vp test run` が通る

## 解決方法

### 変更対象

- `src/session.ts`: `ConnectOptions` に GREASE 送信オプションを追加し、`initialize()` から `createSetup()` に中継する
- `src/message/setup.ts`: `createSetup()` の options に GREASE 送信フラグを追加し、条件付きで GREASE Setup Option を push する
- `src/message/setup.test.ts`: GREASE Setup Option あり/なしのテストを追加する

### 参照

- draft-ietf-moq-transport-19 Section 14 (Grease)
- draft-ietf-moq-transport-19 Section 15.4 (Setup Options IANA registry)
- RFC 9170 §3.3

## reopened にする理由

draft-ietf-moq-transport-19 §14 でも GREASE 予約は存続しており、実装対象として有効なため。

- `generateGreaseValue()` / `isGreaseValue()` は `src/grease.ts` に存在する
- 未配線なのは送信パスのみ

着手スコープは SETUP Option への opt-in GREASE 送信に限定する。Object / Track Properties への注入は本 issue の必須とせず、必要なら後続 issue に分ける。
