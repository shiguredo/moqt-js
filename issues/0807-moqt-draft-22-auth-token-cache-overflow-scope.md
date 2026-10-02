# 認証トークンキャッシュのオーバーフロー規則の適用範囲を確認する

- Created: 2026-10-02
- Completed: {YYYY-MM-DD}
- Branch: feature/update-auth-token-cache-overflow-scope
- Polished: {YYYY-MM-DD}

## 目的

draft-ietf-moq-transport-22 で認証トークンキャッシュの上限超過の扱いが明確化された。

- §8.9: 上限超過で AUTH_TOKEN_CACHE_OVERFLOW によりセッションを終了するのは「SETUP 以外での登録」である。SETUP の登録は §9.1.4 に従う
- §9.1.4: SETUP の REGISTER が上限を超えてもセッションを失敗させず、USE_VALUE として扱う。SETUP はピアの SETUP 受信前に送られることがあるため、送信側はピアの MAX_AUTH_TOKEN_CACHE_SIZE (未受信時は既定 0) に基づき、登録に失敗した Alias を purge する MUST がある

受信側は既に適合している。送信側の purge は未実装のため、実装方針を決める。

## 現状

- 受信側は適合。`src/session/authTokenCache.ts` の `processSetupAuthorizationTokens` は SETUP の超過 REGISTER を登録せずセッションも閉じない (USE_VALUE 扱い)。`processMessageAuthorizationTokens` は SETUP 以外の超過 REGISTER で `AUTH_TOKEN_CACHE_OVERFLOW` の `SessionError` を throw する。テストで固定済み
- 送信側は未実装。`src/session/connection.ts` の `peerMaxAuthTokenCacheSize` はデバッグ出力にのみ使われ、Alias 登録の可否判定に使われていない
- `src/message/authorizationToken.ts` の `assertAuthorizationTokenForSetup` は SETUP 送信で REGISTER と USE_VALUE を許可する。ユーザーが REGISTER Token を渡すと、`Session.setupAuthToken` に保持され、SUBSCRIBE / FETCH / PUBLISH などで再利用される
- トークンサイズは `AuthTokenCache` の `AUTH_TOKEN_CACHE_ENTRY_OVERHEAD` (16 バイト) + Token Value 長で計算する。送信側に対応する追跡は無い

## 設計方針

- 送信側で SETUP に載せた REGISTER Token のサイズを計算し、受信した MAX_AUTH_TOKEN_CACHE_SIZE (未受信時は既定 0) を超える Alias を「登録失敗」として記録する。その Alias を後続メッセージの USE_ALIAS で使わない (ローカルエラーにする、または値がある場合は USE_VALUE に切り替える)
- SETUP はピアの SETUP 受信前に送れる現仕様を維持し、ピアの SETUP を受信した時点で purge を反映する
- 受信側の挙動は変更しない。§8.9 / §9.1.3 / §9.1.4 の引用コメントを v22 に更新する
- 高レベル API が Alias を扱わない方針であれば、低レベル API で REGISTER / USE_ALIAS を渡した場合の制約を JSDoc に明記する

## 完了条件

- 送信側の purge (または REGISTER / USE_ALIAS を扱う場合の明示的な制約) が実装され、テストで固定されている
- 受信側の既存挙動 (SETUP は USE_VALUE 扱い、非 SETUP は AUTH_TOKEN_CACHE_OVERFLOW) のテストが維持されている
- コメントの参照が v22 に更新されている
- `vp check` / `tsc --noEmit` / `vp test run` が通る

## 参照

- draft-ietf-moq-transport-22 §8.9 (Authorization Token Compression) / §9.1.3 (MAX_AUTH_TOKEN_CACHE_SIZE) / §9.1.4 (AUTHORIZATION TOKEN)
- `src/session/authTokenCache.ts` の `AuthTokenCache` / `processSetupAuthorizationTokens` / `processMessageAuthorizationTokens`
- `src/session/connection.ts` の `peerMaxAuthTokenCacheSize` / `setupAuthToken`
- `src/message/authorizationToken.ts` の `assertAuthorizationTokenForSetup` / `encodeAuthorizationToken`

## 解決方法

{未着手}
