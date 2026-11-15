# publisher 側 SUBSCRIBE_TRACKS の実機 E2E を追加する

- Created: 2026-11-15
- Completed: 2026-11-15
- Branch: feature/add-subscribe-tracks-relay-e2e
- Polished: {YYYY-MM-DD}

## 目的

publisher として受信する SUBSCRIBE_TRACKS の実装を、実リレーとの相互接続で検証する。単体テストでは relay が上流 publisher へ SUBSCRIBE_TRACKS を送るか、受理した要求へ PUBLISH を返して downstream の購読が確立するかを確認できない。

検証環境のリレーは draft-23 対応であり、CI の `e2e-test` の relay ジョブは実リレーへ接続して成功している (2026-11-15 時点で relay (1) は 17 passed)。`TEST_MOQT_URI` は CI の secret として設定されている。したがって「draft-23 対応のリレーが無い」という前提は誤りであり、本 issue と関連する記述を訂正する。

## 現状

- `tests/e2e/main.ts` の `window.__moqtE2E` は publisher / subscriber / fetch / namespace 系を公開するが、SUBSCRIBE_TRACKS を送る操作と、受信 SUBSCRIBE_TRACKS を観測する操作を公開していない
- `tests/e2e/relay/` に SUBSCRIBE_TRACKS を使う spec は無い。`tests/e2e/devtools-subscribe-tracks.spec.ts` は devtools の画面を使う別経路であり、リレー経由の publisher 側経路を検証しない
- `.github/workflows/e2e-test.yml` の冒頭コメントは「現状は検証環境に draft-23 対応のリレーが無いため」と書くが、事実と異なる
- `issues/closed/0960-add-publisher-subscribe-tracks.md` の「10. 前提」と、`issues/pending/0817-add-relay-tests.md` などいくつかの pending issue の pending 理由が同じ誤った前提に依存する
- `TEST_MOQT_URIS` (複数リレー) はリポジトリ内で未使用である

## 設計方針

- `tests/e2e/main.ts` に、SUBSCRIBE_TRACKS を送る `startTracksSubscriber` と、publisher が受信した SUBSCRIBE_TRACKS の回数と受理結果を観測する API を追加する。実ブラウザと実リレーだけを使い、モックは使わない
- publisher 側は catalog と媒体トラックの PUBLISH に加えて PUBLISH_NAMESPACE を送る (高レベル API の `announceNamespace` を有効にする)
- 単一リレーの spec は、publisher と subscriber を同じリレーへ接続し、subscriber が SUBSCRIBE_TRACKS で namespace を購読して映像が届くこと、publisher が SUBSCRIBE_TRACKS を受信して PUBLISH を返すことを確認する。relay が上流へ SUBSCRIBE_TRACKS を送らない場合に備え、観測結果を assert の前提にせず、実際の挙動を spec のコメントに記録する
- 複数リレーの spec は `TEST_MOQT_URIS` (カンマ区切り) を読み、publisher を 1 台目、subscriber を 2 台目へ接続する。未設定の環境では skip として記録する
- `.github/workflows/e2e-test.yml` で `TEST_MOQT_URIS` を relay ジョブへ渡す
- 誤った前提に依存する記述を訂正する (workflow のコメント、`issues/closed/0960` の前提、`issues/pending/0817` の pending 理由)
- 接続先のホストや URI をリポジトリへ書かない

## 完了条件

- 単一リレーの SUBSCRIBE_TRACKS E2E が、実リレーに対して通る
- `TEST_MOQT_URIS` を設定した環境では 2 ノードの E2E が通り、未設定では skip として記録される
- publisher が SUBSCRIBE_TRACKS を受信して PUBLISH を返すこと、downstream の購読が PUBLISH を受信することを assert する。結果 PUBLISH での映像 Object の配送は、リレーが上流へ送る通常 SUBSCRIBE との組み合わせに依存するため 0962 で扱う
- `vp check` と `vp test run` が通る
- workflow のコメントと、上記 issue の誤った前提を訂正する

## 参照

- `src/session/incomingSubscribeTracks.ts` / `src/session/publishedTracks.ts`
- `tests/e2e/main.ts` / `tests/e2e/relay/` / `tests/e2e/urls.ts` / `playwright.config.ts`
- `.github/workflows/e2e-test.yml`
- draft-ietf-moq-transport-23 §3.6 / §3.6.1 / §7.7 / §9.17 / §9.19.21
- 関連 issue: 0960 (publisher 側 SUBSCRIBE_TRACKS の実装)、0817 (実リレーの E2E 追加)、0956 / 0957 (devtools の SUBSCRIBE_TRACKS)

## 解決方法

- `tests/e2e/main.ts` に `startTracksSubscriber` / `getTracksSubscriber` / `stopTracksSubscriber` と、publisher が受信した SUBSCRIBE_TRACKS の観測 (`PublisherStatus.subscribeTracks`) を追加した。publisher は `announceNamespace: true` で PUBLISH_NAMESPACE と PUBLISH を同じセッションから送る
- `tests/e2e/relay/subscribe-tracks.spec.ts` を追加した。単一リレーと、`TEST_MOQT_URIS` (カンマまたは空白区切り) を使う 2 台のリレーの両方で、relay が SUBSCRIBE_TRACKS を上流 publisher へ転送し、publisher が受理して catalog と video の PUBLISH を返し、downstream の subscriber が PUBLISH を受信することを実リレーで検証する。2 本未満の環境では 2 台のテストだけを skip する
- `.github/workflows/e2e-test.yml` で `secrets.TEST_MOQT_URIS` を relay ジョブへ渡すようにした。冒頭コメントの「draft-23 対応のリレーが無い」という誤った前提を訂正した
- `.env.example` と `docs/DEVELOPMENT.md` に `TEST_MOQT_URIS` を追加し、`docs/IMPLEMENTATION_STATUS.md` の相互接続の記述を実態に合わせた
- `issues/closed/0960-add-publisher-subscribe-tracks.md` の前提と `issues/pending/0817-add-relay-tests.md` の pending 理由を訂正した
- 2026-11-15 の実行結果: 単一リレーと 2 台のリレーで 2 テストが通り、publisher の受信記録は `received: 1`、prefix は namespace と一致し、`accepted: true` であった
- 結果 PUBLISH での映像 Object の配送は、リレーが上流へ送る通常 SUBSCRIBE を moqt-js がクライアント専用のため処理できず実現しない。これは本 issue の範囲外とし、0962 で原因の確定と対応方針の決定を行う
