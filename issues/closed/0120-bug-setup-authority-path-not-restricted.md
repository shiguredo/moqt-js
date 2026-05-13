# SETUP の AUTHORITY / PATH オプションが WebTransport クライアントで送信制限されていない

Created: 2026-05-02
Completed: 2026-05-03
Model: Opus 4.7

## 概要

`Session#initialize()` (`src/session.ts:854-895` 付近) は `options.authority` / `options.path` を受け取り、そのまま `createSetup()` 経由で SETUP メッセージへ積む。moqt-js は WebTransport 専用クライアントだが、仕様 §9.4.1.1 / §9.4.1.2 は AUTHORITY / PATH オプションを「WebTransport 使用時には MUST NOT 送信」と規定している。

加えて、サーバから AUTHORITY / PATH を受信した場合に `INVALID_AUTHORITY` / `INVALID_PATH` でセッションを閉じる検証も実装されていない。

## RFC 根拠

draft-ietf-moq-transport-17 §9.4.1.1 AUTHORITY (line 3162-3177):

> The AUTHORITY option (Option Type 0x05) allows the client to specify the authority component of the MoQ URI when using native QUIC ([QUIC]). It MUST NOT be used by the server, or when WebTransport is used. When an AUTHORITY option is received from a server, or when an AUTHORITY option is received while WebTransport is used, or when an AUTHORITY option is received by a server but the server does not support the specified authority, the session MUST be closed with INVALID_AUTHORITY.

draft-ietf-moq-transport-17 §9.4.1.2 PATH (line 3179-3187):

> The PATH option (Option Type 0x01) allows the client to specify the path of the MoQ URI when using native QUIC ([QUIC]). It MUST NOT be used by the server, or when WebTransport is used. When a PATH option is received from a server, or when a PATH option is received while WebTransport is used, or when a PATH option is received by a server but the server does not support the specified path, the session MUST be closed with INVALID_PATH.

## 該当箇所

### 送信側

- `src/session.ts:854-895` (`initialize()`) — `options.path` / `options.authority` を無条件で `createSetup` に渡す
- `src/message/setup.ts:62-67` 付近 — `createSetup({path, authority})` がそのまま AUTHORITY (0x05) / PATH (0x01) Setup Option を積む
- 公開 API 上、利用者が `authority` / `path` を渡せてしまう

### 受信側

- `src/session.ts` の SETUP 受信処理 (`decodeSetupPayload` の戻り値処理) — 受信した Setup Options に AUTHORITY / PATH が含まれているかを検査していない

## 期待される動作

### 送信側

- moqt-js は WebTransport 専用クライアントであるため、`initialize()` の `options` から `path` / `authority` を削除するか、渡された場合に `Error` で即拒否する
- `createSetup` レベルでも WebTransport 用のフラグを受け取り、AUTHORITY / PATH が指定されたら throw する

### 受信側

- SETUP 受信時に AUTHORITY (0x05) または PATH (0x01) を検出したら以下で閉じる:
  - AUTHORITY → `closeWithError(SessionErrorCode.INVALID_AUTHORITY)`
  - PATH → `closeWithError(SessionErrorCode.INVALID_PATH)`
- 該当のエラーコードは `src/error.ts` で対応する値が定義されているか確認し、未定義であれば追加する

## 補足: MAX_AUTH_TOKEN_CACHE_SIZE / AUTHORIZATION_TOKEN の SETUP 検証

同じ SETUP 受信処理で次の MUST も漏れている:

- §9.4.1.4: SETUP の AUTHORIZATION_TOKEN で Alias Type DELETE / USE_ALIAS は禁止 (peer 違反時の扱い)
- §9.4.1.4: REGISTER がキャッシュサイズを超える場合は USE_VALUE 扱いとし `AUTH_TOKEN_CACHE_OVERFLOW` を出さない MUST NOT

`MAX_AUTH_TOKEN_CACHE_SIZE` (0x04) を保持する状態がそもそも実装されていない (`closed/0021-clarify-auth-token-cache-multiple-streams` で「クライアントは送信側であり cache 管理はサーバー側の責務」と整理されているが、送信側でも自分で REGISTER したアライアスのサイズ集計は必要)。本 issue では AUTHORITY / PATH のみを対象とし、AUTHORIZATION_TOKEN 関連は別 issue として切り出す前提でよい。

## 優先度

重要。WebTransport 専用クライアントが MUST NOT のオプションを送出すると、仕様準拠サーバから `INVALID_AUTHORITY` / `INVALID_PATH` でセッション切断される。受信側検証なしは敵対的サーバへの脆弱性。

## 解決方法

AUTHORITY / PATH のみを対象として、送受信両側で MUST 規定に従うようにする。AUTHORIZATION_TOKEN 関連は別 issue として切り出す前提を維持する。

### 送信側

- `src/message/setup.ts` の `createSetup` の options から `path` / `authority` を削除し、引数として受け取らないようにする (型レベルで送信不可を強制する)
- `src/session.ts` の `initialize()` の options 型からも `path` / `authority` を削除する
- 上記により API として送信できなくなる

### 受信側

- `src/session.ts` の SETUP 受信処理で `decodeSetupPayload` の戻り値を変数に保持し、`getSetupAuthority` / `getSetupPath` で AUTHORITY / PATH を検出する
- 検出時は `SessionError` を throw する (上位の `initialize` の呼び出し元が catch して `closeWithError(SessionErrorCode.INVALID_AUTHORITY)` / `closeWithError(SessionErrorCode.INVALID_PATH)` で閉じる経路を持つ)
- エラーコード (`SessionErrorCode.INVALID_AUTHORITY` = 0x19, `INVALID_PATH` = 0x8) は `src/error.ts` に既に定義済みのため新設は不要
- `getSetupAuthority` / `getSetupPath` の getter は受信側検証で使うため残す (送信側の API は削除しても getter は維持)

### テスト

- `setup.test.ts`: 「path パラメータ付きで作成」「authority パラメータ付きで作成」「すべてのパラメータ付きで作成」を、createSetup から PATH / AUTHORITY が出てこないことを保証するテストに置き換え。「エンコード・デコード roundtrip」も MOQT_IMPLEMENTATION のみで成立するように修正
- `setup.prop.ts`: PATH / AUTHORITY 文字列を任意生成する PBT を、AuthorizationToken の有無にかかわらず PATH / AUTHORITY が決して含まれないことを多数検証する PBT に置き換え

### スコープ外

`MAX_AUTH_TOKEN_CACHE_SIZE` / `AUTHORIZATION_TOKEN` の SETUP 受信側検証 (Alias Type の DELETE / USE_ALIAS 受信時の扱い、REGISTER がキャッシュサイズを超えた場合の扱い) は別 issue として独立して扱う。
