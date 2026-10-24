/**
 * 再生の入口 (`MediaPlayout`) の内部形状をテストから読むための共有ヘルパー
 *
 * 入口は時間軸・音声の再生の組み立て・映像の表示の組み立て・計器・復号へ渡した入力の
 * 対応表を内部に持つ。これらを直接駆動・観測する検証は、公開面を広げずに、テストの中だけ
 * で内部形状へキャストして行う。ライブラリのテストと入口単体のテストで同じ形を二重に
 * 宣言すると、内部の名前を変えたときに片方だけが壊れて実行時 TypeError になるため、
 * ここ 1 か所に置く。
 *
 * このファイルは vitest の `test.include` (`src/**\/*.{test,prop}.ts`) に一致しない名前で
 * あり、ライブラリのビルド entry (`src/index.ts`) からも到達しないため、配布物には含まれない。
 */

import type { AudioClockBridge, AudioPlayoutScheduler } from "../playout/audioPlayout";
import type { AudioPlayoutOutput, AudioPlayoutSession } from "../playout/audioPlayoutSession";
import type { AudioPlayoutTimingStats } from "../playout/audioPlayoutTimingStats";
import type { AudioDecodeInput, AudioDecodeInputs } from "../playout/decodeInputTimestamps";
import type { MediaPlayout } from "../playout/mediaPlayout";
import type { PlayoutTimeline } from "../playout/timeline";
import type {
  VideoDecodeInput,
  VideoDecodeInputs,
  VideoPlayoutSession,
} from "../playout/videoPlayoutSession";

/** 再生の入口の内部形状 (テストの中だけで使う) */
export interface MediaPlayoutInternals {
  /** 音声と映像で共有する表示時刻の時間軸 */
  readonly timeline: PlayoutTimeline;
  /** 音声の再生 (音声を構成していないときは null) */
  readonly audio: {
    readonly session: AudioPlayoutSession;
    readonly timing: AudioPlayoutTimingStats;
  } | null;
  /** 映像の表示 (映像を構成していないときは null) */
  readonly video: { readonly session: VideoPlayoutSession } | null;
  /** 復号へ渡した音声 Object の対応表 */
  readonly audioInputs: AudioDecodeInputs;
  /** 復号へ渡した映像 Object の対応表 */
  readonly videoInputs: VideoDecodeInputs;
  /** 鳴らす先 */
  readonly audioOutput: AudioPlayoutOutput | null;
}

/** 再生の入口を内部形状へキャストする */
export function playoutInternalsOf(playout: MediaPlayout): MediaPlayoutInternals {
  return playout as unknown as MediaPlayoutInternals;
}

/** 共有する時間軸を読む */
export function playoutTimelineOf(playout: MediaPlayout): PlayoutTimeline {
  return playoutInternalsOf(playout).timeline;
}

/** 音声の再生を読む (音声を構成していない入口では throw する) */
export function playoutAudioOf(playout: MediaPlayout): AudioPlayoutSession {
  const audio = playoutInternalsOf(playout).audio;
  if (audio === null) {
    throw new Error("audio is not configured in this playout");
  }
  return audio.session;
}

/** 音声の計器を読む (音声を構成していない入口では throw する) */
export function playoutAudioTimingOf(playout: MediaPlayout): AudioPlayoutTimingStats {
  const audio = playoutInternalsOf(playout).audio;
  if (audio === null) {
    throw new Error("audio is not configured in this playout");
  }
  return audio.timing;
}

/** 音声の予約 (基準の取り直しと捨ての数) を読む */
export function playoutAudioSchedulerOf(playout: MediaPlayout): AudioPlayoutScheduler {
  return playoutAudioOf(playout).playout;
}

/** 音声の時計の対応を読む */
export function playoutAudioClockOf(playout: MediaPlayout): AudioClockBridge {
  return playoutAudioOf(playout).clock;
}

/** 鳴らす先を読む */
export function playoutAudioOutputOf(playout: MediaPlayout): AudioPlayoutOutput | null {
  return playoutInternalsOf(playout).audioOutput;
}

/** 映像の表示を読む (映像を構成していない入口では throw する) */
export function playoutVideoSessionOf(playout: MediaPlayout): VideoPlayoutSession {
  const video = playoutInternalsOf(playout).video;
  if (video === null) {
    throw new Error("video is not configured in this playout");
  }
  return video.session;
}

/** 復号へ渡した音声 Object の対応表の Map を読む (テストの中だけで使う) */
export function playoutAudioInputMapOf(playout: MediaPlayout): Map<number, AudioDecodeInput> {
  const inputs = playoutInternalsOf(playout).audioInputs as unknown as {
    readonly inputs: Map<number, AudioDecodeInput>;
  };
  return inputs.inputs;
}

/** 復号へ渡した映像 Object の対応表の Map を読む (テストの中だけで使う) */
export function playoutVideoInputMapOf(playout: MediaPlayout): Map<number, VideoDecodeInput> {
  const inputs = playoutInternalsOf(playout).videoInputs as unknown as {
    readonly inputs: Map<number, VideoDecodeInput>;
  };
  return inputs.inputs;
}
