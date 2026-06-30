# SETUP の AUTHORIZATION_TOKEN Alias Type 検証と MAX_AUTH_TOKEN_CACHE_SIZE 処理が未実装

- Priority: Medium
- Created: 2026-06-30
- Completed:
- Model: Kimi Code CLI
- Branch: feature/fix-setup-authorization-token-validation
- Polished:

## 目的

draft-18 §10.2.2 / §10.3.1.4 に基づき、SETUP メッセージ内の AUTHORIZATION_TOKEN の Alias Type 検証と MAX_AUTH_TOKEN_CACHE_SIZE Setup Option の送受信を実装する。

## 優先度根拠

- SETUP 時の認証トークン処理の仕様準拠。
- 現状ではサーバーからの SETUP に DELETE/USE_ALIAS が含まれても検出できず、セキュリティ/相互運用リスクがある。
- MAX_AUTH_TOKEN_CACHE_SIZE を送信していないため、ピアのエイリアス登録上限が分からず、AUTH_TOKEN_CACHE_OVERFLOW で拒否される可能性がある。

## 現状

`src/message/setup.ts:decodeSetupPayload()` は `decodeKeyValuePairs()` を呼び出すのみで、受信した AUTHORIZATION_TOKEN の Alias Type を検証していない。

未実装の検証/処理:

1. SETUP で Alias Type `DELETE`（0x0）または `USE_ALIAS`（0x2）を受信した場合、`PROTOCOL_VIOLATION` でセッションを閉じる（§10.2.2）。
2. SETUP での REGISTER（0x1）が相手の MAX_AUTH_TOKEN_CACHE_SIZE を超えた場合、`USE_VALUE`（0x3）として扱う（§10.3.1.4）。
3. `MAX_AUTH_TOKEN_CACHE_SIZE` Setup Option（0x04）を送信/受信する。
4. WebTransport 使用時にサーバーから PATH（0x01）/ AUTHORITY（0x05）を受信した場合、`INVALID_PATH` / `INVALID_AUTHORITY` でセッションを閉じる（§10.3.1.1 / §10.3.1.2）。

## 設計方針

- `decodeSetupPayload()` または呼び出し元の `session.ts` で、受信 SETUP の AUTHORIZATION_TOKEN の Alias Type を検証する。
- `MAX_AUTH_TOKEN_CACHE_SIZE` の送受信を `createSetup()` / `decodeSetupPayload()` に追加する。
- 送信時の REGISTER サイズがピアの上限を超える場合、`USE_VALUE` にフォールバックするロジックを追加する。
- PATH/AUTHORITY の受信検証は moqt-js が WebTransport 専用クライアントであることを前提に実装する。

## 完了条件

- SETUP で Alias Type DELETE / USE_ALIAS を受信した場合、`PROTOCOL_VIOLATION` でセッションを閉じる。
- MAX_AUTH_TOKEN_CACHE_SIZE を送受信できる。
- REGISTER サイズがピアの上限を超える場合、`USE_VALUE` にフォールバックする。
- WebTransport 使用時に PATH/AUTHORITY を受信した場合、適切なエラーコードでセッションを閉じる。
- テストが追加される。

## 解決方法

1. `src/message/authorizationToken.ts` に Alias Type 検証/USE_VALUE 変換ヘルパーを追加する。
2. `src/message/setup.ts` の `createSetup()` / `decodeSetupPayload()` を拡張する。
3. `src/session.ts` の SETUP 処理で上記検証を統合する。
4. テストを追加する。

## 該当箇所一覧

| ファイル | 変更内容 |
| --- | --- |
| `src/message/authorizationToken.ts` | Alias Type 検証/USE_VALUE 変換ヘルパー追加 |
| `src/message/setup.ts` | MAX_AUTH_TOKEN_CACHE_SIZE 送受信、受信時検証追加 |
| `src/session.ts` | SETUP 受信時の検証統合 |
