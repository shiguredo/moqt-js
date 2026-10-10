/**
 * 受信側の音声が live から遅れたときに、復号器を作り直して追いつく
 *
 * 受信側の音声は、復号器 (WebCodecs の `AudioDecoder`) の中に未処理の音が溜まると、
 * 溜まった分だけ復号の出力が送られた TIMESTAMP から遅れたまま固定される。原因は復号器の
 * 中にあり、鳴らす音を捨てても (捨てた分は復号器から出てきた後の音である) 中の分は減らない。
 * 音は鳴り続けるため、聴いている側からは「ずっと遅れた音」になり、待っても戻らない。
 *
 * 実測 (手元の 1 台、実リレーへ同じページから配信と購読を行い、メインスレッドを 2 秒止める)
 * では、次のようになった。
 *
 * - 止めている間に届いた Object の到着の遅れ (受信した壁時計 - LOC TIMESTAMP) は
 *   2017.9 ms になった (止めた長さの分だけ受信の処理が遅れる)
 * - 復号の出力の遅れ (復号の出力を受け取った壁時計 - `AudioData.timestamp`) も同じだけ
 *   伸びる。止めた後に溜まった分を復号し終えると 20 ms 前後へ戻る。この間も遅れは 100 ms
 *   以上続くため、追いつきは始まる (実測: 止めた直後に 1 回始まり、復号の出力の timestamp の
 *   跳びから 1939.9 ms 分を捨てた)
 * - 時間軸が使う基準の遅れ (`avSync.delays.audio.baseDelayMs`) は 18.3 ms のままで、段差は
 *   出ない
 *
 * つまり、受信の処理がまとめて遅れただけの状態は自然に戻るが、戻るまでの間は音声が遅れた
 * ままである (実測: 200 ms 止めると、始めない場合の音声と映像の表示時刻の差は -197.1 ms に
 * なり、そのまま戻らなかった)。これに対して、CI の runner のように復号の出力が復号へ
 * 渡した音から遅れ続ける環境 (実測: 実リレーの E2E の失敗で、音声の基準の遅れが 116.4 ms
 * から 256.2 ms へ段差で上がり、そのまま戻らなかった) では、遅れは固定される。このクラスが
 * 追いつくのはこの状態である。
 *
 * 追いつく手段は復号器の作り直し (`AudioDecoderWrapper.reset()`) だけである。実測では、
 * 復号器を同じ設定で configure し直すと、その直後の出力から遅れが戻った (CPU を 6 倍に
 * 遅くしてメインスレッドを 60 ms 占有 / 40 ms 明け渡す負荷を 10 秒かけた後、作り直さなければ
 * 3370 ms のまま 23 秒間戻らなかった遅れが、作り直しを重ねると 39.1 ms へ戻り、その後は
 * 21〜30 ms で安定した)。鳴らす音を捨てるだけでは、復号器の中の分が減らないため遅れは
 * 戻らない。
 *
 * 判定は配信側の `AudioPublishCatchUp` と同じ考え方である (上限を超えた状態が続いたときだけ
 * 始める、やめた後は一定は始めない)。違うのは、配信側の遅れ (読み出しの遅れ + 符号化の
 * キューの長さ) が「実時間より先に進んだ分」であるのに対して、こちらは「受信と復号が
 * 済んだ音がどれだけ古いか」であること、遅れの床を直近の窓の最小値から求めること
 * (詳しくは `AUDIO_RECEIVE_CATCH_UP_FLOOR_WINDOW_MS`)、遅れが上限へ戻るまでは作り直しを
 * 繰り返すこと (詳しくは `AUDIO_RECEIVE_CATCH_UP_COOLDOWN_MS`)、そして音声を映像へ
 * 合わせられない遅れ (床から `AUDIO_RECEIVE_CATCH_UP_JUMP_MS` を超えた分) では持続を
 * 待たずに始めることである。
 *
 * 復号器を作り直すと、復号器の中に溜まっていた音 (未処理の投入と、まだ届いていない出力) は
 * 捨てられる。次に復号される音は、作り直した時点で届いている最も新しい Object であるため、
 * 音はその分だけ飛ぶ。飛んだ長さは復号の出力の timestamp の跳びとして現れるので、これを
 * 測って `AudioReceiveCatchUpStats` に出す。鳴らす側 (再生の時間軸) では、飛んだ分が前の音と
 * 次の音の間の隙間になり、上限 (`AUDIO_PLAYOUT_MAX_CONCEAL_SECONDS` = 100 ms) まで
 * concealment が埋める。それより長い分は無音のまま残る。鳴らす音そのものは捨てない
 * (鳴らなかった音として数えると、復号器の中の分が減らないまま「鳴らなかった音」だけが
 * 増え続け、実リレーの E2E が判定に使う `missedFrames` の意味が壊れる)。
 *
 * ブラウザ API に依存しない (時刻と値は呼び出し側が渡す)。
 */

/**
 * 健全時の遅れ (床) を求める、直近の窓 (ミリ秒)
 *
 * 床は「今の環境で健全なときの遅れ」であり、その環境の経路と復号の速さで決まる
 * (実測: 手元では 18〜19 ms、実リレーの E2E の失敗では 116 ms 前後)。遅れが段差で上がっても、
 * 窓がその値で埋まれば床も上がるため、環境が恒久的に悪化した状態で作り直しを繰り返さない。
 *
 * 全期間の最小値にしないのは、購読の直後に relay の cache から届いた分をまとめて復号すると
 * 1 音だけ小さな遅れが出ることがあり、それを床にすると健全な状態 (その環境の定常値) が
 * 上限を超えたままに見えるためである。5 秒は、定常値を保つのに十分で、環境が変わったときに
 * 数秒で追従する長さである
 */
export const AUDIO_RECEIVE_CATCH_UP_FLOOR_WINDOW_MS = 5_000;

/**
 * 床が小さく観測されたときに許す、遅れの上限 (ミリ秒)
 *
 * 配信側の `AUDIO_PUBLISH_CATCH_UP_MIN_MS` と同じ値である。音声の 1 パケットは 20 ms で
 * あり、これは 3 パケット分にあたる。復号の出力は投入から 1 パケット以上遅れて返るため、
 * 健全な状態でも 10〜20 ms の遅れがある。床を実際より小さく観測しても、上限がこれより
 * 下がらないようにする
 */
export const AUDIO_RECEIVE_CATCH_UP_MIN_MS = 60;

/**
 * 健全時の遅れからさらに許す遅れ (ミリ秒)
 *
 * 配信側の `AUDIO_PUBLISH_CATCH_UP_GROWTH_MS` と同じ値である (2 パケット分)。遅れは経路と
 * 復号の揺らぎで数十 ms 動く (実測: 手元の負荷なしで 18〜28 ms、CPU を 4 倍に遅くした負荷で
 * 20〜45 ms) ため、1 音の揺らぎで始めない幅としてこれを許す
 */
export const AUDIO_RECEIVE_CATCH_UP_GROWTH_MS = 40;

/**
 * 健全時の遅れを超えた分がこれを超えたら、持続を待たずに始める (ミリ秒)
 *
 * 音声と映像のずれとして合わせられる量の上限 (`PLAYOUT_MAX_COMPENSATED_DIFFERENCE_MS` = 100 ms。
 * `docs/AV_SYNC_DECISIONS.md` の決定 1) と同じ値である。復号の出力が健全時の遅れから 100 ms
 * を超えて遅れているとき、受信側は音声を映像へ合わせられない (映像を待たせても足りない)。
 * この状態は、受信の処理がまとめて遅れて、止まっている間に届いた Object を復号し終えるまで
 * 続く。待たずに始めて溜まった分を捨てる方が、遅れた音を鳴らし続けるより良い。
 *
 * 実測 (手元の 1 台、実リレー) では、到着の遅れが 233 ms になった観測で、音声と映像の表示
 * 時刻の差が -168.6 ms になった (許す絶対値は 150 ms)。1 音だけの揺らぎ (実測: 65 ms 前後)
 * では届かない値であり、持続の確認 (100 ms) を待つと、その間に映像だけが先へ進んでずれが
 * 開く
 */
export const AUDIO_RECEIVE_CATCH_UP_JUMP_MS = 100;

/**
 * 追いつきを始める前に、上限を超えた状態が続くことを要求する時間 (ミリ秒)
 *
 * 配信側の `AUDIO_PUBLISH_CATCH_UP_CONFIRM_MS` と同じ値である。1 音の観測だけで始めると、
 * 経路と復号が一瞬つまずいただけでも始まる。実測 (手元の 1 台、CPU を 6 倍に遅くした負荷の
 * 前の 8 秒、250 ms ごとの観測) では、復号の出力の遅れは 20〜45 ms で動き、上限
 * (床 21.4 ms + 40 ms = 61.4 ms) を超えたのは 250 ms ごとの観測で 1 回だけで、次には戻って
 * いた。100 ms (5 音) の持続を要求すれば、この形では始まらない。
 *
 * `AUDIO_RECEIVE_CATCH_UP_JUMP_MS` を超える遅れ (音声を映像へ合わせられない状態) は、
 * この持続を待たずに始める。待つと、その間に映像だけが先へ進んでずれが開くためである
 */
export const AUDIO_RECEIVE_CATCH_UP_CONFIRM_MS = 100;

/**
 * 追いつきを始めた後、次を始めない時間 (ミリ秒)
 *
 * 配信側の `AUDIO_PUBLISH_CATCH_UP_COOLDOWN_MS` と同じ値である。遅れが上限へ戻るまで
 * (作り直しが効くまで) は、この間隔で作り直しを繰り返す。
 *
 * 1 回の作り直しで戻らない状態がある。実測 (CPU を 6 倍に遅くしてメインスレッドを 60 ms
 * 占有 / 40 ms 明け渡す負荷を 10 秒、手元の 1 台) では、遅れは負荷の間 145 ms から
 * 2788 ms へ伸び続け、負荷をやめた後も 2788 ms のまま 23 秒間戻らなかった。負荷の間に
 * 1 回作り直しても、作り直した後に溜まり直すためである。負荷が去った後に作り直せば、
 * 溜まった分は捨てられて遅れは戻る。そのため、遅れが上限へ戻るまではこの間隔で始め直す。
 *
 * 1 秒にするのは、配信側と同じ間隔であり、遅れが伸び続けている間だけ始まる (上限へ戻れば
 * 止まる) ためである。上限をまたぐたびに始め直す状態にはならない (床と上限は窓と共に動く)
 */
export const AUDIO_RECEIVE_CATCH_UP_COOLDOWN_MS = 1_000;

/**
 * 追いつきで音が飛んだとみなす、1 音の長さを超える最小の跳び (ミリ秒)
 *
 * 復号の出力の timestamp は投入の順に進むため、飛びが無ければ 1 音の長さ (20 ms) ずつ
 * 進む。これより小さい差は timestamp の丸めとみなし、捨てた音として数えない
 */
export const AUDIO_RECEIVE_CATCH_UP_SKIP_MIN_MS = 1;

/** `AudioReceiveCatchUp.observe()` の入力 */
export interface AudioReceiveCatchUpObservation {
  /** 復号の出力が届いた時刻 (`performance.now()` と同じ軸のミリ秒) */
  readonly nowMs: number;
  /**
   * 復号の出力の遅れ (ミリ秒)
   *
   * 到着の壁時計 - `AudioData.timestamp` である。壁時計の TIMESTAMP を持たない音では
   * 測れないため、呼び出し側が観測しない
   */
  readonly lagMs: number;
  /** 音の長さ (ミリ秒) */
  readonly durationMs: number;
  /** 復号の出力の timestamp (Unix epoch マイクロ秒)。追いつきで飛んだ長さを測る */
  readonly timestampMicros: number;
}

/** `AudioReceiveCatchUp.observe()` の判定 */
export interface AudioReceiveCatchUpDecision {
  /**
   * 復号器を作り直すか
   *
   * true のとき、呼び出し側は復号器を作り直す (このファイルの先頭のコメントを参照)。
   * 作り直さないと、溜まった分は実時間と同じ速さでしか出てこないため遅れは戻らない
   */
  readonly rebuildDecoder: boolean;
}

/** 受信側の音声の追いつきの観測値 (devtools と統計に出す) */
export interface AudioReceiveCatchUpStats {
  /** 直近に観測した、復号の出力の遅れ (ミリ秒)。まだ観測していなければ null */
  lagMs: number | null;
  /** 健全時に観測した遅れ (床、ミリ秒)。直近の窓の最小値であり、まだ観測していなければ null */
  floorMs: number | null;
  /** 観測した最大の遅れ (ミリ秒)。まだ観測していなければ null */
  maxLagMs: number | null;
  /** いま使っている遅れの上限 (ミリ秒)。床と `AUDIO_RECEIVE_CATCH_UP_GROWTH_MS` から決まる */
  limitMs: number;
  /**
   * いま追いつきの最中か
   *
   * 復号器を作り直した後、遅れが上限へ戻るまで true である。この間も、遅れが伸び続けて
   * いれば作り直しを繰り返す (`catchUpStarts` が増える)
   */
  catchingUp: boolean;
  /** 追いつきを始めた回数 (復号器を作り直した回数、累積) */
  catchUpStarts: number;
  /** 追いつきで飛んだ音の数 (累積の推定。timestamp の跳びから求める) */
  skippedFrames: number;
  /** 追いつきで飛んだ音の長さの合計 (ミリ秒、累積の推定) */
  skippedMs: number;
  /** 直近に飛んだ音の長さ (ミリ秒)。飛んでいなければ null */
  lastSkippedMs: number | null;
}

/** 何も観測していないときの追いつきの観測値 */
export const EMPTY_AUDIO_RECEIVE_CATCH_UP: AudioReceiveCatchUpStats = {
  lagMs: null,
  floorMs: null,
  maxLagMs: null,
  limitMs: AUDIO_RECEIVE_CATCH_UP_MIN_MS,
  catchingUp: false,
  catchUpStarts: 0,
  skippedFrames: 0,
  skippedMs: 0,
  lastSkippedMs: null,
};

/** 床を求めるために持つ、1 音分の観測 */
interface FloorSample {
  /** 観測した時刻 (ミリ秒) */
  readonly atMs: number;
  /** 観測した遅れ (ミリ秒) */
  readonly lagMs: number;
}

/** `AudioReceiveCatchUp` の設定 */
export interface AudioReceiveCatchUpOptions {
  /** 遅れの上限の下限 (ミリ秒)。既定は `AUDIO_RECEIVE_CATCH_UP_MIN_MS` */
  readonly minMs?: number;
  /** 健全時の遅れからさらに許す遅れ (ミリ秒)。既定は `AUDIO_RECEIVE_CATCH_UP_GROWTH_MS` */
  readonly growthMs?: number;
  /**
   * 持続を待たずに始める、健全時の遅れからの増加 (ミリ秒)。既定は
   * `AUDIO_RECEIVE_CATCH_UP_JUMP_MS`
   */
  readonly jumpMs?: number;
  /** 床を求める直近の窓 (ミリ秒)。既定は `AUDIO_RECEIVE_CATCH_UP_FLOOR_WINDOW_MS` */
  readonly floorWindowMs?: number;
  /** 追いつきを始める前に要求する、上限を超えた状態の持続 (ミリ秒)。既定は `AUDIO_RECEIVE_CATCH_UP_CONFIRM_MS` */
  readonly confirmMs?: number;
  /** 追いつきを始めた後、次を始めない時間 (ミリ秒)。既定は `AUDIO_RECEIVE_CATCH_UP_COOLDOWN_MS` */
  readonly cooldownMs?: number;
}

/**
 * 受信側の音声の追いつきの判定と観測
 *
 * 音声の購読 (復号した音を鳴らす側) ごとに 1 つ持つ。復号の出力を受け取るたびに
 * `observe()` を呼び、返ってきた `rebuildDecoder` に従って復号器を作り直す。
 */
export class AudioReceiveCatchUp {
  private readonly minMs: number;
  private readonly growthMs: number;
  private readonly jumpMs: number;
  private readonly floorWindowMs: number;
  private readonly confirmMs: number;
  private readonly cooldownMs: number;

  /** 直近の窓の観測 (床を求める)。古い方から捨てる */
  private readonly floorSamples: FloorSample[] = [];
  /** 健全時に観測した遅れ (床、ミリ秒)。直近の窓の最小値 */
  private floorMs: number | null = null;
  /** 直近に観測した遅れ (ミリ秒) */
  private lastLagMs: number | null = null;
  /** 観測した最大の遅れ (ミリ秒) */
  private maxLagMs: number | null = null;
  /** 上限を超えた状態が始まった時刻 (ミリ秒)。超えていなければ null */
  private overLimitSinceMs: number | null = null;
  /** 追いつきの最中か (復号器を作り直した後、遅れが上限へ戻るまで) */
  private catchingUp = false;
  /** 直近に追いつきを始めた時刻 (ミリ秒)。まだ始めていなければ null */
  private startedAtMs: number | null = null;
  /** 直前に観測した復号の出力の timestamp (マイクロ秒)。飛んだ長さを測る */
  private lastTimestampMicros: number | null = null;
  /** 直前に観測した時刻 (ミリ秒)。観測が窓の長さより途切れたかを見る */
  private lastObservedAtMs: number | null = null;
  /** 観測が途切れる前に観測した床 (ミリ秒)。途切れた後、窓の長さの分だけ保つ */
  private heldFloorMs: number | null = null;
  /** 途切れる前の床を保つ期限 (ミリ秒)。保たないときは null */
  private heldFloorUntilMs: number | null = null;
  private catchUpStarts = 0;
  private skippedFrames = 0;
  private skippedMs = 0;
  private lastSkippedMs: number | null = null;

  constructor(options: AudioReceiveCatchUpOptions = {}) {
    this.minMs = options.minMs ?? AUDIO_RECEIVE_CATCH_UP_MIN_MS;
    this.growthMs = options.growthMs ?? AUDIO_RECEIVE_CATCH_UP_GROWTH_MS;
    this.jumpMs = options.jumpMs ?? AUDIO_RECEIVE_CATCH_UP_JUMP_MS;
    this.floorWindowMs = options.floorWindowMs ?? AUDIO_RECEIVE_CATCH_UP_FLOOR_WINDOW_MS;
    this.confirmMs = options.confirmMs ?? AUDIO_RECEIVE_CATCH_UP_CONFIRM_MS;
    this.cooldownMs = options.cooldownMs ?? AUDIO_RECEIVE_CATCH_UP_COOLDOWN_MS;
  }

  /**
   * 復号の出力 1 つを観測し、復号器を作り直すかどうかを決める
   *
   * @param observation - 届いた時刻と、その音の TIMESTAMP からの遅れ
   */
  observe(observation: AudioReceiveCatchUpObservation): AudioReceiveCatchUpDecision {
    const lagMs = observation.lagMs;
    this.lastLagMs = lagMs;
    this.maxLagMs = this.maxLagMs === null ? lagMs : Math.max(this.maxLagMs, lagMs);
    this.updateFloor(observation.nowMs, lagMs);
    const limitMs = this.limitMs();

    // 追いつきで飛んだ音を、timestamp の跳びから測る (遅れが戻る判定より先に行う)
    this.measureSkip(observation);

    if (lagMs <= limitMs) {
      // 上限の中へ戻った (作り直しが効いた)。次に上限を超えたら、また始められる
      this.catchingUp = false;
      this.overLimitSinceMs = null;
      return { rebuildDecoder: false };
    }
    this.overLimitSinceMs ??= observation.nowMs;
    if (!this.shouldStart(observation.nowMs, lagMs)) {
      return { rebuildDecoder: false };
    }
    // 遅れが上限へ戻るまで始め直す。実測 (CPU を 6 倍に遅くしてメインスレッドを
    // 60 ms 占有 / 40 ms 明け渡す負荷を 10 秒) では、負荷の間も遅れが伸び続け、
    // 1 回作り直しただけでは戻らなかった (詳細は AUDIO_RECEIVE_CATCH_UP_COOLDOWN_MS)
    this.catchingUp = true;
    this.startedAtMs = observation.nowMs;
    this.catchUpStarts++;
    return { rebuildDecoder: true };
  }

  /** 観測値 (devtools と統計に出す) */
  snapshot(): AudioReceiveCatchUpStats {
    return {
      lagMs: this.lastLagMs,
      floorMs: this.floorMs,
      maxLagMs: this.maxLagMs,
      limitMs: this.limitMs(),
      catchingUp: this.catchingUp,
      catchUpStarts: this.catchUpStarts,
      skippedFrames: this.skippedFrames,
      skippedMs: this.skippedMs,
      lastSkippedMs: this.lastSkippedMs,
    };
  }

  /** 購読をやり直すときなどに、観測と累積を消す */
  reset(): void {
    this.floorSamples.length = 0;
    this.floorMs = null;
    this.lastLagMs = null;
    this.maxLagMs = null;
    this.overLimitSinceMs = null;
    this.catchingUp = false;
    this.startedAtMs = null;
    this.lastTimestampMicros = null;
    this.lastObservedAtMs = null;
    this.heldFloorMs = null;
    this.heldFloorUntilMs = null;
    this.catchUpStarts = 0;
    this.skippedFrames = 0;
    this.skippedMs = 0;
    this.lastSkippedMs = null;
  }

  /** いまの遅れの上限 (ミリ秒)。床からの増加と絶対値の下限の大きい方 */
  private limitMs(): number {
    return Math.max(this.minMs, (this.floorMs ?? 0) + this.growthMs);
  }

  /**
   * 追いつきを始めてよいか
   *
   * 2 つの経路を持つ。健全時の遅れ (床) から `AUDIO_RECEIVE_CATCH_UP_JUMP_MS` を超えて
   * 遅れている場合は、音声を映像へ合わせられない状態であり、その場で始める。上限を超えた
   * 状態が `AUDIO_RECEIVE_CATCH_UP_CONFIRM_MS` 続いた場合も始める。どちらも、直近に始めて
   * いれば `AUDIO_RECEIVE_CATCH_UP_COOLDOWN_MS` たっていることを要求する (詳しくは各定数の
   * コメント)
   */
  private shouldStart(nowMs: number, lagMs: number): boolean {
    if (this.startedAtMs !== null && nowMs - this.startedAtMs < this.cooldownMs) {
      return false;
    }
    if (lagMs > (this.floorMs ?? 0) + this.jumpMs) {
      return true;
    }
    if (this.overLimitSinceMs === null) {
      return false;
    }
    return nowMs - this.overLimitSinceMs >= this.confirmMs;
  }

  /**
   * 健全時の遅れ (床) を、直近の窓の最小値として更新する
   *
   * 窓より古い観測は捨てる。観測が窓の長さより途切れたとき (ページが長く止まった、
   * 復号が長く止まった) は、途切れる前の床を窓の長さの分だけ保つ。途切れている間に溜まった
   * 分をそのまま床にすると、遅れが健全な値とみなされ、追いつきが始まらなくなる (実測:
   * 10 秒の観測のうち 5 秒を超えて途切れた後、遅れが 150 ms のまま固定され、始まらなかった)
   */
  private updateFloor(nowMs: number, lagMs: number): void {
    const previousAtMs = this.lastObservedAtMs;
    this.lastObservedAtMs = nowMs;
    if (previousAtMs !== null && nowMs - previousAtMs > this.floorWindowMs) {
      this.heldFloorMs = this.floorMs;
      this.heldFloorUntilMs = nowMs + this.floorWindowMs;
    }
    this.floorSamples.push({ atMs: nowMs, lagMs });
    const oldestMs = nowMs - this.floorWindowMs;
    while (this.floorSamples.length > 0 && (this.floorSamples[0]?.atMs ?? 0) <= oldestMs) {
      this.floorSamples.shift();
    }
    let floorMs = lagMs;
    for (const sample of this.floorSamples) {
      floorMs = Math.min(floorMs, sample.lagMs);
    }
    if (
      this.heldFloorMs !== null &&
      this.heldFloorUntilMs !== null &&
      nowMs < this.heldFloorUntilMs
    ) {
      floorMs = Math.min(floorMs, this.heldFloorMs);
    }
    this.floorMs = floorMs;
  }

  /**
   * 追いつきで飛んだ音の長さを、復号の出力の timestamp の跳びから測る
   *
   * 復号器を作り直すと、中に溜まっていた投入が捨てられる。捨てられた分は、次に復号された音の
   * timestamp が前の音から跳ぶことで現れる。跳びから 1 音の長さを引いた分が、鳴らなかった音で
   * ある。数えるのは追いつきの最中 (作り直した後、遅れが上限へ戻るまで) だけであり、それ以外の
   * 跳び (配信側の欠落、relay の cache の再送など) は数えない
   */
  private measureSkip(observation: AudioReceiveCatchUpObservation): void {
    const previousMicros = this.lastTimestampMicros;
    this.lastTimestampMicros = observation.timestampMicros;
    if (previousMicros === null || !this.catchingUp) {
      return;
    }
    const frameMicros = observation.durationMs * 1_000;
    const stepMicros = observation.timestampMicros - previousMicros;
    if (stepMicros - frameMicros <= AUDIO_RECEIVE_CATCH_UP_SKIP_MIN_MS * 1_000) {
      return;
    }
    const skippedMs = (stepMicros - frameMicros) / 1_000;
    // 飛んだ音の数は、跳びが 1 音の長さの何個分かを四捨五入して 1 を引いた数にする
    // (timestamp の格子が音の長さと一致しない環境でも 1 以上になる)
    const skippedFrames = Math.max(1, Math.round(stepMicros / frameMicros) - 1);
    this.skippedFrames += skippedFrames;
    this.skippedMs += skippedMs;
    this.lastSkippedMs = skippedMs;
  }
}
