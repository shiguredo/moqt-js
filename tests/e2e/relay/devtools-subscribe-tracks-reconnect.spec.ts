import { expect, test, type Page } from "@playwright/test";
import { formatTrackNamespace } from "../../../src/fullTrackName";
import type { SubscriberStats } from "../../../devtools/src/testApi";
import { DEVTOOLS_URL } from "../urls";
import { RELAY_TEST_TIMEOUT_MS, createTestNamespace, requireRelayUri } from "./support";

/**
 * SUBSCRIBE_TRACKS で購読している devtools の subscriber が、publisher の再起動後に
 * 実リレーから PUBLISH を受け取り、REQUEST_OK を返して購読を確立し直し、Object を
 * 受け取ることを確かめる。
 *
 * draft-ietf-moq-transport-23 §3.6 (Subscribing to Tracks by Prefix):
 * SUBSCRIBE_TRACKS は prefix に一致する Track の PUBLISH を受け取る要求である。
 * ライブラリは受信 PUBLISH に PUBLISH_OK (draft-23 では REQUEST_OK) を自動で返し、
 * 書き込みが終わってから onPublishEstablished をアプリへ通知する。したがって
 * publishedSubscriptionsCount が増えることは、REQUEST_OK を返して購読が確立したことを
 * 意味する。publishedObjectsReceived が増えることは、その購読で Object を受け取った
 * ことを意味する。
 *
 * 同じ Track の再 PUBLISH は §3.6.3 で relay の裁量 (MAY) だが、SUBSCRIBE_TRACKS を
 * 維持している購読者へ publisher の再接続後に PUBLISH を届ける経路の確認である。
 * テスト用の sora-moq はクラスターであり、クラスター状態では SUBSCRIBE_TRACKS が
 * 未対応である。そのためこのテストは xfail (Playwright の test.fail) として追加している。
 * クラスターが対応したら test.fail() を削除し、そのまま成功することを確認する。
 * 実リレーが要るため、接続先を渡していない実行では skip する。
 */

/** テスト全体の上限 (停止と再開の待ちを含む) */
const TEST_TIMEOUT_MS = RELAY_TEST_TIMEOUT_MS * 3;

/** 配信、購読、再確立の待ち */
const WAIT_TIMEOUT_MS = 30_000;

/** 状態を読む間隔 (ミリ秒) */
const SAMPLE_INTERVAL_MS = 200;

/** devtools の publisher の統計 (必要な部分) */
interface DevtoolsPublisherStats {
  status: string;
  statusMessage: string;
  objectsSent: number;
  framesEncoded: number;
}

/** devtools の publisher の統計を読む */
async function readPublisher(page: Page): Promise<DevtoolsPublisherStats> {
  return page.evaluate(() => {
    const api = (window as unknown as { moqtDevTools: { getPublisher(): DevtoolsPublisherStats } })
      .moqtDevTools;
    return api.getPublisher();
  });
}

/** devtools の subscriber の統計を読む */
async function readSubscriber(page: Page): Promise<SubscriberStats> {
  return page.evaluate(() => {
    const api = (window as unknown as { moqtDevTools: { getSubscribers(): SubscriberStats[] } })
      .moqtDevTools;
    const subscriber = api.getSubscribers()[0];
    if (subscriber === undefined) {
      throw new Error("購読者がまだ作られていない");
    }
    return subscriber;
  });
}

/**
 * devtools の publisher を実リレーへつなぎ、Object を送り始めるまで待つ
 *
 * @param videoTrackName - 最初に publish する映像 Track の名前
 */
async function startPublisher(
  page: Page,
  moqtUri: string,
  namespace: string,
  videoTrackName: string,
): Promise<void> {
  const params = new URLSearchParams({
    url: moqtUri,
    namespace,
    mode: "publisher",
    videoTrackName,
    // headless Chromium で符号化できるコーデックにする
    codec: "vp8",
    resolution: "640x360",
    bitrate: "1000000",
    // 実デバイスに依存しないダミーの映像と音声を使う
    videoSource: "dummy",
    audioSource: "dummy",
    publishStop: "publish-done",
  });
  await page.goto(`${DEVTOOLS_URL}?${params.toString()}`);
  await expect(page.getByTestId("moqt-uri")).toHaveValue(moqtUri);

  await page.getByTestId("publisher-publish-button").click();
  await expect
    .poll(
      async () => {
        const publisher = await readPublisher(page);
        return publisher.objectsSent;
      },
      {
        message: "配信側が Object を送り始めるのを待つ",
        timeout: WAIT_TIMEOUT_MS,
      },
    )
    .toBeGreaterThan(0);
}

/**
 * devtools の subscriber を実リレーへつなぎ、SUBSCRIBE_TRACKS と catalog の購読を
 * 確立して映像を復号し始めるまで待つ
 */
async function startSubscriber(page: Page, moqtUri: string, namespace: string): Promise<void> {
  const params = new URLSearchParams({
    url: moqtUri,
    namespace,
    mode: "subscriber",
    // catalog に届く codec を使うが、catalog 到着前の既定値も headless Chromium で
    // 復号できるものにしておく
    codec: "vp8",
  });
  await page.goto(`${DEVTOOLS_URL}?${params.toString()}`);
  await expect(page.getByTestId("moqt-uri")).toHaveValue(moqtUri);

  await page.getByTestId("subscriber-subscribe-button").click();
  // catalog の購読だけでなく SUBSCRIBE_TRACKS の REQUEST_OK も待つ。購読が確立して
  // 映像が復号されるまで進める
  await expect
    .poll(
      async () => {
        const stats = await readSubscriber(page);
        return stats.subscribeTracksState === "active" && stats.framesDecoded > 0;
      },
      {
        message: "SUBSCRIBE_TRACKS が確立し、購読側が映像を復号し始めるのを待つ",
        timeout: WAIT_TIMEOUT_MS,
        intervals: [SAMPLE_INTERVAL_MS],
      },
    )
    .toBe(true);
}

/**
 * devtools の publisher を止め、catalog 経由の購読が PUBLISH_DONE で終わるまで待つ
 *
 * 止め方は URL で指定した publish-done である。購読側の statusMessage が
 * 「audio ended ... / video ended ...」になれば、catalog 経由の SUBSCRIBE が終了し、
 * SUBSCRIBE_TRACKS だけが残っている状態になったと分かる。
 */
async function stopPublisher(publisherPage: Page, subscriberPage: Page): Promise<void> {
  const stopButton = publisherPage.getByTestId("publisher-stop-button");
  await expect(stopButton).toBeEnabled();
  await stopButton.click();
  // セッションの close コールバックと stopPublishing の後始末は前後し得るため、
  // statusMessage ではなく status と再開ボタンの状態で停止を待つ
  await expect
    .poll(
      async () => {
        const publisher = await readPublisher(publisherPage);
        return publisher.status;
      },
      {
        message: "publisher が停止するのを待つ",
        timeout: WAIT_TIMEOUT_MS,
      },
    )
    .toBe("disconnected");
  await expect(publisherPage.getByTestId("publisher-publish-button")).toBeEnabled();
  await expect(subscriberPage.getByTestId("subscriber-status-message")).toContainText("ended", {
    timeout: WAIT_TIMEOUT_MS,
  });
}

test("publisher の再起動で同じ Track の PUBLISH を SUBSCRIBE_TRACKS から受け取り、Object を受け取る", async ({
  browser,
}) => {
  test.setTimeout(TEST_TIMEOUT_MS);
  const moqtUri = requireRelayUri();
  if (moqtUri === null) {
    return;
  }
  // sora-moq のクラスターが SUBSCRIBE_TRACKS に対応するまでの xfail。クラスターが
  // 対応してこのテストが成功するようになったら、この行を削除する
  test.fail(
    "sora-moq のクラスター状態では SUBSCRIBE_TRACKS が未対応のため、publisher の再接続後に同じ Track の PUBLISH が届かない",
  );

  const namespace = formatTrackNamespace(createTestNamespace());
  const publisherPage = await browser.newPage();
  const subscriberPage = await browser.newPage();
  try {
    await startPublisher(publisherPage, moqtUri, namespace, "video");
    await startSubscriber(subscriberPage, moqtUri, namespace);

    const started = await readSubscriber(subscriberPage);
    // SUBSCRIBE_TRACKS を送り、relay から REQUEST_OK を受けて購読が active になっている
    expect(started.subscribeTracksEnabled, "SUBSCRIBE_TRACKS を送る設定になっていない").toBe(true);
    expect(
      started.subscribeTracksState,
      "SUBSCRIBE_TRACKS の REQUEST_OK が返らず購読が確立していない",
    ).toBe("active");

    await stopPublisher(publisherPage, subscriberPage);

    // 停止直後に届く Object を baseline に混ぜないよう、少し待ってから読む
    await subscriberPage.waitForTimeout(1_000);
    const stopped = await readSubscriber(subscriberPage);
    // 購読全体と SUBSCRIBE_TRACKS は維持されている。catalog 経由の SUBSCRIBE だけが終わる
    expect(stopped.status, "publisher の停止で購読全体が止まっている").toBe("connected");
    expect(stopped.subscribeTracksState, "publisher の停止で SUBSCRIBE_TRACKS が終了している").toBe(
      "active",
    );

    // publisher を同じ設定で再起動する。Track 名は変えないため、relay が
    // SUBSCRIBE_TRACKS の購読を維持していれば、再開した同じ Track の PUBLISH が届く
    await publisherPage.getByTestId("publisher-publish-button").click();
    await expect
      .poll(
        async () => {
          const publisher = await readPublisher(publisherPage);
          return publisher.statusMessage;
        },
        {
          message: "再起動した publisher が Publishing になるのを待つ",
          timeout: WAIT_TIMEOUT_MS,
        },
      )
      .toBe("Publishing");
    // 再開した publisher が同じ Track の映像を符号化し始めるまで待つ
    await expect
      .poll(
        async () => {
          const publisher = await readPublisher(publisherPage);
          return publisher.framesEncoded;
        },
        {
          message: "再起動した publisher が同じ Track の映像を符号化し始めるのを待つ",
          timeout: WAIT_TIMEOUT_MS,
        },
      )
      .toBeGreaterThan(0);

    // relay が SUBSCRIBE_TRACKS の要求へ同じ Track の PUBLISH を送り、ライブラリが
    // REQUEST_OK を返して購読を確立し直す。その購読で Object を受け取るまで待つ。
    // ここが sora-moq のクラスター状態で失敗する箇所である
    const deadline = Date.now() + WAIT_TIMEOUT_MS;
    let recovered = await readSubscriber(subscriberPage);
    while (Date.now() < deadline) {
      recovered = await readSubscriber(subscriberPage);
      if (
        recovered.publishedSubscriptionsCount > 0 &&
        recovered.publishedObjectsReceived > stopped.publishedObjectsReceived
      ) {
        break;
      }
      await subscriberPage.waitForTimeout(SAMPLE_INTERVAL_MS);
    }
    console.log(
      `再起動後の購読: status=${recovered.status}, subscribeTracks=${String(recovered.subscribeTracksState)}, ` +
        `publishedSubscriptions=${recovered.publishedSubscriptionsCount}, ` +
        `publishedObjects=${recovered.publishedObjectsReceived}, ` +
        `framesDecoded=${recovered.framesDecoded}, ` +
        `baselinePublishedObjects=${stopped.publishedObjectsReceived}`,
    );

    // PUBLISH から確立した購読がある。onPublishEstablished は REQUEST_OK の write 後に
    // 呼ばれるため、この値は REQUEST_OK を返して確立したことの証拠になる
    expect(
      recovered.publishedSubscriptionsCount,
      "SUBSCRIBE_TRACKS の PUBLISH から購読が確立していない",
    ).toBeGreaterThan(0);
    // PUBLISH から確立した購読で Object を受け取っている
    expect(
      recovered.publishedObjectsReceived,
      `PUBLISH から確立した購読で Object を受け取っていない (${JSON.stringify(recovered)})`,
    ).toBeGreaterThan(stopped.publishedObjectsReceived);
    // 購読の状態は壊れていない
    expect(recovered.status, `購読の状態が壊れている (${JSON.stringify(recovered)})`).toBe(
      "connected",
    );
    expect(
      recovered.subscribeTracksState,
      `再起動後に SUBSCRIBE_TRACKS が active でない (${JSON.stringify(recovered)})`,
    ).toBe("active");
  } finally {
    await subscriberPage.context().close();
    await publisherPage.context().close();
  }
});
