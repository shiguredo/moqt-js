import { expect, test } from "@playwright/test";
import {
  RELAY_TEST_TIMEOUT_MS,
  closeRelayPage,
  createTestNamespace,
  openRelayPage,
  requireRelayUri,
  requireRelayUris,
} from "./support";

/**
 * Track Namespace Prefix が Publisher の namespace の先頭と一致するかを返す
 *
 * draft-ietf-moq-transport-23 §2.4.2 (Namespace Prefix Matching):
 * 要求の prefix は、その全フィールドが Track Namespace の先頭と等しいときに一致する。
 */
function matchesNamespacePrefix(prefix: string[], namespace: string[]): boolean {
  if (prefix.length > namespace.length) {
    return false;
  }
  return prefix.every((field, index) => field === namespace[index]);
}

/**
 * SUBSCRIBE_TRACKS の PUBLISH が届くまで待つ
 *
 * SUBSCRIBE_TRACKS の REQUEST_OK が返った後に PUBLISH が新しい双方向ストリームで届く。
 * 固定の sleep で待つと遅い runner でだけ落ちるため、観測値の増加を待つ。
 */
async function expectTracksPublishReceived(
  subscriberPage: Awaited<ReturnType<typeof openRelayPage>>,
  tracksSubscriberId: string,
): Promise<void> {
  await expect
    .poll(
      () =>
        subscriberPage.evaluate(
          (id) => window.__moqtE2E.getTracksSubscriber(id).publications.length,
          tracksSubscriberId,
        ),
      {
        message: "SUBSCRIBE_TRACKS の PUBLISH が届くのを待つ",
        timeout: 30_000,
      },
    )
    .toBeGreaterThan(0);
}

// 単一リレーで SUBSCRIBE_TRACKS を送り、Publisher と Subscriber を同じリレーへ接続する。
//
// draft-ietf-moq-transport-23 §3.6 (Subscribing to Tracks by Prefix)
// draft-ietf-moq-transport-23 §9.17 (SUBSCRIBE_TRACKS)
// draft-ietf-moq-transport-23 §9.8 (PUBLISH)
//
// Publisher は announceNamespace: true にして PUBLISH の後に PUBLISH_NAMESPACE を送る
// (§4.1 / §7.7)。namespace を告知していない publisher には、リレーが namespace 購読を
// ルーティングしないためである (§7.7 の MUST)。
//
// 単一リレーでは、リレーが Publisher から直接 PUBLISH を受けているため、受信した
// SUBSCRIBE_TRACKS を上流の Publisher へ転送せずに自身で処理する実装があり得る。
// そのため Publisher 側の観測は「送られた場合だけ、prefix が一致して受理されている」
// ことを確かめ、0 件を失敗にしない。
//
// 2026-11-15 の実測では、検証環境のリレーは SUBSCRIBE_TRACKS を Publisher へ転送し、
// Publisher が返した catalog と video の PUBLISH を受理した (Publisher 側の受信記録も
// prefix が一致して受理済み)。このテストは PUBLISH の受理までを固定する。
//
// その後の映像 Object の配送は固定しない。リレーは同じ video の通常 SUBSCRIBE を
// Publisher へ送り、moqt-js はクライアント専用で受信 SUBSCRIBE を NOT_SUPPORTED で
// 拒否するため、リレーは PUBLISH 購読を打ち切る。Object の配送には、リレーが
// SUBSCRIBE_TRACKS の結果 PUBLISH だけで配送するか、Publisher が受信 SUBSCRIBE に
// 対応する必要があり、別の issue で扱う (draft-ietf-moq-transport-23 §7.7 は
// 「Relays MUST send at least one SUBSCRIBE to each matching publisher」と定める)。
test("実リレーで SUBSCRIBE_TRACKS が publisher に転送され、PUBLISH が届く", async ({ browser }) => {
  test.setTimeout(RELAY_TEST_TIMEOUT_MS);
  const moqtUri = requireRelayUri();
  if (moqtUri === null) {
    return;
  }
  const namespace = createTestNamespace();
  const publisherPage = await openRelayPage(browser);
  const subscriberPage = await openRelayPage(browser);
  let publisherId: string | undefined;
  let tracksSubscriberId: string | undefined;

  try {
    // PUBLISH と PUBLISH_NAMESPACE を同じセッションで行う。start() は RELAY_OK まで
    // 待つため、解決した時点で namespace の告知は受理されている
    publisherId = await publisherPage.evaluate(
      (options) => window.__moqtE2E.startPublisher(options),
      { url: moqtUri, namespace, announceNamespace: true },
    );
    const activePublisherId = publisherId;

    // 映像の Object が実際に流れ始めてから SUBSCRIBE_TRACKS を送る
    await expect
      .poll(
        () =>
          publisherPage.evaluate(
            (id) => window.__moqtE2E.getPublisher(id).framesSent,
            activePublisherId,
          ),
        {
          message: "Publisher が映像フレームを送信し始めるのを待つ",
          timeout: 30_000,
        },
      )
      .toBeGreaterThan(0);

    // 同じ namespace を prefix として SUBSCRIBE_TRACKS する。subscribeTracks() は
    // REQUEST_OK を受信すると解決する
    tracksSubscriberId = await subscriberPage.evaluate(
      (options) => window.__moqtE2E.startTracksSubscriber(options),
      { url: moqtUri, trackNamespacePrefix: namespace },
    );
    const activeTracksSubscriberId = tracksSubscriberId;

    await expectTracksPublishReceived(subscriberPage, activeTracksSubscriberId);

    const tracksStatus = await subscriberPage.evaluate(
      (id) => window.__moqtE2E.getTracksSubscriber(id),
      activeTracksSubscriberId,
    );
    const videoPublication = tracksStatus.publications.find(
      (publication) => publication.trackName === "video",
    );

    // 1. Subscriber が PUBLISH を受け取っている
    expect(videoPublication).toBeDefined();
    // PUBLISH の namespace は要求した prefix と PUBLISH の suffix を連結した値であり、
    // prefix が namespace 全体なので namespace と一致する
    for (const publication of tracksStatus.publications) {
      expect(publication.namespace).toEqual(namespace);
    }
    expect(tracksStatus.state).toBe("active");

    // 2. 失敗を握り潰していないこと
    expect(tracksStatus.errors).toEqual([]);
    for (const publication of tracksStatus.publications) {
      expect(publication.errors).toEqual([]);
    }
    const publisherStatus = await publisherPage.evaluate(
      (id) => window.__moqtE2E.getPublisher(id),
      activePublisherId,
    );
    expect(publisherStatus.errors).toEqual([]);

    // 実際に観測した件数と prefix を失敗時の診断に使えるようログへ残す。接続先は
    // 含まれない (namespace はテストごとに作る乱数)
    console.log(
      `単一リレーで publisher が受信した SUBSCRIBE_TRACKS: ${JSON.stringify(
        publisherStatus.subscribeTracks,
      )}`,
    );

    // 3. Publisher 側の記録。単一リレーでは 0 件があり得るため、送られた場合だけ
    // prefix の一致と受理を確かめる
    for (const request of publisherStatus.subscribeTracks.requests) {
      expect(matchesNamespacePrefix(request.trackNamespacePrefix, namespace)).toBe(true);
      expect(request.accepted).toBe(true);
    }
  } finally {
    if (tracksSubscriberId !== undefined) {
      await subscriberPage
        .evaluate((id) => window.__moqtE2E.stopTracksSubscriber(id), tracksSubscriberId)
        .catch(() => {});
    }
    if (publisherId !== undefined) {
      await publisherPage
        .evaluate((id) => window.__moqtE2E.stopPublisher(id), publisherId)
        .catch(() => {});
    }
    await closeRelayPage(subscriberPage);
    await closeRelayPage(publisherPage);
  }
});

// 2 台のリレーをまたいで SUBSCRIBE_TRACKS を通す。
//
// draft-ietf-moq-transport-23 §3.6 (Subscribing to Tracks by Prefix)
// draft-ietf-moq-transport-23 §4.1 (Publishing Namespaces)
//
// Publisher を 1 台目のリレーへ、Subscriber を 2 台目のリレーへ接続する。2 台目は
// 1 台目へ上流の SUBSCRIBE_TRACKS を送り、それを受けた 1 台目が Publisher へ
// SUBSCRIBE_TRACKS を転送する構成を検証する。単一リレーの経路と違い、Publisher 側の
// 観測を必須にできるため、ここでは受信 0 件を失敗にする。
//
// 接続先は TEST_MOQT_URIS (カンマまたは空白区切り) から読む。1 台しか設定されていない環境では
// skip として記録する。
test("2 台のリレーをまたぐ SUBSCRIBE_TRACKS で PUBLISH が上流の publisher へ転送される", async ({
  browser,
}) => {
  test.setTimeout(RELAY_TEST_TIMEOUT_MS);
  const uris = requireRelayUris(2);
  if (uris === null) {
    return;
  }
  const publisherUri = uris[0];
  const subscriberUri = uris[1];
  if (publisherUri === undefined || subscriberUri === undefined) {
    // requireRelayUris(2) が 2 本以上を保証するため到達しない
    throw new Error("TEST_MOQT_URIS の先頭 2 本を取得できなかった");
  }

  const namespace = createTestNamespace();
  const publisherPage = await openRelayPage(browser);
  const subscriberPage = await openRelayPage(browser);
  let publisherId: string | undefined;
  let tracksSubscriberId: string | undefined;

  try {
    publisherId = await publisherPage.evaluate(
      (options) => window.__moqtE2E.startPublisher(options),
      { url: publisherUri, namespace, announceNamespace: true },
    );
    const activePublisherId = publisherId;

    await expect
      .poll(
        () =>
          publisherPage.evaluate(
            (id) => window.__moqtE2E.getPublisher(id).framesSent,
            activePublisherId,
          ),
        {
          message: "Publisher が映像フレームを送信し始めるのを待つ",
          timeout: 30_000,
        },
      )
      .toBeGreaterThan(0);

    tracksSubscriberId = await subscriberPage.evaluate(
      (options) => window.__moqtE2E.startTracksSubscriber(options),
      { url: subscriberUri, trackNamespacePrefix: namespace },
    );
    const activeTracksSubscriberId = tracksSubscriberId;

    await expectTracksPublishReceived(subscriberPage, activeTracksSubscriberId);

    const tracksStatus = await subscriberPage.evaluate(
      (id) => window.__moqtE2E.getTracksSubscriber(id),
      activeTracksSubscriberId,
    );
    const videoPublication = tracksStatus.publications.find(
      (publication) => publication.trackName === "video",
    );

    // 1. Subscriber が PUBLISH を受け取っている
    expect(videoPublication).toBeDefined();
    for (const publication of tracksStatus.publications) {
      expect(publication.namespace).toEqual(namespace);
    }
    expect(tracksStatus.state).toBe("active");

    // 2. 失敗を握り潰していないこと
    expect(tracksStatus.errors).toEqual([]);
    for (const publication of tracksStatus.publications) {
      expect(publication.errors).toEqual([]);
    }
    const publisherStatus = await publisherPage.evaluate(
      (id) => window.__moqtE2E.getPublisher(id),
      activePublisherId,
    );
    expect(publisherStatus.errors).toEqual([]);

    console.log(
      `2 台のリレーをまたいで publisher が受信した SUBSCRIBE_TRACKS: ${JSON.stringify(
        publisherStatus.subscribeTracks,
      )}`,
    );

    // 3. 2 台目のリレーが 1 台目へ送った上流の SUBSCRIBE_TRACKS が Publisher まで
    // 届いていること。prefix は relay が広げる場合があるため、namespace の先頭との
    // 一致だけを確かめる
    expect(publisherStatus.subscribeTracks.received).toBeGreaterThan(0);
    for (const request of publisherStatus.subscribeTracks.requests) {
      expect(matchesNamespacePrefix(request.trackNamespacePrefix, namespace)).toBe(true);
      expect(request.accepted).toBe(true);
    }
  } finally {
    if (tracksSubscriberId !== undefined) {
      await subscriberPage
        .evaluate((id) => window.__moqtE2E.stopTracksSubscriber(id), tracksSubscriberId)
        .catch(() => {});
    }
    if (publisherId !== undefined) {
      await publisherPage
        .evaluate((id) => window.__moqtE2E.stopPublisher(id), publisherId)
        .catch(() => {});
    }
    await closeRelayPage(subscriberPage);
    await closeRelayPage(publisherPage);
  }
});
