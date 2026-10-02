# 認証トークンキャッシュのオーバーフロー規則の適用範囲に追随する

- Created: 2026-10-02
- Completed: 2026-10-03
- Branch: feature/update-auth-token-cache-overflow-scope
- Polished: 2026-10-02

## 目的

draft-ietf-moq-transport-22 の §8.9 は、上限超過による AUTH_TOKEN_CACHE_OVERFLOW のセッション終了が「SETUP 以外での登録」のみに適用されることを明確にした (changelog: "Scope the auth token cache overflow rule to non-SETUP registrations (#1927)")。

- v21 §8.9 は「If a registration is attempted which would cause this limit to be exceeded, the receiver MUST terminate the Session with a AUTH_TOKEN_CACHE_OVERFLOW error.」で SETUP の例外を定めていなかった
- v22 §8.9 は「If a registration outside of SETUP is attempted that would cause this limit to be exceeded, the receiver MUST terminate the Session with an AUTH_TOKEN_CACHE_OVERFLOW error. Registrations in SETUP are handled as described in Section 9.1.4.」に変わった

§9.1.4 の「SETUP の REGISTER が上限を超えてもセッションを失敗させず USE_VALUE として扱う (MUST NOT fail / treat as USE_VALUE)」と「送信側はピアの MAX_AUTH_TOKEN_CACHE_SIZE (未受信時は既定 0) に基づき、登録に失敗した Alias を purge する MUST」は v21 から同一の文言で存在する。つまり:

- 受信側: v22 の §8.9 / §9.1.4 が定める挙動は moqt-js が既に実装しており、v22 化で変更するものは無い (コメントの参照更新のみ)
- 送信側: §9.1.4 の purge MUST は v21 から存在するが未実装である。本 issue は送信側の実装方針を決めてコードとテストで固定する

## 現状

- 受信側は適合。`src/session/authTokenCache.ts` の `processSetupAuthorizationTokens` (処理本体は `processSetupAuthorizationToken`) は SETUP の超過 REGISTER を登録せずセッションも閉じない (USE_VALUE 扱い)。`processMessageAuthorizationTokens` は SETUP 以外の超過 REGISTER で `AUTH_TOKEN_CACHE_OVERFLOW` の `SessionError` を throw する。`src/session.test.ts` の「initialize: 受信 SETUP の上限超過 REGISTER は USE_VALUE 扱いで閉じない」と「受信 PUBLISH: 上限超過 REGISTER は AUTH_TOKEN_CACHE_OVERFLOW でセッションを閉じる」で固定済み。ただしコメントの引用は v21 のまま
- 送信側は未実装。`src/session/connection.ts` の `connectionInitialize` は受信 SETUP の MAX_AUTH_TOKEN_CACHE_SIZE を `getSetupMaxAuthTokenCacheSize` で取り出し `peerMaxAuthTokenCacheSize` (ローカル変数) としてデバッグ出力に使うのみで、セッションに保持せず Alias 登録の可否判定に使わない
- SETUP へ載せたトークンは `src/session.ts` の `setupAuthToken` (`setupAuthorizationToken` ゲッター) に保持され、`src/connect.ts` の `resolveMsfAuthorizationToken` (c4m は USE_VALUE) または `ConnectOptions.authorizationToken` (REGISTER / USE_VALUE が許可される) が入る。高レベル API (`src/createMediaSubscriber.ts` / `src/createMediaPublisher.ts`) と devtools (`devtools/src/utils/trackAuthorization.ts`) は `setupAuthorizationToken` を SUBSCRIBE / FETCH / PUBLISH 等の `authorizationToken` オプションにそのまま付与する。REGISTER の場合は REGISTER のまま再送され、SETUP で登録に成功した Alias を後続メッセージで再 REGISTER することになる (§8.9: 登録済み Alias の再 REGISTER の受信は DUPLICATE_AUTH_TOKEN_ALIAS でセッションを閉じる MUST)
- トークンサイズは `src/session/authTokenCache.ts` の `AUTH_TOKEN_CACHE_ENTRY_OVERHEAD` (16 バイト、§9.1.3 の "16 bytes + the size of the Token Value field") + Token Value 長で計算する。送信側に対応する追跡・計算は無い
- `src/message/authorizationToken.ts` の `assertAuthorizationTokenForSetup` は SETUP 送信で REGISTER と USE_VALUE を許可し、DELETE / USE_ALIAS を拒否する (§9.1.4)

## 設計方針

- 送信側で、SETUP に載せた REGISTER Token (moqt-js の公開 API は SETUP につき 1 件) のエントリサイズ (§9.1.3: 16 バイト + Token Value 長) を計算し、受信したピアの MAX_AUTH_TOKEN_CACHE_SIZE (未受信時は既定 0) を超えるとき「登録失敗 (purge 対象)」として記録する。判定と記録はピアの SETUP を受信した時点 (`connectionInitialize` のデコード検証後) で行い、セッション終了まで保持する
- 後続メッセージ (SUBSCRIBE / FETCH / PUBLISH / REQUEST_UPDATE / SUBSCRIBE_NAMESPACE 等) へトークンを付与する送信経路では次のとおり正規化する:
  - 自 SETUP の REGISTER で登録に成功した Alias と同一の REGISTER を付与する場合 → 同 Alias の USE_ALIAS に変換して送る。§8.9 は登録済み Alias の再 REGISTER を禁止するが USE_ALIAS での参照は許可する。§8.9 の「別ストリームの REGISTER を参照する USE_ALIAS は応答受信まで禁止」は、moqt-js がピアの SETUP 受信後 (接続確立後) にしか要求メッセージを送らないため常に満たされる
  - 登録に失敗した (purge 対象の) Alias と同一の REGISTER / USE_ALIAS を付与する場合 → 値が手元にあれば USE_VALUE に変換して送る (§9.1.4 の purge MUST。ピアも同じ扱いをする)。値が無い場合はローカルエラーにする
  - USE_VALUE、および上記以外の REGISTER / USE_ALIAS (ユーザーが明示的に渡すもの) はそのまま送る
- 正規化は送信パラメータの構築経路 (例: `src/session/params.ts` の `encodeAuthorizationTokenParameter` を呼ぶ各 build 関数) に共通の変換関数を設けて行い、高レベル API (SETUP トークンの自動付与) と低レベル API (明示指定) の両方に適用する。§8.9 / §9.1.3 / §9.1.4 の根拠と制約は JSDoc (`src/session/params.ts` / `src/session/publicTypes.ts`) に明記する (issue 番号は記さない)
- 受信側の挙動は変更しない。§8.9 / §9.1.3 / §9.1.4 の引用コメントを v22 に更新する。AUTHORIZATION TOKEN Parameter の §9.20.3 → §9.20.2 を含む §9.20 系の参照更新は 0803 が担当するため、本 issue では触らない

## 完了条件

- 送信側で SETUP の REGISTER の登録成否が追跡され、後続メッセージへの付与時に「登録成功 → USE_ALIAS / 登録失敗 → USE_VALUE (値なしはローカルエラー)」へ正規化され、テストで固定されている
- 受信側の既存挙動 (SETUP は USE_VALUE 扱い、非 SETUP は AUTH_TOKEN_CACHE_OVERFLOW) のテストが維持されている
- §8.9 / §9.1.3 / §9.1.4 のコメント参照が v22 に更新されている (§9.20 系参照は 0803 の対象)
- `vp check` / `tsc --noEmit` / `vp test run` が通る

## 参照

- draft-ietf-moq-transport-22 §8.9 (Authorization Token Compression) / §9.1.3 (MAX_AUTH_TOKEN_CACHE_SIZE) / §9.1.4 (AUTHORIZATION TOKEN)。v21 との差分は changelog A.1 の "Scope the auth token cache overflow rule to non-SETUP registrations (#1927)"。v21 の各節は git 履歴 (コミット `d011611`) で確認できる
- `src/session/authTokenCache.ts` の `AuthTokenCache` / `processSetupAuthorizationTokens` / `processMessageAuthorizationTokens`
- `src/session/connection.ts` の `connectionInitialize` / `peerMaxAuthTokenCacheSize` / `setupAuthToken`
- `src/session.ts` の `setupAuthToken` / `setupAuthorizationToken` / `localMaxAuthTokenCacheSize`
- `src/message/authorizationToken.ts` の `assertAuthorizationTokenForSetup` / `encodeAuthorizationToken`
- `src/message/setup.ts` の `createSetup` / `getSetupMaxAuthTokenCacheSize`
- `src/session/params.ts` の `encodeAuthorizationTokenParameter`
- `src/createMediaSubscriber.ts` / `src/createMediaPublisher.ts` / `devtools/src/utils/trackAuthorization.ts` (SETUP トークンの自動付与)

## 解決方法

draft-ietf-moq-transport-22 §8.9 / §9.1.3 / §9.1.4 を正として、受信側は現状の適合を確認して参照を更新し、未実装だった送信側を実装した。

### 1. 受信側 (挙動変更なし)

- `processSetupAuthorizationTokens` は SETUP の超過 REGISTER を登録せずセッションも閉じない (§9.1.4 の USE_VALUE 扱い)、`processMessageAuthorizationTokens` は SETUP 以外の超過 REGISTER で `AUTH_TOKEN_CACHE_OVERFLOW` を throw する。§8.9 が「SETUP 以外の登録が対象」と明確化したことと整合することを確認した (既存テストは維持)
- 受信側の §8.9 の引用を v22 の文面 ("If a registration outside of SETUP is attempted that would cause this limit to be exceeded ... Registrations in SETUP are handled as described in Section 9.1.4.") に更新した

### 2. 送信側 (実装)

- `src/session/authTokenCache.ts` に `setupTokenRegistration` と `normalizeAuthorizationTokenForSend`、`authTokenRegisterEntrySize` を追加した
  - `setupTokenRegistration`: §9.1.3 のエントリサイズ (16 バイト + Token Value 長) とピアの MAX_AUTH_TOKEN_CACHE_SIZE から SETUP の REGISTER の登録成否を判定する
  - `normalizeAuthorizationTokenForSend`: 登録に成功した Alias の REGISTER / USE_ALIAS は USE_ALIAS に、登録に失敗した Alias は USE_VALUE に変換する (§8.9 の再 REGISTER 禁止と §9.1.4 の purge MUST)。同一 Alias でも Token Type / Value が異なる REGISTER はアプリの指定を尊重して変換しない
- `src/session/connection.ts` はピアの SETUP を受信して上限が判明した時点で `peerMaxAuthTokenCacheSize` と `setupTokenRegistration` を確定する
- `SessionImpl.normalizeAuthorizationTokenForSend` は SETUP Alias の正規化を先に行い (登録失敗時の purge を上限判定で妨げない)、そのうえで SETUP 以外の REGISTER が 1 件でピアの上限を超える場合は §8.9 のセッション終了を招くためローカルエラーにする
- 送信経路の適用: PUBLISH / SUBSCRIBE / FETCH / TRACK_STATUS (`src/session/requests.ts`)、SUBSCRIBE_NAMESPACE / SUBSCRIBE_TRACKS / PUBLISH_NAMESPACE (`src/session/namespaces.ts`)、REQUEST_UPDATE (`src/session/bidi.ts` が参照する保持値)。SUBSCRIBE 等で REGISTER を送った Alias は、同じストリームの REQUEST_UPDATE では USE_ALIAS で参照する (`requestsTokenForRequestUpdate`)
- 公開 API の JSDoc (`ConnectOptions.authorizationToken` / `encodeAuthorizationTokenParameter`) に、SETUP の登録成否に応じた正規化の前提を書いた

### 3. 検証

`vp check` (1284 files 整形 / 475 files lint・型エラーなし) / `tsc --noEmit` / `vp test run` (198 files / 3576 tests) が通る。テストは純関数 4 件とセッション 3 件 (登録成否の確定・正規化・上限超過のローカルエラー・登録失敗時の purge) を追加した。`/review-diff-code` を 3 周回し、未適用だった経路 (REQUEST_UPDATE / SUBSCRIBE_NAMESPACE / PUBLISH_NAMESPACE) と、上限判定の順序 (登録失敗の purge を妨げる) を検出して修正した。

### 4. 残課題 (別 issue 候補)

- §9.1.3 の上限は「登録サイズの総和 − DELETE の総和」であり、ローカルエラーの判定は 1 件単位である (SETUP 分との合算は未追跡)
- SUBSCRIBE_NAMESPACE / SUBSCRIBE_TRACKS の REQUEST_UPDATE はトークンを運ばない (MSF §11.4.3 は track に紐づくトークンの MUST 付与を求める)
- ピア SETUP の受信を「別ストリームの USE_ALIAS 禁止 (§8.9) の応答」とみなす解釈をコメントに残す
