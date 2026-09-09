# 受信 AUTHORIZATION TOKEN のデコードとトークンキャッシュを実装する

- Created: 2026-09-09
- Completed: {YYYY-MM-DD}
- Branch: feature/add-receive-authorization-token
- Polished: {YYYY-MM-DD}

## 目的

draft-ietf-moq-transport-21 §8.9 / §9.1.4 は、受信した AUTHORIZATION TOKEN (SETUP Option / Message Parameter) のデコード、REGISTER のトークンキャッシュ登録、USE_ALIAS の解決、不正時のエラー処理を MUST で求める。現状は受信トークンを一切デコードしておらず、適合 peer との相互運用と仕様適合を満たせない。

## 現状

- `src/message/setup.ts` の `getSetupAuthorizationTokens()` と `src/message/authorizationToken.ts` の `decodeAuthorizationToken()` は実装済みだが、セッションから呼ばれていない。
- `src/message/parameter.ts` の `decodeParameters()` は AUTHORIZATION TOKEN (0x03) を生バイトのまま保持し、malformed token でもセッションを閉じない。
- REGISTER の重複 (DUPLICATE_AUTH_TOKEN_ALIAS)、未登録 Alias 参照 (UNKNOWN_AUTH_TOKEN_ALIAS)、デコード不能 (KEY_VALUE_FORMATTING_ERROR) の各 MUST が未実装。

## 設計方針

1. 受信 SETUP の AUTHORIZATION TOKEN オプションと、PUBLISH / SUBSCRIBE_OK / REQUEST_UPDATE 等の AUTHORIZATION TOKEN パラメータをデコードする。
2. REGISTER はトークンキャッシュへ登録し、MAX_AUTH_TOKEN_CACHE_SIZE を超える場合は §9.1.4 の MUST に従い USE_VALUE として扱う。
3. USE_ALIAS / DELETE を解決し、未登録 Alias は UNKNOWN_AUTH_TOKEN_ALIAS で拒否する。
4. デコード不能は KEY_VALUE_FORMATTING_ERROR、重複 Alias は DUPLICATE_AUTH_TOKEN_ALIAS でセッションを閉じる。
5. 既存の `decodeAuthorizationToken` / `getSetupAuthorizationTokens` を再利用し、セッションにトークンキャッシュを追加する。

## 完了条件

- 受信トークンの REGISTER / USE_ALIAS / DELETE が仕様どおり処理される。
- 不正 token / 重複 Alias / 未登録 Alias で仕様のエラーコードによりセッションが閉じる。
- `vp check` / `tsc --noEmit` / `vp test run` が通る。

## 参照

- `refs/moq/draft-ietf-moq-transport-21.txt` §8.9 / §9.1.4 / §9.20.3
- 監査: issue 0558 の適合監査 (I-3)
