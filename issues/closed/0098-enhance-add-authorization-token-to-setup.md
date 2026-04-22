# ConnectOptions に authorizationToken を追加し SETUP Option として送出する

Created: 2026-04-22
Completed: 2026-04-22
Model: Claude Opus 4.7

## 概要

`moqt-js` は内部に `AUTHORIZATION_TOKEN` パラメータのエンコード/デコード (`src/message/authToken.ts`) と
受信側 cache (`src/session/authTokenCache.ts`) を持っているが、
public API から `AUTHORIZATION_TOKEN` を送出する手段が存在しない。

draft-ietf-moq-transport-17 §9.4.1.4 (AUTHORIZATION TOKEN Setup Option) に従い、
`ConnectOptions` から SETUP Option (Option Type 0x03) として Authorization Token を
送出できるようにする。

併せて、略称の `AuthToken` を仕様上のフルネーム `AuthorizationToken` にリネームする。

## 根拠

- draft-ietf-moq-transport-17 §9.3.2 AUTHORIZATION TOKEN Parameter
- draft-ietf-moq-transport-17 §9.4.1.4 AUTHORIZATION TOKEN (Setup Option)
- moqt-devtools (issue 0099) で Authorization Token の入力欄を提供するため、
  ライブラリ側から公開 API が必要。

## スコープ

SETUP Option としての送出のみ対応する。PUBLISH / SUBSCRIBE / FETCH 等の
Message Parameter としての個別指定は別 issue とする。

Alias Type は SETUP での使用を考慮し、仕様上 `DELETE (0x0)` と `USE_ALIAS (0x2)` は
SETUP で禁止されている (§9.3.2) ため、`REGISTER (0x1)` と `USE_VALUE (0x3)` のみ許可する。

## 変更内容

### リネーム

- `src/message/authToken.ts` → `src/message/authorizationToken.ts`
- `AuthToken` → `AuthorizationToken`
- `AuthTokenAliasType` → `AuthorizationTokenAliasType`
- `AuthTokenDelete` / `AuthTokenRegister` / `AuthTokenUseAlias` / `AuthTokenUseValue` を
  `AuthorizationToken` プレフィックスに
- `encodeAuthToken` → `encodeAuthorizationToken`
- `decodeAuthToken` → `decodeAuthorizationToken`
- `src/session/authTokenCache.ts` → `src/session/authorizationTokenCache.ts`
- `AuthTokenCache` → `AuthorizationTokenCache`

エラーコード名 (`AUTH_TOKEN_CACHE_OVERFLOW` など) は仕様書で略称が使われているため変更しない。

### API 追加

- `ConnectOptions.authorizationToken?: AuthorizationToken` を追加
- `session.initialize()` の SETUP メッセージに `AUTHORIZATION_TOKEN` Setup Option
  (Option Type 0x03) を積む
- `src/index.ts` から `AuthorizationToken` 型と `AuthorizationTokenAliasType` を export

## 影響範囲

- `src/index.ts`
- `src/message/authToken.ts` → `src/message/authorizationToken.ts`
- `src/message/authToken.test.ts` → `src/message/authorizationToken.test.ts`
- `src/message/authToken.prop.ts` → `src/message/authorizationToken.prop.ts`
- `src/message/index.ts`
- `src/session/authTokenCache.ts` → `src/session/authorizationTokenCache.ts`
- `src/session/authTokenCache.prop.ts` → `src/session/authorizationTokenCache.prop.ts`
- `src/session/authTokenWiring.prop.ts` → `src/session/authorizationTokenWiring.prop.ts`
- `src/session/machine.ts`
- `src/session/session.ts`

## 解決方法

- ファイル群を `git mv` でリネームした
  - `src/message/authToken.ts` → `src/message/authorizationToken.ts`
  - `src/message/authToken.test.ts` → `src/message/authorizationToken.test.ts`
  - `src/message/authToken.prop.ts` → `src/message/authorizationToken.prop.ts`
  - `src/session/authTokenCache.ts` → `src/session/authorizationTokenCache.ts`
  - `src/session/authTokenCache.prop.ts` → `src/session/authorizationTokenCache.prop.ts`
  - `src/session/authTokenWiring.prop.ts` → `src/session/authorizationTokenWiring.prop.ts`
- 型・関数・メソッド名を仕様どおりフルネームに変更した
  - `AuthToken*` → `AuthorizationToken*` / `AuthTokenCache` → `AuthorizationTokenCache`
  - `encodeAuthToken` / `decodeAuthToken` → `encodeAuthorizationToken` / `decodeAuthorizationToken`
  - `SessionMachine.localAuthTokenCache` / `peerAuthTokenCache` / `processOutgoingAuthTokens` / `processIncomingAuthTokens` をフルネームに
  - エラーコード名 (`AUTH_TOKEN_CACHE_OVERFLOW` 等) は仕様書で略称のため変更しない
- `SetupOptionType.AUTHORIZATION_TOKEN = 0x03` を追加した (§9.4.1.4)
- `createSetup()` に `authorizationToken` オプションを追加し、指定時は AUTHORIZATION_TOKEN Setup Option として `parameters` に積む
- `ConnectOptions` に `authorizationToken?: AuthorizationToken` を追加した
- `Session` コンストラクタに `authorizationToken` を受け取る第 3 引数を追加し、`initialize()` で `createSetup()` に渡す
- `src/index.ts` から `AuthorizationToken` / `AuthorizationTokenDelete` / `AuthorizationTokenRegister` / `AuthorizationTokenUseAlias` / `AuthorizationTokenUseValue` / `AuthorizationTokenAliasType` / `encodeAuthorizationToken` / `decodeAuthorizationToken` を公開した
- `src/message/setup.test.ts` に SETUP Option AUTHORIZATION_TOKEN の単体テストを 3 件追加した (USE_VALUE / REGISTER / roundtrip)
