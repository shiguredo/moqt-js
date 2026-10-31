/**
 * 音声の再生のライフサイクル (開始・停止・切り替え)
 *
 * `useSubscriber` から切り出した、AudioContext の開始・停止・出力機器の切り替えの競合制御である。
 * このモジュールが持つ状態は「今の audio graph」と「開始の試行のトークン」だけで、購読・
 * 復号・再生の入口・signal は依存として渡してもらう。
 *
 * 不変条件:
 * - `audioPlayback` が非 null の間は、再生の入口 (`mediaPlayoutRef.current`) があるなら、
 *   その入口に同じ AudioContext が鳴らす先として付いている。例外は 2 つである。再生を
 *   始めている途中 (AudioContext を作ってから `setAudioOutput` するまで) と、停止の drain の
 *   途中に入口が作り直された場合で、後者は閉じる Context を新しい入口へ付けないため、
 *   非 null でも入口には付いていない期間がある (closeAudioContext が古い入口から外し、
 *   drain が終わると null に戻る)
 * - `audioPlayback` を null にするのは `closeStartedAudioPlayback` と `closeAudioContext`
 *   (停止の後始末) と `pauseAudioPlayback` だけである
 * - 停止 (`stopAudioPlayback`) は `audioPlaybackAttempt` を null にして進行中の開始を無効に
 *   する。開始は各 await の後と確定時にトークンの同一性を確かめ、外れていたら
 *   自分が作った Context だけを閉じる
 */

import type { Signal } from "@preact/signals";
import type { RefObject } from "preact";
import type { MediaPlayout } from "moqt-js";
import { applyAudioOutputSink } from "../utils/audioOutput";
import {
  discardStaleAudioPlaybackStart,
  isAudioPlaybackStartCurrent,
  settleAudioPlaybackStart,
  shouldAttachAudioPlayback,
} from "./audioPlaybackLifecycle.ts";
import type { SubscriberAudioStop } from "./subscriberAudioStop.ts";

/** 受信した音声を再生するための audio graph */
interface AudioPlayback {
  context: AudioContext;
  destination: AudioDestinationNode;
  /**
   * `statechange` のリスナー
   *
   * Context を閉じるすべての経路で外す。外さないと、閉じた Context が "closed" になった
   * ときの通知が、後から作った Context の状態を上書きする。
   */
  stateChangeListener: () => void;
}

/** 音声の再生の開始の試行 (開始のたびに作り直すトークン) */
interface AudioPlaybackStartAttempt {
  /**
   * 開始が作った audio graph
   *
   * 開始は await の途中で例外を投げることがある。そのときの後始末 (自分の Context だけ
   * 閉じる) に使うため、トークンにも持たせる。まだ作っていなければ null。
   */
  playback: AudioPlayback | null;
}

/** 音声の再生のライフサイクルの依存 (フックから渡す) */
interface AudioPlaybackControllerDeps {
  /** ログに使う subscriber の ID */
  readonly subscriberId: string;
  /** 共有の再生の入口 (購読ごとに作り直される) */
  readonly mediaPlayoutRef: RefObject<MediaPlayout | null>;
  /** 停止の二重呼び出しを共有する処理 (復号の対応付けにも使うためフックが持つ) */
  readonly audioStopRef: RefObject<SubscriberAudioStop>;
  /** 停止 (drain) の flush に使う、復号前の段の保持分を流す */
  flushAudioPreDecode(): number;
  /** 購読中の再生の有効・無効 (購読していない間は null) */
  getAudioPlaybackEnabledSignal(): Signal<boolean> | null;
  /** URL クエリ (`playAudio`) へ反映する signal */
  readonly playAudioEnabled: Signal<boolean>;
  /** `setSinkId` に渡す、選択中の音声出力デバイスの ID (空文字は既定) */
  getSelectedAudioOutputDeviceId(): string;
  /**
   * AudioContext を作るときのサンプルレート (Hz)
   *
   * 復号フレームのレートに揃えた値である (`resolveAudioContextSampleRate`)。レートが
   * 食い違うと `AudioBufferSourceNode` がバッファごとにリサンプルするため、不要な変換を避ける。
   */
  getAudioContextSampleRate(): number;
  /**
   * AudioContext の状態を通知する
   *
   * Context を作った直後の初期状態も同じコールバックで通知する。`suspended` の間は
   * 予約した音が鳴らないため、状態と、その Context のサンプルレート (Hz) を signal へ
   * 写して警告の判定に使う (docs/AUDIO_GLITCH_CAUSES.md の B4)。
   */
  onAudioContextStateChange(
    state: AudioContextState,
    contextSampleRate: number,
    baseLatencyMs: number,
    outputLatencyMs: number | null,
  ): void;
  /**
   * AudioContext を閉じ始めたときに呼ぶ (`statechange` のリスナーを外したあと)
   *
   * 閉じた Context の状態を画面に残さない。再生の AudioContext が無いことを null で
   * 表すため、状態を消す。
   */
  onAudioContextClosed(): void;
  /**
   * 再生を始めた時点の累積の計器の基準を取り直し、signal へ写す
   *
   * 入口の統計 (`getStats()`) を 1 回だけ読んで基準と表示に共用する。
   */
  restartAudioPlayoutCumulative(): void;
}

/** 音声の再生のライフサイクル */
export interface AudioPlaybackController {
  /** 購読の入口を作り直したときに、再生中の AudioContext を鳴らす先として付ける */
  attachPlaybackToPlayout(playout: MediaPlayout): void;
  /** 音声の再生 (AudioContext) があるか */
  hasPlayback(): boolean;
  /** 出力システムと機器が現在報告している遅延 (ms)。未再生なら null */
  getOutputLatency(): { baseLatencyMs: number; outputLatencyMs: number | null } | null;
  /** 再生中の Context の出力デバイスを切り替える。未再生なら次回の開始で反映する */
  setOutputDevice(deviceId: string): Promise<void>;
  /** 音声の再生を切り替える (UI のトグル) */
  toggleAudioPlayback(): Promise<void>;
  /** 音声を鳴らし切ってから止め、AudioContext を閉じる */
  stopAudioPlayback(): Promise<void>;
}

/**
 * 音声の再生のライフサイクルを作る
 *
 * この関数はフックの再描画で作り直さないこと (`useRef` の遅延初期化で 1 回だけ作る)。
 * 作った側が audio graph と開始の試行を持つため、作り直すと再生中の状態を失う。
 *
 * @param deps - フックが持つ状態へのアクセス
 * @returns 音声の再生のライフサイクル
 */
export function createAudioPlaybackController(
  deps: AudioPlaybackControllerDeps,
): AudioPlaybackController {
  // 受信した音声を再生するための audio graph (トグル有効時のみ非 null)。トグルは購読前から
  // 押せるため、購読していない間は入口が無いまま AudioContext だけを作れる
  let audioPlayback: AudioPlayback | null = null;
  // 音声の再生の開始の試行。開始は await をまたぐため、二重起動の防止と「古い開始が
  // 新しい開始の後始末をしない」ことをトークンの同一性で判定する。停止はこのトークンを
  // null にして、進行中の開始を無効にする
  let audioPlaybackAttempt: AudioPlaybackStartAttempt | null = null;

  /**
   * AudioContext の状態の通知を始める
   *
   * 生成直後の初期状態も通知する (トグルで作るため、作った時点では suspended のことが
   * 多い)。以降の `statechange` も同じコールバックで通知する。
   *
   * @param context - 監視する AudioContext
   * @returns `statechange` のリスナー (閉じる経路で外す)
   */
  function attachAudioContextStateListener(context: AudioContext): () => void {
    const listener = (): void => {
      deps.onAudioContextStateChange(
        context.state,
        context.sampleRate,
        context.baseLatency * 1000,
        Number.isFinite(context.outputLatency) ? context.outputLatency * 1000 : null,
      );
    };
    context.addEventListener("statechange", listener);
    listener();
    return listener;
  }

  /**
   * AudioContext の状態の監視をやめる
   *
   * Context を閉じる直前に呼ぶ。閉じると "closed" の `statechange` が届くが、それは
   * 再生が終わった Context の状態であり、画面に残す値ではない。
   *
   * @param playback - 監視をやめる audio graph
   */
  function detachAudioContextStateListener(playback: AudioPlayback): void {
    playback.context.removeEventListener("statechange", playback.stateChangeListener);
    deps.onAudioContextClosed();
  }

  /**
   * 音声の再生の audio graph を作る
   *
   * AudioContext のサンプルレートは、復号フレームのレートに揃えた値で作る。既定レート
   * (出力デバイスの preferred sample rate) が復号のレートと違うと、`AudioBufferSourceNode`
   * がバッファごとにリサンプルする。OfflineAudioContext で再現した境界の重なりと
   * 実出力のクリックの有無は区別し、ここでは不要な変換を避ける。
   *
   * @returns 音声の再生の audio graph
   */
  function createAudioPlayback(): AudioPlayback {
    let context: AudioContext;
    try {
      context = new AudioContext({
        sampleRate: deps.getAudioContextSampleRate(),
        latencyHint: "interactive",
      });
    } catch {
      // 指定したレートの AudioContext を作れない環境 (デバイスがレートに対応しない、
      // ブラウザの制限など) では、既定レートで作る。レートが復号フレームと揃わなくても
      // 音は鳴る (音質上の問題は残るが、再生できないよりよい)
      context = new AudioContext({ latencyHint: "interactive" });
    }
    // 出力先まで作れたら、状態の監視を始める。失敗した Context は通知しない
    const stateChangeListener = attachAudioContextStateListener(context);
    return { context, destination: context.destination, stateChangeListener };
  }

  /**
   * 開始が作った audio graph を閉じ、再生の対象から外す (失敗は握り潰す)
   *
   * 開始の途中で停止されるか新しい開始に置き換えられたときに呼ぶ。
   * 新しい Context を閉じないよう、開始が作ったものだけを対象にする。
   */
  async function closeStartedAudioPlayback(playback: AudioPlayback): Promise<void> {
    if (audioPlayback === playback) {
      audioPlayback = null;
    }
    if (playback.context.state === "closed") {
      // 停止側が先に閉じている。閉じる経路を 1 つに保つ (失敗の握り潰しに頼らない)。
      // 状態の監視も停止側が先に外している
      return;
    }
    // 状態の監視を先に外す。閉じた Context の "closed" を画面へ残さない
    detachAudioContextStateListener(playback);
    await playback.context.close().catch(() => {
      // 既に閉じている場合は無視する
    });
  }

  /**
   * 受信した音声を音声出力デバイスへ流す graph を作り、再生を始める
   *
   * Context の destination へ直接出す。MediaStream と `<audio>` を経由すると別の
   * 再生バッファを挟み、Context の出力時計だけでは実際の再生位置を追えなくなる。
   * トグルのクリックを契機に resume し、自動再生ポリシーにも従う。
   *
   * 鳴らす先を再生の入口へ付けるのは呼び出し側である。`audioPlaybackEnabled` を立てる直前に
   * 付けることで、有効になる前に届いた音を捨てる今の扱いを変えない。
   *
   * 開始は AudioContext の生成・`resume()`・出力機器の選択 をまたいで await する。
   * その途中で停止が始まるか新しい開始が始まることがあるため、各 await の後に対象が
   * 変わっていないかを確かめる。変わっていたら、自分が作った
   * Context だけ閉じて null を返す (停止の drain の途中は停止側が閉じるため閉じない)。
   *
   * @param attempt - 開始の試行。作った audio graph を後始末用に記録する
   * @returns 開始に使った audio graph。開始の途中で対象が変わったときは null
   */
  async function startAudioPlayback(
    attempt: AudioPlaybackStartAttempt,
  ): Promise<AudioPlayback | null> {
    const playback = createAudioPlayback();
    audioPlayback = playback;
    attempt.playback = playback;
    // 開始の途中で対象が変わっていないかを確かめる。外れていたら自分の Context だけ閉じる
    const abandonIfStale = async (): Promise<boolean> => {
      if (
        isAudioPlaybackStartCurrent(audioPlayback, playback, deps.audioStopRef.current.isStopping)
      ) {
        return false;
      }
      await discardStaleAudioPlaybackStart(deps.audioStopRef.current.isStopping, () =>
        closeStartedAudioPlayback(playback),
      );
      return true;
    };
    if (playback.context.state === "suspended") {
      await playback.context.resume();
      if (await abandonIfStale()) return null;
    }
    const outputDeviceId = deps.getSelectedAudioOutputDeviceId();
    if (outputDeviceId !== "") {
      await applyAudioOutputSink(playback.context, outputDeviceId);
      if (await abandonIfStale()) return null;
    }
    return playback;
  }

  /**
   * 音声出力を止め、Context を閉じる
   *
   * 停止の要求を受けたら、新規の音声 Object を復号へ積むのを止め、復号前の段に保持して
   * いる Object を flush して復号へ流し、予約済みの音が鳴り終わるまで待ってから
   * `AudioContext` を閉じる (drain)。待ち時間の上限は `AUDIO_PLAYOUT_DRAIN_MAX_MS`。
   * 復号前の段の flush 分の復号出力は、予約されるまで待つ。
   *
   * 二重に呼ばれた場合は同じ Promise を返す。停止の完了を待てない経路 (パネルの削除、
   * アンマウント、セッションの close 通知) は `void` で呼び、AudioContext はこの処理が
   * 必ず閉じる。
   */
  function stopAudioPlayback(): Promise<void> {
    // 進行中の再生開始を無効にする (開始は await の後にトークンで自分が今の試行かを確かめる)
    audioPlaybackAttempt = null;
    // 停止の対象の再生の入口。停止の完了 (drain) は非同期であるため、その間に次の購読が
    // 始まって入口が作り直されても、作り直された入口を触らないよう参照を固定する
    const stoppingPlayout = deps.mediaPlayoutRef.current;
    return deps.audioStopRef.current.stop({
      flushAudio: () => deps.flushAudioPreDecode(),
      drain: async (options) => {
        if (audioPlayback === null) {
          // 停止の経路で再生の対象を null にするのは closeAudioContext だけである。
          // ここで null なら Context は既に閉じられており、鳴らし切る予約も残っていない
          return;
        }
        // 予約済みの音が鳴り終わるまで待つ。flush した分の復号出力が届くまでは
        // 予約が尽きていても終えない (再生の入口が持つ)
        await stoppingPlayout?.drainAudio(options);
      },
      closeAudioContext: async () => {
        const playback = audioPlayback;
        audioPlayback = null;
        // 閉じる AudioContext を再生の入口から外し、時計の対応と直前の音を捨てる。
        // 停止の drain の間に購読がやり直されて入口が作り直されることがあるため、
        // 作り直された入口からも外す (残すと、閉じた Context へ次の音を予約してしまう)。
        // 入口が作り直されていなければ、下の 1 回で足りる
        stoppingPlayout?.setAudioOutput(null);
        if (deps.mediaPlayoutRef.current !== stoppingPlayout) {
          deps.mediaPlayoutRef.current?.setAudioOutput(null);
        }
        if (playback !== null) {
          // 状態の監視を先に外す。閉じると "closed" の statechange が届くが、それは
          // 再生が終わった Context の状態であり、画面に残す値ではない
          detachAudioContextStateListener(playback);
          await playback.context.close().catch(() => {
            // 既に閉じている場合は無視する
          });
        }
      },
      onStopped: () => {
        // 時間軸からも音声の基準と学習と実績を消す。残すと共有の再生遅延に音声の下限
        // (AUDIO_PLAYOUT_DELAY_FLOOR_MS) が残り、映像の表示が音声を一度も再生していない購読より
        // 遅れたまま固定される。世代は進めない (積んでいる映像フレームを到着順に落とさない)
        stoppingPlayout?.resetAudioTimeline();
      },
    });
  }

  /**
   * 音声出力だけを止める (購読は続ける)
   *
   * 購読の停止時と違い、復号前の段は flush しない (保持している Object は購読の停止時に
   * 流す)。復号チェーンへの接続も外さない。外すと、購読を続けたまま音声を再度有効にした
   * ときに、復号前の段から流れた Object が復号へ届かない。予約済みで鳴り始めていない音は、
   * 閉じるときに切った量として計器へ残す。
   *
   * 音声の再生の状態 (予約の基準・追いつきの観測) も取り直す。有効に戻したときに、古い
   * `AudioContext` の基準で並べ直さないためである。映像の表示は止めない
   * (`resetPlayout` を使うと映像の表示待ちまで消える)。
   */
  function pauseAudioPlayback(): void {
    audioPlaybackAttempt = null;
    const playback = audioPlayback;
    audioPlayback = null;
    const playout = deps.mediaPlayoutRef.current;
    playout?.setAudioOutput(null);
    if (playback !== null) {
      // 予約済みで鳴り始めていない音は、閉じると鳴らないまま切り捨てられる
      playout?.recordAudioStopped();
      playout?.resetAudioTimeline();
      // 鳴らす先を外したので、予約の基準・時計の対応・追いつきの観測を取り直す
      playout?.resetAudioPlayback();
      // 状態の監視を先に外す。閉じた Context の "closed" を画面へ残さない
      detachAudioContextStateListener(playback);
      void playback.context.close().catch(() => {
        // 既に閉じている場合は無視する
      });
    }
  }

  /**
   * 受信した音声を再生するかどうかを切り替える
   *
   * 既定は無効。有効にしたときだけ音声出力デバイスへ繋ぐ。
   */
  async function toggleAudioPlayback(): Promise<void> {
    const enabled = deps.getAudioPlaybackEnabledSignal();
    if (enabled === null) return;
    // 購読の停止 (drain) の途中は切り替えない。停止の最後に AudioContext を閉じるため、
    // 途中で作り直すと参照が失われ、有効のまま無音になる
    if (deps.audioStopRef.current.isStopping) return;

    if (enabled.value) {
      pauseAudioPlayback();
      enabled.value = false;
      // URL クエリ (`playAudio`) へ反映する。共有した URL で同じ状態から始められる
      deps.playAudioEnabled.value = false;
      return;
    }

    // 開始の途中にもう一度クリックされると AudioContext が二重に作られ、先に作った方が
    // 参照を失って解放されない。開始の試行をトークンで持ち、終わった試行だけが後始末する
    if (audioPlaybackAttempt !== null) {
      return;
    }
    const attempt: AudioPlaybackStartAttempt = { playback: null };
    audioPlaybackAttempt = attempt;

    try {
      const started = await startAudioPlayback(attempt);
      if (started === null) {
        return;
      }
      const playout = deps.mediaPlayoutRef.current;
      playout?.resetAudioPlayback();
      await playout?.prepareAudio({ context: started.context, destination: started.destination });
      // await の間に停止が始まるか、停止の後に新しい開始が始まることがある。開始に使った
      // audio graph が今も対象かと停止中かで、今の再生として確定するかを決める。確定しない
      // ときは自分が作った Context だけを閉じる (停止の drain の
      // 途中は停止側が閉じるため閉じない)。確定したときだけ下の commit が呼ばれる
      await settleAudioPlaybackStart({
        isCurrent: audioPlayback === started,
        isStopping: deps.audioStopRef.current.isStopping,
        commit: () => {
          // 鳴らす先を再生の入口へ付け、有効にする直前に音声の再生の状態を取り直す。
          // ここから先は同じタスクで有効にするため、付け直した出力で鳴らす前に
          // audioPlaybackEnabled が false のままの音は現れない
          deps.mediaPlayoutRef.current?.setAudioOutput({
            context: started.context,
            destination: started.destination,
          });
          // 開始の経路は再生が無効なときだけ通るため、AudioContext は必ず作り直している。
          // 予約の基準と累積の表示の起点を取り直す
          deps.restartAudioPlayoutCumulative();
          enabled.value = true;
          deps.playAudioEnabled.value = true;
        },
        discard: () => closeStartedAudioPlayback(started),
      });
    } catch (error) {
      // 停止や新しい開始に置き換えられていたら、この失敗は想定内である。
      // ログや状態には出さず、開始が作った graph だけ
      // 後始末して戻る。新しい開始が作った Context は触らない
      if (audioPlaybackAttempt !== attempt) {
        const started = attempt.playback;
        if (started !== null) {
          await discardStaleAudioPlaybackStart(deps.audioStopRef.current.isStopping, () =>
            closeStartedAudioPlayback(started),
          );
        }
        return;
      }
      console.error(`[${deps.subscriberId}] failed to start audio playback:`, error);
      // 開始失敗も出力だけを閉じる。購読中の復号前キューの通知先は保つ。
      pauseAudioPlayback();
      enabled.value = false;
      deps.playAudioEnabled.value = false;
    } finally {
      // 二重起動のガードは、この試行が今の試行であるときだけ外す。古い開始が新しい開始の
      // ガードを消すと、同じ再生を二重に始められる
      if (audioPlaybackAttempt === attempt) {
        audioPlaybackAttempt = null;
      }
    }
  }

  /**
   * 購読の入口を作り直したときに、再生中の AudioContext を鳴らす先として付ける
   *
   * 停止の drain の途中は付けない (判定と理由は shouldAttachAudioPlayback を参照)。
   * 付けない場合、閉じる Context を新しい入口が掴んだままになり、次の音を閉じた
   * Context へ予約してしまうためである。
   */
  function attachPlaybackToPlayout(playout: MediaPlayout): void {
    if (shouldAttachAudioPlayback(audioPlayback, deps.audioStopRef.current.isStopping)) {
      playout.setAudioOutput({
        context: audioPlayback.context,
        destination: audioPlayback.destination,
      });
    }
  }

  /** 音声の再生 (AudioContext) があるか */
  function hasPlayback(): boolean {
    return audioPlayback !== null;
  }

  /** 初回の running 通知後にも機器の推定値が更新されるため、統計の周期ごとに読む。 */
  function getOutputLatency(): { baseLatencyMs: number; outputLatencyMs: number | null } | null {
    const context = audioPlayback?.context;
    if (context === undefined) return null;
    return {
      baseLatencyMs: context.baseLatency * 1000,
      outputLatencyMs: Number.isFinite(context.outputLatency) ? context.outputLatency * 1000 : null,
    };
  }

  /** 出力時計と再生先を同じ Context のデバイスへ揃える。 */
  async function setOutputDevice(deviceId: string): Promise<void> {
    const playback = audioPlayback;
    if (playback === null) return;
    try {
      await applyAudioOutputSink(playback.context, deviceId);
    } catch (error) {
      // setSinkId は機器の取得前に renderer を止めることがある。失敗後に有効表示と
      // 予約だけを残さず、現在の再生を閉じる。古い切り替えで新しい Context は止めない。
      if (audioPlayback === playback) {
        const enabled = deps.getAudioPlaybackEnabledSignal();
        if (enabled !== null) enabled.value = false;
        deps.playAudioEnabled.value = false;
        // 購読は続くため、復号前キューの通知先を外す購読停止の drain は使わない。
        pauseAudioPlayback();
      }
      throw error;
    }
  }

  return {
    attachPlaybackToPlayout,
    hasPlayback,
    getOutputLatency,
    setOutputDevice,
    toggleAudioPlayback,
    stopAudioPlayback,
  };
}
