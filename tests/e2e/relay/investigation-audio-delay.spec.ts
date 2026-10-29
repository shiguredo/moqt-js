import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { formatTrackNamespace } from "../../../src/fullTrackName";
import { RELAY_TEST_TIMEOUT_MS, createTestNamespace, requireRelayUri } from "./support";
import { DEVTOOLS_URL } from "../urls";

// 調査専用の spec である。値の判定はせず、計測した結果を `investigation-logs/` へ書く。
//
// 測定の待ち時間 (1 テストあたり 30〜60 秒) を CI へ持ち込まないため、
// `MOQT_INVESTIGATION=1` のときだけ動かす。既定では skip する。
//
// 目的は「A/V 同期と音声の遅延の内訳を 1 秒ごとに 60 秒採る」ことである。経路が跳ねた回に
// `syncExtraDelayPinnedAtLimit` が出る条件、目標遅延の上限が効いているか、不感帯の効果を、
// 同じ時間帯の条件で比べるために使う。値は判定に使わず、`investigation-logs/` へ
// JSON Lines で書く。
//
// 動かし方は docs/AUDIO_PLAYOUT_LATENCY.md を参照すること。実行例:
//
//   npx vp exec playwright test --project=relay --grep "調査: A/V 同期と音声の遅延の内訳を"
//
// 別プロジェクトが port 5173 を使っている環境では、`MOQT_DEVTOOLS_URL` と
// playwright.config.ts のポートをずらす必要がある。

/** devtools のページ */

/** 観測の間隔 (ミリ秒)。追いつきの開始条件を細かく見るときは 250 にする */
const SAMPLE_INTERVAL_MS = Number(process.env.MOQT_INVESTIGATION_INTERVAL_MS ?? "1000");

/** 観測を続ける秒数 */
const INVESTIGATION_SECONDS = Number(process.env.MOQT_INVESTIGATION_SECONDS ?? "60");

/**
 * 受信する datagram を捨てる割合 (0 なら捨てない)
 *
 * 音声は既定で datagram で届き、再送されない。落ちたときの壊れ方と戻り方を測るために、
 * `MOQT_INVESTIGATION_LOSS=0.02` のように指定する
 */
const DATAGRAM_LOSS_RATIO = Number(process.env.MOQT_INVESTIGATION_LOSS ?? "0");

/**
 * 損失を何個まとめて落とすか (1 なら 1 個ずつ)
 *
 * 実際の経路の損失は、輻輳で送信キューがあふれたときにまとめて落ちる。1 個ずつ落とす注入では
 * 「続けて送った冗長化の 2 個目」も生き残ってしまうため、まとめて落とす条件も測れるようにする
 */
const DATAGRAM_LOSS_BURST = Number(process.env.MOQT_INVESTIGATION_LOSS_BURST ?? "1");

/** 受信する datagram に与える揺らぎの上限 (ミリ秒)。0 なら揺らぎを注入しない */
const DATAGRAM_JITTER_MS = Number(process.env.MOQT_INVESTIGATION_JITTER_MS ?? "0");

/** たまに大きく遅らせる割合 (0〜1)。実際の経路は、普段は静かで時々まとめて遅れる */
const DATAGRAM_JITTER_SPIKE_RATIO = Number(
  process.env.MOQT_INVESTIGATION_JITTER_SPIKE_RATIO ?? "0",
);

/** 到着を遅らせる割合 (0〜1)。配信側が冗長化で 2 個目を後から送ったときと同じ形になる */
const DATAGRAM_LATE_RATIO = Number(process.env.MOQT_INVESTIGATION_LATE_RATIO ?? "0");

/** 到着を遅らせるときの遅れ (ミリ秒) */
const DATAGRAM_LATE_MS = Number(process.env.MOQT_INVESTIGATION_LATE_MS ?? "60");

/**
 * 「1 個目を落として、2 個目が遅れて届く」割合 (0〜1)
 *
 * 配信側の冗長化では、2 個目を後続の Object と一緒に送るため、1 個目を失った分は遅れて届く。
 * その形だけを注入する (到着を遅らせるだけでは、先に届いた 1 個目が使われて影響が出ない)
 */
const DATAGRAM_RECOVERY_RATIO = Number(process.env.MOQT_INVESTIGATION_RECOVERY_RATIO ?? "0");

/** 復旧の分が遅れて届く長さ (ミリ秒) */
const DATAGRAM_RECOVERY_MS = Number(process.env.MOQT_INVESTIGATION_RECOVERY_MS ?? "60");

/** たまに遅らせるときの遅れ (ミリ秒) */
const DATAGRAM_JITTER_SPIKE_MS = Number(process.env.MOQT_INVESTIGATION_JITTER_SPIKE_MS ?? "0");

/**
 * 同じ Group の datagram を遅らせて、Group の順序を入れ替える間隔 (Group 数)
 *
 * 0 なら無効。N > 0 のとき、受信した datagram の Group ID を数え、N 個ごとの Group に
 * 属する datagram をすべて遅らせる。既存の recovery 注入は「1 Object = 2 datagram」の
 * 組の並びを仮定しているため、組の先頭がずれると遅らせた copy が重複として捨てられ、
 * 注入が効かないことがある (同じ条件の 2 回で片方だけ効いた)。Group ID を wire から
 * 読めば copy の並びに依存せず、順序を入れ替えられる
 */
const DATAGRAM_REORDER_EVERY = Number(process.env.MOQT_INVESTIGATION_REORDER_EVERY ?? "0");

/**
 * Group の順序を入れ替えるときに遅らせる長さ (ミリ秒)
 *
 * 音声 1 Object = 20 ms であり、40 ms 遅らせると 2 個後ろの Group より後に受信される
 */
const DATAGRAM_REORDER_MS = Number(process.env.MOQT_INVESTIGATION_REORDER_MS ?? "40");

/** 音声の Object が届いて鳴り始めるまでに待つ上限 (ミリ秒) */
const AUDIO_ARRIVAL_TIMEOUT_MS = 30_000;

/** 配信する音声のサンプルレート (Hz)。環境変数で切り替える */
const AUDIO_SAMPLE_RATE = process.env.MOQT_TEST_AUDIO_SAMPLE_RATE ?? "48000";

/** 配信する音声のチャンネル数。環境変数で切り替える */
const AUDIO_CHANNELS = process.env.MOQT_TEST_AUDIO_CHANNELS ?? "2";

// 偽のマイクは完全な Chromium (新しい headless) でだけ使える
test.use({
  launchOptions: {
    channel: "chromium",
    args: ["--use-fake-device-for-media-stream"],
  },
  permissions: ["microphone", "camera"],
});

/** devtools の publisher の統計 (採る値だけ) */
interface PublisherStats {
  audio: {
    objectsSent: number;
    timestampOffset: {
      currentMs: number;
      minMs: number;
      maxMs: number;
      slope10sMsPerSecond: number | null;
      appliedMs: number | null;
      samples: number;
    };
    catchUp: {
      catchUpStarts: number;
      droppedMs: number;
      sendLagMs: number | null;
      maxSendLagMs: number | null;
    };
  };
}

/** devtools の subscriber の統計 (採る値だけ) */
interface SubscriberStats {
  warnings: readonly unknown[];
  // relay の cache から追いつく途中で、復号したが描かなかったフレーム数 (映像の取りこぼし)
  catchUpFramesSkipped: number;
  audio: {
    playbackEnabled: boolean;
    objectsReceived: number;
    datagramObjectsReceived: number;
    chunksDecoded: number;
    playoutRebases: number;
    playoutCompressedMs: number;
    playoutConcealedMs: number;
    playoutConcealments: number;
    playoutDrops: number;
    catchUpObjectsSkipped: number;
    playedMs: number;
    receiveDelayMs: number;
    maxReceiveDelayMs: number;
    // 受信側の重複排除と順序逆転の計器 (devtools の受信経路が数える累積)。
    // 重複は配信側の冗長化で届いた 2 個目以降を捨てた数、順序逆転は受信済みの
    // 最大 Location より古い Location で届いた数である (冗長化の copy は同じ Location なので
    // 1 回だけ数える)。順序逆転の距離は Group ID の差 (`maxOutOfOrderGroupDistance`) で読む。
    // devtools 側は同じ名前で実装している
    duplicateObjectsDropped: number;
    outOfOrderObjectsReceived: number;
    maxOutOfOrderGroupDistance: number;
    playoutTiming: {
      playedMs: number;
      missedFrames: number;
      gapCount: number;
      gapMs: number;
      unrecoverableGapMs: number;
      startDelayMs: {
        p50: number | null;
        p95: number | null;
        max: number | null;
      } | null;
    };
    playoutCatchUp: {
      catchUpStarts: number;
      catchingUp: boolean;
      lagMs: number;
      floorMs: number;
      maxLagMs: number;
      skippedMs: number;
    };
  };
  avSync: {
    skewMs: number | null;
    delays: {
      sharingBases: boolean;
      unsharedReason: string;
      baseDifferenceMs: number | null;
      baseDifferenceRecentMs: number | null;
      baseDifferenceSettledMs: number | null;
      baseDriftMsPerSecond: number | null;
      audioPlayoutCorrectionMs?: number;
      audio: {
        baseDelayMs: number | null;
        jitterDelayMs: number | null;
        syncExtraDelayMs: number;
        presentationDelayMs: number | null;
      };
      video: {
        baseDelayMs: number | null;
        jitterDelayMs: number | null;
        syncExtraDelayMs: number;
        presentationDelayMs: number | null;
      };
      audioDelay: {
        targetMs: number;
        jitterMs: number | null;
        outputLeadMs: number | null;
      };
    };
  };
}

/** 統計を読む */
async function readPublisher(page: Page): Promise<PublisherStats> {
  return page.evaluate(() => {
    const api = (window as unknown as { moqtDevTools: { getPublisher(): PublisherStats } })
      .moqtDevTools;
    return api.getPublisher();
  });
}

/** 統計を読む */
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

/** 受信した音声の再生を有効にする (押すと停止になるため、無効なときだけ押す) */
async function ensureAudioPlaybackEnabled(page: Page): Promise<void> {
  const toggle = page.getByTestId("subscriber-audio-playback-toggle");
  if ((await toggle.getAttribute("aria-pressed")) !== "true") {
    await toggle.click();
  }
}

/** 配信と購読を始める */
async function startBoth(page: Page, moqtUri: string, namespace: string): Promise<void> {
  const params = new URLSearchParams({
    url: moqtUri,
    namespace,
    mode: "both",
    codec: "vp8",
    resolution: "640x360",
    bitrate: "1000000",
    audioSource: "microphone",
    audioSampleRate: AUDIO_SAMPLE_RATE,
    audioChannels: AUDIO_CHANNELS,
  });
  const targetLatencyMs = process.env.MOQT_TEST_TARGET_LATENCY;
  if (targetLatencyMs !== undefined) {
    params.set("targetLatency", targetLatencyMs);
  }
  // 音声 Object の送信回数 (1 か 2)。2 のときは配信側が同じ Object を 2 回送る
  const redundancy = process.env.MOQT_INVESTIGATION_REDUNDANCY;
  if (redundancy !== undefined) {
    params.set("audioRedundancy", redundancy);
  }
  await page.goto(`${DEVTOOLS_URL}?${params.toString()}`);
  await expect(page.getByTestId("moqt-uri")).toHaveValue(moqtUri);
  await page.getByTestId("publisher-publish-button").click();
  await expect
    .poll(
      async () => {
        const publisher = await readPublisher(page);
        return publisher.audio.objectsSent;
      },
      {
        message: "配信側が Object を送り始めるのを待つ",
        timeout: 30_000,
      },
    )
    .toBeGreaterThan(0);
  await page.getByTestId("subscriber-subscribe-button").click();
  await ensureAudioPlaybackEnabled(page);
}

/** 音声が届いて鳴るまで待つ */
async function waitForAudio(page: Page): Promise<void> {
  await expect
    .poll(
      async () => {
        const stats = await readSubscriber(page);
        return stats.audio.playbackEnabled && stats.audio.chunksDecoded > 10;
      },
      { message: "購読側が音声を復号して鳴らし始めるのを待つ", timeout: AUDIO_ARRIVAL_TIMEOUT_MS },
    )
    .toBe(true);
}

/**
 * 受信する datagram を指定の割合で捨てる仕込みを入れる (ページを開く前に呼ぶ)
 *
 * 音声は既定で datagram で届く (RFC 9221、再送されない)。経路の損失がそのまま音の欠落に
 * なるため、落ちたときに何が起きるかを測るには損失を起こす必要がある。手元の経路の実測は
 * 0.000〜0.024 であり、狙った割合で起こせないため、`WebTransport` の datagram の読み出しを
 * 包んで届かなかったことにする (この環境では `sudo` が要る経路の操作ができない)。
 * 実装 (ライブラリ) には手を入れない。落とす判断は固定の種で行う (回ごとに比べられるように)
 */
/**
 * 受信する datagram に揺らぎ (0〜maxDelayMs の遅れ) を注入する
 *
 * 実装 (ライブラリ) には手を入れない。datagram は順序を保証しないため、遅らせて流すだけである。
 * 目標遅延が揺らぎにどう反応するかを、経路任せにせず条件を決めて測るために使う
 */
async function installDatagramJitter(
  page: Page,
  maxDelayMs: number,
  spikeRatio = 0,
  spikeMs = 0,
): Promise<void> {
  if (maxDelayMs <= 0 && (spikeRatio <= 0 || spikeMs <= 0)) {
    return;
  }
  await page.addInitScript(
    (settings: {
      lateMs: number;
      lateRatio: number;
      maxDelay: number;
      recoveryMs: number;
      recoveryRatio: number;
      spikeMs: number;
      spikeRatio: number;
    }) => {
      const maxDelay = settings.maxDelay;
      const spikeRatio = settings.spikeRatio;
      const spikeMs = settings.spikeMs;
      const lateRatio = settings.lateRatio;
      const lateMs = settings.lateMs;
      const recoveryRatio = settings.recoveryRatio;
      const recoveryMs = settings.recoveryMs;
      // 音声は 1 Object = 2 datagram (冗長度 2) で、datagram の流れは音声だけである。
      // 2 個ずつの組として数え、組の 1 個目を落として 2 個目を遅らせる
      let datagramIndex = 0;
      const OriginalWebTransport = window.WebTransport;
      class JitteryWebTransport extends OriginalWebTransport {
        constructor(url: string, options?: WebTransportOptions) {
          super(url, options);
          const source = this.datagrams.readable.getReader();
          let state = 0x9e3779b9;
          const nextRandom = (): number => {
            state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
            return state / 0x1_0000_0000;
          };
          Object.defineProperty(this.datagrams, "readable", {
            configurable: true,
            value: new ReadableStream<Uint8Array>({
              start(controller) {
                const pump = async (): Promise<void> => {
                  for (;;) {
                    const { value, done } = await source.read();
                    if (done) {
                      controller.close();
                      return;
                    }
                    // 普段は 0〜maxDelay の揺らぎ、たまに (spikeRatio の割合で) spikeMs だけ
                    // 遅れる。lateRatio の割合では lateMs だけ遅らせる (配信側の冗長化の
                    // 2 個目が後から届く形と同じになる)
                    //
                    // recoveryRatio では、音声の組 (1 Object = 2 datagram) のうち
                    // recoveryEvery 組に 1 組だけ、1 個目を落として 2 個目を recoveryMs だけ
                    // 遅らせる。1 個目を失った分の復旧が遅れて届く形である
                    const index = datagramIndex;
                    datagramIndex += 1;
                    const recoveryEvery = Math.max(
                      1,
                      Math.round(1 / Math.max(recoveryRatio, 0.001)),
                    );
                    const isRecovery =
                      recoveryRatio > 0 && Math.floor(index / 2) % recoveryEvery === 0;
                    if (isRecovery && index % 2 === 0) {
                      continue;
                    }
                    const delayMs = isRecovery
                      ? recoveryMs
                      : lateRatio > 0 && nextRandom() < lateRatio
                        ? lateMs
                        : spikeRatio > 0 && spikeMs > 0 && nextRandom() < spikeRatio
                          ? spikeMs
                          : nextRandom() * maxDelay;
                    setTimeout(() => {
                      try {
                        controller.enqueue(value);
                      } catch {
                        // 読み手が閉じた後は捨てる
                      }
                    }, delayMs);
                  }
                };
                void pump();
              },
            }),
          });
        }
      }
      window.WebTransport = JitteryWebTransport as unknown as typeof WebTransport;
    },
    {
      lateMs: DATAGRAM_LATE_MS,
      lateRatio: DATAGRAM_LATE_RATIO,
      maxDelay: maxDelayMs,
      recoveryMs: DATAGRAM_RECOVERY_MS,
      recoveryRatio: DATAGRAM_RECOVERY_RATIO,
      spikeMs,
      spikeRatio,
    },
  );
}

/**
 * 受信する datagram の Group 単位の順序を入れ替える仕込みを入れる (ページを開く前に呼ぶ)
 *
 * 既存の `installDatagramJitter` の recovery 注入は「1 Object = 2 datagram」の組を仮定して
 * いるため、組の先頭がずれると、遅らせた copy が同じ Object の先着 copy と重複して捨てられ、
 * 注入が効かなくなる (同じ条件の 2 回で片方だけ効いた)。ここでは datagram の wire から
 * Group ID を読み、Group を数えて N 個ごとの Group に属する全 copy を遅らせる。copy の並びに
 * 依存しないため、どの copy が先に届いてもその Group は後続の Group より後に受信される。
 *
 * datagram の wire は Type Flags (varint) → Track Alias (varint) → Group ID (varint) の順で
 * ある (draft-ietf-moq-transport-22 §11.2.1。varint は §8.1。エンコードの並びは
 * `src/dataStream/datagram.ts` の `encodeObjectDatagram` を参照)。PADDING datagram
 * (§11.5.2、Type 0x132b3e29) は Track Alias も Group ID も持たないため、そのまま流す。
 * 実装 (ライブラリ) には手を入れない
 */
async function installDatagramReorder(page: Page): Promise<void> {
  if (!Number.isFinite(DATAGRAM_REORDER_EVERY) || DATAGRAM_REORDER_EVERY <= 0) {
    return;
  }
  // 遅らせる長さが 0 以下や非有限だと順序が入れ替わらないため、既定の 40 ms にする
  const reorderMs =
    Number.isFinite(DATAGRAM_REORDER_MS) && DATAGRAM_REORDER_MS > 0 ? DATAGRAM_REORDER_MS : 40;
  await page.addInitScript(
    (settings: { delayMs: number; every: number }) => {
      const every = Math.max(1, Math.floor(settings.every));
      const delayMs = settings.delayMs;
      // PADDING datagram の Type Flags (draft-ietf-moq-transport-22 §11.5.2)
      const paddingDatagramType = 0x132b3e29n;

      /**
       * MOQT の varint を読む (draft-ietf-moq-transport-22 §8.1)
       *
       * 先頭バイトの leading 1-bit の数で長さ (1〜9 バイト) が決まる。9 バイトは 64 bit の
       * 値であり、Group ID の比較に使うため bigint で返す
       *
       * @returns 値と読んだバイト数。データが足りないときは null
       */
      const readMoqtVarint = (
        data: Uint8Array,
        offset: number,
      ): { length: number; value: bigint } | null => {
        const firstByte = data[offset];
        if (firstByte === undefined) {
          return null;
        }
        let length: number;
        let usableBitsInFirstByte: number;
        if ((firstByte & 0x80) === 0) {
          length = 1;
          usableBitsInFirstByte = 7;
        } else if ((firstByte & 0xc0) === 0x80) {
          length = 2;
          usableBitsInFirstByte = 6;
        } else if ((firstByte & 0xe0) === 0xc0) {
          length = 3;
          usableBitsInFirstByte = 5;
        } else if ((firstByte & 0xf0) === 0xe0) {
          length = 4;
          usableBitsInFirstByte = 4;
        } else if ((firstByte & 0xf8) === 0xf0) {
          length = 5;
          usableBitsInFirstByte = 3;
        } else if ((firstByte & 0xfc) === 0xf8) {
          length = 6;
          usableBitsInFirstByte = 2;
        } else if ((firstByte & 0xfe) === 0xfc) {
          length = 7;
          usableBitsInFirstByte = 1;
        } else if (firstByte === 0xfe) {
          length = 8;
          usableBitsInFirstByte = 0;
        } else {
          length = 9;
          usableBitsInFirstByte = 0;
        }
        if (data.length - offset < length) {
          return null;
        }
        // 先頭バイトの leading 1-bit より後ろのビットが値の上位ビットになる
        const mask = (1 << usableBitsInFirstByte) - 1;
        let value = BigInt(firstByte & mask);
        for (let index = 1; index < length; index++) {
          const byte = data[offset + index];
          if (byte === undefined) {
            return null;
          }
          value = (value << 8n) | BigInt(byte);
        }
        return { length, value };
      };

      const OriginalWebTransport = window.WebTransport;
      class ReorderingWebTransport extends OriginalWebTransport {
        constructor(url: string | URL, options?: WebTransportOptions) {
          super(url, options);
          const source = this.datagrams.readable.getReader();
          Object.defineProperty(this.datagrams, "readable", {
            configurable: true,
            value: new ReadableStream<Uint8Array>({
              start(controller) {
                // Group ID ごとの「遅らせるか」を覚える。同じ Group には冗長化の
                // copy が複数あるため、どの copy も同じ扱いにする
                const delayedGroups = new Map<bigint, boolean>();
                let groupCount = 0;
                let delayedGroupCount = 0;
                const pump = async (): Promise<void> => {
                  for (;;) {
                    const { value, done } = await source.read();
                    if (done) {
                      controller.close();
                      return;
                    }
                    let shouldDelay = false;
                    // wire から Group ID を読む。読めない datagram と PADDING datagram は
                    // 順序の対象にせず、そのまま流す
                    const type = readMoqtVarint(value, 0);
                    if (type !== null && type.value !== paddingDatagramType) {
                      const trackAlias = readMoqtVarint(value, type.length);
                      if (trackAlias !== null) {
                        const group = readMoqtVarint(value, type.length + trackAlias.length);
                        if (group !== null) {
                          let groupDelayed = delayedGroups.get(group.value);
                          if (groupDelayed === undefined) {
                            groupCount += 1;
                            groupDelayed = groupCount % every === 0;
                            delayedGroups.set(group.value, groupDelayed);
                            if (groupDelayed) {
                              delayedGroupCount += 1;
                              // 注入が実際に動いたかを spec から読めるようにする (no-op を
                              // 0 件の測定として記録しないため)
                              (
                                window as unknown as {
                                  __moqtDatagramReorderDelayedGroups?: number;
                                }
                              ).__moqtDatagramReorderDelayedGroups = delayedGroupCount;
                            }
                          }
                          shouldDelay = groupDelayed;
                        }
                      }
                    }
                    if (shouldDelay) {
                      // 後続の Group の datagram はそのまま enqueue される。この Group は
                      // 後から enqueue されるため、復号器へは後続の Group より後に届く
                      setTimeout(() => {
                        try {
                          controller.enqueue(value);
                        } catch {
                          // 読み手が閉じた後は捨てる
                        }
                      }, delayMs);
                    } else {
                      try {
                        controller.enqueue(value);
                      } catch {
                        // 読み手が閉じた後は捨てる
                      }
                    }
                  }
                };
                void pump().catch((error: unknown) => {
                  // transport の異常終了で unhandled rejection にしない
                  try {
                    controller.error(error);
                  } catch {
                    // 既に閉じている
                  }
                });
              },
            }),
          });
        }
      }
      Object.defineProperty(window, "WebTransport", {
        configurable: true,
        value: ReorderingWebTransport,
        writable: true,
      });
    },
    { delayMs: reorderMs, every: DATAGRAM_REORDER_EVERY },
  );
}

async function installDatagramLoss(
  page: Page,
  lossRatio: number,
  burstLength = DATAGRAM_LOSS_BURST,
): Promise<void> {
  if (lossRatio <= 0) {
    return;
  }
  await page.addInitScript(
    (settings: { ratio: number; burst: number }) => {
      const ratio = settings.ratio;
      const burst = Math.max(1, Math.floor(settings.burst));
      const OriginalWebTransport = window.WebTransport;
      class LossyWebTransport extends OriginalWebTransport {
        constructor(url: string | URL, options?: WebTransportOptions) {
          super(url, options);
          const source = this.datagrams.readable.getReader();
          let state = 0x2f6e2b1;
          let burstRemaining = 0;
          const nextRandom = (): number => {
            // 32 bit の線形合同法 (Numerical Recipes)。`Math.imul` で桁溢れを避ける。
            // 素朴に `state * 1103515245` と書くと倍精度の桁溢れで並びが壊れ、損失が
            // 連続して起きる (実測: 5 % の指定で 3〜6 フレームの塊で欠けていた)
            state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
            return state / 0x1_0000_0000;
          };
          Object.defineProperty(this.datagrams, "readable", {
            configurable: true,
            value: new ReadableStream<Uint8Array>({
              async pull(controller) {
                for (;;) {
                  const { value, done } = await source.read();
                  if (done) {
                    controller.close();
                    return;
                  }
                  // まとめて落とすときは、当たりを引いた後も続けて落とす。1 個ずつ落とすときは
                  // burst が 1 であり、この分岐は働かない
                  if (burstRemaining > 0) {
                    burstRemaining -= 1;
                    continue;
                  }
                  if (nextRandom() < ratio / burst) {
                    burstRemaining = burst - 1;
                    continue;
                  }
                  controller.enqueue(value);
                  return;
                }
              },
            }),
          });
        }
      }
      Object.defineProperty(window, "WebTransport", {
        configurable: true,
        value: LossyWebTransport,
        writable: true,
      });
    },
    { burst: burstLength, ratio: lossRatio },
  );
}

test("調査: A/V 同期と音声の遅延の内訳を 1 秒ごとに採る", async ({ page }) => {
  // 調査用のため、明示したときだけ動かす
  test.skip(process.env.MOQT_INVESTIGATION !== "1", "MOQT_INVESTIGATION=1 のときだけ動かす");
  test.setTimeout(RELAY_TEST_TIMEOUT_MS * 3);
  const moqtUri = requireRelayUri();
  if (moqtUri === null) {
    return;
  }

  await installDatagramLoss(page, DATAGRAM_LOSS_RATIO);
  await installDatagramJitter(
    page,
    DATAGRAM_JITTER_MS,
    DATAGRAM_JITTER_SPIKE_RATIO,
    DATAGRAM_JITTER_SPIKE_MS,
  );
  // Group ID を読んで Group 単位で遅らせる。recovery 注入の組の並びに依存しないため、
  // 同じ条件で注入が効いたり効かなかったりしない (既定では無効)
  await installDatagramReorder(page);
  const namespace = formatTrackNamespace(createTestNamespace());
  await startBoth(page, moqtUri, namespace);
  await waitForAudio(page);

  const samples: string[] = [];
  const startedAtMs = Date.now();
  while (Date.now() - startedAtMs < INVESTIGATION_SECONDS * 1_000) {
    const stats = await readSubscriber(page);
    const publisher = await readPublisher(page);
    const { audio, avSync } = stats;
    const delays = avSync.delays;
    const audioDelay = delays.audioDelay;
    samples.push(
      JSON.stringify({
        t: (Date.now() - startedAtMs) / 1_000,
        objectsReceived: audio.objectsReceived,
        datagramObjectsReceived: audio.datagramObjectsReceived,
        chunksDecoded: audio.chunksDecoded,
        receiveDelayMs: audio.receiveDelayMs,
        maxReceiveDelayMs: audio.maxReceiveDelayMs,
        // 重複排除と順序逆転の計器。devtools 側の受信経路が数える累積であり、
        // 順序逆転の距離は Group ID の差で読む
        duplicateObjectsDropped: audio.duplicateObjectsDropped,
        outOfOrderObjectsReceived: audio.outOfOrderObjectsReceived,
        maxOutOfOrderGroupDistance: audio.maxOutOfOrderGroupDistance,
        audioBaseMs: delays.audio.baseDelayMs,
        videoBaseMs: delays.video.baseDelayMs,
        baseDifferenceMs: delays.baseDifferenceMs,
        baseDifferenceRecentMs: delays.baseDifferenceRecentMs,
        baseDifferenceSettledMs: delays.baseDifferenceSettledMs,
        sharingBases: delays.sharingBases,
        unsharedReason: delays.unsharedReason,
        baseDriftMsPerSecond: delays.baseDriftMsPerSecond,
        jitterMs: audioDelay.jitterMs,
        targetMs: audioDelay.targetMs,
        outputLeadMs: audioDelay.outputLeadMs,
        audioJitterDelayMs: delays.audio.jitterDelayMs,
        videoJitterDelayMs: delays.video.jitterDelayMs,
        audioSyncExtraMs: delays.audio.syncExtraDelayMs,
        videoSyncExtraMs: delays.video.syncExtraDelayMs,
        audioPresentationMs: delays.audio.presentationDelayMs,
        videoPresentationMs: delays.video.presentationDelayMs,
        audioPlayoutCorrectionMs: delays.audioPlayoutCorrectionMs ?? 0,
        skewMs: avSync.skewMs,
        startDelayP50Ms: audio.playoutTiming.startDelayMs?.p50 ?? null,
        startDelayP95Ms: audio.playoutTiming.startDelayMs?.p95 ?? null,
        startDelayMaxMs: audio.playoutTiming.startDelayMs?.max ?? null,
        compressedMs: audio.playoutCompressedMs,
        concealedMs: audio.playoutConcealedMs,
        concealments: audio.playoutConcealments,
        drops: audio.playoutDrops,
        catchUpObjectsSkipped: audio.catchUpObjectsSkipped,
        playedMs: audio.playoutTiming.playedMs,
        missedFrames: audio.playoutTiming.missedFrames,
        gapCount: audio.playoutTiming.gapCount,
        gapMs: audio.playoutTiming.gapMs,
        unrecoverableGapMs: audio.playoutTiming.unrecoverableGapMs,
        rebases: audio.playoutRebases,
        videoSkipped: stats.catchUpFramesSkipped,
        // 受信側の追いつき (音を飛ばす条件を測る)
        catchUpStarts: audio.playoutCatchUp.catchUpStarts,
        catchUpPending: audio.playoutCatchUp.catchingUp,
        catchUpLagMs: audio.playoutCatchUp.lagMs,
        catchUpFloorMs: audio.playoutCatchUp.floorMs,
        catchUpMaxLagMs: audio.playoutCatchUp.maxLagMs,
        catchUpSkippedMs: audio.playoutCatchUp.skippedMs,
        warningCount: stats.warnings.length,
        timestampOffsetMs: publisher.audio.timestampOffset.appliedMs,
        timestampOffsetCurrentMs: publisher.audio.timestampOffset.currentMs,
        timestampOffsetMinMs: publisher.audio.timestampOffset.minMs,
        timestampOffsetMaxMs: publisher.audio.timestampOffset.maxMs,
        timestampSlope10s: publisher.audio.timestampOffset.slope10sMsPerSecond,
        timestampSamples: publisher.audio.timestampOffset.samples,
        publishDroppedMs: publisher.audio.catchUp.droppedMs,
        publishCatchUpStarts: publisher.audio.catchUp.catchUpStarts,
        publishSendLagMs: publisher.audio.catchUp.sendLagMs,
        publishMaxSendLagMs: publisher.audio.catchUp.maxSendLagMs,
        publishObjectsSent: publisher.audio.objectsSent,
      }),
    );
    await page.waitForTimeout(SAMPLE_INTERVAL_MS);
  }

  // reorder 条件が no-op のまま 0 件の測定として記録される事故を防ぐ
  const delayedGroups = await page.evaluate(
    () =>
      (
        window as unknown as {
          __moqtDatagramReorderDelayedGroups?: number;
        }
      ).__moqtDatagramReorderDelayedGroups ?? 0,
  );
  if (DATAGRAM_REORDER_EVERY > 0) {
    expect(delayedGroups, "reorder の注入が Group を遅らせている").toBeGreaterThan(0);
  }
  console.log(`遅らせた Group: ${delayedGroups.toString()} 件`);

  const outputPath = join(
    process.cwd(),
    "investigation-logs",
    `av-sync-samples-${Date.now().toString()}.jsonl`,
  );
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${samples.join("\n")}\n`);
  console.log(`調査の観測を書いた: ${outputPath} (${samples.length.toString()} 件)`);
});

/**
 * 音声の出力の遅れを読むための仕込みを入れる (ページを開く前に呼ぶ)
 *
 * `avSync.skewMs` は「`AudioContext` の時計で予約した時刻を、`getOutputTimestamp()` の対応で
 * 実際の時刻へ換算した値」を音声の表示時刻に使う。この換算が「デバイスが今鳴らしている位置」を
 * 指すのか「再生のために処理した位置」を指すのかで、真のリップシンク誤差との差が変わる。
 * 確かめるため、作られた `AudioContext` を覚えておき、`currentTime` と
 * `getOutputTimestamp()` と `outputLatency` を外から読めるようにする。製品のコードには
 * 入れない (調査のための仕込み)
 */
async function installAudioOutputProbe(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const contexts: AudioContext[] = [];
    const OriginalAudioContext = window.AudioContext;
    class ProbedAudioContext extends OriginalAudioContext {
      constructor(options?: AudioContextOptions) {
        super(options);
        contexts.push(this);
      }
    }
    Object.defineProperty(window, "AudioContext", {
      configurable: true,
      value: ProbedAudioContext,
      writable: true,
    });
    (window as unknown as { __audioOutputProbe?: AudioContext[] }).__audioOutputProbe = contexts;
  });
}

/** 音声の出力の遅れの観測 */
interface AudioOutputSample {
  /** `AudioContext.currentTime` (ミリ秒) */
  currentMs: number;
  /** `getOutputTimestamp().contextTime` = デバイスが今鳴らしている位置 (ミリ秒) */
  deviceMs: number;
  /** `getOutputTimestamp().performanceTime` = その位置が鳴る実時刻 (ミリ秒) */
  performanceTimeMs: number;
  /** 処理済みでまだ鳴っていない長さ (`currentTime - contextTime`、ミリ秒) */
  inFlightMs: number;
  /** ブラウザが申告する出力の遅れ (`outputLatency`、ミリ秒) */
  outputLatencyMs: number;
  /** `AudioContext` 自身のバッファ (`baseLatency`、ミリ秒) */
  baseLatencyMs: number;
  /** 対応付けから見た「今」と `performance.now()` の差 (ミリ秒) */
  mappingOffsetMs: number;
}

/** 仕込みから音声の出力の遅れを読む */
async function readAudioOutputProbe(page: Page): Promise<AudioOutputSample | null> {
  return page.evaluate(() => {
    const contexts = (window as unknown as { __audioOutputProbe?: AudioContext[] })
      .__audioOutputProbe;
    const context = contexts?.[0];
    if (context === undefined) {
      return null;
    }
    const timestamp = context.getOutputTimestamp();
    const { contextTime, performanceTime } = timestamp;
    if (contextTime === undefined || performanceTime === undefined) {
      // まだ鳴っていない (対応が無い) ときは読めない
      return null;
    }
    const inFlightMs = (context.currentTime - contextTime) * 1_000;
    return {
      baseLatencyMs: context.baseLatency * 1_000,
      currentMs: context.currentTime * 1_000,
      deviceMs: contextTime * 1_000,
      inFlightMs,
      mappingOffsetMs: performance.now() - (performanceTime + inFlightMs),
      outputLatencyMs: context.outputLatency * 1_000,
      performanceTimeMs: performanceTime,
    };
  });
}

/** 値の要約 (中央値と 95 分位と最大) */
function summarizeValues(values: readonly number[]): string {
  if (values.length === 0) {
    return "-";
  }
  const sorted = [...values].sort((left, right) => left - right);
  const at = (quantile: number): number =>
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * quantile))] ?? 0;
  return `p50=${at(0.5).toFixed(1)} p95=${at(0.95).toFixed(1)} max=${(sorted[sorted.length - 1] ?? 0).toFixed(1)}`;
}

// 音声の出力の遅れを測る。`skewMs` の推定に入っていない量であり、真のリップシンク誤差との
// 差を見積もるために要る (どのくらいの長さの音が、処理されてから鳴るまでに溜まるか)
test("調査: 音声の出力の遅れを測る", async ({ page }) => {
  // 調査用のため、明示したときだけ動かす
  test.skip(process.env.MOQT_INVESTIGATION !== "1", "MOQT_INVESTIGATION=1 のときだけ動かす");
  test.setTimeout(RELAY_TEST_TIMEOUT_MS * 3);
  const moqtUri = requireRelayUri();
  if (moqtUri === null) {
    return;
  }

  await installAudioOutputProbe(page);
  const namespace = formatTrackNamespace(createTestNamespace());
  await startBoth(page, moqtUri, namespace);
  await waitForAudio(page);

  const samples: AudioOutputSample[] = [];
  const startedAtMs = Date.now();
  while (Date.now() - startedAtMs < INVESTIGATION_SECONDS * 1_000) {
    const sample = await readAudioOutputProbe(page);
    if (sample !== null) {
      samples.push(sample);
    }
    await page.waitForTimeout(SAMPLE_INTERVAL_MS);
  }

  const outputPath = join(
    process.cwd(),
    "investigation-logs",
    `audio-output-${Date.now().toString()}.jsonl`,
  );
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${samples.map((sample) => JSON.stringify(sample)).join("\n")}\n`);
  console.log(`調査の観測を書いた: ${outputPath} (${samples.length.toString()} 件)`);
  console.log(
    `音声の出力の遅れ (ミリ秒): 処理済みで未再生 ${summarizeValues(samples.map((s) => s.inFlightMs))}, ` +
      `outputLatency ${summarizeValues(samples.map((s) => s.outputLatencyMs))}, ` +
      `baseLatency ${summarizeValues(samples.map((s) => s.baseLatencyMs))}, ` +
      `対応付けのずれ ${summarizeValues(samples.map((s) => s.mappingOffsetMs))}`,
  );
});

// 受信した Object の時刻の間隔を数える。1 つの datagram の欠落が、受信の並びで
// 1 フレーム (40 ms) の穴になるのか、まとまった穴 (80 ms 以上) になるのかを見る。
// この計測には、次の 2 つの一時的な計器を入れておく必要がある (測り終えたら消す)。
// どちらも devtools のページでは Worker / メインスレッドの別があるため、`page.on("worker")`
// でも拾う。
//
// - `devtools/src/hooks/useSubscriber.ts` の `handleAudioObject` に `obj-probe`
//   (受信した Object の時刻と到着。devtools は `createMediaSubscriber` を通らない)
// - `src/playout/audioPlayoutSession.ts` の `catchUp.observe` の呼び出しに `catch-probe`
//   (復号の出力の時刻と、追いつきが作り直しを決めたか)
test("調査: 受信した Object の時刻の間隔を数える", async ({ page }) => {
  // 調査用のため、明示したときだけ動かす
  test.skip(process.env.MOQT_INVESTIGATION !== "1", "MOQT_INVESTIGATION=1 のときだけ動かす");
  test.setTimeout(RELAY_TEST_TIMEOUT_MS * 3);
  const moqtUri = requireRelayUri();
  if (moqtUri === null) {
    return;
  }

  const objects: { ts: number; nowMs: number }[] = [];
  const catches: { lagMs: number; rebuild: boolean; nowMs: number; tsMs: number }[] = [];
  // 受信と復号は Dedicated Worker で動くため、Worker の console も拾う
  // (メインスレッドの console だけでは届かない)
  const collect = (text: string): void => {
    const match = /obj-probe (\{.*\})/.exec(text);
    if (match?.[1] !== undefined) {
      objects.push(JSON.parse(match[1]) as { ts: number; nowMs: number });
    }
  };
  const collectCatch = (text: string): void => {
    const match = /catch-probe (\{.*\})/.exec(text);
    if (match?.[1] !== undefined) {
      catches.push(
        JSON.parse(match[1]) as { lagMs: number; rebuild: boolean; nowMs: number; tsMs: number },
      );
    }
  };
  page.on("console", (message) => {
    collect(message.text());
    collectCatch(message.text());
  });
  page.on("worker", (worker) => worker.on("console", (message) => collect(message.text())));

  await installDatagramLoss(page, DATAGRAM_LOSS_RATIO);
  await installDatagramJitter(
    page,
    DATAGRAM_JITTER_MS,
    DATAGRAM_JITTER_SPIKE_RATIO,
    DATAGRAM_JITTER_SPIKE_MS,
  );
  const namespace = formatTrackNamespace(createTestNamespace());
  await startBoth(page, moqtUri, namespace);
  await waitForAudio(page);
  await page.waitForTimeout(INVESTIGATION_SECONDS * 1_000);

  const first = objects[0];
  const last = objects[objects.length - 1];
  if (first === undefined || last === undefined) {
    console.log("受信した Object の記録が無い");
    return;
  }
  const stepCounts = new Map<number, number>();
  for (let index = 1; index < objects.length; index++) {
    const step = Math.round((objects[index]?.ts ?? 0) - (objects[index - 1]?.ts ?? 0));
    stepCounts.set(step, (stepCounts.get(step) ?? 0) + 1);
  }
  const histogram = [...stepCounts.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 8)
    .map(([step, count]) => `${step.toString()} ms:${count.toString()}`);
  const missingMs = last.ts - first.ts - (objects.length - 1) * 20;
  console.log(
    `受信 ${objects.length.toString()} 件 (損失 ${DATAGRAM_LOSS_RATIO.toString()}): ` +
      `音の時刻 ${(last.ts - first.ts).toFixed(0)} ms / 実時間 ${(last.nowMs - first.nowMs).toFixed(0)} ms, ` +
      `欠けた長さ ${missingMs.toFixed(0)} ms`,
  );
  console.log(`  間隔の分布: ${histogram.join(" ")}`);
  // 追いつきの判定: 直前の受信の穴との関係を見る
  const rebuilds = catches.filter((entry) => entry.rebuild);
  const lags = catches.map((entry) => entry.lagMs).sort((a, b) => a - b);
  console.log(
    `追いつき: 判定 ${catches.length.toString()} 回, 作り直し ${rebuilds.length.toString()} 回, ` +
      `lag p50 ${(lags[Math.floor(lags.length / 2)] ?? 0).toFixed(0)} ms / 最大 ${(lags[lags.length - 1] ?? 0).toFixed(0)} ms`,
  );
  // 作り直しの直前に、復号の出力の時刻が跳んでいるか (穴の直後か) を見る
  const jumps: number[] = [];
  for (let index = 1; index < catches.length; index++) {
    const previous = catches[index - 1];
    const current = catches[index];
    if (previous === undefined || current === undefined) {
      continue;
    }
    jumps.push(current.tsMs - previous.tsMs);
  }
  const jumpCounts = new Map<number, number>();
  for (const jump of jumps) {
    const key = Math.round(jump);
    jumpCounts.set(key, (jumpCounts.get(key) ?? 0) + 1);
  }
  const jumpHistogram = [...jumpCounts.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 6)
    .map(([jump, count]) => `${jump.toString()} ms:${count.toString()}`);
  console.log(`  復号の出力の間隔: ${jumpHistogram.join(" ")}`);
  const rebuildLags = rebuilds.map((entry) => entry.lagMs).sort((a, b) => a - b);
  console.log(
    `  作り直しのときの lag: 最小 ${(rebuildLags[0] ?? 0).toFixed(0)} ms / ` +
      `p50 ${(rebuildLags[Math.floor(rebuildLags.length / 2)] ?? 0).toFixed(0)} ms / ` +
      `最大 ${(rebuildLags[rebuildLags.length - 1] ?? 0).toFixed(0)} ms`,
  );
});
