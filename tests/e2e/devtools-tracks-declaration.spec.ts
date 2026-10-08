import { test, expect } from "@playwright/test";

// devtools の Tracks カードが出す catalog の宣言の UI テスト
// 宣言は配信の前に画面が示す値のため、実リレーは起動しない (DOM だけで検証できる)
// dev サーバーは playwright.config.ts の webServer で起動される (port 5173)
const DEVTOOLS_URL = "http://localhost:5173/index.html";

// 既定の設定 (devtools/src/signals/connectionSettings.ts) で、Tracks カードに catalog の
// 宣言が全て出る。キーは catalog のキーそのままで、送信後に catalog を出す Catalog パネルと
// 同じ名前で読める。値は下の Audio / Video カードの設定から決まる
test("Tracks カードが既定値の catalog の宣言を出す", async ({ page }) => {
  await page.goto(DEVTOOLS_URL);

  // 音声: Audio カードの Bitrate / Sample Rate / Channels から決まる
  // (samplerate / channelConfig は MSF §5.2.28 / §5.2.29 が audio codec の track に MUST で要求する)
  await expect(page.getByTestId("audio-track-packaging")).toHaveText("loc");
  await expect(page.getByTestId("audio-track-isLive")).toHaveText("true");
  await expect(page.getByTestId("audio-track-bitrate")).toHaveText("64 kbps");
  await expect(page.getByTestId("audio-track-samplerate")).toHaveText("48000");
  // channelConfig は catalog では文字列で載る (§5.2.29)
  await expect(page.getByTestId("audio-track-channelConfig")).toHaveText("2");

  // 映像: Video カードの Resolution / Frame Rate / Bitrate から決まる
  await expect(page.getByTestId("video-track-packaging")).toHaveText("loc");
  await expect(page.getByTestId("video-track-isLive")).toHaveText("true");
  await expect(page.getByTestId("video-track-width")).toHaveText("1280");
  await expect(page.getByTestId("video-track-height")).toHaveText("720");
  await expect(page.getByTestId("video-track-framerate")).toHaveText("30");
  await expect(page.getByTestId("video-track-bitrate")).toHaveText("2.0 Mbps");

  // event timeline: depends は広告するメディアトラックの名前 (§8.2)
  await expect(page.getByTestId("event-track-packaging")).toHaveText("eventtimeline");
  await expect(page.getByTestId("event-track-isLive")).toHaveText("true");
  await expect(page.getByTestId("event-track-mimeType")).toHaveText("application/json");
  await expect(page.getByTestId("event-track-depends")).toHaveText('["audio","video"]');

  // 上の入力欄 / 選択欄が既に値を見せているキーは行にしない (name / role / codec / eventType)。
  // name の testid (audio-track-name / video-track-name / event-track-name) は入力欄が持つ
  await expect(page.getByTestId("audio-track-role")).toHaveCount(0);
  await expect(page.getByTestId("audio-track-codec")).toHaveCount(0);
  await expect(page.getByTestId("video-track-role")).toHaveCount(0);
  await expect(page.getByTestId("video-track-codec")).toHaveCount(0);
  await expect(page.getByTestId("event-track-eventType")).toHaveCount(0);

  // targetLatency / renderGroup は未指定 (Unset) のとき宣言に載らない。
  // draft-ietf-moq-msf-01 §5.2.8: 宣言が無く isLive が true のときは購読側が遅延を選んでよい MAY
  await expect(page.getByTestId("audio-track-targetLatency")).toHaveCount(0);
  await expect(page.getByTestId("audio-track-renderGroup")).toHaveCount(0);
  await expect(page.getByTestId("video-track-targetLatency")).toHaveCount(0);
});

// Tracks カードの宣言は Audio カードの設定に追随する。ここが追随しないと、画面で見た値と
// 実際に送る catalog の値が食い違う
test("Audio カードの設定を変えると音声の宣言が追随する", async ({ page }) => {
  await page.goto(DEVTOOLS_URL);

  await page.getByTestId("audio-bitrate").selectOption("96000");
  await page.getByTestId("audio-sample-rate").selectOption("24000");
  await page.getByTestId("audio-channels").selectOption("1");

  await expect(page.getByTestId("audio-track-bitrate")).toHaveText("96 kbps");
  await expect(page.getByTestId("audio-track-samplerate")).toHaveText("24000");
  await expect(page.getByTestId("audio-track-channelConfig")).toHaveText("1");

  // 映像の宣言は映像の設定から決まるため変わらない
  await expect(page.getByTestId("video-track-width")).toHaveText("1280");
  await expect(page.getByTestId("video-track-bitrate")).toHaveText("2.0 Mbps");
});

// Video カードの設定に追随する。映像の宣言は width / height / framerate / bitrate を持つ
test("Video カードの設定を変えると映像の宣言が追随する", async ({ page }) => {
  await page.goto(DEVTOOLS_URL);

  await page.getByTestId("resolution").selectOption("640x480");
  await page.getByTestId("framerate").selectOption("15");
  await page.getByTestId("video-bitrate").selectOption("8000000");

  await expect(page.getByTestId("video-track-width")).toHaveText("640");
  await expect(page.getByTestId("video-track-height")).toHaveText("480");
  await expect(page.getByTestId("video-track-framerate")).toHaveText("15");
  await expect(page.getByTestId("video-track-bitrate")).toHaveText("8.0 Mbps");

  // 音声の宣言は音声の設定から決まるため変わらない
  await expect(page.getByTestId("audio-track-samplerate")).toHaveText("48000");
});

// draft-ietf-moq-msf-01 §5.2.8 / §5.2.11: targetLatency と renderGroup は音声と映像の
// 両方の track に同じ値を載せ、メディアを描画しない event timeline には載せない
test("Catalog カードの Target Latency と Render Group が音声と映像の宣言に載る", async ({
  page,
}) => {
  await page.goto(DEVTOOLS_URL);

  await page.getByTestId("target-latency").selectOption("100");
  await page.getByTestId("render-group").selectOption("1");

  await expect(page.getByTestId("audio-track-targetLatency")).toHaveText("100");
  await expect(page.getByTestId("audio-track-renderGroup")).toHaveText("1");
  await expect(page.getByTestId("video-track-targetLatency")).toHaveText("100");
  await expect(page.getByTestId("video-track-renderGroup")).toHaveText("1");
  await expect(page.getByTestId("event-track-targetLatency")).toHaveCount(0);
  await expect(page.getByTestId("event-track-renderGroup")).toHaveCount(0);

  // Unset に戻すと宣言から消える (§5.2.8 の MAY の経路が残る)
  await page.getByTestId("target-latency").selectOption("");
  await page.getByTestId("render-group").selectOption("");
  await expect(page.getByTestId("audio-track-targetLatency")).toHaveCount(0);
  await expect(page.getByTestId("video-track-renderGroup")).toHaveCount(0);
});

// トラック名は Tracks カードの入力欄の値がそのまま catalog の name になり、event timeline の
// depends にも同じ値が載る (§8.2: depends は対応するメディアトラックの名前)
test("トラック名を変えると event timeline の depends が追随する", async ({ page }) => {
  await page.goto(DEVTOOLS_URL);

  await page.getByTestId("video-track-name").fill("cam");
  await page.getByTestId("audio-track-name").fill("mic");

  await expect(page.getByTestId("event-track-depends")).toHaveText('["mic","cam"]');
});

// 広告しないトラックは catalog に載らないため、宣言の行も出さない (Advertised の行が理由を出す)。
// depends からも消え、メディアトラックが 1 つも無ければ空になる
test("広告しないトラックの宣言を出さず、event timeline の depends からも消す", async ({ page }) => {
  await page.goto(DEVTOOLS_URL);

  // 映像の入力を None にすると映像の宣言が消え、depends には音声だけが残る
  await page.getByTestId("video-source").selectOption("none");
  await expect(page.getByTestId("video-track-declaration")).toHaveCount(0);
  await expect(page.getByTestId("event-track-depends")).toHaveText('["audio"]');

  // 音声も None にすると event timeline の宣言だけが残り、depends は空になる
  await page.getByTestId("audio-source").selectOption("none");
  await expect(page.getByTestId("audio-track-declaration")).toHaveCount(0);
  await expect(page.getByTestId("event-track-declaration")).toBeVisible();
  await expect(page.getByTestId("event-track-depends")).toHaveText("[]");
});
