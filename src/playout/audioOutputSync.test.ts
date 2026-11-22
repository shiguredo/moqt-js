import { assert, test } from "vite-plus/test";
import { AudioOutputSync, videoSelectionTargetMs, type AudioOutputSkew } from "./audioOutputSync";
import type { AudioRenderedPositionSpan } from "./audioRenderPosition";
import { PlayoutBuffer } from "./buffer";
import { PlayoutTimeline } from "./timeline";

const SAMPLE_RATE = 48_000;
const EPOCH = 7;

function span(
  kind: AudioRenderedPositionSpan["kind"],
  firstFrame: number,
  endFrame: number,
  timestampMicroseconds: number,
  epoch = EPOCH,
): AudioRenderedPositionSpan {
  return { kind, firstFrame, endFrame, timestampMicroseconds, epoch };
}

test("描画済みの実音と補間の範囲だけから媒体時刻を求める", () => {
  const sync = new AudioOutputSync(SAMPLE_RATE);
  sync.record([span("real", 480, 960, 100_000)], EPOCH);
  sync.record([span("concealed", 960, 1440, 110_000), span("real", 1920, 2400, 130_000)], EPOCH);

  // 描画量子やブロック境界とは異なる機器上の再生位置でも、実出力範囲を補外しない。
  assert.isNull(sync.positionAt(479.99, EPOCH));
  assert.deepEqual(sync.positionAt(720.48, EPOCH), {
    kind: "real",
    timestampMicroseconds: 105_010,
  });
  assert.deepEqual(sync.positionAt(960, EPOCH), {
    kind: "concealed",
    timestampMicroseconds: 110_000,
  });
  assert.isNull(sync.positionAt(1440, EPOCH), "未補間の区間を最後の値で埋めないこと");
  assert.deepEqual(sync.positionAt(1920, EPOCH), {
    kind: "real",
    timestampMicroseconds: 130_000,
  });
  assert.isNull(sync.positionAt(2400, EPOCH), "未描画の未来を予測しないこと");
});

test("旧世代と、連続した実音を参照できない補間を使わない", () => {
  const sync = new AudioOutputSync(SAMPLE_RATE);
  sync.record([span("real", 480, 960, 100_000)], EPOCH);
  assert.isNull(sync.positionAt(480, EPOCH + 1));
  sync.record(
    [span("real", 480, 960, 100_000), span("concealed", 960, 1440, 110_000, EPOCH + 1)],
    EPOCH + 1,
  );
  assert.isNull(sync.positionAt(960, EPOCH + 1), "以前の世代の実音から延長しないこと");
  sync.record([span("real", 1440, 1920, 120_000, EPOCH + 1)], EPOCH + 1);
  sync.record(
    [
      span("concealed", 1920, 2400, 0, EPOCH + 1),
      span("concealed", 2400, 2880, 140_000, EPOCH + 1),
    ],
    EPOCH + 1,
  );
  assert.isNull(sync.positionAt(1920, EPOCH + 1), "媒体時刻が非連続な補間は無効にすること");
  assert.isNull(sync.positionAt(2400, EPOCH + 1), "無効な範囲を越えて補間を再開しないこと");
  sync.clear(1920);
  sync.record([span("real", 1440, 1920, 120_000, EPOCH + 1)], EPOCH + 1);
  assert.isNull(sync.positionAt(1440, EPOCH + 1), "時計を取り直す前の通知を再登録しないこと");
  sync.record([span("real", 1920, 2400, 130_000, EPOCH + 1)], EPOCH + 1);
  assert.isNotNull(sync.positionAt(1920, EPOCH + 1), "新しい出力位置は使うこと");
});

test("新しい出力観測が来るたびに古い履歴を捨てる", () => {
  const sync = new AudioOutputSync(SAMPLE_RATE);
  sync.record([span("real", 480, 960, 100_000)], EPOCH);
  // 停止後に再開した遠い位置を取り込み、以前の出力位置に戻れないことを検証する。
  sync.record([span("real", 48_000, 48_480, 1_090_000)], EPOCH);
  assert.isNull(sync.positionAt(480, EPOCH));
  assert.isNotNull(sync.positionAt(48_000, EPOCH));
});

test("補間中に音声が先に進んだ範囲で映像の候補を選ぶ", () => {
  const sampleRate = 1000;
  const timeOriginMs = 1_790_000_000_000;
  const timeline = new PlayoutTimeline({ timeOriginMs, maxQueuedFrames: 24 });
  const timestampMicroseconds = timeOriginMs * 1000;
  timeline.observe("audio", timeOriginMs, timestampMicroseconds);
  timeline.observe("video", timeOriginMs, timestampMicroseconds);
  const sync = new AudioOutputSync(sampleRate);
  // 音声の媒体時刻 4〜16 ms は実音でなく、実際に出力した予測区間として扱う。
  sync.record(
    [
      span("real", 42, 46, timestampMicroseconds),
      span("concealed", 46, 58, timestampMicroseconds + 4000),
    ],
    EPOCH,
  );
  const videoBuffer = new PlayoutBuffer<number>(24, timeline);
  const videoTimestamp = timestampMicroseconds + 10_000;
  videoBuffer.enqueue(10, videoTimestamp);
  const outputPosition = sync.positionAt(52, EPOCH);
  assert.equal(outputPosition?.kind, "concealed");
  const baseTargetMs = timeline.presentationPerformanceMs("video", videoTimestamp) ?? 0;
  // 通常の選択では次の映像は 8 ms の許容幅外。音声の観測がある場合だけ、範囲内へ入る。
  const earlyTickMs = baseTargetMs - 10;
  assert.isNull(videoBuffer.selectNearest(earlyTickMs, 8).draw);
  const audioPresentationMs = timeline.presentationPerformanceMs(
    "video",
    outputPosition?.timestampMicroseconds ?? 0,
  );
  const selectionMs = videoSelectionTargetMs(earlyTickMs, audioPresentationMs, 16);
  assert.equal(videoBuffer.selectNearest(earlyTickMs, 8, 20, selectionMs).draw, 10);
});

test("同じ提示時刻で照合したずれは、現在位置とは別に補間の根拠を返す", () => {
  const timeOriginMs = 1_790_000_000_000;
  const timeline = new PlayoutTimeline({ timeOriginMs, maxQueuedFrames: 24 });
  const startMicros = timeOriginMs * 1000;
  const sync = new AudioOutputSync(1000);
  sync.record(
    [span("real", 0, 40, startMicros), span("concealed", 40, 60, startMicros + 40_000)],
    EPOCH,
  );
  sync.record([span("real", 60, 80, startMicros + 60_000)], EPOCH);
  timeline.recordPresentation("video", startMicros + 43_000, BigInt(startMicros + 50_000));
  const actual: AudioOutputSkew | null = timeline.audioOutputSkew(70, (atMs) =>
    sync.positionAt(atMs, EPOCH),
  );
  assert.deepEqual(actual, { skewMs: 7, audioKind: "concealed" });
  assert.isNull(
    timeline.audioOutputSkew(49, (atMs) => sync.positionAt(atMs, EPOCH)),
    "未来の映像を照合しないこと",
  );
  assert.isNull(timeline.audioOutputSkew(70, (atMs) => sync.positionAt(atMs, EPOCH + 1)));
  timeline.recordPresentation("audio", startMicros + 40_000, BigInt(startMicros + 40_000));
  timeline.recordUntimedVideoPresentation();
  assert.isNull(timeline.audioOutputSkew(70, (atMs) => sync.positionAt(atMs, EPOCH)));
  assert.equal(timeline.skewMs(70), 7, "従来の統計は最後に時刻付きで提示した値を残すこと");
});
