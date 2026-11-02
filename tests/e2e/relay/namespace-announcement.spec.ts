import { expect, test } from "@playwright/test";
import {
  RELAY_TEST_TIMEOUT_MS,
  closeRelayPage,
  createTestNamespace,
  openRelayPage,
  requireRelayUri,
} from "./support";

/**
 * 実リレーで namespace の告知と発見の往復を検証する
 *
 * draft-ietf-moq-transport-22 §4.1 (Publishing Namespaces):
 * publisher は PUBLISH_NAMESPACE で namespace を告知する。高レベル API は
 * `announceNamespace: true` のとき、PUBLISH の後に PUBLISH_NAMESPACE を送って
 * REQUEST_OK を待つ。
 *
 * draft-ietf-moq-transport-22 §4.2 (Subscribing to Namespaces):
 * relay は告知された namespace を SUBSCRIBE_NAMESPACE の購読者へ NAMESPACE として列挙し、
 * 告知が撤回されると NAMESPACE_DONE を送る。
 *
 * 低レベル API 単体での PUBLISH_NAMESPACE の受理と、高レベル API の告知
 * (PUBLISH_NAMESPACE) を実リレーで受理して別セッションの SUBSCRIBE_NAMESPACE から
 * 発見できること、close() の解放で撤回が伝わることを、実ブラウザの WebTransport と
 * 実リレーだけで確かめる。
 */
test("実リレーで namespace の告知を SUBSCRIBE_NAMESPACE で発見できる", async ({ browser }) => {
  test.setTimeout(RELAY_TEST_TIMEOUT_MS);
  const moqtUri = requireRelayUri();
  if (moqtUri === null) {
    return;
  }

  // テストごとに一意な namespace を使う。SUBSCRIBE_NAMESPACE の prefix は先頭
  // フィールドだけにし、NAMESPACE の suffix と連結して自分の namespace を探す
  const namespace = createTestNamespace();
  const subscribedPrefix = [namespace[0]];
  const publisherPage = await openRelayPage(browser);
  const observerPage = await openRelayPage(browser);
  let publisherId: string | undefined;
  let subscriptionId: string | undefined;

  try {
    // 低レベル API の PUBLISH_NAMESPACE が受理されること (REQUEST_OK) を先に確かめる。
    // 告知する namespace は高レベルの検証対象と衝突しないよう別にする
    const probeNamespace = [namespace[0], `${crypto.randomUUID()}-probe`];
    const probeId = await publisherPage.evaluate(
      (options) => window.__moqtE2E.startPublishNamespace(options),
      { url: moqtUri, namespace: probeNamespace },
    );
    const probeStatus = await publisherPage.evaluate(
      (id) => window.__moqtE2E.getPublishNamespace(id),
      probeId,
    );
    expect(probeStatus.state).toBe("active");
    expect(probeStatus.namespace).toEqual(probeNamespace);
    expect(probeStatus.errors).toEqual([]);
    // 撤回は closed になり、namespace は撤回後も読める
    const probeStopStatus = await publisherPage.evaluate(
      (id) => window.__moqtE2E.stopPublishNamespace(id),
      probeId,
    );
    expect(probeStopStatus.state).toBe("closed");
    expect(probeStopStatus.namespace).toEqual(probeNamespace);
    // 停止時の close で relay が control stream を RESET_STREAM することがあり、
    // errors の空は要求しない (撤回の状態と namespace だけを確認する)

    // PUBLISH_NAMESPACE が受理され REQUEST_OK が返るまで start() が待つ。
    // relay が告知を拒否すれば start() が reject するため、この evaluate で失敗する
    publisherId = await publisherPage.evaluate(
      (options) => window.__moqtE2E.startPublisher(options),
      { url: moqtUri, namespace, announceNamespace: true },
    );
    const activePublisherId = publisherId;
    await expect
      .poll(
        () =>
          publisherPage.evaluate(
            (id) => window.__moqtE2E.getPublisher(id).state,
            activePublisherId,
          ),
        { message: "告知が受理されて Publisher が publishing になるのを待つ", timeout: 30_000 },
      )
      .toBe("publishing");

    // 別セッションで prefix を購読し、告知された namespace が NAMESPACE で届くのを待つ
    subscriptionId = await observerPage.evaluate(
      (options) => window.__moqtE2E.startSubscribeNamespace(options),
      { url: moqtUri, namespacePrefix: subscribedPrefix },
    );
    const activeSubscriptionId = subscriptionId;
    await expect
      .poll(
        () =>
          observerPage.evaluate(
            (args) =>
              window.__moqtE2E
                .getSubscribeNamespace(args.id)
                .namespaces.some(
                  (candidate) =>
                    candidate.length === args.expected.length &&
                    candidate.every((field, index) => field === args.expected[index]),
                ),
            { id: activeSubscriptionId, expected: namespace },
          ),
        { message: "SUBSCRIBE_NAMESPACE で告知された namespace を観測する", timeout: 30_000 },
      )
      .toBe(true);

    // 撤回の前に、失敗を握り潰していないこと (errors が空) と、まだ対象の namespace の
    // NAMESPACE_DONE を受けていないこと (告知が stop まで維持されていること) を確かめる。
    // 共有リレーでは同じ prefix の別 namespace も届くため、対象の namespace だけを見る
    const beforeStop = await observerPage.evaluate(
      (id) => window.__moqtE2E.getSubscribeNamespace(id),
      activeSubscriptionId,
    );
    expect(beforeStop.state).toBe("active");
    expect(
      beforeStop.done.some(
        (candidate) =>
          candidate.length === namespace.length &&
          candidate.every((field, index) => field === namespace[index]),
      ),
    ).toBe(false);
    expect(beforeStop.errors).toEqual([]);
    const publisherBeforeStop = await publisherPage.evaluate(
      (id) => window.__moqtE2E.getPublisher(id),
      activePublisherId,
    );
    expect(publisherBeforeStop.errors).toEqual([]);

    // 告知を撤回すると NAMESPACE_DONE が届く。ハーネスの stopPublisher は close() を呼ぶため、
    // 解放の done() で告知が終了する経路を通る
    const publisherAfterStop = await publisherPage.evaluate(
      (id) => window.__moqtE2E.stopPublisher(id),
      activePublisherId,
    );
    publisherId = undefined;
    // close の完了だけを見る。close の途中で relay が control stream を RESET_STREAM する
    // ことによるエラー通知は正常な終了手順であり、errors の空は要求しない
    expect(publisherAfterStop.state).toBe("closed");
    await expect
      .poll(
        () =>
          observerPage.evaluate(
            (args) =>
              window.__moqtE2E
                .getSubscribeNamespace(args.id)
                .done.some(
                  (candidate) =>
                    candidate.length === args.expected.length &&
                    candidate.every((field, index) => field === args.expected[index]),
                ),
            { id: activeSubscriptionId, expected: namespace },
          ),
        { message: "告知の撤回で NAMESPACE_DONE を観測する", timeout: 30_000 },
      )
      .toBe(true);

    // 撤回の経路でも失敗を握り潰していないこと
    const afterStop = await observerPage.evaluate(
      (id) => window.__moqtE2E.getSubscribeNamespace(id),
      activeSubscriptionId,
    );
    expect(afterStop.errors).toEqual([]);
  } finally {
    if (publisherId !== undefined) {
      await publisherPage
        .evaluate((id) => window.__moqtE2E.stopPublisher(id), publisherId)
        .catch(() => {});
    }
    if (subscriptionId !== undefined) {
      await observerPage
        .evaluate((id) => window.__moqtE2E.stopSubscribeNamespace(id), subscriptionId)
        .catch(() => {});
    }
    await closeRelayPage(publisherPage);
    await closeRelayPage(observerPage);
  }
});
