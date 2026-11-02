# 発見した namespace の track を SUBSCRIBE して受信する経路が実リレー未検証

- Created: 2026-11-02
- Completed: {YYYY-MM-DD}
- Branch: feature/test-relay-discovered-namespace-subscribe
- Polished: {YYYY-MM-DD}

## 目的

`createMediaPublisher` の `announceNamespace` で告知した namespace を、`SUBSCRIBE_NAMESPACE` で発見し、その namespace の track を `createMediaSubscriber` で購読して実際に映像が届くまでの経路が、実リレーでは未検証である。告知と発見の往復 (`NAMESPACE` / `NAMESPACE_DONE`) は確認済みだが、「発見した配信を視聴する」という本来の用途の全体は、単体テストでも実リレー E2E でも通しで確かめていない。

## 現状

- `tests/e2e/relay/namespace-announcement.spec.ts` は、低レベルの `PUBLISH_NAMESPACE` の受理 (`REQUEST_OK`)、`SUBSCRIBE_NAMESPACE` での `NAMESPACE` の受信、`close()` 後の `NAMESPACE_DONE` を実リレーで確認している。しかし track の購読は行わない
- `tests/e2e/relay/pubsub.spec.ts` は、namespace を既知として直接 `createMediaSubscriber` に渡し、映像が届くところまでを実リレーで確認している。`SUBSCRIBE_NAMESPACE` による発見は通らない
- `tests/e2e/main.ts` の `window.__moqtE2E` は、Publisher / Subscriber / Fetch / namespace の告知 (低レベル) / namespace の購読をそれぞれ別のハンドルとして露出している。発見した namespace をそのまま購読へ渡す組み合わせは spec 側で書く必要がある
- `high レベル側` の `announceNamespace` と `rendezvousTimeout` は、それぞれ個別の E2E で検証している

## 設計方針

実リレーの E2E 1 本で、次の流れを通す。

1. publisher を `announceNamespace: true` で開始する (低レベル probe は不要)
2. 別ページで `SUBSCRIBE_NAMESPACE` を開始し、告知された namespace を観測する
3. 観測した namespace を使って `startSubscriber` を呼び、`getSubscriber` が `"active"` になり、`framesReceived > 0` になることを待つ
4. 後始末で publisher と subscriber と購読を止める

既存の `namespace-announcement.spec.ts` に足すか、新しい spec にするかは、テストの実行時間と失敗時の切り分けやすさで決める。既存 spec は告知の往復だけを見ており、購読を足すと 1 本のテストが 2 つの契約を持つ。新しい spec (`namespace-discovery-subscribe.spec.ts` など) に分ける方が、失敗時にどちらが壊れたかを切り分けやすい。

E2E のハーネスに不足があれば足す。`startSubscriber` は namespace を渡すだけなので、既存の露出で足りる見込みである。

## 完了条件

- 実リレーで、`announceNamespace: true` の publisher を `SUBSCRIBE_NAMESPACE` で発見し、その namespace を `createMediaSubscriber` で購読して映像フレームが届くところまでを通す E2E を追加する
- 発見した namespace の track の購読が、実リレーで通ることを確認する
- relay が経路に対応していない場合は E2E を追加せず、確認した内容を解決方法に記録する (`issues/0817-add-relay-tests.md` の方針)
- `npx vp check` と `npx vp test --run` が通る
- 追加した E2E が CI の relay プロジェクトで通る

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
- `issues/0817-add-relay-tests.md` (実リレーの E2E の方針)
- `issues/closed/0887-add-media-publisher-namespace-announcement.md` (この経路の実装)
