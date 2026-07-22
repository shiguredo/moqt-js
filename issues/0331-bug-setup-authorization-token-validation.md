# SETUP の MAX_AUTH_TOKEN_CACHE_SIZE 送受信と REGISTER→USE_VALUE フォールバックが未実装

- Priority: Medium
- Created: 2026-06-30
- Completed:
- Model: Kimi Code CLI
- Branch: feature/fix-setup-authorization-token-validation
- Polished: 2026-07-23

## 目的

draft-18 §10.3.1.3 / §10.3.1.4 に基づき、SETUP メッセージでの MAX_AUTH_TOKEN_CACHE_SIZE の送受信と、REGISTER が上限を超えた場合の USE_VALUE フォールバック、送信側の alias purging を実装する。

## 優先度根拠

- draft-18 §10.3.1.3: "The MAX_AUTH_TOKEN_CACHE_SIZE option (Option Type 0x04) communicates the maximum size in bytes of all actively registered Authorization tokens that the endpoint is willing to store per Session. This option is optional. The default value is 0 which prohibits the use of token Aliases." — MAX_AUTH_TOKEN_CACHE_SIZE を送信しない場合、デフォルトで Alias の使用が禁止される。
- draft-18 §10.3.1.4: "If an endpoint receives an AUTHORIZATION TOKEN option in SETUP with Alias Type REGISTER that exceeds its MAX_AUTH_TOKEN_CACHE_SIZE, it MUST NOT fail the session with AUTH_TOKEN_CACHE_OVERFLOW. Instead, it MUST treat the option as Alias Type USE_VALUE." — 受信側のフォールバック MUST 要件。
- draft-18 §10.3.1.4: "the sender MUST handle registration failures of this kind by purging any Token Aliases that failed to register based on the peer's MAX_AUTH_TOKEN_CACHE_SIZE option in SETUP (or the default value of 0)." — 送信側の alias purging MUST 要件。
- MAX_AUTH_TOKEN_CACHE_SIZE を送信していないため、ピアのエイリアス登録上限が分からず、AUTH_TOKEN_CACHE_OVERFLOW で拒否される可能性がある。

## 現状

`src/message/setup.ts` の `createSetup()` / `decodeSetupPayload()` に MAX_AUTH_TOKEN_CACHE_SIZE の送受信機能がない。

### 既に実装済みの機能（本 issue の対象外）

- **PATH/AUTHORITY 受信検証**: `session.ts` 1243-1253 行目に実装済み。WebTransport 使用時にサーバーから PATH / AUTHORITY を受信した場合、INVALID_PATH / INVALID_AUTHORITY でセッションを閉じる。
- **送信側の Alias Type 検証**: `createSetup()` 内で `assertAuthorizationTokenForSetup()` が呼び出され、クライアントが DELETE/USE_ALIAS を SETUP に載せないことは担保されている。
- **DELETE/USE_ALIAS 受信検証**: §10.2.2 の "If a server receives Alias Type DELETE (0x0) or USE_ALIAS (0x2) in a SETUP message, it MUST close the session with a PROTOCOL_VIOLATION" はサーバー側の義務であり、クライアントである moqt-js には仕様上の義務はない。

### 未実装の機能

1. `MAX_AUTH_TOKEN_CACHE_SIZE` Setup Option（0x04）の送受信。
2. 受信した SETUP の AUTHORIZATION_TOKEN が REGISTER（0x1）で、自分の MAX_AUTH_TOKEN_CACHE_SIZE を超える場合、USE_VALUE（0x3）として扱うフォールバック。
3. ピアの SETUP から MAX_AUTH_TOKEN_CACHE_SIZE を取得し、登録失敗した Token Alias を purge する送信側処理。

### トークンサイズの計算

§10.3.1.3: "The token size is calculated as 16 bytes + the size of the Token Value field (see Figure 5)." — REGISTER→USE_VALUE フォールバックの判定にはこの計算式が必要。

## 設計方針

- `createSetup()` に MAX_AUTH_TOKEN_CACHE_SIZE Setup Option（0x04）の送信を追加する。
- `decodeSetupPayload()` に MAX_AUTH_TOKEN_CACHE_SIZE の受信処理を追加する。
- 受信 SETUP の AUTHORIZATION_TOKEN が REGISTER で、トークンサイズ（16 bytes + Token Value サイズ）が自分の MAX_AUTH_TOKEN_CACHE_SIZE を超える場合、USE_VALUE として扱う。
- ピアの SETUP から MAX_AUTH_TOKEN_CACHE_SIZE（またはデフォルト値 0）を取得し、登録失敗した Token Alias を purge する。
- デフォルト値 0 は Alias の使用禁止を意味するため、MAX_AUTH_TOKEN_CACHE_SIZE を受信しなかった場合は Alias を使用しない。

## 完了条件

- MAX_AUTH_TOKEN_CACHE_SIZE を SETUP で送受信できる。
- 受信した REGISTER が自分の MAX_AUTH_TOKEN_CACHE_SIZE を超える場合、USE_VALUE として扱う（AUTH_TOKEN_CACHE_OVERFLOW でセッションを閉じない）。
- ピアの MAX_AUTH_TOKEN_CACHE_SIZE（またはデフォルト値 0）に基づき、登録失敗した Token Alias を purge する。
- MAX_AUTH_TOKEN_CACHE_SIZE を受信しなかった場合、Alias を使用しない。
- テストが追加される（MAX_AUTH_TOKEN_CACHE_SIZE 送受信、フォールバック、purge）。

## 解決方法

1. `src/message/setup.ts` の `createSetup()` に MAX_AUTH_TOKEN_CACHE_SIZE Setup Option の送信を追加する。
2. `src/message/setup.ts` の `decodeSetupPayload()` に MAX_AUTH_TOKEN_CACHE_SIZE の受信処理を追加する。
3. `src/message/authorizationToken.ts` にトークンサイズ計算（16 bytes + Token Value サイズ）と REGISTER→USE_VALUE フォールバックのヘルパーを追加する。
4. `src/session.ts` の SETUP 処理で、ピアの MAX_AUTH_TOKEN_CACHE_SIZE に基づく alias purging を統合する。
5. テストを追加する。

## reopened にする理由

polish-issue による磨き上げが完了したため。仕様引用の検証・設計方針の確定・完了条件の具体化を実施済み。
