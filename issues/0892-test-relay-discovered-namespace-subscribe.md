# 発見した namespace の track を SUBSCRIBE して受信する経路が実リレー未検証

- Created: 2026-11-02
- Completed: {YYYY-MM-DD}
- Branch: feature/test-relay-discovered-namespace-subscribe
- Polished: 2026-11-03

## 目的

`createMediaPublisher` の `announceNamespace` で告知した namespace を、`SUBSCRIBE_NAMESPACE` で発見し、その namespace の track を `createMediaSubscriber` で購読して実際に映像が届くまでの経路が、実リレーでは未検証である。告知と発見の往復 (`NAMESPACE` / `NAMESPACE_DONE`) は確認済みだが、「発見した配信を視聴する」という本来の用途の全体は、単体テストでも実リレー E2E でも通しで確かめていない。

## 現状

- `tests/e2e/relay/namespace-announcement.spec.ts` は、低レベルの `PUBLISH_NAMESPACE` の受理 (`REQUEST_OK`)、`SUBSCRIBE_NAMESPACE` での `NAMESPACE` の受信、`close()` 後の `NAMESPACE_DONE` を実リレーで確認している。しかし track の購読は行わない
- `tests/e2e/relay/pubsub.spec.ts` は、namespace を既知として直接 `createMediaSubscriber` に渡し、映像が届くところまでを実リレーで確認している。`SUBSCRIBE_NAMESPACE` による発見は通らない
- `tests/e2e/main.ts` の `window.__moqtE2E` は、Publisher / Subscriber / Fetch / namespace の告知 (低レベル) / namespace の購読をそれぞれ別のハンドルとして露出している。発見した namespace をそのまま購読へ渡す組み合わせは spec 側で書く必要がある
- 高レベルの `announceNamespace` と `rendezvousTimeout` は、それぞれ個別の E2E で検証している

### `issues/0817-add-relay-tests.md` との関係

`issues/0817-add-relay-tests.md` は、実リレーの E2E を増やす横断的な issue である。同 issue の「試行結果 (namespace discovery)」は「`SUBSCRIBE_NAMESPACE` は応答が返らない (リレー未対応)」として namespace discovery を保留していた。その後、`tests/e2e/relay/namespace-announcement.spec.ts` が実リレーで通ることを確認できたため、この前提は解消している。

本 issue は 0817 の「優先順 1. namespace discovery」のうち、**発見した namespace の track を購読して映像が届くまでの通し**に限定する。`SUBSCRIBE_TRACKS` / `TRACK_STATUS` / `REQUEST_UPDATE` / fill / Object Datagram は 0817 の範囲に残す。

## 設計方針

実リレーの E2E 1 本で、次の流れを通す。

1. publisher を `announceNamespace: true` で開始する (低レベルの probe は不要)
2. 別ページで `SUBSCRIBE_NAMESPACE` を開始し、告知された namespace を観測する
3. 観測した namespace を使って `startSubscriber` を呼び、`getSubscriber` が `"active"` になり、`framesReceived > 0` になることを待つ
4. 後始末で publisher と subscriber と購読を止める

既存の `namespace-announcement.spec.ts` に足すか、新しい spec にするかは、テストの実行時間と失敗時の切り分けやすさで決める。既存 spec は告知の往復だけを見ており、購読を足すと 1 本のテストが 2 つの契約を持つ。新しい spec (`namespace-discovery-subscribe.spec.ts` など) に分ける方が、失敗時にどちらが壊れたかを切り分けやすい。

E2E のハーネスに不足があれば足す。`startSubscriber` は namespace を渡すだけなので、既存の露出で足りる見込みである。ただし `tests/e2e/main.ts` の `startSubscriber` は `video` を既定で要求するため、告知した配信が映像を持つことを前提にする (publisher は `video: { codec: "vp8" }` で開始する)。

CI の relay ジョブは `timeout-minutes: 20` で、2 shard (`--shard=N/2`) に分けて `--project=relay --project=chromium-production-relay --grep-invert='調査:'` を実行する。実行されるのは relay project の spec 18 本 (調査専用 2 本は grep で除外) と `chromium-production-relay` の 1 本である。各実行 step の `timeout-minutes` は 8 分で、失敗時にもう 8 分の再実行が入る (実効の制限は job の 20 分ではなく、この 8 分 / shard)。追加する 1 本は 30 秒以内 (接続・告知・購読・数フレームの受信) に収まる見込みだが、実行時間が伸びる場合は既存 spec との統合を検討する。

## 完了条件

- 実リレーで、`announceNamespace: true` の publisher を `SUBSCRIBE_NAMESPACE` で発見し、その namespace を `createMediaSubscriber` で購読して映像フレームが届くところまでを通す E2E を追加する
- 発見した namespace の track の購読が、実リレーで通ることを確認する (ローカルで実行した結果を解決方法に記録する)
- relay が経路に対応していない場合は E2E を追加せず、確認した内容を解決方法に記録する (`issues/0817-add-relay-tests.md` の方針)
- `npx vp check` と `npx vp test --run` が通る
- 追加した E2E が CI の relay プロジェクトで通り、各 shard の実行 step の `timeout-minutes` (8 分。失敗時の再実行を含め 16 分) に収まる

`CHANGES.md` は MOQT RFC ドラフト中のため更新しない (`CODEBASE.md` の特別ルール)。

## 解決方法

{未着手}

## 参照

- `tests/e2e/relay/namespace-announcement.spec.ts` (告知と発見の往復)
- `tests/e2e/relay/pubsub.spec.ts` (既知の namespace の購読)
- `tests/e2e/relay/support.ts` の `openRelayPage` / `createTestNamespace` / `requireRelayUri`
- `tests/e2e/main.ts` の `window.__moqtE2E` (`startPublisher` / `startSubscriber` / `startSubscribeNamespace`)
- `src/createMediaPublisher.ts` の `MediaPublisherImpl.announceNamespace`
- `src/createMediaSubscriber.ts` の `MediaSubscriberImpl.start`
- `docs/HIGH_LEVEL_API.md` の「namespace の告知 (announceNamespace)」
- `issues/0817-add-relay-tests.md` (実リレーの E2E の方針。namespace discovery を保留していた前提は、別 issue の `issues/closed/0887-add-media-publisher-namespace-announcement.md` の実装で追加した `tests/e2e/relay/namespace-announcement.spec.ts` が実リレーで通ったことで解消済み)
- `issues/closed/0887-add-media-publisher-namespace-announcement.md` (この経路の実装)
- `.github/workflows/e2e-test.yml` (relay ジョブの `timeout-minutes`)
