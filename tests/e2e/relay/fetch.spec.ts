import { expect, test, type Page } from "@playwright/test";
import {
  RELAY_TEST_TIMEOUT_MS,
  closeRelayPage,
  createTestNamespace,
  openRelayPage,
  requireRelayUri,
} from "./support";

// 実リレーに対する FETCH の受信経路を検証する
//
// draft-ietf-moq-transport-21 Section 9.11 (FETCH) — Section 9.12 (FETCH_OK)
// draft-ietf-moq-transport-21 Section 9.20.10 (LOCATION FILTER Parameter)
// draft-ietf-moq-transport-21 Section 11.4 (Fetch ストリームの終端)
//
// FETCH の受信経路は合成ストリームを注入する単体テストでしか覆われておらず、実リレーの
// FIN と End of Range の作り方、payload の境界の扱いはそこで再現できない。受信側の
// 終端判定を厳格化する変更では、実装差が誤検出と見逃しに直結するため、実ワイヤの門が要る。
// 映像トラックは Publisher が配信中のものを対象にする (過去のデータが確実に存在する)。

/** 映像トラックの名前。createMediaPublisher の既定値 */
const VIDEO_TRACK_NAME = "video";

/**
 * FETCH の前に待つ publish 済みフレーム数
 *
 * 1 フレームだけだと、要求した範囲に Object が 1 つしか無い状態でリレーの実装差に
 * 当たりやすい。Group の中で複数の Object が確定してから FETCH する。
 */
const MIN_PUBLISHED_FRAMES = 5;

/**
 * Publisher を起動し、フレームが十分に送られるまで待ってから現在の Group ID を返す
 *
 * FETCH の対象がリレー上に存在することを保証してから要求するために使う。
 * 既定のキーフレーム間隔では Group は数秒単位で進むため、この時点の Group は
 * リレー上に確定している。
 */
async function startPublisherAndWaitForFrames(
  publisherPage: Page,
  moqtUri: string,
  namespace: string[],
): Promise<{ publisherId: string; currentGroupId: number }> {
  const publisherId = await publisherPage.evaluate(
    (options) => window.__moqtE2E.startPublisher(options),
    { url: moqtUri, namespace },
  );

  await expect
    .poll(
      () =>
        publisherPage.evaluate((id) => window.__moqtE2E.getPublisher(id).framesSent, publisherId),
      {
        message: `Publisher が ${MIN_PUBLISHED_FRAMES} フレームを送信するのを待つ`,
        timeout: 30_000,
      },
    )
    .toBeGreaterThanOrEqual(MIN_PUBLISHED_FRAMES);

  const status = await publisherPage.evaluate(
    (id) => window.__moqtE2E.getPublisher(id),
    publisherId,
  );
  // 初期 Group ID は 0 ではない (draft-ietf-moq-msf-01 §6.1 の単調増加の起点)
  expect(status.currentGroupId).toBeGreaterThan(0);
  return { publisherId, currentGroupId: status.currentGroupId };
}

test("実リレーに対して Location Filter 無しで FETCH し、全オブジェクトの end が通知される", async ({
  browser,
}) => {
  test.setTimeout(RELAY_TEST_TIMEOUT_MS);
  const moqtUri = requireRelayUri();
  if (moqtUri === null) {
    return;
  }

  const namespace = createTestNamespace();
  const publisherPage = await openRelayPage(browser);
  const fetchPage = await openRelayPage(browser);
  let publisherId: string | undefined;
  let fetchId: string | undefined;

  try {
    const started = await startPublisherAndWaitForFrames(publisherPage, moqtUri, namespace);
    publisherId = started.publisherId;

    fetchId = await fetchPage.evaluate((options) => window.__moqtE2E.startFetch(options), {
      url: moqtUri,
      namespace,
      trackName: VIDEO_TRACK_NAME,
      // フィルタ無しの範囲は {0, 0} から始まるため、リレーは存在しない Group の fill を
      // 待とうとする。0 を指定して「即座に利用可能な Object だけ」を要求する
      // (draft-ietf-moq-transport-21 Section 9.20.6)
      fillTimeout: 0,
    });
    const activeFetchId = fetchId;

    // 取得範囲の終端まで到達すると end が通知される。end が来ない場合は
    // リレーが範囲を閉じていない (または終端判定が実装差で落ちている) ことになる
    await expect
      .poll(
        () => fetchPage.evaluate((id) => window.__moqtE2E.getFetch(id).endNotified, activeFetchId),
        {
          message: "FETCH の end が通知されるのを待つ",
          timeout: 30_000,
        },
      )
      .toBe(true);

    const fetchStatus = await fetchPage.evaluate(
      (id) => window.__moqtE2E.getFetch(id),
      activeFetchId,
    );
    expect(fetchStatus.errors).toEqual([]);
    expect(fetchStatus.objectCount).toBeGreaterThan(0);
    expect(fetchStatus.bytesReceived).toBeGreaterThan(0);

    // 取得できた Object 数は、その時点までに publish されたフレーム数を超えない
    // (超えていればリレーが publish されていない Object を返している)
    const publisherStatus = await publisherPage.evaluate(
      (id) => window.__moqtE2E.getPublisher(id),
      started.publisherId,
    );
    expect(publisherStatus.errors).toEqual([]);
    expect(fetchStatus.objectCount).toBeLessThanOrEqual(publisherStatus.framesSent);
  } finally {
    if (fetchId !== undefined) {
      await fetchPage.evaluate((id) => window.__moqtE2E.stopFetch(id), fetchId);
    }
    if (publisherId !== undefined) {
      await publisherPage.evaluate((id) => window.__moqtE2E.stopPublisher(id), publisherId);
    }
    await closeRelayPage(fetchPage);
    await closeRelayPage(publisherPage);
  }
});

test("実リレーに対して Location Filter 付きで FETCH し、指定した Group 以降だけを取得できる", async ({
  browser,
}) => {
  test.setTimeout(RELAY_TEST_TIMEOUT_MS);
  const moqtUri = requireRelayUri();
  if (moqtUri === null) {
    return;
  }

  const namespace = createTestNamespace();
  const publisherPage = await openRelayPage(browser);
  const fetchPage = await openRelayPage(browser);
  let publisherId: string | undefined;
  let fetchId: string | undefined;

  try {
    const started = await startPublisherAndWaitForFrames(publisherPage, moqtUri, namespace);
    publisherId = started.publisherId;
    // 配信中の Group を絶対指定の開始位置にする
    const startGroup = started.currentGroupId;

    fetchId = await fetchPage.evaluate((options) => window.__moqtE2E.startFetch(options), {
      url: moqtUri,
      namespace,
      trackName: VIDEO_TRACK_NAME,
      filter: { startGroup, startObject: 0 },
    });
    const activeFetchId = fetchId;

    await expect
      .poll(
        () => fetchPage.evaluate((id) => window.__moqtE2E.getFetch(id).endNotified, activeFetchId),
        {
          message: "FETCH の end が通知されるのを待つ",
          timeout: 30_000,
        },
      )
      .toBe(true);

    const fetchStatus = await fetchPage.evaluate(
      (id) => window.__moqtE2E.getFetch(id),
      activeFetchId,
    );
    expect(fetchStatus.errors).toEqual([]);
    expect(fetchStatus.objectCount).toBeGreaterThan(0);
    expect(fetchStatus.groupIds.length).toBeGreaterThan(0);

    // 要求した開始位置より前の Group が混ざっていないこと。混ざっていれば
    // LOCATION FILTER がリレーに届いていないか、受信側が範囲を無視している
    const earlierGroups = fetchStatus.groupIds.filter(
      (groupId) => BigInt(groupId) < BigInt(startGroup),
    );
    expect(earlierGroups).toEqual([]);
  } finally {
    if (fetchId !== undefined) {
      await fetchPage.evaluate((id) => window.__moqtE2E.stopFetch(id), fetchId);
    }
    if (publisherId !== undefined) {
      await publisherPage.evaluate((id) => window.__moqtE2E.stopPublisher(id), publisherId);
    }
    await closeRelayPage(fetchPage);
    await closeRelayPage(publisherPage);
  }
});
