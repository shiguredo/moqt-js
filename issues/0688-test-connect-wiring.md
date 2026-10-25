# connect() のオプション配線がテストで固定されていない

- Created: 2026-09-24
- Completed: {YYYY-MM-DD}
- Branch: feature/test-connect-wiring
- Polished: 2026-10-25

## 目的

`connect()` は `ConnectOptions` の各フィールドを `WebTransportOptions`、`SessionImpl` の options、`session.initialize` の options へ振り分ける。`src/connect.test.ts` は手書きの WebTransport 代役 (`installSetupHandshakeTransport`) で `connect()` を SETUP の交換まで駆動しているが、`authorizationToken` 以外の `ConnectOptions` の配線を assert していない。`fragment` / `pendingSubgroup` の `SessionImpl` への配線と、`serverCertificateHashes` の `WebTransportOptions` への配線も固定されていない。`initialize` のオプションのうち wire に出ないタイムアウトと受信バッファ上限は、公開の `Session` インターフェースから観測できない。

closed の `0646-bug-data-stream-buffer-limit.md` が `dataStreamMaxBufferBytes` を追加したときも、`connect()` の配線は未テストのまま `initialize` を直接呼ぶテストだけで固定された。0646 の「残した課題」にも `connect()` 経由の配線テストが無いことが記録されている。closed の `0686-bug-session-wide-data-stream-buffer-cap.md` が追加した `dataStreamMaxTotalBufferBytes` も同じ状態である。

## 現状

- `src/connect.ts` の `connect` は、`normalizeMoqtUri` の結果、`assertMsfConnectionSupported`、`resolveMsfAuthorizationToken`、`WebTransportOptions`、`SessionImpl` の options、`session.initialize` の options を組み立てる。`WebTransportOptions` には `serverCertificateHashes` を空でないときだけ載せ、`protocols` に `["moqt-22"]` を常に載せる。`SessionImpl` の options には `pendingSubgroup` を定義済みのときだけ載せ、`fragment` を常に載せる。`session.initialize` には `authorizationToken` / `moqtImplementation` / `grease` / `maxAuthTokenCacheSize` / `maxRequestUpdates` / `maxFilterRanges` / `controlMessageTimeoutMs` / `dataStreamTimeoutMs` / `dataStreamMaxBufferBytes` / `dataStreamMaxTotalBufferBytes` の 10 フィールドを、定義済みのときだけ conditional spread で載せる
- `authorizationToken` は `options.authorizationToken` が定義済みならそれを、未定義なら MOQT URI の msf fragment の `c4m` から `resolveMsfAuthorizationToken` で解決した値を使う。`c4m` の復号に失敗すると `new WebTransport` を作る前に throw する
- `ConnectOptions` (`src/session/publicTypes.ts` の `ConnectOptions`) は `serverCertificateHashes` / `authorizationToken` / `maxAuthTokenCacheSize` / `maxRequestUpdates` / `maxFilterRanges` / `pendingSubgroup` / `controlMessageTimeoutMs` / `dataStreamTimeoutMs` / `dataStreamMaxBufferBytes` / `dataStreamMaxTotalBufferBytes` / `moqtImplementation` / `grease` を持つ。このうち `serverCertificateHashes` は `WebTransportOptions` へ、`pendingSubgroup` は `SessionImpl` の options へ、残りの 10 フィールドは `session.initialize` へ渡る
- `src/connect.test.ts` は `installSetupHandshakeTransport` で `globalThis.WebTransport` を手書きの代役に差し替え、`connect()` を SETUP の交換まで駆動するテストを 5 件持つ。固定しているのは `c4m` の `authorizationToken`、`options.authorizationToken` の優先、fragment を WebTransport の URL に渡さないこと、`c4m` が無いときトークンを送らないこと、復号できない `c4m` で `new WebTransport` を作る前に throw することである。`ConnectOptions` の他のフィールドは assert していない
- `src/session.test.ts` の「connect: WebTransport に protocols ['moqt-22'] を渡す」は `RecordingWebTransport` で `new WebTransport` の options を観測し、`ready` を reject させて `initialize` へ進まない。観測するのは `protocols` だけで、`serverCertificateHashes` は観測しない
- `src/session.test.ts` の「initialize: SETUP で上限を広告し localMaxFilterRanges と受信バッファ上限を保持する」は `session.initialize` を直接呼び、`maxAuthTokenCacheSize` / `maxRequestUpdates` / `maxFilterRanges` / `dataStreamMaxBufferBytes` / `dataStreamMaxTotalBufferBytes` の反映を固定する。データストリームの上限超過テストは `createDataStreamFinContext` が `SessionImpl` の内部フィールドを直接設定しており、`initialize` を経由しない (「initialize() を経由せずタイムアウト値とバッファ上限だけを差し替える」)。`connect()` から `authorizationToken` 以外の値を渡す経路は検証されない
- 公開の `Session` インターフェース (`src/session.ts` の `Session`) に `initialize` は無く、`SessionImpl.initialize` は内部メソッドである。`connect()` の戻り値の型は `Session` であり、`initialize` を呼び直して観測することはできない
- `src/createMedia/connect.ts` の `connectMediaSession` は `settings.url` を `connect()` の第 1 引数へ渡し、`serverCertificateHashes` / `authorizationToken` / `pendingSubgroup` の 3 フィールドを `ConnectOptions` へ写す。`serverCertificateHashes` は `ArrayBuffer[]` から `CertificateHash[]` (`algorithm: "sha-256"`) へ変換し、空配列は載せない。`onSessionClose` / `onSessionError` は `ConnectCallbacks` へ写す。`src/createMediaSubscriber.ts` の `connectToServer` と `src/createMediaPublisher.ts` の `connectToServer` はこの関数を呼ぶ
- `tests/e2e/webtransport-devtools.spec.ts` は devtools の UI だけを検証する。devtools は `devtools/src/webtransport-devtools/signals.ts` で自前の `new WebTransport` を呼ぶため moqt-js の `connect()` を通らない。`playwright.config.ts` の `webServer` は devtools、relay 用ページ、production preview の HTTP サーバーを動的な空きポートで立てるが、MOQT の WebTransport サーバーは立てない。実リレーを使う e2e は `TEST_MOQT_URI` の外部依存である
- `CODEBASE.md` は「Node.js が WebTransport に正式対応したら、テスト用としてサーバー対応も行うこと」としており、実サーバーを立てるテストの前提が無い。`src/connect.test.ts` は手書きの代役で `connect()` を SETUP まで駆動するが、`initialize` のオプションのうち wire に出ないものは代役からも観測しにくい
- 0646 の「残した課題」に「`connect()` 経由の end-to-end 配線テストは無い (WebTransport の実体が必要。`initialize` 経由で固定)」と記録されている

## 設計方針

- `connect()` の組み立てを純粋関数へ切り出して export し、`connect()` 本体はそれらを呼ぶだけにする。切り出す単位は次の 3 つである
  - `connectBuildTransportOptions(options)` → `WebTransportOptions`。`serverCertificateHashes` は空配列を載せない (現行の `connect` と同じ条件)。`protocols` は常に `["moqt-22"]`
  - `connectBuildSessionOptions(options, fragment)` → `SessionImpl` の options。`pendingSubgroup` が undefined なら載せない。`fragment` は常に載せる
  - `connectBuildInitializeOptions(options, authorizationToken)` → `ConnectionInitializeOptions` (`initialize` の options)。undefined のフィールドを載せない (`exactOptionalPropertyTypes` のため、載せると型エラーになる)。`authorizationToken` は `connect()` が `options.authorizationToken` または fragment の `c4m` から解決した値を引数で渡し、関数は `options.authorizationToken` を直接読まない。`connect()` は現行どおり `new WebTransport` を作る前に `authorizationToken` を解決し、`c4m` の復号失敗時に WebTransport を作らない挙動を保つ
- `src/connect.test.ts` は既に存在する。新設せず、既存の `installSetupHandshakeTransport` とテスト群に次のテストを追加する。`src/session.test.ts` は 1 ファイルが大きく、`connect()` のテストが `RecordingWebTransport` の差し替えに埋もれているため、`connect()` のテストは `src/connect.test.ts` に置く
  - `connectBuildInitializeOptions`: `initialize` へ渡す 10 フィールド (`authorizationToken` / `moqtImplementation` / `grease` / `maxAuthTokenCacheSize` / `maxRequestUpdates` / `maxFilterRanges` / `controlMessageTimeoutMs` / `dataStreamTimeoutMs` / `dataStreamMaxBufferBytes` / `dataStreamMaxTotalBufferBytes`) をすべて指定し、1 フィールドずつ assert する (まとめての deepEqual は使わない)。`authorizationToken` は第 2 引数で渡す。未指定のフィールドが載らないことを `Object.keys` で確認する
  - `connectBuildSessionOptions`: `pendingSubgroup` が定義済みなら載り、undefined なら載らないこと、`fragment` がそのまま載ることを assert する
  - `connectBuildTransportOptions`: `serverCertificateHashes` が空でないときは載り、空配列のときは載らないこと、`protocols` が常に `["moqt-22"]` であることを assert する
  - `src/createMedia/connect.ts` の `ConnectOptions` の組み立ても `connectBuildConnectOptions(settings)` として純粋関数へ切り出し、`connectMediaSession` から呼ぶ。`connectBuildConnectOptions` は `url` を含まない (`url` は `connectMediaSession` が `connect()` の第 1 引数へ渡す)。`serverCertificateHashes` は `ArrayBuffer[]` から `CertificateHash[]` (`algorithm: "sha-256"`) へ変換し、空配列を載せない。`authorizationToken` / `pendingSubgroup` は定義済みのときだけ載せる。`src/createMedia/connect.test.ts` を新設し、これらの変換と未指定時の除外を固定する
- 実サーバーを立てる e2e は対象外とする。`CODEBASE.md` が Node.js の WebTransport 対応待ちとしており、Chromium の e2e で MOQT サーバーを立てる仕組みがリポジトリに無い。`tests/e2e/webtransport-devtools.spec.ts` は devtools の UI 専用のままにする
- 純粋関数で固定できない実行時の配線は、`new WebTransport(httpsUrl, transportOptions)` の 2 引数、`await transport.ready` の待機順序、`session.initialize` へ組み立てた options を渡す呼び出しである。このうち `new WebTransport` の URL と `ready` の待機順序は既存の `src/session.test.ts` の `RecordingWebTransport` テストと `src/connect.test.ts` の代役テストが守る。`session.initialize` へ渡す呼び出しは `connect()` が `connectBuildInitializeOptions` の戻り値をそのまま渡すことをコードで確認する
- 公開 API のシグネチャは変えない。切り出した関数は `src/index.ts` から export しない (内部関数)
- 利用者から見た挙動の変更が無いため `CHANGES.md` には追記しない

## 完了条件

- `connect()` の組み立てが純粋関数 (`connectBuildTransportOptions` / `connectBuildSessionOptions` / `connectBuildInitializeOptions`) として export され、`connect()` はそれらを呼ぶだけになっている
- `src/connect.test.ts` に、`connectBuildInitializeOptions` が `initialize` へ渡す 10 フィールドをすべて載せること、未指定のフィールドが載らないこと、`connectBuildSessionOptions` が `pendingSubgroup` と `fragment` を載せること、`connectBuildTransportOptions` が空でない `serverCertificateHashes` を載せ、空配列を載せず、`protocols` を `["moqt-22"]` にすることのテストがある
- `connectMediaSession` の `ConnectOptions` の組み立てが `connectBuildConnectOptions` として純粋関数へ切り出され、`serverCertificateHashes` の `CertificateHash[]` への変換、`authorizationToken` / `pendingSubgroup` の写し、空配列の除外が新設した `src/createMedia/connect.test.ts` で固定されている
- 切り出した関数が `src/index.ts` の公開面に含まれない
- `connect()` の戻り値の型と `ConnectOptions` の型が変わらない
- `tests/e2e/webtransport-devtools.spec.ts` を変更しない
- `npx vp check` / `npx vp test --run` が通る

## 参照

- draft-ietf-moq-transport-22 §6.2 / §6.2.1 (セッション確立と ALPN / WT-Available-Protocols)
- closed `0646-bug-data-stream-buffer-limit.md` (`connect()` 経由の配線テストが無いことを残した課題とした)
- closed `0686-bug-session-wide-data-stream-buffer-cap.md` (`dataStreamMaxTotalBufferBytes` を `ConnectOptions` から `connect` 経由で追加した)
- `src/connect.test.ts` (`installSetupHandshakeTransport` と `connect()` の既存テスト)
- `src/session/connection.ts` の `ConnectionInitializeOptions` (`initialize` の options の型)
- `src/session.test.ts` の「connect: WebTransport に protocols ['moqt-22'] を渡す」と「initialize: SETUP で上限を広告し localMaxFilterRanges と受信バッファ上限を保持する」
- `CODEBASE.md` (Node.js の WebTransport 対応待ち。e2e で実サーバーを立てない根拠)

## 解決方法

{未着手}
