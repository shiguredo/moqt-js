# publisher 側 SUBSCRIBE_TRACKS の実機 E2E を追加する

- Created: 2026-11-15
- Completed: 2026-11-16
- Branch: feature/add-subscribe-tracks-e2e-object-assert
- Polished: 2026-11-15

## 目的

publisher として受信する SUBSCRIBE_TRACKS の実装を、実リレーとの相互接続で検証する。単体テストでは、relay が上流 publisher へ SUBSCRIBE_TRACKS を送るか、その結果 downstream の購読が映像を受信するかは確認できない。publisher が受理した要求へ PUBLISH を返すこと自体は単体テストで確認できるが、実リレーを経由した PUBLISH の返却と downstream の購読確立は実機でしか確認できない。実リレーが上流へ SUBSCRIBE_TRACKS を送る場合は、publisher の受信、PUBLISH 返却、downstream の映像受信を検証する。送らない場合は、その実測を spec のコメントに記録し、downstream の映像受信だけを検証する。

検証環境のリレーは draft-23 対応であり、CI の `e2e-test` の relay ジョブは実リレーへ接続して成功している (2026-11-15 の CI run 43708580399 で relay (1) / relay (2) が成功し、relay (1) は 17 passed)。`TEST_MOQT_URI` は CI の secret として設定されている。したがって「draft-23 対応のリレーが無い」という前提は誤りであり、本 issue と関連する記述を訂正する。

## 現状

- `tests/e2e/main.ts` の `window.__moqtE2E` は publisher / subscriber / fetch / namespace 系を公開するが、SUBSCRIBE_TRACKS を送る操作と、受信 SUBSCRIBE_TRACKS を観測する操作を公開していない
- `tests/e2e/relay/` に、SUBSCRIBE_TRACKS を送って publisher 側の受信と PUBLISH 返却を観測する spec は無い。devtools の subscriber を使う relay spec (`devtools-both-audio.spec.ts` など) は既定で SUBSCRIBE_TRACKS を送るが、publisher が受信した SUBSCRIBE_TRACKS と PUBLISH 返却は観測していない。`tests/e2e/devtools-subscribe-tracks.spec.ts` はリレーを起動せず devtools の画面だけを検証する別経路である
- `.github/workflows/e2e-test.yml` の冒頭コメントは「現状は検証環境に draft-23 対応のリレーが無いため」と書くが、事実と異なる
- `issues/closed/0960-add-publisher-subscribe-tracks.md` の「10. 前提」と、`issues/pending/` の `0703-test-c4m-cat-interop.md` / `0817-add-relay-tests.md` / `0845-test-devtools-publish-stop-e2e.md` / `0931-test-relay-onerror-count.md` / `0946-update-namespace-match-semantics.md` の pending 理由にある「draft-23 対応のリレーが無い」という記述が同じ誤った前提に依存する。0703 は CAT トークンの受理確認が別途必要なため、記述の訂正だけでは pending を解消しない
- `TEST_MOQT_URIS` (複数リレー) はリポジトリ内で未使用である

## 設計方針

- `tests/e2e/main.ts` に、SUBSCRIBE_TRACKS を送る `startTracksSubscriber` と、publisher が受信した SUBSCRIBE_TRACKS の回数と受理結果を観測する API を追加する。publisher 側の観測は `createMediaPublisher` の `MediaPublisherOptions.authorizeSubscribeTracks` に記録用のハンドラを渡して行う (`MediaPublisher` は `Session.getStatistics()` を公開していないため、統計値ではなく受信要求のコールバックで記録する)。受理判定は配信 namespace との prefix 一致で行う。実ブラウザと実リレーだけを使い、モックは使わない
- publisher 側は catalog と媒体トラックの PUBLISH に加えて PUBLISH_NAMESPACE を送る (高レベル API の `announceNamespace` を有効にする)
- 単一リレーの spec は、publisher と subscriber を同じリレーへ接続し、subscriber が SUBSCRIBE_TRACKS で namespace を購読して映像トラックの Object が届くこと、publisher が SUBSCRIBE_TRACKS を受信した場合は PUBLISH を返すことを確認する。publisher 側の観測は downstream の映像受信を待つ間の前提にしない (先に映像受信を assert する)。relay が上流へ SUBSCRIBE_TRACKS を送る場合は、その後に publisher 側の観測を assert する。送らない場合は、その実測を spec のコメントに記録し、publisher 側の assert は行わない
- 複数リレーの spec は `TEST_MOQT_URIS` (カンマ区切り) を読み、publisher を 1 台目、subscriber を 2 台目へ接続する。未設定または 2 件未満の環境では skip として記録する。relay 間の相互接続はライブラリの実装対象ではない (CODEBASE.md) が、リレーが coordinated set として動作するかを実機で確認するために 2 ノードへ接続する
- `.github/workflows/e2e-test.yml` で `TEST_MOQT_URIS` を relay ジョブへ渡す。`TEST_MOQT_URIS` の各 URI の host / authority / fragment も `::add-mask::` の対象にし、`TEST_MOQT_URI` または `TEST_MOQT_URIS` のどちらかが設定されていればマスクする
- 誤った前提に依存する記述を訂正する (workflow のコメント、`issues/closed/0960` の前提、`issues/pending/0703` / `0817` / `0845` / `0931` / `0946` の pending 理由にある「draft-23 対応のリレーが無い」という記述)。0703 は CAT トークンの受理確認が別途必要なため、記述の訂正だけでは pending を解消しない
- 接続先のホストや URI をリポジトリへ書かない

## 完了条件

- 単一リレーの SUBSCRIBE_TRACKS E2E が、実リレーに対して通る
- `TEST_MOQT_URIS` を 2 件以上設定した環境では 2 ノードの E2E が通り、未設定または 2 件未満では skip として記録される
- downstream の購読が映像トラックの Object を受信することを assert する。relay が上流へ SUBSCRIBE_TRACKS を送る場合は、publisher が受信した回数と受理結果、および受理した要求への PUBLISH 返却を assert する。送らない場合は、その実測を spec のコメントに記録する
- `vp check` と `vp test run` が通る
- workflow のコメント、`TEST_MOQT_URIS` のマスク手順、`0960` の前提、`0703` / `0817` / `0845` / `0931` / `0946` の pending 理由にある「draft-23 対応のリレーが無い」という記述を訂正する

## 参照

- `src/session/incomingSubscribeTracks.ts` / `src/session/publishedTracks.ts` / `src/codec/types.ts` の `MediaPublisherOptions.authorizeSubscribeTracks` / `src/createMediaPublisher.ts` の `createSubscribeTracksHandler` / `src/session/publicTypes.ts` の `IncomingSubscribeTracksRequest` / `SubscribeTracksHandler`
- `tests/e2e/main.ts` / `tests/e2e/relay/` / `tests/e2e/urls.ts` / `playwright.config.ts`
- `.github/workflows/e2e-test.yml`
- draft-ietf-moq-transport-23 §3.6 / §3.6.1 / §7.7 / §9.17 / §9.19.21
- 関連 issue: 0960 (publisher 側 SUBSCRIBE_TRACKS の実装)、0817 (実リレーの E2E 追加)、0956 / 0957 (devtools の SUBSCRIBE_TRACKS)

## 解決方法

- `tests/e2e/relay/subscribe-tracks.spec.ts` に、SUBSCRIBE_TRACKS の結果 PUBLISH で映像の Object を受信することを待つ helper と assert を追加した。単一リレーと 2 台のリレーの両方で、`video` の `objectCount` が 0 より大きくなるまで待つ
- 実リレーでの実行結果: 2 テストとも成功した (単一リレーと 2 台のリレー)。publisher は SUBSCRIBE_TRACKS を 1 件受信して受理し、subscriber は結果 PUBLISH で映像 Object を受信した
- コメントを更新し、以前の「Object の配送は固定しない」という制限の記述を、closed 0966 / 0967 の修正後に Object まで固定する記述に改めた
- workflow のコメント、closed 0960 の前提、pending 0817 の pending 理由に加え、0703 / 0845 / 0931 / 0946 の「draft-23 対応のリレーが無い」という記述も、実リレーが利用できる事実に合わせて訂正した (pending の理由としての妥当性は別途見直す)
- 確認: `tsc --noEmit`、`vp check`、`vp test run` (279 ファイル / 5262 テスト)、実リレーの E2E (2 passed) が通った
