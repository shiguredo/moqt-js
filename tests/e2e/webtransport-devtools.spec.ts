import { test, expect } from "@playwright/test";
import { WEBTRANSPORT_DEVTOOLS_URL as DEVTOOLS_URL } from "./urls";

// webtransport-devtools の UI テスト
// WebTransport サーバーへの接続は不要で、接続時設定の UI 動作と
// クエリパラメータ連携（保存・復元・排他検証）を検証する
// dev サーバーは playwright.config.ts の webServer で起動される (port 5173)

test("クエリパラメータから接続時設定が復元される", async ({ page }) => {
  // 接続時設定を含む URL を開くと、各入力欄に値が復元されることを確認する
  await page.goto(
    `${DEVTOOLS_URL}?url=https%3A%2F%2Fexample.com%2Fwt&allowPooling=true&congestionControl=low-latency&protocols=foo%2C+bar`,
  );

  await expect(page.getByTestId("connection-url")).toHaveValue("https://example.com/wt");
  await expect(page.getByTestId("connection-allow-pooling")).toBeChecked();
  await expect(page.getByTestId("connection-congestion-control")).toHaveValue("low-latency");
  await expect(page.getByTestId("connection-protocols")).toHaveValue("foo, bar");
});

test("allowPooling と certificateHash の排他検証が働く", async ({ page }) => {
  // W3C §6.9 の allowPooling と serverCertificateHashes の排他制約に基づく
  await page.goto(DEVTOOLS_URL);

  const certificateHashInput = page.getByTestId("connection-certificate-hash");
  const allowPoolingCheckbox = page.getByTestId("connection-allow-pooling");

  // certificateHash に入力すると allowPooling がオフになる
  await certificateHashInput.fill("hash");
  await expect(allowPoolingCheckbox).not.toBeChecked();

  // allowPooling をオンにすると certificateHash がクリアされ、入力欄が無効化される
  await allowPoolingCheckbox.check();
  await expect(certificateHashInput).toHaveValue("");
  await expect(certificateHashInput).toBeDisabled();
});

test("Copy URL で接続時設定がクエリパラメータに反映される", async ({ page }) => {
  // Copy URL ボタンは history.replaceState で URL を書き換えるため、
  // クリック後にページ URL へ設定が反映されることを確認する
  await page.goto(DEVTOOLS_URL);

  await page.getByTestId("connection-url").fill("https://example.com/wt");
  await page.getByTestId("connection-allow-pooling").check();
  await page.getByTestId("connection-congestion-control").selectOption("low-latency");
  await page.getByTestId("connection-headers").fill("X-Foo: bar");

  await page.getByTestId("copy-url").click();

  await expect(page).toHaveURL(/allowPooling=true/);
  await expect(page).toHaveURL(/congestionControl=low-latency/);
  // headers は "key: value" が URL エンコードされるため、正規表現ではなく includes で検証する
  await expect(page).toHaveURL((url) => url.href.includes("headers=X-Foo%3A+bar"));
});

test("静的 API 存在確認パネルに CR の新 API が表示される", async ({ page }) => {
  // 接続不要の存在確認なので、WebTransport サーバーなしで検証できる。
  // CR 2026-07-30 で追加された API が一覧に含まれ、サマリが存在確認であることを示す文言になっている
  await page.goto(DEVTOOLS_URL);

  await page.getByTestId("api-support-toggle").click();

  // サマリは「存在」を示す文言で、分母付きで表示される。
  // 分母は 52 項目から deprecated の writable と詳細項目の createWritable を除いた 50
  const summary = page.getByTestId("api-presence-summary");
  await expect(summary).toHaveText(/(All Present|Partially Present) \(\d+ \/ 50\)/);
  // 存在確認にすぎない旨の注記
  await expect(page.getByText("Presence check only")).toBeVisible();

  // 一覧に追加した API
  await expect(
    page.getByTestId("api-presence-WebTransport.prototype.exportKeyingMaterial"),
  ).toBeVisible();
  await expect(
    page.getByTestId("api-presence-WebTransportDatagramsWritable.prototype.sendOrder"),
  ).toBeVisible();
  await expect(
    page.getByTestId("api-presence-WebTransportWriter.prototype.atomicWrite"),
  ).toBeVisible();
  await expect(
    page.getByTestId("api-presence-WebTransportSendStream.prototype.getWriter"),
  ).toBeVisible();
  await expect(page.getByTestId("api-presence-WebTransportError constructor")).toBeVisible();
  await expect(
    page.getByTestId("api-presence-Datagram send path (writable or createWritable)"),
  ).toBeVisible();

  // 実際の Chromium 156 の API 有無と present / absent が一致する
  await expect(page.getByTestId("api-presence-WebTransport")).toContainText("present");
  await expect(page.getByTestId("api-presence-WebTransport.prototype.close")).toContainText(
    "present",
  );
  await expect(
    page.getByTestId("api-presence-Datagram send path (writable or createWritable)"),
  ).toContainText("present");
  // Chromium 156 はグローバルと writer 系を公開しない
  await expect(page.getByTestId("api-presence-WebTransportWriter")).toContainText("absent");
  await expect(
    page.getByTestId("api-presence-WebTransportSendStream.prototype.getWriter"),
  ).toContainText("absent");
});

test("protocols にバッジが表示される", async ({ page }) => {
  // BCD の options_protocols_parameter (Chrome 143 / Firefox 155 / Safari 26.4) を表示する
  await page.goto(DEVTOOLS_URL);
  await expect(page.getByText("Chrome: 143+")).toBeVisible();
});

test("接続失敗時は Disconnected ではなく Error と closed outcome が表示される", async ({
  page,
}) => {
  // 接続先に待ち受けが無い URL を使うとハンドシェイクが失敗する。
  // 失敗は connectionStatus の error として表示し、ready / closed の状態も残す
  await page.goto(DEVTOOLS_URL);

  await page.getByTestId("connection-url").fill("https://127.0.0.1:1/wt");
  await page.getByTestId("connection-connect").click();

  await expect(page.getByTestId("connection-status")).toContainText("Error:", { timeout: 15_000 });
  await expect(page.getByTestId("closed-outcome-state")).toHaveText("rejected");
  const closedError = page.getByTestId("closed-outcome-error");
  await expect(closedError).not.toHaveText("undefined");
  await expect(closedError).toContainText(/failed|rejected|handshake|WebTransport/i);
});

test("protocols の非 ASCII 文字は接続前に拒否される", async ({ page }) => {
  // §6.2 の protocols は構造化ヘッダーの string item として送られるため ASCII のみ許可する
  await page.goto(DEVTOOLS_URL);

  await page.getByTestId("connection-protocols").fill("プロトコル");
  await page.getByTestId("connection-connect").click();

  await expect(page.getByTestId("connection-status")).toContainText("Error:");
  await expect(page.getByTestId("connection-status")).toContainText("protocol");
});

test("証明書ハッシュが 32 byte でない場合は接続前に拒否される", async ({ page }) => {
  // §6.9 serverCertificateHashes の value は SHA-256 (32 byte) である。
  // "AAAA" は 3 byte に復号されるため拒否される
  await page.goto(DEVTOOLS_URL);

  const certificateHash = page.getByTestId("connection-certificate-hash");
  await certificateHash.fill("AAAA");
  await page.getByTestId("connection-connect").click();

  await expect(page.getByTestId("connection-status")).toContainText("Error:");
  await expect(page.getByTestId("connection-status")).toContainText("32 bytes");
  // error 状態でも設定を編集でき、不正な値を直せる
  await expect(certificateHash).toBeEnabled();
});

test("検証エラーの後も接続設定を編集して再試行できる", async ({ page }) => {
  // error 状態で接続設定が disabled になると、不正な入力を直せずページを
  // リロードするしかなくなる。入力が編集可能であることを確認する
  await page.goto(DEVTOOLS_URL);

  const protocols = page.getByTestId("connection-protocols");
  const status = page.getByTestId("connection-status");

  await protocols.fill("プロトコル");
  await page.getByTestId("connection-connect").click();
  await expect(status).toContainText("Error:");
  await expect(status).toContainText("printable ASCII");
  await expect(protocols).toBeEnabled();

  // 値を直して再試行すると、検証エラーではなく接続エラーになる
  await protocols.fill("my-protocol");
  await page.getByTestId("connection-connect").click();
  await expect(status).not.toContainText("printable ASCII", { timeout: 15_000 });
  await expect(status).toContainText("Error:", { timeout: 15_000 });
});

test("BCD の preview と experimental バッジが表示される", async ({ page }) => {
  // Safari の maxBufferedDatagrams は preview、anticipated* と maxBuffered* は
  // experimental であることが UI に出る
  await page.goto(DEVTOOLS_URL);
  await expect(page.getByText("Safari: preview").first()).toBeVisible();
  await expect(page.getByText("experimental", { exact: true }).first()).toBeVisible();
});

test("前回の closed outcome は次の接続試行でクリアされる", async ({ page }) => {
  // 接続失敗の結果を表示した後、別の接続試行を始めたら前回の結果は消える
  await page.goto(DEVTOOLS_URL);

  await page.getByTestId("connection-url").fill("https://127.0.0.1:1/wt");
  await page.getByTestId("connection-connect").click();
  await expect(page.getByTestId("closed-outcome-state")).toHaveText("rejected", {
    timeout: 15_000,
  });

  // 不正な protocols で次の接続試行を始めると、前回の closed outcome は消える
  await page.getByTestId("connection-protocols").fill("プロトコル");
  await page.getByTestId("connection-connect").click();
  await expect(page.getByTestId("connection-status")).toContainText("printable ASCII");
  await expect(page.getByTestId("closed-outcome")).toHaveCount(0);
});
