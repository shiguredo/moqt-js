import { test, expect } from "@playwright/test";

// devtools の音声設定と音声再生トグルの UI テスト
// 実リレーは起動しない (音声 object の到達は相互運用 harness 側で検証する)
// dev サーバーは playwright.config.ts の webServer で起動される (port 5173)
const DEVTOOLS_URL = "http://localhost:5173/index.html";

test("音声の設定が UI から URL へ反映され、生成された URL から復元される", async ({ page }) => {
  await page.goto(DEVTOOLS_URL);

  // 既定は Web Audio で作る音 (値は dummy)。送り方は Subgroup。コーデックは Opus・64000・48000・2ch
  await expect(page.getByTestId("audio-source")).toHaveValue("dummy");
  await expect(page.getByTestId("audio-delivery")).toHaveValue("subgroup");
  await expect(page.getByTestId("audio-codec")).toHaveValue("opus");
  await expect(page.getByTestId("audio-bitrate")).toHaveValue("64000");
  await expect(page.getByTestId("audio-sample-rate")).toHaveValue("48000");
  await expect(page.getByTestId("audio-channels")).toHaveValue("2");

  // UI から変更する (Copy URL は history.replaceState で URL を書き換える)
  await page.getByTestId("audio-source").selectOption("none");
  await page.getByTestId("audio-delivery").selectOption("datagram");
  await page.getByTestId("audio-codec").selectOption("aac");
  await page.getByTestId("audio-bitrate").selectOption("96000");
  await page.getByTestId("audio-sample-rate").selectOption("24000");
  await page.getByTestId("audio-channels").selectOption("1");
  await page.getByTestId("copy-url").click();

  await expect(page).toHaveURL(/audioSource=none/);
  await expect(page).toHaveURL(/audioDelivery=datagram/);
  await expect(page).toHaveURL(/audioCodec=aac/);
  await expect(page).toHaveURL(/audioBitrate=96000/);
  await expect(page).toHaveURL(/audioSampleRate=24000/);
  await expect(page).toHaveURL(/audioChannels=1/);

  // 生成された URL を開き直すと設定が復元される (UI → signal → URL → signal の往復)
  await page.goto(page.url());
  await expect(page.getByTestId("audio-source")).toHaveValue("none");
  await expect(page.getByTestId("audio-delivery")).toHaveValue("datagram");
  await expect(page.getByTestId("audio-codec")).toHaveValue("aac");
  await expect(page.getByTestId("audio-bitrate")).toHaveValue("96000");
  await expect(page.getByTestId("audio-sample-rate")).toHaveValue("24000");
  await expect(page.getByTestId("audio-channels")).toHaveValue("1");
});

test("Publisher と Subscriber、および Subscriber だけは音声出力デバイスを選べ、Publisher だけでは出さない", async ({
  page,
}) => {
  // 既定は両方を表示する。再生先は Subscribe Settings にある
  await page.goto(DEVTOOLS_URL);
  await expect(page.getByTestId("audio-output-fetch-devices")).toBeVisible();

  await page.goto(`${DEVTOOLS_URL}?mode=subscriber`);
  await expect(page.getByTestId("audio-output-fetch-devices")).toBeVisible();

  // Publisher だけは受信した音声を再生しない
  await page.goto(`${DEVTOOLS_URL}?mode=publisher`);
  await expect(page.getByTestId("audio-output-fetch-devices")).toHaveCount(0);
});

test("不正な音声の設定は既定値のままにし、有効な値は反映する", async ({ page }) => {
  // 有効値と無効値を同時に渡し、「拒否された」ことと「初期化が壊れた」ことを切り分ける。
  // 列挙値と選択式の数値は許可リストで検証する (選択肢に無い値を受け入れると
  // select の表示が空になり、表示と実際の設定が食い違う)
  await page.goto(
    `${DEVTOOLS_URL}?audioSource=dummy&audioCodec=vp8&audioBitrate=32000&audioSampleRate=44100&audioChannels=1`,
  );

  // 有効な値は反映される
  await expect(page.getByTestId("audio-source")).toHaveValue("dummy");
  await expect(page.getByTestId("audio-bitrate")).toHaveValue("32000");
  await expect(page.getByTestId("audio-channels")).toHaveValue("1");

  // 無効な値 (未知の codec / 選択肢に無いサンプルレート) は既定値のまま
  await expect(page.getByTestId("audio-codec")).toHaveValue("opus");
  await expect(page.getByTestId("audio-sample-rate")).toHaveValue("48000");
});

test("音声再生トグルは既定で無効で、有効にすると audio 要素へ出力を繋ぐ", async ({ page }) => {
  await page.goto(DEVTOOLS_URL);

  const audioElement = page.getByTestId("subscriber-audio-element");
  const toggle = page.getByTestId("subscriber-audio-playback-toggle");

  // 既定では再生しない (srcObject が未設定で checkbox は外れている)
  await expect(toggle).not.toBeChecked();
  await expect(audioElement).toHaveJSProperty("paused", true);
  await expect(audioElement).toHaveJSProperty("srcObject", null);

  // トグルを有効にすると、devtools 側で組んだ MediaStreamAudioDestinationNode の
  // ストリームが srcObject に設定され、再生状態になる
  await toggle.click();
  await expect(toggle).toBeChecked();
  await expect(audioElement).not.toHaveJSProperty("srcObject", null);
  await expect(audioElement).toHaveJSProperty("paused", false);

  // 無効に戻すと srcObject が外れて停止する
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  await expect(audioElement).toHaveJSProperty("srcObject", null);
  await expect(audioElement).toHaveJSProperty("paused", true);
});

test("ダミー音声のストリームは指定したチャンネル数で実際にサンプルを流す", async ({ page }) => {
  // トグルを 1 度クリックしてユーザー操作を作る。自動再生ポリシー下では
  // 操作なしに作った AudioContext が suspended のままになり得る
  await page.goto(DEVTOOLS_URL);
  await page.getByTestId("subscriber-audio-playback-toggle").click();

  // dev サーバーが配信するモジュールを直接読み込み、ブラウザ側の音声経路だけを検証する。
  // テストファイル側の tsconfig は devtools の WebCodecs 型拡張を読み込まないため、
  // ここでは必要な形を明示してキャストする
  const results = await page.evaluate(async () => {
    const modulePath = "/src/webcodecs-devtools/utils/dummyAudio.ts";
    const module = (await import(modulePath)) as {
      createDummyAudioStream: (
        sampleRate: number,
        channels: number,
      ) => { stream: MediaStream; stop: () => void };
      summarizeToneLevel: (samples: Float32Array) => { level: number; voiceActivity: boolean };
    };

    const processorCtor = (
      globalThis as unknown as {
        MediaStreamTrackProcessor: new (init: { track: MediaStreamTrack }) => {
          readable: ReadableStream<AudioData>;
        };
      }
    ).MediaStreamTrackProcessor;

    const observed = [];
    // モノラルでも符号化できること。MediaStreamAudioDestinationNode の既定は 2ch の
    // ため、チャンネル数を明示しないと Encoder の設定と食い違って符号化が止まる
    for (const channels of [1, 2]) {
      const generator = module.createDummyAudioStream(48000, channels);
      const [track] = generator.stream.getAudioTracks();
      if (!track) {
        generator.stop();
        throw new Error("dummy audio stream has no track");
      }

      const processor = new processorCtor({ track });
      const reader = processor.readable.getReader();
      const { value } = await reader.read();
      if (!value) {
        generator.stop();
        throw new Error("dummy audio stream produced no AudioData");
      }

      try {
        // 第 1 チャンネルを f32-planar で読み出し、実際に信号が乗っていることを見る
        const samples = new Float32Array(value.numberOfFrames);
        value.copyTo(samples, { planeIndex: 0, format: "f32-planar" });
        let peak = 0;
        for (const sample of samples) {
          const magnitude = Math.abs(sample);
          if (magnitude > peak) {
            peak = magnitude;
          }
        }
        observed.push({
          requestedChannels: channels,
          numberOfChannels: value.numberOfChannels,
          numberOfFrames: value.numberOfFrames,
          sampleRate: value.sampleRate,
          peak,
          level: module.summarizeToneLevel(samples),
        });
      } finally {
        value.close();
        await reader.cancel();
        generator.stop();
      }
    }
    return observed;
  });

  expect(results).toHaveLength(2);
  for (const result of results) {
    expect(result.numberOfChannels).toBe(result.requestedChannels);
    expect(result.numberOfFrames).toBeGreaterThan(0);
    expect(result.sampleRate).toBe(48000);
    // 生成したトーンがそのまま流れている (無音ではない)
    expect(result.peak).toBeGreaterThan(0.1);

    // LOC Audio Level (RFC 6464 §3) が -dBov として求まる
    expect(result.level.level).toBeGreaterThanOrEqual(12);
    expect(result.level.level).toBeLessThanOrEqual(18);
    expect(result.level.voiceActivity).toBe(true);
  }
});

test("ダミー音声は MediaStreamTrackProcessor が使えるブラウザで配信可能と判定される", async ({
  page,
}) => {
  // 音声の配信可否はブラウザの対応状況で決まる。Node には MediaStreamTrackProcessor が
  // 無いため単体テストでは false 側しか固定できず、対応環境の true をここで確認する
  await page.goto(DEVTOOLS_URL);

  const publishable = await page.evaluate(async () => {
    const modulePath = "/src/hooks/usePublisher.ts";
    const module = (await import(modulePath)) as {
      resolveAudioPublishable: (source: string) => boolean;
    };
    return {
      dummy: module.resolveAudioPublishable("dummy"),
      none: module.resolveAudioPublishable("none"),
    };
  });

  expect(publishable).toEqual({ dummy: true, none: false });
});
