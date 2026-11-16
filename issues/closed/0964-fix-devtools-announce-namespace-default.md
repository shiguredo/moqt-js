# devtools publisher の PUBLISH_NAMESPACE を既定で有効にする

- Created: 2026-11-15
- Completed: 2026-11-16
- Branch: feature/fix-devtools-announce-namespace-default
- Polished: 2026-11-16

## 目的

devtools の publisher が既定で namespace を告知するようにする。

draft-ietf-moq-transport-23 §7.7 は、namespace への購読を自分へルーティングしてほしい publisher に PUBLISH_NAMESPACE を明示することを MUST とする。告知が無い publisher には、relay は別ノードの subscriber が送った prefix 購読 (SUBSCRIBE_TRACKS / SUBSCRIBE_NAMESPACE) をルーティングできない。同一ノードでは relay がローカルの PUBLISH 購読を使えるため動くが、別ノード構成では動かない。

devtools の subscriber は SUBSCRIBE_TRACKS が既定で有効である。一方、publisher の `announceNamespace` は既定 false (opt-in) であり、既定同士の組み合わせでは SUBSCRIBE_TRACKS による prefix 購読の配信が成立しない。閉じた 0963 で opt-in をそのまま踏襲したのが原因であり、devtools の既定としては誤りである。

## 現状

- `devtools/src/signals/publisher.ts` の `announceNamespace` は `signal(false)` であり、Publisher パネルのチェックボックスも既定で未チェック。配信の開始中・配信中・停止中はチェックボックスを変更できない (`devtools/src/components/PublisherPanel.tsx`)
- `devtools/src/hooks/usePublisher.test.ts` の `resetPublisherSignals` は `pub.announceNamespace.value = false` を設定しており、`devtools/src/signals/statsSnapshot.test.ts` の「配信前は既定値を返す」テストは `stats.announceNamespace` が false であることを assert している。既定値を直接 assert するテストは `statsSnapshot.test.ts` だけである
- 実リレー E2E (`tests/e2e/relay/devtools-namespace-announcement.spec.ts`) はチェックボックスを明示的にチェックしている
- `README.md` と `docs/DEVELOPMENT.md` は既定が無効であると記録している
- `devtools/src/signals/publisher.ts` の JSDoc も既定が無効 (opt-in) と記録している

## 設計方針

- `announceNamespace` の既定を true にする。配信の開始前にチェックボックスを外せば次の配信で無効にできる (既定で有効、明示的に無効化可能)
- `devtools/src/signals/statsSnapshot.test.ts` の既定値の assert を true に更新し、`devtools/src/hooks/usePublisher.test.ts` の `resetPublisherSignals` も既定に合わせて true を設定する。無効にした場合は送らないことを引き続き固定する
- E2E は「既定でチェック済み」を assert し、チェック操作を不要にする。チェックを外したときに送らないことは単体テストで固定する
- `README.md`、`docs/DEVELOPMENT.md`、`devtools/src/signals/publisher.ts` の JSDoc の既定の記述を更新する
- namespace が空のときは従来どおり送らない (0 フィールドの Track Namespace Prefix はすべての namespace に一致し (§2.4.2)、SUBSCRIBE_NAMESPACE では 0 フィールドが全 namespace を意味する (§4.2))
- relay が PUBLISH_NAMESPACE を拒否した場合の扱い (開始の失敗として onError を 1 回通知する) は現状のままにする

## 完了条件

- devtools の publisher が、namespace が空でないとき、既定で PUBLISH_NAMESPACE を送り、配信の開始前にチェックを外すと次の配信で送らない
- 単体テスト・統計テスト・E2E が通る
- README と docs と `devtools/src/signals/publisher.ts` の JSDoc の既定の記述が実装と一致する
- 別ノード構成 (publisher を 1 台目の relay、subscriber を 2 台目の relay に繋ぐ。`TEST_MOQT_URIS` を使う) で publisher と subscriber を繋ぎ、既定のまま最初の配信がどこまで届くかを実リレーで再検証し、結果を解決方法に記録する。SUBSCRIBE_TRACKS の結果 PUBLISH の Object 配送は 0962 の範囲であり、ここでは届いた範囲を記録するに留める
- `vp check` と `vp test run` が通る

## 参照

- `devtools/src/signals/publisher.ts` / `devtools/src/hooks/usePublisher.ts` / `devtools/src/components/PublisherPanel.tsx`
- `devtools/src/signals/statsSnapshot.ts`
- `devtools/src/signals/statsSnapshot.test.ts` / `devtools/src/hooks/usePublisher.test.ts`
- `tests/e2e/relay/devtools-namespace-announcement.spec.ts`
- `tests/e2e/relay/support.ts` (`TEST_MOQT_URIS` / `requireRelayUris`) / `tests/e2e/relay/subscribe-tracks.spec.ts` (2 台の relay をまたぐ確認)
- `README.md` / `docs/DEVELOPMENT.md`
- draft-ietf-moq-transport-23 §2.4.2 / §4.1 / §4.2 / §7.7
- 関連 issue: 0962 (relay から publisher への SUBSCRIBE と結果 PUBLISH の Object 配送)、0963 (devtools の告知実装)、closed 0887 (高レベル API の opt-in)

## 解決方法

- `devtools/src/signals/publisher.ts` の `announceNamespace` の既定を true にした。Publisher パネルのチェックを外すと送らない (明示的に無効化できる)
- 既定値を前提にしていた単体テスト (`usePublisher.test.ts` の初期化、`statsSnapshot.test.ts` の既定値) を更新し、E2E は「既定でチェック済み」を assert するようにした
- `README.md` と `docs/DEVELOPMENT.md` の既定の記述を「有効」に更新した
- 確認: `vp check`、`vp test run` (279 ファイル / 5254 テスト)、実リレーの `devtools-namespace-announcement.spec.ts` (1 passed) が通った
- 2026-11-16 の別ノード再検証: 既定のまま devtools publisher をノード A、ハーネスの SUBSCRIBE_TRACKS 購読者をノード B に接続した。チェックは既定で有効、publisher は `namespaceAnnouncement: "active"` で 5 秒後も connected (objectsSent 13)。購読者は audio 499 / catalog 1 / events 0 / video 0 Object を受信し、映像だけ届かなかった。既定の告知は必要だが十分ではなく、relay が §7.7 の MUST で送る上流 SUBSCRIBE を moqt-js がクライアント専用として拒否する経路 (0962) と、PUBLISH_DONE 後の close 失敗で publisher セッションが落ちる経路 (0966) が残る

### 2026-11-16 の最終再検証

closed 0966 / 0967 の修正後に、既定の告知 + 別ノード構成で再検証した。

- 初回: video PUBLISH 1 回、objects 419 (audio / catalog / video)、publisher は connected のまま
- PUBLISH_DONE で停止して再配信: video PUBLISH 2 回目、objects 824、subscriber の errors は空
- 以前の「映像が 0 Object」「MALFORMED_TRACK」「publisher セッションの閉鎖」は解消した
