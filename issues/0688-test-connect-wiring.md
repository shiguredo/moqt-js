# connect() のオプション配線がテストで固定されていない

- Created: 2026-09-24
- Completed: {YYYY-MM-DD}
- Branch: feature/test-connect-wiring
- Polished: 2026-09-24

## 目的

`connect()` は WebTransport の実体を必要とするため Node の単体テストで最後まで駆動できず、URL の正規化と `new WebTransport` のオプション以外はテストされていない。`ConnectOptions` の optional フィールドが `session.initialize` へ、`fragment` / `pendingSubgroup` が `SessionImpl` へ渡る配線は、どれか 1 つを落としてもテストが落ちない。closed の `0646-bug-data-stream-buffer-limit.md` が `dataStreamMaxBufferBytes` を追加したときも、`connect()` の配線は未テストのまま `initialize` を直接呼ぶテストだけで固定された。0646 の「残した課題」にも `connect()` 経由の配線テストが無いことが記録されている。

## 現状

- `src/connect.ts` の `connect` (44-117 行目) が組み立てるのは 4 つである。`normalizeMoqtUri` の結果 (49 行目)、`WebTransportOptions` (`serverCertificateHashes` 58-60 行目、`protocols: ["moqt-21"]` 69 行目)、`SessionImpl` の options (`pendingSubgroup` / `fragment`。77-80 行目)、`session.initialize` の options (90-114 行目)
- `initialize` へ渡す 9 フィールドは `authorizationToken` / `moqtImplementation` / `grease` / `maxAuthTokenCacheSize` / `maxRequestUpdates` / `maxFilterRanges` / `controlMessageTimeoutMs` / `dataStreamTimeoutMs` / `dataStreamMaxBufferBytes` で、`ConnectOptions` (`src/session/publicTypes.ts` 119 行目以降) の同名フィールドを 1 つずつ conditional spread で写している
- `connect()` を駆動するテストは `src/session.test.ts` の「connect: WebTransport に protocols ['moqt-21'] を渡す」(8412-8437 行目) の 1 件だけである。`globalThis.WebTransport` を `RecordingWebTransport` (8415 行目) に差し替え、`ready` を reject (8420 行目) させて `new WebTransport` の options だけを観測する。`connect()` の呼び出し (8426 行目) は `await transport.ready` で reject するため、そのあとの `SessionImpl` の構築と `initialize` には到達しない
- `initialize` 側のオプション反映は `src/session.test.ts` の `initialize()` を直接呼ぶテストで固定されている (8200 行目付近の SETUP 広告、6283 行目以降の受信バッファ上限)。`connect()` から値を渡す経路は検証されない
- 公開の `Session` インターフェース (`src/session.ts` 151 行目) に `initialize` は無く、`SessionImpl.initialize` (661-663 行目) は内部メソッドである。`connect()` の戻り値から `initialize` を呼び直して観測することもできない
- `src/createMedia/connect.ts` の `connectMediaSession` (36-57 行目) は `MediaConnectSettings` (15-28 行目) の `url` / `serverCertificateHashes` / `authorizationToken` / `pendingSubgroup` の 4 つだけを `ConnectOptions` へ写す。`src/createMediaSubscriber.ts` の `connectToServer` (550 行目) と `src/createMediaPublisher.ts` の `connectToServer` (578 行目) はこの関数を呼ぶため、タイムアウトと受信バッファ上限は高レベル API から渡す手段が無い
- e2e の `tests/e2e/webtransport-devtools.spec.ts` (コメントは 3-6 行目) は devtools の UI だけを検証する。devtools は自前で `new WebTransport` を呼ぶ (`devtools/src/webtransport-devtools/signals.ts` の 673 行目) ため moqt-js の `connect()` を通らない。`playwright.config.ts` の `webServer` も devtools の dev サーバー (5173) のみで、MOQT の WebTransport サーバーは立てない
- `CODEBASE.md` は「Node.js が WebTransport に正式対応したら、テスト用としてサーバー対応も行うこと」としており、Node の単体テストで `connect()` を最後まで駆動する前提が無い
- 0646 の「残した課題」に「`connect()` 経由の end-to-end 配線テストは無い (WebTransport の実体が必要。`initialize` 経由で固定)」と記録されている

## 設計方針

- `connect()` の組み立てを純粋関数へ切り出して export し、`connect()` 本体はそれを呼ぶだけにする。切り出す単位は次の 3 つである
  - `connectBuildTransportOptions(options)` → `WebTransportOptions`。`serverCertificateHashes` は空配列を載せない (58-60 行目と同じ条件)。`protocols` は常に `["moqt-21"]`
  - `connectBuildSessionOptions(options, fragment)` → `SessionImpl` の options。`pendingSubgroup` が undefined なら載せない
  - `connectBuildInitializeOptions(options)` → `initialize` の options。undefined のフィールドを載せない (`exactOptionalPropertyTypes` のため、載せると型エラーになる)
- `src/connect.test.ts` を新設する。`src/session.test.ts` は 1 ファイルが大きく、`connect()` のテストが `RecordingWebTransport` の差し替えに埋もれているため分離する。固定する内容は次の 3 点である
  - `ConnectOptions` の全フィールドを指定したとき、`initialize` の options に全フィールドが同じ値で載る。1 フィールドずつ assert し、まとめての deepEqual は使わない (落ちたフィールドを特定できるようにする)
  - 未指定のフィールドが載らない (`Object.keys` で確認する)
  - `serverCertificateHashes: []` が `WebTransportOptions` に載らず、`protocols` が常に `["moqt-21"]` である
- `src/createMedia/connect.ts` の `ConnectOptions` の組み立ても `connectBuildConnectOptions(settings)` として純粋関数へ切り出し、`connectMediaSession` から呼ぶ。写す 4 フィールドと空配列を載せない条件を単体テストで固定する
- `MediaConnectSettings` にタイムアウトと受信バッファ上限のフィールドを足すことは本 issue の対象外とする。オプション自体の追加になりカテゴリ `test` の範囲を超えるため、`connect()` 側の配線は `connectBuildInitializeOptions` のテストで固定する
- 実サーバーを立てる e2e は対象外とする。`CODEBASE.md` が Node.js の WebTransport 対応待ちとしており、Chromium の e2e で MOQT サーバーを立てる仕組みがリポジトリに無い。`tests/e2e/webtransport-devtools.spec.ts` は devtools の UI 専用のままにする
- 純粋関数の外に残るのは `new WebTransport(httpsUrl, transportOptions)` の 2 引数と `await transport.ready` の待機順序だけである。この 2 つは既存の `RecordingWebTransport` のテスト (8412-8437 行目) が引き続き守る
- 公開 API のシグネチャは変えない。切り出した関数は `src/index.ts` から export しない (内部関数)
- 利用者から見た挙動の変更が無いため `CHANGES.md` には追記しない

## 完了条件

- `connect()` の組み立てが純粋関数 (`connectBuildTransportOptions` / `connectBuildSessionOptions` / `connectBuildInitializeOptions`) として export され、`connect()` はそれらを呼ぶだけになっている
- `src/connect.test.ts` に、`ConnectOptions` の全フィールドが `initialize` の options へ渡ること、未指定のフィールドが載らないこと、`protocols` が `["moqt-21"]` であること、`serverCertificateHashes: []` が載らないことを固定するテストがある
- `connectMediaSession` の `ConnectOptions` の組み立てが純粋関数へ切り出され、4 フィールドの写し方と空配列の除外がテストで固定されている
- 切り出した関数が `src/index.ts` の公開面に含まれない
- `connect()` の戻り値の型と `ConnectOptions` の型が変わらない
- `tests/e2e/webtransport-devtools.spec.ts` を変更しない
- `npx vp check` / `npx vp test --run` が通る

## 参照

- draft-ietf-moq-transport-21 §6.2 / §6.2.1 (セッション確立と ALPN / WT-Available-Protocols)
- closed `0646-bug-data-stream-buffer-limit.md` (`connect()` 経由の配線テストが無いことを残した課題とした)
- `src/session.test.ts` の「connect: WebTransport に protocols ['moqt-21'] を渡す」(8412-8437 行目。現在唯一の `connect()` テスト)
- `CODEBASE.md` (Node.js の WebTransport 対応待ち。e2e で実サーバーを立てない根拠)

## 解決方法

{未着手}
