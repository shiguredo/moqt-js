# 送信側の AUTH_TOKEN_CACHE_OVERFLOW 判定を登録サイズの総和にする

- Created: 2026-10-03
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-auth-token-cache-total-size
- Polished: 2026-10-03

## 目的

draft-ietf-moq-transport-22 §9.1.3 は、MAX_AUTH_TOKEN_CACHE_SIZE で制限されるサイズを「登録したトークンサイズの総和 − 解除したトークンサイズの総和」と定める。

> The total size as restricted by the MAX_AUTH_TOKEN_CACHE_SIZE option is calculated as the sum of the token sizes for all registered tokens (Alias Type value of 0x01) minus the sum of the token sizes for all deregistered tokens (Alias Type value of 0x00), since Session initiation.

§8.9 は、SETUP 以外の登録がこの上限を超えると受信側が AUTH_TOKEN_CACHE_OVERFLOW でセッションを終了する MUST を定める。送信側が 1 件単位でしか判定しないと、複数の REGISTER の合計が上限を超える場合に、ピアがセッションを閉じるメッセージを送ってしまう。

## 現状

- `src/session/authTokenCache.ts` の `AuthTokenCache.register` は受信側として `registeredSize + entrySize > maxSize` の総和で判定している
- `src/session.ts` の `normalizeAuthorizationTokenForSend` は送信側として 1 件分のエントリサイズ (`authTokenRegisterEntrySize`) とピアの `peerMaxAuthTokenCacheSize` を比較するだけで、それまでに送った REGISTER の累積や SETUP で登録済みの分を考慮しない
- そのため、ピアの上限が 30 バイトのとき 18 バイトの REGISTER を 2 件送ると、送信側ではどちらも通過し、合計 36 バイトでピアが AUTH_TOKEN_CACHE_OVERFLOW でセッションを閉じる
- 0807 の解決方法にも「ローカルエラーの判定は 1 件単位である (SETUP 分との合算は未追跡)」として残課題に挙げている
- SETUP の REGISTER の登録成否 (`setupTokenRegistration`) は保持しているが、成功した場合のサイズは保持していない

## 設計方針

- セッションに「ピアに登録済みとみなせるトークンサイズの合計」を持たせ、送信側の REGISTER の判定を総和で行う
  - 初期値は、ピアの SETUP を受信して `peerMaxAuthTokenCacheSize` と `setupTokenRegistration` を確定する `connectionInitialize` (src/session/connection.ts) 内で設定する
  - SETUP の REGISTER が登録に成功した場合はそのエントリサイズを初期値にする (§9.1.3 の「since Session initiation」)
  - SETUP の登録に失敗した場合は 0 のままにする (§9.1.4 の purge 対象でピアには登録されていない)
- 送信する REGISTER ごとにエントリサイズを加算し、加算後の合計がピアの上限を超える場合は `SessionImpl.normalizeAuthorizationTokenForSend` でローカルエラーにする。超過判定と加算は送信前の正規化時に同期で行い (予約)、ローカルエラー、後続の検証エラー、ストリーム生成や書き込みの失敗で送信に至らなかった場合は予約を減算して取り消す。同期で予約する理由は、チェックと実際の書き込み (await `createBidirectionalStream` / `writer.write` を含む送信経路) の間に他の REGISTER 判定が割り込んで互いの加算を見落とし、合計超過のまま両方送信してしまうことを防ぐためである。追跡対象は正規化後も REGISTER のままのトークンだけであり、SETUP の Alias は正規化で USE_ALIAS / USE_VALUE に変換済みのため初期値と重複して数えない
- DELETE の減算: メッセージ経路の公開 API (`authorizationToken` オプション) は型上 DELETE (Alias Type 0x00) も受け付けてそのまま送信できる一方、moqt-js が DELETE を生成する経路は無いため、本 issue では減算を実装せず、送信経路に DELETE が現れた時点で扱いを決める。手当てをしない間は、§9.1.3 の総和 (登録済み − 解除済み) に対して追跡値が高めに固まり、実際には登録できる REGISTER がローカルエラーになり得る (ピアにセッションを閉じさせる方向にはならない)。この扱いと帰結をコメントに記録する
- §9.1.3 / §8.9 / §9.1.4 の根拠は JSDoc に明記し、issue 番号は書かない

## 完了条件

- 送信側の判定が登録サイズの総和で行われ、複数の REGISTER の合計が上限を超える場合に送信前のローカルエラーになる (同一セッションでの並行送信でも合計超過を見落とさない)
- SETUP の登録成功分が初期値として合算される
- 送信に至らなかった REGISTER の予約が取り消される
- 上記がテストで固定されている (総和での超過、単発での超過、上限ちょうど、送信失敗時の予約取消し)
- `vp check` / `tsc --noEmit` / `vp test run` が通る

## 参照

- draft-ietf-moq-transport-22 §8.9 (Authorization Token Compression) / §9.1.3 (MAX_AUTH_TOKEN_CACHE_SIZE) / §9.1.4 (AUTHORIZATION TOKEN)
- `src/session.ts` の `normalizeAuthorizationTokenForSend` / `peerMaxAuthTokenCacheSize` / `setupTokenRegistration`
- `src/session/authTokenCache.ts` の `AuthTokenCache.register` / `authTokenRegisterEntrySize` / `setupTokenRegistration` / `normalizeAuthorizationTokenForSend`
- `src/session/requests.ts` の `requestsNormalizeAuthorizationToken`
- 関連 issue: 0807 (送信側の正規化と 1 件単位のローカルエラー)

## 解決方法

{未着手}
