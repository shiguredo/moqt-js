/**
 * 実リレー経由の音声が live かどうかを、再生側の観測から判定する純関数
 *
 * 実リレーの E2E では、cache を再生していないことを「受信の遅れ」で判定してきた。
 * 受信の遅れは Object の到着時点で測るため、1 個の遅着 Object でも 300 ms を超え、
 * 実際には live を鳴らしていても失敗する。ここでは、復号の出力の遅れ (`lagMs`) と
 * 鳴り始めの遅れ (`startDelayMs`) で判定し、受信の遅れは診断値として返すだけにする。
 *
 * `lagMs` は復号器が出力した音の古さであり、cache を復号していれば秒単位になる。
 * 窓内の中央値を使うため、1 個の遅着 Object で跳ねた 1 点では判定を変えない。
 *
 * しきい値は、実リレーの E2E がこれまで使ってきた値 (300 ms / 1000 ms) をそのまま
 * 使う。緩和ではなく、観測する量を変える。
 *
 * ブラウザ API に依存しない。入力は devtools の統計から必要な値だけを写したもの。
 */

/** live 判定に使う音声の観測値 */
export interface LiveAudioSample {
  /** 音声の再生が有効か */
  readonly playbackEnabled: boolean;
  /** 直近に復号した音声の古さ (ミリ秒)。未観測なら null */
  readonly lagMs: number | null;
  /** 鳴り始めの遅れの p50 (ミリ秒)。未観測なら null */
  readonly startDelayMs: number | null;
  /** 直近の Object の受信の遅れ (ミリ秒)。診断にだけ使う */
  readonly receiveDelayMs: number | null;
}

/** 判定の理由 */
export type LiveAudioReason =
  | "live"
  | "notPlaying"
  | "noDecodedAudio"
  | "decodedAudioIsOld"
  | "startIsLate";

/** live 判定の結果 */
export interface LiveAudioJudgement {
  readonly live: boolean;
  readonly reason: LiveAudioReason;
  /** 窓内の中央値 (ミリ秒) */
  readonly lagMs: number | null;
  /** 窓内の中央値 (ミリ秒) */
  readonly startDelayMs: number | null;
  /** 直近のサンプルの受信の遅れ (ミリ秒)。診断値であり判定には使わない */
  readonly receiveDelayMs: number | null;
}

/** 復号済み音声の古さの上限 (ミリ秒)。これ以上なら cache か復号の溜まりとみなす */
export const LIVE_AUDIO_LAG_MS = 300;

/** 鳴り始めの遅れの上限 (ミリ秒) */
export const LIVE_AUDIO_START_DELAY_MS = 1_000;

/** null を除いた中央値。値が無ければ null */
function median(values: readonly (number | null)[]): number | null {
  const finite = values.filter(
    (value): value is number => value !== null && Number.isFinite(value),
  );
  if (finite.length === 0) return null;
  const sorted = [...finite].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? null;
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

/**
 * 窓内のサンプルから live かどうかを判定する
 *
 * 再生の有無は最後のサンプルで見る。`lagMs` と `startDelayMs` は窓内の中央値を使い、
 * 1 点だけ跳ねた観測で判定を変えない。`receiveDelayMs` は結果に写すだけである。
 *
 * @param samples - 時系列の観測値。空なら再生していないとみなす
 */
export function judgeLiveAudio(samples: readonly LiveAudioSample[]): LiveAudioJudgement {
  const latest = samples.at(-1);
  const lagMs = median(samples.map((sample) => sample.lagMs));
  const startDelayMs = median(samples.map((sample) => sample.startDelayMs));
  const receiveDelayMs = latest?.receiveDelayMs ?? null;
  const verdict = (live: boolean, reason: LiveAudioReason): LiveAudioJudgement => ({
    live,
    reason,
    lagMs,
    startDelayMs,
    receiveDelayMs,
  });
  if (latest === undefined || !latest.playbackEnabled) return verdict(false, "notPlaying");
  if (lagMs === null) return verdict(false, "noDecodedAudio");
  if (lagMs >= LIVE_AUDIO_LAG_MS) return verdict(false, "decodedAudioIsOld");
  if (startDelayMs === null || startDelayMs >= LIVE_AUDIO_START_DELAY_MS)
    return verdict(false, "startIsLate");
  return verdict(true, "live");
}

/** 失敗メッセージに載せる判定の内訳 */
export function describeLiveAudio(judgement: LiveAudioJudgement): string {
  const ms = (value: number | null): string => (value === null ? "-" : value.toFixed(1));
  return (
    `reason=${judgement.reason}, lagMs=${ms(judgement.lagMs)}, ` +
    `startDelayMs=${ms(judgement.startDelayMs)}, receiveDelayMs=${ms(judgement.receiveDelayMs)}`
  );
}
