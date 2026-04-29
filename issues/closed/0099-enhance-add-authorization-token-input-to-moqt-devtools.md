# moqt-devtools に Authorization Token 入力欄を追加する

Created: 2026-04-22
Completed: 2026-04-29
Model: Claude Opus 4.7

## 概要

moqt-devtools の Connection Settings に Authorization Token を入力する UI を追加する。
入力された値は `ConnectOptions.authorizationToken` として moqt-js に渡し、
SETUP Option (Option Type 0x03) として Relay に送出する。

## 根拠

- draft-ietf-moq-transport-17 §9.3.2 AUTHORIZATION TOKEN Parameter
- draft-ietf-moq-transport-17 §9.4.1.4 AUTHORIZATION TOKEN (Setup Option)
- 認証が必要な Relay (例: Sora MOQT) に接続する際、DevTools から手軽にトークンを
  指定できるようにするため。
- issue 0098 の API 拡張に依存する。

## スコープ

- SETUP Option 送出のみ対応する (PUBLISH / SUBSCRIBE 個別指定は別 issue)
- Alias Type は `USE_VALUE (0x3)` と `REGISTER (0x1)` のみ許可する
  (SETUP では DELETE / USE_ALIAS は仕様上禁止)
- Token Value は UTF-8 テキスト入力として受け取り、UTF-8 で bytes 化する
  (仕様上 Token Value は任意バイト列だが、実運用のトークン (JWT, API key 等) は
  ASCII/UTF-8 文字列であるため)

## UI 要素

Connection Settings に Authorization Token セクションを追加:

- **Alias Type**: セレクト (`USE_VALUE` / `REGISTER`)
- **Token Alias**: 数値入力 (REGISTER 時のみ表示)
- **Token Type**: 数値入力 (デフォルト 0 = out-of-band)
- **Token Value**: テキスト入力 (空の場合は送出しない)

## クエリパラメータ

- `authorizationTokenAliasType`: `useValue` / `register`
- `authorizationTokenAlias`: 数値文字列
- `authorizationTokenType`: 数値文字列
- `authorizationTokenValue`: テキスト

## 影響範囲

- `devtools/src/components/ConnectionSettings.tsx`
- `devtools/src/signals/connectionSettings.ts`
- `devtools/src/App.tsx` (ConnectOptions への注入ポイント確認)

## 依存

- issue 0098 (ConnectOptions.authorizationToken の API 追加)

## 解決方法

- `devtools/src/signals/connectionSettings.ts` に以下の signal と helper を追加:
  - `authorizationTokenAliasType: signal<"useValue" | "register">("useValue")`
  - `authorizationTokenAlias: signal<string>("0")`
  - `authorizationTokenType: signal<string>("0")`
  - `authorizationTokenValue: signal<string>("")`
  - `buildAuthorizationToken()`: 設定値から `AuthorizationToken | undefined` を組み立てる純粋関数。Token Value が空、または Token Alias / Token Type が不正な 10 進文字列の場合は `undefined` を返す。
- `devtools/src/components/ConnectionSettings.tsx` の WebCodecs Settings の下に Authorization Token セクションを追加。Alias Type が `register` の場合のみ Token Alias 入力を表示する。
- `buildQueryString` / `initFromUrl` に `authorizationTokenAliasType` / `authorizationTokenAlias` / `authorizationTokenType` / `authorizationTokenValue` を追加した。Token Value が空の場合はクエリ文字列に含めない。
- `devtools/src/hooks/usePublisher.ts` / `useSubscriber.ts` の `connectOptions` に `authorizationToken?: AuthorizationToken` を加え、`buildAuthorizationToken()` の戻り値を注入するようにした。
