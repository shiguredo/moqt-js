# 受信 AUTHORIZATION TOKEN のデコードとトークンキャッシュを実装する

- Created: 2026-09-09
- Completed: {YYYY-MM-DD}
- Branch: feature/add-receive-authorization-token
- Polished: 2026-09-13

## 目的

draft-ietf-moq-transport-21 §8.9 / §9.1.4 は、受信した AUTHORIZATION TOKEN (SETUP Option / Message Parameter) のデコード、REGISTER のトークンキャッシュ登録、USE_ALIAS の解決、不正時のエラー処理を定める。現状は受信トークンを一切デコードしておらず、適合 peer との相互運用と仕様適合を満たせない。

## 現状

- 送信側は実装済み (`createSetup` の AUTHORIZATION TOKEN / MAX_AUTH_TOKEN_CACHE_SIZE、`encodeAuthorizationTokenParameter`)。受信側は未実装で、`src/message/setup.ts` の `getSetupAuthorizationTokens()` と `src/message/authorizationToken.ts` の `decodeAuthorizationToken()` はセッションから呼ばれていない。
- `src/message/parameter.ts` の `decodeParameters()` は AUTHORIZATION TOKEN (0x03) を生バイトのまま保持し、malformed token でもセッションを閉じない。
- REGISTER の重複 (DUPLICATE_AUTH_TOKEN_ALIAS)、未登録 Alias 参照 (UNKNOWN_AUTH_TOKEN_ALIAS)、デコード不能 (KEY_VALUE_FORMATTING_ERROR)、キャッシュ上限超過 (AUTH_TOKEN_CACHE_OVERFLOW) の各 MUST が未実装。
- MAX_AUTH_TOKEN_CACHE_SIZE は SETUP で広告しピアの値も取得済み (`src/session.ts`)。未広告時の既定は 0 で Alias 使用不可。

## 設計方針

1. デコード対象は、受信 SETUP の AUTHORIZATION TOKEN オプション (0x03) と、§9.20.3 が列挙するメッセージ (PUBLISH / SUBSCRIBE / REQUEST_UPDATE / SUBSCRIBE_NAMESPACE / SUBSCRIBE_TRACKS / PUBLISH_NAMESPACE / TRACK_STATUS / FETCH) の AUTHORIZATION TOKEN パラメータとする。SUBSCRIBE_OK 等の出現不可メッセージの扱いは既存の `validateParameterScope` と各 ALLOWED_PARAMS に委ね、従来どおり PROTOCOL_VIOLATION のままとする (緩和しない)。
2. セッションに受信トークンのキャッシュを追加する。Alias 空間は送信元ごとに独立するため、ピアが REGISTER した Alias を保持する。`decodeAuthorizationToken` / `getSetupAuthorizationTokens` を再利用する。デコード不能の判定は既存の `decodeAuthorizationToken` に委ねる (必須フィールドが欠けた Token は `KEY_VALUE_FORMATTING_ERROR` の `SessionError` になる)。Token Value は残りバイト列であり 0 バイトでも構造として成立するため、切り詰めとは扱わない。
3. REGISTER はキャッシュへ登録する。§8.9 の MUST により、セッションエラーにならない限りメッセージ自体が UNAUTHORIZED 等で失敗しても登録を維持する (拒否時に登録を巻き戻さない)。
4. キャッシュ上限の扱いは経路で異なる。受信 SETUP オプションの REGISTER が自分が広告した MAX_AUTH_TOKEN_CACHE_SIZE (未広告時は既定 0) を超える場合は、§9.1.4 の MUST に従いセッションを閉じず USE_VALUE として扱う。Message Parameter の REGISTER が上限を超える場合は、§8.9 の MUST に従い AUTH_TOKEN_CACHE_OVERFLOW でセッションを終了する。上限判定のサイズは §9.1.3 の定義に従い、1 トークンあたり「16 バイト + Token Value の長さ」、合計は「REGISTER (Alias Type 0x01) の総和 − DELETE (Alias Type 0x00) の総和」で計算する。
5. USE_ALIAS は登録済みの Token Type / Value を解決する。DELETE は Alias を退役させる。USE_VALUE は値をそのまま使い、キャッシュへは登録しない。
6. エラー処理は仕様の粒度に合わせる。デコード不能は KEY_VALUE_FORMATTING_ERROR、登録済み Alias の再 REGISTER は DUPLICATE_AUTH_TOKEN_ALIAS でセッションを閉じる。未登録 Alias の参照はセッションを閉じず、当該メッセージを REQUEST_ERROR で拒否する。コードは §8.9 が指名する UNKNOWN_AUTH_TOKEN_ALIAS (0x17) を使う。§12.3 の REQUEST_ERROR 登録表には 0x17 が無いため `RequestErrorCode` に追加し、根拠 (§8.9 の MUST / §12.3 表に未収載) をコメントに残す。ピア側で未知コードとして INTERNAL_ERROR に正規化され得ることは許容する。トークンを運ぶ 8 メッセージはいずれも REQUEST 系で REQUEST_ERROR を返せるため、ローカル拒否のみで済ませる経路は無い。
7. 受信 SETUP の DELETE / USE_ALIAS は、§9.1.4 の MUST が server 宛であり client である moqt-js に仕様義務はない。SETUP 時点で解決できない Alias であり適合 peer は送らないため、防御的検査として PROTOCOL_VIOLATION でセッションを閉じる (closed 0542 が保留した検査をここで実施する)。
8. 認可判断と、well-formed だが内容が不正な Token (MALFORMED_AUTH_TOKEN)・期限切れ Token (EXPIRED_AUTH_TOKEN) の判定はアプリ層の責務であり本 issue の対象外とする。解決した Token Type / Value をアプリへ公開する API も本 issue には含めない (キャッシュの維持と Alias の解決まで)。

## 完了条件

- 受信 SETUP の REGISTER がキャッシュへ登録され、同一 Alias の再 REGISTER で DUPLICATE_AUTH_TOKEN_ALIAS によりセッションが閉じること。テストは `connect()` で 0 より大きい `maxAuthTokenCacheSize` を広告したセッションで行う (未広告時の既定 0 では §9.1.4 により全 REGISTER が USE_VALUE に降格しキャッシュが空になるため)。
- USE_ALIAS が登録済みの Token Type / Value を解決し、DELETE で退役した Alias への USE_ALIAS が REQUEST_ERROR (UNKNOWN_AUTH_TOKEN_ALIAS 0x17) でメッセージを拒否すること (セッションは閉じない)。
- デコード不能な Token 構造で KEY_VALUE_FORMATTING_ERROR によりセッションが閉じること。
- SETUP オプションの REGISTER が MAX_AUTH_TOKEN_CACHE_SIZE を超える場合は USE_VALUE として扱われてセッションが閉じないこと。Message Parameter の REGISTER が上限を超える場合は AUTH_TOKEN_CACHE_OVERFLOW でセッションが閉じること。
- §9.20.3 の対象メッセージで AUTHORIZATION TOKEN パラメータがデコードされ、SUBSCRIBE_OK 等の出現不可メッセージでは従来どおり PROTOCOL_VIOLATION になること (緩和しない)。
- 受信 SETUP の DELETE / USE_ALIAS が PROTOCOL_VIOLATION によりセッションを閉じること (設計方針 7 の防御的検査)。
- 上記を検証するテストがあること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。
- `CHANGES.md` の `## develop` に `[ADD]` があること。

## 参照

- `refs/moq/draft-ietf-moq-transport-21.txt` §8.9 (Authorization Token Compression) / §9.1.3 (MAX_AUTH_TOKEN_CACHE_SIZE) / §9.1.4 (AUTHORIZATION TOKEN Setup Option) / §9.20.3 (AUTHORIZATION TOKEN Parameter) / §12.2 (Session Termination Codes)
- `decodeAuthorizationToken` / `assertAuthorizationTokenForSetup` (`src/message/authorizationToken.ts`)
- `getSetupAuthorizationTokens` (`src/message/setup.ts`。セッションから未使用)
- `decodeParameters` (`src/message/parameter.ts`。AUTHORIZATION_TOKEN は生バイト保持)
- `validateParameterScope` と各 ALLOWED_PARAMS (`src/message/parameterScope.ts`)
- `SessionErrorCode` / `RequestErrorCode` (`src/error.ts`)
- `issues/closed/0542-bug-setup-auth-token-alias-validation.md` (SETUP の DELETE / USE_ALIAS を client 側で検査しないと判断した先行 issue)
- 監査: issue 0558 (draft-21 適合監査) の残項目として起票
