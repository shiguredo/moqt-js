# ConnectOptions に authorizationToken を追加し SETUP Option として送出する

Created: 2026-04-22
Model: Claude Opus 4.7

## 概要

`moqt-js` に `AUTHORIZATION_TOKEN` の扱いが一切無いため、認証付き Relay (例: Sora MOQT)
に接続する手段が存在しない。

draft-ietf-moq-transport-17 §9.4.1.4 (AUTHORIZATION TOKEN Setup Option) に従い、
`ConnectOptions` から SETUP Option (Option Type 0x03) として Authorization Token を
送出できるようにする。

## 根拠

- draft-ietf-moq-transport-17 §9.3.2 AUTHORIZATION TOKEN Parameter
- draft-ietf-moq-transport-17 §9.4.1.4 AUTHORIZATION TOKEN (Setup Option)
- moqt-devtools (issue 0099) で Authorization Token の入力欄を提供するため、
  ライブラリ側から公開 API が必要。

## スコープ

- SETUP Option としての送出のみ対応する
- PUBLISH / SUBSCRIBE / FETCH 等の Message Parameter としての個別指定は別 issue とする
- 受信側 (サーバーから来る AUTHORIZATION_TOKEN) は対象外
- Alias Type は仕様上 SETUP で `DELETE (0x0)` と `USE_ALIAS (0x2)` が禁止されている (§9.3.2) ため、`REGISTER (0x1)` と `USE_VALUE (0x3)` のみ許可する
- 仕様フルネームの `AuthorizationToken` を型・関数名のベースに使う (`AuthToken` 略称は採用しない)

## 変更内容

### 型・エンコード/デコード

- `src/message/authorizationToken.ts` を新設する
  - `AuthorizationTokenAliasType` enum (`DELETE = 0` / `REGISTER = 1` / `USE_ALIAS = 2` / `USE_VALUE = 3`)
  - `AuthorizationToken` discriminated union (`AuthorizationTokenRegister` / `AuthorizationTokenUseValue` / `AuthorizationTokenUseAlias` / `AuthorizationTokenDelete`)
  - `encodeAuthorizationToken` / `decodeAuthorizationToken`
  - decode 失敗時は `KEY_VALUE_FORMATTING_ERROR` で throw する
- `src/message/authorizationToken.test.ts` に単体テストを追加する
- `src/message/authorizationToken.prop.ts` に fast-check PBT を追加する
- `src/message/index.ts` から上記を re-export する

### SETUP Option 配線

- `SetupOptionType.AUTHORIZATION_TOKEN = 0x03` を `src/message/setup.ts` に追加する
- `createSetup()` に `authorizationToken?: AuthorizationToken` オプションを追加し、指定時は `encodeAuthorizationToken` の結果を `AUTHORIZATION_TOKEN` Setup Option の value として `parameters` に積む
- SETUP 送出前に Alias Type を検証し、`DELETE` / `USE_ALIAS` が指定されたら throw する
- `src/message/setup.test.ts` に AUTHORIZATION_TOKEN Setup Option の roundtrip / USE_VALUE / REGISTER テストを追加する

### Session / ConnectOptions

- `ConnectOptions` に `authorizationToken?: AuthorizationToken` を追加する
- `connect()` / `Session` 側で受け取り、`session.initialize()` の SETUP 生成に渡す
- `src/index.ts` から `AuthorizationToken` / `AuthorizationTokenAliasType` / `AuthorizationTokenRegister` / `AuthorizationTokenUseValue` / `encodeAuthorizationToken` / `decodeAuthorizationToken` を公開する

## 影響範囲

- `src/index.ts`
- `src/message/authorizationToken.ts` (新規)
- `src/message/authorizationToken.test.ts` (新規)
- `src/message/authorizationToken.prop.ts` (新規)
- `src/message/index.ts`
- `src/message/setup.ts`
- `src/message/setup.test.ts`
- `src/session.ts`
