# 送信側の AUTH_TOKEN_CACHE_OVERFLOW 判定を登録サイズの総和にする

- Created: 2026-10-03
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-auth-token-cache-total-size
- Polished: {YYYY-MM-DD}

## 目的

draft-ietf-moq-transport-22 §9.1.3 は、MAX_AUTH_TOKEN_CACHE_SIZE で制限されるサイズを「登録したトークンサイズの総和 − 解除したトークンサイズの総和」と定める。

> The total size as restricted by the MAX_AUTH_TOKEN_CACHE_SIZE option is calculated as the sum of the token sizes for all registered tokens (Alias Type value of 0x01) minus the sum of the token sizes for all deregistered tokens (Alias Type value of 0x00), since Session initiation.

§8.9 は、SETUP 以外の登録がこの上限を超えると受信側が AUTH_TOKEN_CACHE_OVERFLOW でセッションを終了する MUST を定める。送信側が 1 件単位でしか判定しないと、複数の REGISTER の合計が上限を超える場合に、ピアがセッションを閉じるメッセージを送ってしまう。

## 現状

- `src/session/authTokenCache.ts` の `AuthTokenCache.register` は受信側として `registeredSize + entrySize > maxSize` の総和で判定している
- `src/session.ts` の `normalizeAuthorizationTokenForSend` は送信側として 1 件分のエントリサイズ (`authTokenRegisterEntrySize`) とピアの`peerMaxAuthTokenCacheSize` を比較するだけで、それまでに送った REGISTER の累積や SETUP で登録済みの分を考慮しない
- そのため、ピアの上限が 30 バイトのとき 18 バイトの REGISTER を 2 件送ると、送信側ではどちらも通過し、合計 36 バイトでピアが AUTH_TOKEN_CACHE_OVERFLOW でセッションを閉じる
- 0807 の解決方法にも「ローカルエラーの判定は 1 件単位である (SETUP 分との合算は未追跡)」として残課題に挙げている
- SETUP の REGISTER の登録成否 (`setupTokenRegistration`) は保持しているが、成功した場合のサイズは保持していない

## 設計方針

- セッションに「ピアに登録済みとみなせるトークンサイズの合計」を持たせ、送信側の REGISTER の判定を総和で行う
  - SETUP の REGISTER が登録に成功した場合はそのエントリサイズを初期値にする (§9.1.3 の「since Session initiation」)
  - SETUP の登録に失敗した場合は 0 のままにする (§9.1.4 の purge 対象でピアには登録されていない)
- 送信する REGISTER ごとにエントリサイズを加算し、上限を超える場合は `SessionImpl.normalizeAuthorizationTokenForSend` でローカルエラーにする。加算するのは実際に送信した (しようとした) REGISTER のみとする
- DELETE の減算は、moqt-js が DELETE を送る公開 API を持たないため、送信経路に DELETE が現れた時点で扱いを決める (現状は減算不要であることをコメントに記録する)
- §9.1.3 / §8.9 / §9.1.4 の根拠は JSDoc に明記し、issue 番号は書かない

## 完了条件

- 送信側の判定が登録サイズの総和で行われ、複数の REGISTER の合計が上限を超える場合に送信前のローカルエラーになる
- SETUP の登録成功分が初期値として合算される
- 上記がテストで固定されている (総和での超過、単発での超過、上限ちょうど)
- `vp check` / `tsc --noEmit` / `vp test run` が通る

## 参照

- draft-ietf-moq-transport-22 §8.9 (Authorization Token Compression) / §9.1.3 (MAX_AUTH_TOKEN_CACHE_SIZE) / §9.1.4 (AUTHORIZATION TOKEN)
- `src/session.ts` の `normalizeAuthorizationTokenForSend` / `peerMaxAuthTokenCacheSize` / `setupTokenRegistration`
- `src/session/authTokenCache.ts` の `AuthTokenCache.register` / `authTokenRegisterEntrySize` / `setupTokenRegistration` / `normalizeAuthorizationTokenForSend`
- `src/session/requests.ts` の `requestsNormalizeAuthorizationToken`
- 関連 issue: 0807 (送信側の正規化と 1 件単位のローカルエラー)

## 解決方法

{未着手}
