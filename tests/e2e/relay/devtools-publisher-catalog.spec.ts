import { expect, test, type Browser, type Page } from "@playwright/test";
import { formatTrackNamespace, parseTrackNamespace } from "../../../src/fullTrackName";
import { DEVTOOLS_URL } from "../urls";
import {
  RELAY_TEST_TIMEOUT_MS,
  closeRelayPage,
  createTestNamespace,
  openRelayPage,
  requireRelayUri,
} from "./support";

// moqt-devtools の publisher が配信しているトラックを、ライブラリの購読者が購読できるかを
// 実リレーで確かめる。
//
// ライブラリは catalog を SUBSCRIBE (Next Object) と FETCH の 2 経路で取得し、FETCH の
// 要求範囲は SUBSCRIBE_OK の LARGEST_OBJECT から決める。この 2 経路を含む catalog の取得は
// 合成ストリームの単体テストでは実ワイヤの作り (範囲の返し方、応答の届き方) まで再現できない。
// publisher が別実装 (moqt-devtools) である組み合わせも含めて、catalog が届いて購読が
// 始まることを実ワイヤで確かめる (どちらの経路で届いたかまでは判定しない)。
//
// devtools の UI は playwright.config.ts の webServer (port 5173) が配信する。
// 接続先は TEST_MOQT_URI で渡す。

/** devtools の publisher がダミー映像を送り始めるまで待つ上限 */
const PUBLISH_START_TIMEOUT_MS = 30_000;

/** 購読者側で映像と音声の Object が届くまで待つ上限 */
const RECEIVE_TIMEOUT_MS = 30_000;

/**
 * テスト全体の上限
 *
 * 待ちの合計 (publisher の起動 30 秒 + 受信 30 秒 × 2) が既定の
 * `RELAY_TEST_TIMEOUT_MS` と同じになるため、そこから余裕を取る。
 */
const TEST_TIMEOUT_MS = RELAY_TEST_TIMEOUT_MS * 2;

/** devtools の publisher の統計 (window.moqtDevTools.getPublisher()) の必要な部分 */
interface DevtoolsPublisherStats {
  status: string;
  objectsSent: number;
  framesEncoded: number;
}

/**
 * devtools の Publisher を実リレーへ向けて起動し、ダミーの映像を送り始めるまで待つ
 *
 * 音声の配信も有効にするが、起動の判定は映像の Object (objectsSent / framesEncoded) で行う
 * (音声の到達は購読側の assert で確かめる)。
 * URL のクエリで接続先と namespace を渡し、欄へ反映されたことと namespace が解析できたこと
 * (namespace-warning が出ないこと) を確かめてから Publish を押す。起動に失敗した場合は
 * 配信が残らないようページを閉じてから throw する。
 *
 * 返す namespace は devtools の namespace 欄の実効値である。TEST_MOQT_URI の msf fragment が
 * namespace を上書きする場合はクエリの値が使われないため、購読者へは実効値を渡す。
 */
async function startDevtoolsPublisher(
  browser: Browser,
  url: string,
  namespaceName: string,
): Promise<{ page: Page; namespace: string[] }> {
  const page = await browser.newPage();
  const params = new URLSearchParams({
    url,
    namespace: namespaceName,
    mode: "publisher",
    // vp9 は headless Chromium で符号化できないことがあるため vp8 を使う (既定は vp9)
    codec: "vp8",
    // 共有リレーと runner の負荷を抑えるため既定より小さい解像度とビットレートにする
    resolution: "640x360",
    bitrate: "1000000",
    // 音声はダミーを配信し、catalog が映像と音声の 2 トラックを持つ状態で購読する
    audioSource: "dummy",
  });
  try {
    await page.goto(`${DEVTOOLS_URL}?${params.toString()}`);
    await expect(page.getByTestId("moqt-uri")).toHaveValue(url);
    await expect(page.getByTestId("namespace-warning")).toHaveCount(0);

    const effectiveNamespaceName = await page.getByTestId("namespace").inputValue();
    await page.getByTestId("publisher-publish-button").click();
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const api = (
              window as unknown as {
                moqtDevTools: { getPublisher(): DevtoolsPublisherStats };
              }
            ).moqtDevTools;
            const stats = api.getPublisher();
            return stats.status === "connected" && stats.objectsSent > 0 && stats.framesEncoded > 0;
          }),
        {
          message: "moqt-devtools の publisher がダミー映像の Object を送り始めるのを待つ",
          timeout: PUBLISH_START_TIMEOUT_MS,
        },
      )
      .toBe(true);
    return { page, namespace: parseTrackNamespace(effectiveNamespaceName) };
  } catch (error) {
    await closeRelayPage(page);
    throw error;
  }
}

test("moqt-devtools の publisher の catalog をライブラリの購読者が受け取れる", async ({
  browser,
}) => {
  test.setTimeout(TEST_TIMEOUT_MS);
  const moqtUri = requireRelayUri();
  if (moqtUri === null) {
    return;
  }

  const requestedNamespace = createTestNamespace();
  const publisher = await startDevtoolsPublisher(
    browser,
    moqtUri,
    formatTrackNamespace(requestedNamespace),
  );
  console.log(
    "購読する namespace",
    JSON.stringify(publisher.namespace),
    "要求した namespace",
    JSON.stringify(requestedNamespace),
  );

  const subscriberPage = await openRelayPage(browser);
  let subscriberId: string | undefined;

  try {
    // createMediaSubscriber は catalog を受け取って各トラックの購読が確立するまで返らない。
    // catalog の受信タイムアウト (5000 ms) で失敗するとここで例外になる
    subscriberId = await subscriberPage.evaluate(
      (options) => window.__moqtE2E.startSubscriber(options),
      { url: moqtUri, namespace: publisher.namespace, audio: true },
    );
    // 後片付け用に保持する subscriberId とは別に、この時点で確定した ID を使う
    // (page.evaluate のコールバックの中では外側の絞り込みが効かないため)
    const activeSubscriberId = subscriberId;

    const status = await subscriberPage.evaluate(
      (id) => window.__moqtE2E.getSubscriber(id),
      activeSubscriberId,
    );
    console.log("購読者の状態", JSON.stringify(status));
    expect(status.errors).toEqual([]);
    expect(status.hasCatalog).toBe(true);
    expect(status.hasVideoTrack).toBe(true);

    // 映像と音声の Object が実際に届くこと (catalog の適用で購読が始まったことの確認)
    await expect
      .poll(
        () =>
          subscriberPage.evaluate(
            (id) => window.__moqtE2E.getSubscriber(id).framesReceived,
            activeSubscriberId,
          ),
        { message: "購読者が映像の Object を受信するのを待つ", timeout: RECEIVE_TIMEOUT_MS },
      )
      .toBeGreaterThan(0);
    await expect
      .poll(
        () =>
          subscriberPage.evaluate(
            (id) => window.__moqtE2E.getSubscriber(id).audio?.framesReceived ?? 0,
            activeSubscriberId,
          ),
        { message: "購読者が音声の Object を受信するのを待つ", timeout: RECEIVE_TIMEOUT_MS },
      )
      .toBeGreaterThan(0);

    // 受信の間に届いた遅延の失敗も見逃さないよう、待ったあとに読み直す
    const statusAfterReceiving = await subscriberPage.evaluate(
      (id) => window.__moqtE2E.getSubscriber(id),
      activeSubscriberId,
    );
    expect(statusAfterReceiving.errors).toEqual([]);
  } finally {
    if (subscriberId !== undefined) {
      await subscriberPage
        .evaluate((id) => window.__moqtE2E.stopSubscriber(id), subscriberId)
        .catch(() => {
          // 停止の失敗はテストの結果に影響しない (購読の解放は context の close でも進む)
        });
    }
    await closeRelayPage(subscriberPage);
    await closeRelayPage(publisher.page);
  }
});
