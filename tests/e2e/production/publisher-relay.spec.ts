import { expect, test } from "@playwright/test";
import { openProductionPage, PRODUCTION_RELAY_TIMEOUT_MS, requireRelayUri } from "./support";

/**
 * production ビルド + moqt-js の既定 useWorker で、公開 API の経路が実リレーまで通ることを
 * 検証する
 *
 * createMediaPublisher().start() は接続、PUBLISH の往復、カタログの送信、エンコーダーの
 * configure をこの順に進める。configure は worker のロードと init の往復を含むため、
 * "publishing" まで到達すれば worker が壊れていないことまで確認できる。実リレーが
 * 要るため、接続先を渡していない実行では skip する (relay ディレクトリの spec と同じ流儀)。
 *
 * リレー不要の再現経路は worker-bundle.spec.ts (生成物の検査と実 Worker の起動) であり、
 * この spec は「既定 useWorker の実際の利用経路」の確認である。
 */
test("既定 useWorker の Publisher が production ビルドで配信を開始できる", async ({ page }) => {
  test.setTimeout(PRODUCTION_RELAY_TIMEOUT_MS);

  const moqtUri = requireRelayUri();
  if (moqtUri === null) {
    return;
  }

  // 実 Worker が生成されたことを Playwright の観測で確かめる (モックではなく実際の生成)
  const createdWorkers: string[] = [];
  page.on("worker", (worker) => {
    createdWorkers.push(worker.url());
  });
  // 失敗時に原因を追えるように、ページのエラー出力を集めておく
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors.push(message.text());
    }
  });

  await openProductionPage(page);

  // 実リレーは共有のため、namespace が衝突しないようにする
  const namespace = ["moqt-js-e2e-production", crypto.randomUUID()];
  const id = await page.evaluate(
    ([url, ns]) => window.__moqtProduction.startPublisher({ url, namespace: ns }),
    [moqtUri, namespace] as const,
  );

  const result = await page.evaluate(
    (handle) => window.__moqtProduction.getPublisherState(handle),
    id,
  );

  // start() が解決していれば、接続・PUBLISH・カタログ送信・encoder configure (worker の
  // init 往復を含む) のすべてが完了している
  expect(
    result.ok,
    `Publisher の状態を取得できなかった: ${JSON.stringify(result)} / ページのエラー: ${JSON.stringify(consoleErrors)}`,
  ).toBe(true);
  if (result.ok) {
    // onError の通知は start() の reject には現れないため、状態と合わせて確認する
    expect(
      result.errors,
      `Publisher が onError を通知した: ${JSON.stringify(result.errors)}`,
    ).toEqual([]);
    expect(
      result.state,
      `Publisher が publishing にならなかった: ${JSON.stringify(result)} / ページのエラー: ${JSON.stringify(consoleErrors)}`,
    ).toBe("publishing");
  }

  // 既定 useWorker の経路が実際に DedicatedWorker を生成している
  expect(
    createdWorkers.length,
    `生成された worker: ${JSON.stringify(createdWorkers)}`,
  ).toBeGreaterThan(0);

  await page.evaluate((handle) => window.__moqtProduction.stopPublisher(handle), id);
});
