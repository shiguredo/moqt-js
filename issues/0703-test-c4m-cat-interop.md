# c4m から取り込んだ CAT が relay 側で受理されるか未検証

- Created: 2026-09-24
- Completed: {YYYY-MM-DD}
- Branch: feature/test-c4m-cat-interop
- Polished: 2026-09-24

## 目的

closed の `0652-bug-devtools-c4m-token-type.md` で devtools が送る Token Type を 0x01 (CAT) に直した。しかし `src/msf/c4m.ts` は MSF URI Fragment の `c4m` を Base64 文字列として扱うだけで Token Type を知らず、`tests/e2e/` には実リレーを起動する相互運用 harness が無い。

そのため「c4m から取り込んだトークンが Token Type 0x01 (CAT) として relay に受理されるか」は自動テストで覆われていない。送信側が 0x01 を載せること (0652) と、受信側がそれを CAT として検証して通すこと (draft-ietf-moq-c4m-01 §7.1.1 の MUST) は別の話であり、後者は実リレーとの疎通でしか確認できない。テストのコメントが言及する「相互運用 harness」はリポジトリ内に実体が無い。

## 現状

- `src/msf/c4m.ts` の `getC4mParameter` (80 行目) は `c4m` の値を Base64 文字列のまま返す (JSDoc 74-79 行目「base64 文字列のまま返す。検証しない。」)。同ファイルに Token Type を扱う型も値も無い
- `src/msf.test.ts` は `getC4mParameter` の文字列レベルの挙動 (最初の `c4m` を返す 1954 行目 / 該当なしは undefined 1962 行目 / 空文字列もそのまま返す 1967 行目) だけを固定する
- devtools 側は `devtools/src/utils/c4m.ts` の `extractC4mBase64` (16 行目) で Base64 を取り出し、`devtools/src/signals/connectionSettings.ts` の `applyC4mFromUrl` (157 行目) が `authorizationTokenType.value = "1"` を設定する (166 行目)。`buildAuthorizationToken` (104 行目) が Base64 を復号した生バイト列を `tokenValue` にし (105-115 行目)、Token Type を 10 進文字列から bigint にする (117-121 行目)
- 送信は SETUP では `src/message/setup.ts` の `createSetup` (61 行目) が `SetupOptionType.AUTHORIZATION_TOKEN` (74 行目) として `encodeAuthorizationToken` (75 行目) を積む (draft-ietf-moq-transport-21 §9.1.4)。SUBSCRIBE などでは `src/session/params.ts` の `encodeAuthorizationTokenParameter` (734 行目) が Message Parameter 0x03 を積む (§9.20.3)
- トークン構造の符号化は `src/message/authorizationToken.ts` の `encodeAuthorizationToken` (89 行目) で、Alias Type / Token Type / Token Value を varint と長さ付きバイト列で書く
- `tests/e2e/` の webServer は devtools の dev サーバーだけである (`playwright.config.ts`)。`tests/e2e/devtools-authorization-token.spec.ts` は 4-5 行目に「実リレーは起動しない」と明記し、Token Type が `"1"` になることまでを固定する (24 行目)
- 「相互運用 harness」はテストのコメントに登場する (`tests/e2e/devtools-audio.spec.ts` 4 行目「音声 object の到達は相互運用 harness 側で検証する」、`tests/e2e/devtools-audio-meter.spec.ts` 5 行目 / 154 行目) が、リポジトリ内に実体が無い。`README.md` 12-13 行目は「時雨堂が開発している MOQT Relay サーバーとのみ疎通確認を行っている」と述べる
- 受信側の要件: draft-ietf-moq-c4m-01 §7.1 Table 4 は 0x01 を CAT として登録し、§7.1.1 は「Token Type が 0x01 のとき Token Payload は CBOR エンコードされた CWT として直列化した CAT」と定め、relay の MUST (署名 / MAC の検証、有効期限と標準クレームの確認、`moqt` claim と `moqt-reval` claim の処理、DPoP claim の処理) を列挙する。検証に失敗したトークンは接続または操作を拒否する MUST
- §2 は本ドラフトが単一のトークン形式 (CAT) を使い、URL に載せるときは Base64 エンコードすると定める。§4 は URL への追加方法をアプリケーションの裁量とする
- draft-ietf-moq-transport-21 §16.6 Table 12 の登録は 0x0 (Reserved、仕様は §8.9) と greasing 用の範囲 (`0x7f * N + 0x9D`) だけであり、0x01 は c4m が登録する。§8.9 は Type 0 を「表に無い型であり out-of-band で交渉する」と定める
- したがって、送信側が「Base64 を復号したバイト列を Token Type 1 で送る」ことと、relay が「そのバイト列を CBOR の CWT として検証して通す」ことは別であり、後者の確認手段が無い

## 設計方針

- 実リレーを起動する相互運用 harness を作る。`playwright.config.ts` の `webServer` にリレー (Sora の Media over QUIC 実装である sora-moq。リレー機能を提供する) を追加し、devtools または専用のテストページから c4m 付きの MSF URL で接続して、SETUP の AUTHORIZATION_TOKEN (0x03) が受理されてセッションが確立することを固定する
  - リレーの起動コマンドと待ち受け URL は環境依存である。リポジトリの他テストに env 依存の skip の前例が無いため、harness を足す場合は「リレーの URL を環境変数で受け取り、未設定なら skip する」形を第一案とし、CI で常時動かすかは別途決める
  - リレーが用意できない場合は harness を作らず、この issue を `issues/pending/` に移す (確認手段が無いまま完了にしない)
- リレーが無い環境でも確認できる範囲として、送信側の構造を Node で往復させるテストを足す。`createSetup` で Alias Type USE_VALUE / Token Type 1 / Token Value が Base64 を復号した生バイト列の SETUP を作り、`src/message/setup.ts` の `getSetupAuthorizationTokens` (223 行目) で戻して Token Type 1 とバイト列が一致することを固定する (`src/message/setup.test.ts` に追加する)。これは relay の受理の証明にはならないが、c4m → SETUP の変換が仕様どおりであることを固定できる
- c4m の Base64 を「CAT のバイト列」として解釈する判断 (Token Type を 1 にする) は devtools の `applyC4mFromUrl` に閉じている。`src/msf/c4m.ts` は Base64 文字列を返すだけの現状の契約を維持し、Token Type を知らないままにする (MSF の `c4m` は Base64 文字列であり、Token Type は MOQT の AUTHORIZATION TOKEN の層であるため)
- 検証の観測点は、relay が受理した場合と拒否した場合の区別 (セッション確立の成否と、拒否されたときのエラーコード) とする。拒否の期待値は relay 実装のエラーコードに依存するため、まずは受理 (セッション確立) を固定する
- 対象は `tests/e2e/` / `playwright.config.ts` / 必要なら `src/message/setup.test.ts` とする。`src/msf/c4m.ts` と devtools の signal は変更しない
- 対象外: Token Type の候補 UI (0705)、既定値の固定 (0704)、high-level API の decoder 解決の e2e (0700)

## 完了条件

- 実リレーを起動する相互運用 harness が `tests/e2e/` にあり、c4m 付きの MSF URL から作った Token Type 0x01 (CAT) のトークンでセッションが確立することを固定する
- harness は実リレーが用意できない環境で失敗せず、未設定であることが分かる形で skip する (環境変数の名前と既定の扱いをテストのコメントに書く)
- 送信側の構造が Node で固定される (c4m の Base64 → Token Type 1 / Alias Type USE_VALUE の SETUP トークン → デコードで同じ Token Type とバイト列)
- relay が拒否した場合の観測 (エラーコードを含む) が harness のコメントに書かれ、受理の確認と区別できる
- `npx vp check` / `npx vp test --run` が通り、harness を足した場合は `npx vp run e2e-test` が通る (リレー未設定時は skip を含めて成功する)
- リレーが用意できない場合は、この issue を `issues/pending/` に移して理由 (確認手段が無い) を記録する

## 参照

- draft-ietf-moq-c4m-01 §2 (Token format) / §4 (Adding a token to a URL) / §7.1 Table 4 (0x01 = CAT) / §7.1.1 (CAT の Payload と relay の MUST)
- draft-ietf-moq-transport-21 §8.9 (Token Type の意味。Type 0 は表に無い型) / §9.1.4 (AUTHORIZATION TOKEN Setup Option 0x03) / §9.20.3 (AUTHORIZATION TOKEN Message Parameter 0x03) / §16.6 Table 12 (登録済みの型)
- draft-ietf-moq-msf-01 §11.1.1 (MSF URI Fragment の `c4m`。Base64 encoded C4M token)
- closed の `0652-bug-devtools-c4m-token-type.md` (送信側を 0x01 に直した。「残した課題」に本件がある)
- `src/msf/c4m.ts` の `getC4mParameter` / `src/msf.test.ts` の `getC4mParameter` テスト / `src/message/setup.ts` の `createSetup` / `src/message/authorizationToken.ts` の `encodeAuthorizationToken`
- `tests/e2e/devtools-authorization-token.spec.ts` (実リレーを起動しない既存の UI テスト) / `tests/e2e/devtools-audio.spec.ts` (相互運用 harness に言及するコメント) / `README.md` 12-13 行目 (疎通確認の範囲)

## 解決方法

{未着手}
