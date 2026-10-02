# relay-to-relay 通信がスコープ外であることを確認する

- Created: 2026-10-02
- Completed: 2026-10-03
- Branch: feature/update-relay-relay-scope
- Polished: 2026-10-02

## 目的

draft-ietf-moq-transport-22 §7 (Relays) は「For the purposes of this specification, a coordinated set of relays are treated as a single MOQT relay. How relays within such a set interconnect, and use cases built on relay to relay communication, are out of scope.」と明記した。moqt-js は CODEBASE.md のとおりクライアント専用であり、relay 間接続の実装を持たない。実装変更が不要であることを確認し、記録する (記録は CODEBASE.md への §7 の根拠を伴う 1 文追記)。

## 現状

- `CODEBASE.md` は「現時点ではブラウザでの利用のみを想定しているため、クライアントでのみ利用すること (MOQT の publisher / subscriber として接続する用途だけを対象とする)」「クライアント以外での用途の実装は不要であること (サーバー / リレーとしての動作は実装しない)」と定める
- `src/dataStream/fetch.ts` の `encodeFetchHeader` / `encodeFetchObjectFields` は「リレーサーバー実装用。moqt-js はクライアント専用のため、ランタイムでは使用しない。PBT（Property-Based Testing）でのラウンドトリップテストで使用。」というコメント付きで、ランタイムでは使わず PBT 専用である
- 受信 bidi ストリームの先頭メッセージは `src/session/incoming.ts` の `incomingClassifyFirstBidiMessage` で 3 分類される。SUBSCRIBE / FETCH / SUBSCRIBE_NAMESPACE / SUBSCRIBE_TRACKS / PUBLISH_NAMESPACE / TRACK_STATUS の 6 種は unsupported-request に分類され、同じファイルの `incomingHandleFirstBidiMessage` が `incomingSendRequestErrorAndClose` で REQUEST_ERROR (NOT_SUPPORTED、予約名前空間は DOES_NOT_EXIST) を応答してストリームを閉じる。受信 PUBLISH は処理対象 (`incomingPublishHandleBidirectionalStream`) であり未対応扱いではない
- relay 間の相互接続に関するコード・設定・API は存在しない (`src/index.ts` の公開 API はクライアント接続と publish / subscribe のみで、サーバー / relay 実装の export は無い)
- クライアント専用の記述自体は `CODEBASE.md` / `docs/LOW_LEVEL_API.md` (「moqt-js はクライアント専用実装であり、サーバー側の振る舞いは持たない」) / `README.md` (「他の MOQT Relay サーバーとの疎通確認は行っておらず、今後も予定はありません」) にあるが、draft-22 §7 の根拠付きで「relay 間の相互接続はスコープ外」と明記した箇所は存在しない

## 設計方針

- 実装コードの変更は行わない。記録として、`CODEBASE.md` の「クライアント以外での用途の実装は不要であること (サーバー / リレーとしての動作は実装しない)」の記述に、「Relay 間の相互接続 (relay to relay) は draft-ietf-moq-transport-22 §7 (Relays) により本仕様のスコープ外であり、実装しない」旨を 1 文追記する
- §7 のうちクライアントが関係する記述は該当する issue 側で扱う (paused subscription は 0800、Largest Object は §3.1.4 の概念であり 0804 が扱う)。relay 専用の規定 (キャッシュ (§7.1)、複数 publisher (§7.3)、Subscriber Interactions (§7.4)、Relay Resource Protection (§7.5)) と §7.4.1 (Graceful Subscriber Relay Switchover、MAY) は moqt-js の対象外であり本 issue でも扱わない。本 issue は relay 間接続のスコープ外確認と記録のみを対象とする

## 完了条件

- relay 間接続のコード・設定・API が存在しないことと、実装変更が不要であることが確認されている (確認結果は解決方法に記録する)
- `CODEBASE.md` に §7 の根拠付きで relay 間接続を対象外とする旨が追記されている
- `vp check` / `tsc --noEmit` / `vp test run` が通る

## 参照

- draft-ietf-moq-transport-22 §7 (Relays)
- `CODEBASE.md`
- `src/session/incoming.ts` の `incomingClassifyFirstBidiMessage` / `incomingHandleFirstBidiMessage` / `incomingSendRequestErrorAndClose`
- `src/dataStream/fetch.ts` の `encodeFetchHeader` / `encodeFetchObjectFields`

## 解決方法

draft-ietf-moq-transport-22 §7 (Relays) を正として、relay 間接続がスコープ外であることと実装変更が不要であることを確認し、`CODEBASE.md` に記録した。実装コードの変更はない。

### 1. 確認結果 (relay 間接続のコード・設定・API は存在しない)

- `src/index.ts` の公開 API はクライアント接続と publish / subscribe のみで、relay / サーバー実装の export は無い
- `src/` の "relay" の言及はコメント (relay の挙動説明) のみである
- `src/dataStream/fetch.ts` の `encodeFetchHeader` / `encodeFetchObjectFields` は「リレーサーバー実装用。moqt-js はクライアント専用のため、ランタイムでは使用しない。PBT でのラウンドトリップテストで使用。」というコメント付きで、`src/index.ts` から非 export であり relay 間接続の実装ではない
- `devtools/` の relay は接続先 URL の設定 (`serverUrlStore` / `ConnectionSettings`) のみである
- `package.json` の `e2e-test:relay` / `playwright.config.ts` の relay project / `tests/e2e/relay/*` / `.env.example` の `TEST_MOQT_URI` はクライアントから実リレーへの接続テストであり、relay 間接続ではない
- `rg "relay.to.relay|relay to relay|リレー間|相互接続"` のヒットは `CODEBASE.md` と本 issue のみである
- 受信 bidi ストリームの先頭が relay 専用メッセージになる経路は無い (`incomingClassifyFirstBidiMessage` の 3 分類で、relay 間接続に相当する分類は無い)

### 2. 記録

`CODEBASE.md` の「クライアント以外での用途の実装は不要であること」の項目に、§7 の逐語 (coordinated set of relays を単一の MOQT relay として扱い、その内部の接続方法と relay to relay のユースケースは out of scope) を根拠として、relay 間の相互接続は本仕様の対象外として実装しない旨を 1 文追記した。

`CODEBASE.md` の変更は shiguredo-git の特別ルール (AGENTS.md / CODEBASE.md は「整備」の 1 語でコミットし、develop に直接コミットする) に従って develop に直接コミットした。そのため本 issue は PR を作成していない。

CHANGES.md への追記は行っていない。shiguredo-changelog のとおり `.md` ファイルの変更は変更履歴に反映せず、ライブラリの利用者に見える変更も無いためである。

### 3. 検証

`vp check` (1284 files 整形 / 475 files lint・型エラーなし) / `tsc --noEmit` / `vp test run` (198 files / 3568 tests) が通る。`/review-diff-code` で引用の逐語一致と、リポジトリ横断での relay 間接続の不在を確認した。
