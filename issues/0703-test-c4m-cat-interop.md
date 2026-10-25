# c4m から取り込んだ CAT が relay 側で受理されるか未検証

- Created: 2026-09-24
- Completed: {YYYY-MM-DD}
- Branch: feature/test-c4m-cat-interop
- Polished: 2026-10-26

## 目的

closed の `0652-bug-devtools-c4m-token-type.md` で devtools が送る Token Type を 0x01 (CAT) に直した。`src/msf/c4m.ts` の `getC4mParameter` は MSF URI Fragment の `c4m` を Base64 文字列として返すだけで Token Type を知らないが、`src/msf/c4mAuthorization.ts` の `createC4mAuthorizationToken` / `resolveMsfAuthorizationToken` が Token Type 0x01 (CAT) の USE_VALUE トークンに変換し、`src/connect.ts` の `connect()` が SETUP に載せる。`tests/e2e/main.ts` と `tests/e2e/relay/` には実リレーへ接続する harness があるが、c4m を明示的に付けた接続を固定する spec は無い。

そのため「c4m から取り込んだトークンが Token Type 0x01 (CAT) として relay に受理されるか」は自動テストで覆われていない。送信側が 0x01 を載せること (0652) と、受信側がそれを CAT として検証して通すこと (draft-ietf-moq-c4m-01 §7.1.1 の MUST) は別の話であり、後者は実リレーとの疎通でしか確認できない。

## 現状

- `src/msf/c4m.ts` の `getC4mParameter` は `c4m` の値を Base64 文字列のまま返す (JSDoc「base64 文字列のまま返す。検証しない。」)。同ファイルに Token Type を扱う型も値も無い
- `src/msf/c4mAuthorization.ts` の `createC4mAuthorizationToken` は Base64 を復号したバイト列を `AuthorizationTokenAliasType.USE_VALUE` / `tokenType = 1n` のトークンにする。`resolveMsfAuthorizationToken` は msf fragment の `c4m` からこのトークンを作る
- `src/connect.ts` の `connect()` は `options.authorizationToken` が指定されていないとき `resolveMsfAuthorizationToken(fragment)` を使い、SETUP の AUTHORIZATION TOKEN として送る
- `src/msf.test.ts` は `getC4mParameter` の文字列レベルの挙動 (最初の `c4m` を返す / 該当なしは undefined / 空文字列もそのまま返す) と、`createC4mAuthorizationToken` / `resolveMsfAuthorizationToken` の Token Type 1 / USE_VALUE / 復号結果を固定する
- `src/connect.test.ts` の `connect: msf fragment の c4m を SETUP の AUTHORIZATION TOKEN として送る` は、`connect()` が実際に送った SETUP を `getSetupAuthorizationTokens` でデコードし、Token Type 1 / USE_VALUE / 復号したバイト列を固定する。送信側の構造は Node で固定済みである
- devtools 側は `devtools/src/utils/c4m.ts` の `extractC4mBase64` で Base64 を取り出し、`devtools/src/signals/connectionSettings.ts` の `applyC4mFromUrl` が `authorizationTokenType.value = "1"` を設定する。`buildAuthorizationToken` が Base64 を復号した生バイト列を `tokenValue` にし、Token Type を 10 進文字列から bigint にする
- `src/message/setup.ts` の `createSetup` は `SetupOptionType.AUTHORIZATION_TOKEN` として `encodeAuthorizationToken` を積む。`getSetupAuthorizationTokens` は SETUP からトークンを取り出す。SUBSCRIBE などでは `src/session/params.ts` の `encodeAuthorizationTokenParameter` が Message Parameter 0x03 を積む
- トークン構造の符号化は `src/message/authorizationToken.ts` の `encodeAuthorizationToken` で、Alias Type / Token Type を varint で書き、Token Value を続ける (外側の Setup Option / Message Parameter の長さで区切る)
- `tests/e2e/main.ts` の `window.__moqtE2E` と `tests/e2e/relay/` の spec が実リレーへ接続する harness である。`tests/e2e/relay/support.ts` の `requireRelayUri` は `TEST_MOQT_URI` が未設定なら skip し、`connect.spec.ts` は SETUP の交換と正常切断を固定する。`playwright.config.ts` は `relay` project と実リレー接続用テストページの webServer を持ち、実リレー自体は起動せず `TEST_MOQT_URI` の外部リレーへ接続する
- `tests/e2e/relay/` に c4m を明示的に付けた接続を固定する spec は無い。`connect.spec.ts` は `TEST_MOQT_URI` をそのまま使うため、secret の URI に c4m が含まれていなければ c4m を送らない。closed の `0784-test-add-relay-e2e-tests.md` も、`TEST_MOQT_AUTH_TOKEN` が無いため Authorization Token を伴う接続は対象外としたと記録している
- `tests/e2e/devtools-authorization-token.spec.ts` は実リレーを起動しない UI テストで、c4m の取り込み後に `authorization-token-type` が `"1"` になることまでを固定する
- `tests/e2e/devtools-audio.spec.ts` / `tests/e2e/devtools-audio-meter.spec.ts` の冒頭コメントは「音声 object の到達は相互運用 harness 側で検証する」と述べる。現在は `tests/e2e/relay/` がその harness である
- `README.md` の冒頭 WARNING は「時雨堂が開発している Sora MoQ とのみ疎通確認を行っている」と述べる
- 受信側の要件: draft-ietf-moq-c4m-01 §7.1 Table 4 は 0x01 を CAT として登録し、§7.1.1 は「Token Type が 0x01 のとき Token Payload は CBOR エンコードされた CWT として直列化した CAT」と定め、relay の MUST (署名 / MAC の検証、有効期限と標準クレームの確認、`moqt` claim と `moqt-reval` claim の処理、DPoP claim の処理) を列挙する。検証に失敗したトークンは接続または操作を拒否する MUST
- §2 は本ドラフトが単一のトークン形式 (CAT) を使い、URL に載せるときは Base64 エンコードすると定める。§4 は URL への追加方法をアプリケーションの裁量とする
- draft-ietf-moq-transport-22 §16.6 Table 13 の登録は 0x0 (Reserved、仕様は §8.9) と greasing 用の範囲 (`0x7f * N + 0x9D`) だけであり、0x01 は c4m が登録する。§8.9 は Type 0 を「表に無い型であり out-of-band で交渉する」と定める
- したがって、送信側が「Base64 を復号したバイト列を Token Type 1 で送る」ことと、relay が「そのバイト列を CBOR の CWT として検証して通す」ことは別であり、後者を確認する c4m のテストが無い

## 設計方針

- 既存の `tests/e2e/relay/` の harness を使う。新しい harness は作らない。`playwright.config.ts` の `relay` project と `tests/e2e/relay/support.ts` の `requireRelayUri` は既にある。`tests/e2e/main.ts` の `connectRelay` は URL を受けて `connect()` に渡すため、テストページの変更は不要
- `tests/e2e/relay/` に c4m 付きの MSF URL で接続する spec を追加する。`TEST_MOQT_URI` の msf fragment に c4m がある場合はその値を使い、無い場合は `C4M.CatTokenBuilder` で生成した CAT を Base64 で `c4m` に載せる (`tests/e2e/devtools-authorization-token.spec.ts` の `buildCatWithTrackNames` と同じ形)。c4m を載せた MSF URL は spec 側で組み立て、`connectRelay({ url })` に渡す
  - `TEST_MOQT_URI` に c4m が無い msf fragment がある場合は `&c4m=...` を追加し、msf fragment が無い場合と msf 以外の fragment の場合は `#msf:<track-identifier>&c4m=...` に置き換える。track-identifier は `connect()` の c4m 解決には使われないため、テスト用の固定値でよい
  - relay が署名 / MAC を検証する場合、生成した CAT の鍵を relay と共有する必要がある。まずは `C4M.CatTokenBuilder` の HMAC 鍵を固定して試し、relay が拒否する場合は `TEST_MOQT_URI` に relay が受理する c4m を含める運用にする (新しい secret は増やさない)
- 観測点は `connectRelay` の戻り値の `state` / `errors` / `closeCode` とする。受理時は `state === "connected"`、`errors` が空、`closeCode === 0`。拒否時は `connectRelay` が reject するか、`errors` にエラーが入るか、`closeCode` が 0 以外になる。拒否の期待値は relay 実装のエラーコードに依存するため、まずは受理 (セッション確立) を固定する
- 送信側の構造は既存の `src/connect.test.ts` / `src/msf.test.ts` で固定済みである。本 issue では Node テストを追加しない。`src/message/setup.test.ts` も変更しない
- c4m を CAT のバイト列として解釈する判断は、devtools の `applyC4mFromUrl` と、ライブラリの `src/msf/c4mAuthorization.ts` の `createC4mAuthorizationToken` / `resolveMsfAuthorizationToken` にある。`src/msf/c4m.ts` の `getC4mParameter` は Base64 文字列を返すだけの契約を維持し、Token Type を知らないままにする
- 対象は `tests/e2e/relay/` に追加する spec とする。`playwright.config.ts` / `tests/e2e/main.ts` / `src/message/setup.test.ts` は変更しない。`src/msf/c4m.ts` / `src/msf/c4mAuthorization.ts` / `src/connect.ts` と devtools の signal も変更しない
- 対象外: Token Type の候補 UI (0705)、既定値の固定 (0704)、high-level API の decoder 解決の e2e (0700)、実リレーの他の経路 (0817)

## 完了条件

- `tests/e2e/relay/` に c4m 付きの MSF URL で接続する spec が追加され、Token Type 0x01 (CAT) のトークンでセッションが確立することを固定する
- 追加する spec は既存の `requireRelayUri` を使い、`TEST_MOQT_URI` が未設定の環境では skip する。skip の理由は日本語のテストログとして出る
- 送信側の構造は既存の `src/connect.test.ts` / `src/msf.test.ts` で固定済みである (c4m の Base64 → Token Type 1 / Alias Type USE_VALUE の SETUP トークン → `getSetupAuthorizationTokens` で同じ Token Type とバイト列)
- 追加する spec のコメントに、受理時 (`state === "connected"`、`errors` 空、`closeCode === 0`) と拒否時 (`connectRelay` が reject するか、`errors` / `closeCode` が受理時と異なる) の区別を書く
- `npx vp check` / `npx vp test --run` が通り、追加した spec は `npx vp run e2e-test:relay` で通る (`TEST_MOQT_URI` 未設定時は skip を含めて成功する)
- リレーが用意できない場合は、この issue を `issues/pending/` に移して理由 (確認手段が無い) を記録する

## 参照

- draft-ietf-moq-c4m-01 §2 (Token format) / §4 (Adding a token to a URL) / §7.1 Table 4 (0x01 = CAT) / §7.1.1 (CAT の Payload と relay の MUST)
- draft-ietf-moq-transport-22 §8.9 (Token Type の意味。Type 0 は表に無い型) / §9.1.4 (AUTHORIZATION TOKEN Setup Option 0x03) / §9.20.2 (AUTHORIZATION TOKEN Message Parameter 0x03) / §16.6 Table 13 (登録済みの型)
- draft-ietf-moq-msf-01 §11.1.1 (MSF URI Fragment の `c4m`。Base64 encoded C4M token)
- closed の `0652-bug-devtools-c4m-token-type.md` (送信側を 0x01 に直した。「残した課題」に本件がある)
- closed の `0784-test-add-relay-e2e-tests.md` (実リレーへ接続する harness を追加した。Authorization Token を伴う接続は対象外)
- `src/msf/c4m.ts` の `getC4mParameter` / `src/msf/c4mAuthorization.ts` の `createC4mAuthorizationToken` / `resolveMsfAuthorizationToken` / `src/connect.ts` の `connect`
- `src/msf.test.ts` の `getC4mParameter` / `createC4mAuthorizationToken` / `resolveMsfAuthorizationToken` テスト / `src/connect.test.ts` の `connect: msf fragment の c4m を SETUP の AUTHORIZATION TOKEN として送る`
- `src/message/setup.ts` の `createSetup` / `getSetupAuthorizationTokens` / `src/message/authorizationToken.ts` の `encodeAuthorizationToken` / `src/session/params.ts` の `encodeAuthorizationTokenParameter`
- `tests/e2e/relay/support.ts` / `tests/e2e/relay/connect.spec.ts` / `tests/e2e/main.ts` の `connectRelay` / `playwright.config.ts` / `.github/workflows/e2e-test.yml`
- `tests/e2e/devtools-authorization-token.spec.ts` (実リレーを起動しない既存の UI テスト) / `tests/e2e/devtools-audio.spec.ts` / `tests/e2e/devtools-audio-meter.spec.ts` (相互運用 harness に言及するコメント) / `README.md` の冒頭 WARNING
- 0817 (実リレーを使った E2E テストを増やす。c4m は本 issue で扱う)

## 解決方法

{未着手}
