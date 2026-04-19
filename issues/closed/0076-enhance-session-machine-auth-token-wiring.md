# SessionMachine に AUTHORIZATION_TOKEN パラメータ処理を配線する

Created: 2026-04-19
Model: Claude Opus 4.7

## 概要

#0075 で追加した `encodeAuthToken` / `decodeAuthToken` を `SessionMachine` に配線する。
現状 `_localAuthTokenCache` と `_peerAuthTokenCache` は用意されているが、
AUTHORIZATION_TOKEN (Parameter Type `0x03`) を含むメッセージを送受信したときに
キャッシュが更新されていないため、alias ベースの参照を行うと必ず未登録扱いになる。

本 issue では以下を実装する。

- `SessionMachine.processOutgoingAuthTokens(parameters)`: 自側が送る REGISTER を `_localAuthTokenCache` に登録、DELETE をキャッシュから除去する。不正は throw する
- `SessionMachine.processIncomingAuthTokens(parameters)`: 相手から来た REGISTER を `_peerAuthTokenCache` に登録、DELETE を除去する。不正は `closeSession` イベントを積む
- 既存の `send*` 系メソッド (SUBSCRIBE / PUBLISH / REQUEST_UPDATE / FETCH / PUBLISH_NAMESPACE / SUBSCRIBE_NAMESPACE / TRACK_STATUS) から送信直前に `processOutgoingAuthTokens` を呼ぶ

受信側は SessionMachine の `handleStreamMessage` ではなく I/O ラッパー `Session` 層で処理する peer-initiated request でも使えるよう、公開メソッドとして提供する。本 issue では配線は行わず、メソッドの提供までとする。

## 背景

#0073 の close 時に残した課題の 1 つ。
`AuthTokenCache` 単体および `decodeAuthToken` は揃ったが、
`SessionMachine` のメッセージ処理フローから呼び出せていない。

## RFC 根拠

`draft-ietf-moq-transport-17` Section 9.3.2 AUTHORIZATION TOKEN Parameter

- "The receiver of a message carrying an AUTHORIZATION TOKEN with Alias Type REGISTER that does not result in a Session error MUST register the Token Alias, in the token cache"
- "The receiver of a message attempting to register an Alias which is already registered MUST close the Session with DUPLICATE_AUTH_TOKEN_ALIAS."
- "If a registration is attempted which would cause this limit to be exceeded, the receiver MUST terminate the Session with a AUTH_TOKEN_CACHE_OVERFLOW error."
- "If the Token structure cannot be decoded, the receiver MUST close the Session with KEY_VALUE_FORMATTING_ERROR."

参考: <https://www.ietf.org/archive/id/draft-ietf-moq-transport-17.html#section-9.3.2>

## 設計判断

| 項目               | 決定                                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------ |
| outgoing 失敗      | 送信側での REGISTER 失敗 (duplicate / overflow) は `SessionError` を throw する            |
| incoming 失敗      | 受信側での REGISTER 失敗 / デコード失敗は `closeSession` イベントを積む (throw はしない)   |
| DELETE の挙動      | 送受いずれも「未登録 alias は no-op」扱い (AuthTokenCache の仕様そのまま)                  |
| USE_ALIAS          | 本 issue ではキャッシュ状態を変えないため no-op。呼び出し側が必要に応じて `resolve` を使う |
| USE_VALUE          | キャッシュを変えないため no-op                                                             |
| 呼び出しタイミング | 送信側は `send*` 系メソッドの冒頭で処理。受信側は本 issue では配線しない                   |

## 作業内容

1. `SessionMachine.processOutgoingAuthTokens(parameters)` を追加
   - `parameters` から type `AUTHORIZATION_TOKEN` を抽出
   - `decodeAuthToken` でデコード。失敗は `SessionError(KEY_VALUE_FORMATTING_ERROR)` で throw
   - REGISTER: `_localAuthTokenCache.tryRegister`。duplicate は `AuthTokenCache` 側の throw が伝播。overflow (false) は `SessionError(AUTH_TOKEN_CACHE_OVERFLOW)` で throw
   - DELETE: `_localAuthTokenCache.delete`
   - USE_ALIAS / USE_VALUE: no-op
2. `SessionMachine.processIncomingAuthTokens(parameters)` を追加
   - 動作は 1. と同じだが、失敗は `fail()` で `closeSession` イベントに変換する
3. 既存 `send*` 系メソッド冒頭で `processOutgoingAuthTokens(message.parameters)` を呼ぶ
4. `src/session/authToken.prop.ts` に配線側の挙動を追加 (duplicate alias / overflow / malformed / delete)
5. `CHANGES.md ## develop` に `[ADD]` として追記

## 影響範囲

- `src/session/machine.ts` に 2 メソッド追加と各 `send*` からの呼び出し
- `src/session/authToken.prop.ts` を新設 (SessionMachine 側の挙動を property 化)
- 既存 `send*` を呼ぶ外部は、AUTHORIZATION_TOKEN を含まないパラメータであれば挙動不変
- AUTHORIZATION_TOKEN を含む重複 REGISTER はこれまで黙って通っていたが、今後は throw される

## リスク

| ID  | リスク                                              | 緩和                                              |
| --- | --------------------------------------------------- | ------------------------------------------------- |
| R1  | 既存 I/O ラッパーが REGISTER を複数回投げている場合 | `send*` 前に throw されることでバグが早期発覚する |

Completed: 2026-04-19

## 解決方法

- `src/session/machine.ts` に 2 つの公開メソッドを追加した
  - `processOutgoingAuthTokens(parameters)`: 失敗時は `SessionError` を throw。REGISTER の overflow は `AUTH_TOKEN_CACHE_OVERFLOW`、重複は `AuthTokenCache` 側で `DUPLICATE_AUTH_TOKEN_ALIAS` を throw
  - `processIncomingAuthTokens(parameters)`: 失敗時は `fail()` 経由で `closeSession` イベントを積み、throw はしない
- REGISTER / DELETE / USE_ALIAS / USE_VALUE の 4 バリアントを処理する共通ヘルパー `applyAuthTokenToCache` を同ファイル内に追加した
- 以下 7 つの `send*` メソッドで先頭に `processOutgoingAuthTokens(message.parameters)` を配線した
  - `sendSubscribe` / `sendPublish` / `sendRequestUpdate` / `sendPublishNamespace` / `sendSubscribeNamespace` / `sendTrackStatus` / `sendFetch`
- `src/session/authTokenWiring.prop.ts` を新設し、以下 10 件のプロパティテストで動作を検証した
  - REGISTER が `_localAuthTokenCache` に登録される
  - DELETE で除去される
  - 重複 REGISTER で `DUPLICATE_AUTH_TOKEN_ALIAS` が throw される
  - キャッシュ超過で `AUTH_TOKEN_CACHE_OVERFLOW` が throw される
  - malformed Token で `KEY_VALUE_FORMATTING_ERROR` が throw される
  - `processIncomingAuthTokens` が `_peerAuthTokenCache` に登録する
  - 受信側 malformed で `closeSession` が積まれる
  - 受信側重複 REGISTER で `closeSession` が積まれる
  - USE_ALIAS / USE_VALUE はキャッシュを変えない
  - DELETE の未登録 alias は no-op
- `vp run typecheck` / `vp run test` (35 files / 441 tests) / `vp run build` (152.84 kB / gzip 31.31 kB) がすべて緑

### 残課題 (別 issue で扱う)

- peer からの SUBSCRIBE / PUBLISH / FETCH 等の request を受けた時点で `processIncomingAuthTokens` を呼ぶ配線は、受信処理を持つ Session (I/O ラッパー) 層で行う
- USE_ALIAS 参照時の `UNKNOWN_AUTH_TOKEN_ALIAS` レスポンス配線も上位層の責任範囲として残す
