import type { Location } from "../message";

/**
 * 復号へ渡した timestamp から、復号の出力を引く
 *
 * 音声の TIMESTAMP の種類 (壁時計かメディア時刻か) は、復号へ渡した時に覚えて復号の出力で
 * 引く。`AudioData` は種類を持たないためである。覚えて引く処理は `AudioDecodeInputs` が持ち、
 * 使うのは再生の入口 (`src/playout/mediaPlayout.ts` の `MediaPlayout.pushAudio`) である。
 * ところが WebCodecs の `AudioDecoder` は、出力する
 * `AudioData.timestamp` を入力の timestamp と完全には一致させない。実測 (実リレー、Opus、
 * 48 kHz) では出力が入力より 100 マイクロ秒だけ大きかった。
 *
 * 完全一致で引くと、この 100 マイクロ秒のずれで引けなくなり、種類を失った音が共有の時間軸へ
 * 記録されなくなる。実測 (CI の runner) では、音声の基準の遅れが 116 ms の
 * まま更新されなくなり、次に一致した観測で 630 ms、836 ms へ飛んで、A/V の基準の共有が解除
 * された。一致する記録が無いときは、許容の中では最も近い記録を引く。ずれて引く (順番で
 * 決め打ちする) と、出力が欠けたときに以降の対応が 1 つずつずれ、位置の判定を誤るため、
 * timestamp の差が許容の中にある記録だけを引く。
 *
 * 許容の中でも引けない状態が続くことがある。実測 (実リレー、CPU を 6 倍に遅くした再現、音声
 * 50 個/秒) では、記録と復号の出力の timestamp の格子が 9.7 ms ずれ、その差がそのまま
 * 残った (記録と出力の双方が 20 ms ごとに進むため、差は縮まらない)。このとき記録は残り
 * (この出力より古い記録は捨てる規則は、出力より新しい記録を消さない)、同じ判定が出力ごとに
 * 繰り返されて、以後の出力がすべて引けなくなる (実測: 対応が引けた 635 回の後、831 回続けて
 * 引けなくなった)。格子がずれるきっかけは経路ではなく配信側の TIMESTAMP の補正の段差と
 * relay の cache の再送であり (実測: 入力の timestamp の間隔に -120 ms から +190 ms の跳びが
 * 20 秒間に 30 回)、実装で防げる性質ではない。
 *
 * そこで、引けないときは直前に分かっている種類を使う (`LastTimestampKind`)。種類は
 * TIMESTAMP の Timescale の有無で決まり、ストリームの途中で変わるものではないため、直前の
 * 種類を当てても実害は無い。値が離れているとき (TIMESTAMP が無い音の 0 など) だけは、別の
 * 時間軸の値であり当てにしない。
 */

/**
 * 復号の出力の timestamp と、復号へ渡した timestamp の差として許す上限 (マイクロ秒)
 *
 * 実測したずれは 100 マイクロ秒である (実リレー、1014 件の出力のうち完全一致は 1〜3 件で、
 * 最も近い記録との差は p50 0.30 ms、p99 0.40 ms、最大 0.40 ms。2026-10-15)。Opus の最短の
 * フレームは 2.5 ms であり、その半分より十分に小さい値にして、隣のフレームと取り違えない
 * ようにする。
 *
 * CPU を 6 倍に遅くした再現では 9.7 ms のずれが観測されており、この枠では引けない。呼び出し
 * 側は音 1 つの長さの半分を `toleranceMicros` に渡してこの枠を広げられる (ライブラリと
 * moqt-devtools のどちらも渡す)
 */
export const DECODER_OUTPUT_TIMESTAMP_TOLERANCE_MICROS = 1_000;

/**
 * 対応が引けないときに、直前に分かっている種類を使ってよい、値の隔たりの上限 (マイクロ秒)
 *
 * 復号の出力の timestamp が、保留している記録からこの値より離れているときは、直前の種類を
 * 当てにしない。TIMESTAMP が無い音は decoder へ 0 を渡すため、その出力は壁時計の値では
 * なく、直前の種類 (壁時計) を当てると 1970 年からの時刻として共有の時間軸へ記録してしまう。
 *
 * 10 秒は、復号が数秒遅れて出る場合 (実測: 負荷時に 0.5 秒) を許しつつ、別の時間軸の値
 * (0、メディア時刻、ミリ秒とマイクロ秒の取り違え) と区別できる大きさである
 */
export const DECODE_INPUT_KIND_FALLBACK_MAX_DISTANCE_MICROS = 10_000_000;

/**
 * 復号の出力の timestamp に対応する記録を 1 つ取り出す (取り出した分は忘れる)
 *
 * 完全一致する記録があればそれを取り出す。無ければ、`toleranceMicros` より古い記録を捨て
 * (その出力にも後続の出力にも対応しない)、残った記録のうち timestamp の差が最も小さいものを
 * 許容以内のときだけ取り出す。対応が無ければ undefined を返す (呼び出し側は種類 `none` と
 * して扱う)。
 *
 * 古い記録を捨てるのは、対応が一度ずれると (出力が欠けた、最初の出力が投入と対応しないなど)
 * 最も古い記録が永久に一致しなくなり、以降の対応がすべて引けなくなるためである。
 *
 * @param entries - 復号へ渡した timestamp をキーにした記録 (記録した順に並ぶ)
 * @param outputTimestampMicros - 復号の出力の timestamp (マイクロ秒)
 * @param toleranceMicros - 対応とみなす差の上限 (マイクロ秒。既定は
 *   `DECODER_OUTPUT_TIMESTAMP_TOLERANCE_MICROS`)。呼び出し側が音 1 つの長さの半分を渡すと、
 *   隣のフレームと取り違えない範囲で最大まで広げられる (復号の出力を持つ呼び出し側が渡す)
 */
export function takeDecodeInputEntry<T>(
  entries: Map<number, T>,
  outputTimestampMicros: number,
  toleranceMicros = DECODER_OUTPUT_TIMESTAMP_TOLERANCE_MICROS,
): T | undefined {
  const exact = entries.get(outputTimestampMicros);
  if (exact !== undefined) {
    entries.delete(outputTimestampMicros);
    return exact;
  }
  // この出力より許容以上に古い記録は、この出力にも後続の出力にも対応しない
  for (const [timestamp] of entries) {
    if (outputTimestampMicros - timestamp <= toleranceMicros) {
      break;
    }
    entries.delete(timestamp);
  }
  // 一致する記録が無いときは、許容の中では最も近い記録を対応させる。復号の出力の timestamp
  // は投入した値と小数だけずれる (実測の詳細はモジュール冒頭を参照) ため、完全一致では引けない。
  //
  // 最も古い記録だけを候補にすると、出力が返らなかった記録が 1 つ残っただけで、その記録が
  // 永久に一致せず、以降の対応がすべて引けなくなる。既定の許容 (1 ms) は音 1 つの間隔 (20 ms)
  // より十分小さく、呼び出し側が音 1 つの長さの半分まで広げても、離れた記録と取り違えない
  let nearest: number | null = null;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const [timestamp] of entries) {
    const distance = Math.abs(timestamp - outputTimestampMicros);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearest = timestamp;
    }
  }
  if (nearest === null || nearestDistance > toleranceMicros) {
    return undefined;
  }
  const value = entries.get(nearest);
  entries.delete(nearest);
  return value;
}

/**
 * 直前に分かっている TIMESTAMP の種類を覚え、対応が引けない出力に使う
 *
 * `takeDecodeInputEntry` が undefined を返したときに `fallbackFor` を呼ぶ。保留している
 * 記録のどれかが `DECODE_INPUT_KIND_FALLBACK_MAX_DISTANCE_MICROS` の中にあれば、その出力は
 * 同じ時間軸の値であり、直前に分かっている種類を当ててよい。離れているときは別の時間軸の値
 * (TIMESTAMP が無い音は decoder へ 0 を渡すため、その出力は 0 である) であり、当てると
 * 誤った時刻で共有の時間軸へ記録するため null を返す。
 *
 * 記録が 1 つも無いときも null を返す。まだ何も分かっていないためである。
 *
 * 引けない状態が続くと記録は減らないため、ここで見る記録は実リレーの再現では 1〜2 件で
 * あった。記録が多いとき (relay の cache からまとめて復号しているとき) は線形に走査するが、
 * その間は対応が引けているため `fallbackFor` は呼ばれない。
 *
 * 種類は Timescale の有無で決まり、ストリームの途中で変わるものではない。変わったときに
 * 古い種類を使い続けないよう、`update` は種類が分かるたびに上書きする。
 */
export class LastTimestampKind<K extends string> {
  private value: K | null = null;

  /**
   * 分かった種類で上書きする
   *
   * 種類が分からない (`TIMESTAMP` が無い) ときは渡さない。0 の出力に古い種類を当てないため
   * である。
   */
  update(kind: K | null): void {
    if (kind !== null) {
      this.value = kind;
    }
  }

  /** 購読を始めるときなど、覚えている種類を捨てる */
  reset(): void {
    this.value = null;
  }

  /**
   * 対応が引けなかった出力に使う種類。使えなければ null
   *
   * @param entries - 復号へ渡した timestamp をキーにした記録
   * @param outputTimestampMicros - 復号の出力の timestamp (マイクロ秒)
   */
  fallbackFor<T>(entries: ReadonlyMap<number, T>, outputTimestampMicros: number): K | null {
    if (this.value === null) {
      return null;
    }
    let nearest = Number.POSITIVE_INFINITY;
    for (const timestamp of entries.keys()) {
      nearest = Math.min(nearest, Math.abs(outputTimestampMicros - timestamp));
    }
    return nearest <= DECODE_INPUT_KIND_FALLBACK_MAX_DISTANCE_MICROS ? this.value : null;
  }
}

/**
 * 音声と映像で共通の TIMESTAMP の種類 (`draft-ietf-moq-loc-04 §2.3.1.1 / §2.3.1.2`)
 *
 * - `wallClock`: TIMESCALE が無い TIMESTAMP (Unix epoch マイクロ秒)
 * - `mediaTime`: TIMESCALE がある TIMESTAMP
 * - `none`: TIMESTAMP が無い (decoder へは 0 を渡す)
 */
export type PlayoutTimestampKind = "none" | "wallClock" | "mediaTime";

/**
 * 復号へ渡した音声 Object の TIMESTAMP の種類
 *
 * `none` (TIMESTAMP が無い) は覚えない。decoder へは 0 を渡すため、同じ TIMESTAMP の音が
 * すべて重なり、種類も位置も一意に引けないためである。
 */
export type AudioDecodeInputKind = Exclude<PlayoutTimestampKind, "none">;

/**
 * 復号へ渡した音声 Object の情報 (解決済みの形)
 *
 * 省略可能な入力 (`AudioDecodeInputRecord`) を、省略を null で埋めて解決した形である。
 */
export interface AudioDecodeInput extends Required<AudioDecodeInputRecord> {
  /** TIMESTAMP の種類 (TIMESTAMP が無い音は記録しないため `none` は来ない) */
  readonly timestampKind: AudioDecodeInputKind;
}

/**
 * `AudioDecodeInputs.remember` へ渡す情報
 *
 * 測れない値は省略できる (省略した値は null として覚え、`resolve` でも null を返す)。
 */
export interface AudioDecodeInputRecord {
  /** TIMESTAMP の種類。`none` の音は覚えない */
  readonly timestampKind: PlayoutTimestampKind;
  /** Object の位置。位置を使わないときは省略する */
  readonly location?: Location | null;
  /** 受信の入口で測った入力の遅れ (ミリ秒) */
  readonly inputLagMs?: number | null;
  /** 復号へ渡すまで実際に保持した時間 (ミリ秒) */
  readonly intentionalDelayMs?: number | null;
}

/**
 * 復号の出力に対して解決した音声の入力の情報
 *
 * `input` が null のときは、種類を直前に分かっている値で補っただけであり、位置と遅れは
 * 使えない (どの Object の値か決められないため)。呼び出し側は種類だけを使う。
 */
export interface ResolvedAudioDecodeInput {
  /** 復号の出力の timestamp に対応する TIMESTAMP の種類。分からなければ null */
  readonly timestampKind: AudioDecodeInputKind | null;
  /** 対応する記録。引けなかった (補った、または分からない) ときは null */
  readonly input: AudioDecodeInput | null;
}

/** 復号へ渡した入力の対応表の設定 (音声と映像で共通) */
export interface DecodeInputsOptions {
  /**
   * 覚えておく上限 (件)
   *
   * 出力されなかった (decoder のエラーで捨てられたなど) 分が残り続けないよう、超えたら
   * 古い方から忘れる。
   */
  readonly maxTracked: number;
  /**
   * 同じ TIMESTAMP の Object が重なったときに、その TIMESTAMP の分を忘れるか
   *
   * true のとき、同じ TIMESTAMP の Object が重なったらどちらの位置か決められないため
   * その TIMESTAMP の分を忘れる (位置を追いつきの判定に使うとき)。false のときは後から
   * 来た情報で上書きする (TIMESTAMP の種類しか使わないとき)。
   */
  readonly forgetOnDuplicate: boolean;
}

/** 対応表の既定の上限 (件) */
export const DEFAULT_MAX_TRACKED_DECODE_INPUTS = 256;

/**
 * 対応表へ入力を記録する (音声と映像で共通の規則)
 *
 * TIMESTAMP を持たない入力は、同じ TIMESTAMP を共有しうるため覚えない (既に覚えていた
 * 分も忘れる)。同じ TIMESTAMP が重なったときは、位置を追いつきの判定に使う設定
 * (`forgetOnDuplicate`) なら忘れ、そうでなければ後から来た情報で上書きする。上限を
 * 超えたら古い方から忘れる。
 *
 * @param inputs - 対応表
 * @param timestampMicros - decoder へ渡した TIMESTAMP (マイクロ秒)
 * @param input - 記録する入力
 * @param options - 上限と重複の扱い
 */
export function storeDecodeInput<T extends { readonly timestampKind: PlayoutTimestampKind }>(
  inputs: Map<number, T>,
  timestampMicros: number,
  input: T,
  options: DecodeInputsOptions,
): void {
  if (input.timestampKind === "none") {
    // 種類も位置も一意に引けない。同じ TIMESTAMP の先の記録も忘れる
    inputs.delete(timestampMicros);
    return;
  }
  if (inputs.has(timestampMicros)) {
    if (options.forgetOnDuplicate) {
      // どちらの Object の情報か決められないため忘れる
      inputs.delete(timestampMicros);
      return;
    }
    // 上書きする。Map は既存のキーの位置を保つため、削除せずに入れ替える (古い記録の
    // 剪定が挿入順 = timestamp 昇順であることを崩さない)
  }
  inputs.set(timestampMicros, input);
  for (const oldest of inputs.keys()) {
    if (inputs.size <= options.maxTracked) {
      break;
    }
    inputs.delete(oldest);
  }
}

/**
 * 復号へ渡した音声 Object の情報を、復号の出力で引けるように覚えておく対応表
 *
 * 復号の出力 (`AudioData.timestamp`) は、入力の timestamp と小数だけずれる
 * (`takeDecodeInputEntry`)。完全一致で引けなくなっても種類を失わないよう、ずれを許容して
 * 最も近い記録を引き、引けないときは直前に分かっている種類で補う (`LastTimestampKind`)。
 *
 * 1 つの再生のまとまりに対して 1 つ作る。購読の停止 (`MediaPlayout.clearAll`) で `clear()`
 * して再利用する (購読を始めるたびに作り直すのではなく、停止時に消す)。
 */
export class AudioDecodeInputs {
  private readonly inputs = new Map<number, AudioDecodeInput>();
  private readonly lastKind = new LastTimestampKind<AudioDecodeInputKind>();
  private readonly options: DecodeInputsOptions;

  constructor(options: DecodeInputsOptions) {
    this.options = options;
  }

  /** 覚えている件数 */
  get size(): number {
    return this.inputs.size;
  }

  /**
   * 復号へ渡した Object の情報を覚える
   *
   * TIMESTAMP を持たない音 (`none`) と、同じ TIMESTAMP が重なった音は、位置も種類も一意に
   * 引けないため覚えない (`forgetOnDuplicate` が true のとき)。
   *
   * @param timestampMicros - decoder へ渡した TIMESTAMP (マイクロ秒)
   * @param record - TIMESTAMP の種類と、測れた付加情報
   */
  remember(timestampMicros: number, record: AudioDecodeInputRecord): void {
    if (record.timestampKind !== "none") {
      // 直前に分かっている種類として残す。復号の出力で対応が引けなくなったときに使う
      this.lastKind.update(record.timestampKind);
    }
    // TIMESTAMP を持たない音の削除と重複の扱いは共通の規則に任せる
    storeDecodeInput(
      this.inputs,
      timestampMicros,
      {
        timestampKind: record.timestampKind,
        location: record.location ?? null,
        inputLagMs: record.inputLagMs ?? null,
        intentionalDelayMs: record.intentionalDelayMs ?? null,
      },
      this.options,
    );
  }

  /**
   * 復号の出力の timestamp に対する入力を解決する (引いた記録は忘れる)
   *
   * 完全一致する記録が無ければ、`toleranceMicros` の中で最も近い記録を引く。それも
   * 無ければ、直前に分かっている種類を、保留している記録から離れすぎていないときだけ
   * 返す (そのとき `input` は null)。
   *
   * @param outputTimestampMicros - 復号の出力の timestamp (マイクロ秒)
   * @param toleranceMicros - 対応とみなす差の上限 (マイクロ秒)
   */
  resolve(outputTimestampMicros: number, toleranceMicros: number): ResolvedAudioDecodeInput {
    const matched = takeDecodeInputEntry(this.inputs, outputTimestampMicros, toleranceMicros);
    if (matched !== undefined) {
      return { timestampKind: matched.timestampKind, input: matched };
    }
    return {
      timestampKind: this.lastKind.fallbackFor(this.inputs, outputTimestampMicros),
      input: null,
    };
  }

  /**
   * すべて忘れる
   *
   * 購読の停止 (`MediaPlayout.clearAll`) で呼ぶ。`AudioContext` を作り直すときは
   * `AudioPlayoutSession.reset` が時計の対応と追いつきの観測だけを消し、この対応表は消さない。
   */
  clear(): void {
    this.inputs.clear();
    this.lastKind.reset();
  }
}
