/**
 * 音声の再生のライフサイクル (開始・停止・切り替え)
 *
 * `useSubscriber` から切り出した、AudioContext と `<audio>` の開始・停止の競合制御である。
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
 *   する。開始は各 await の後と確定時にトークンの同一性を確かめ、外れていたら共有の
 *   `<audio>` を触らず自分が作った Context だけを閉じる
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
  destination: MediaStreamAudioDestinationNode;
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
  /** 音声を鳴らす `<audio>` 要素 */
  readonly audioRef: RefObject<HTMLAudioElement | null>;
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
   * 音声の再生の audio graph を作る
   *
   * 出力先の生成に失敗したときは、作りかけの `AudioContext` を閉じてから throw する。
   * この時点ではまだ再生の対象に載せていないため停止の経路からは閉じられず、閉じないままに
   * するとブラウザの音声出力を占有し続ける。閉じる失敗は元の失敗を隠さないよう握り潰す。
   *
   * @returns 音声の再生の audio graph
   * @throws createMediaStreamDestination が失敗した場合 (閉じたあとに rethrow する)
   */
  function createAudioPlayback(): AudioPlayback {
    const context = new AudioContext();
    try {
      return { context, destination: context.createMediaStreamDestination() };
    } catch (error) {
      // 作りかけの AudioContext を残さない。close の失敗は元の失敗を隠さない
      void context.close().catch(() => {
        // 元の失敗を優先する
      });
      throw error;
    }
  }

  /**
   * 開始が作った audio graph を閉じ、再生の対象から外す (失敗は握り潰す)
   *
   * 開始の途中で停止されるか新しい開始に置き換えられたときに呼ぶ。共有の `<audio>` は
   * 新しい開始のものになり得るため触らない (停止の経路は closeAudioContext が片付ける)。
   */
  async function closeStartedAudioPlayback(playback: AudioPlayback): Promise<void> {
    if (audioPlayback === playback) {
      audioPlayback = null;
    }
    if (playback.context.state === "closed") {
      // 停止側が先に閉じている。閉じる経路を 1 つに保つ (失敗の握り潰しに頼らない)
      return;
    }
    await playback.context.close().catch(() => {
      // 既に閉じている場合は無視する
    });
  }

  /**
   * 受信した音声を音声出力デバイスへ流す graph を作り、再生を始める
   *
   * `audioContext.destination` には繋がず、`MediaStreamAudioDestinationNode` の
   * トラックを `<audio>` の `srcObject` に設定する (ライブラリの
   * createMediaSubscriber と同じ構成)。トグルのクリックがユーザー操作になるため、
   * 自動再生ポリシー下でも `resume()` と `play()` が通る。
   *
   * 鳴らす先を再生の入口へ付けるのは呼び出し側である。`audioPlaybackEnabled` を立てる直前に
   * 付けることで、有効になる前に届いた音を捨てる今の扱いを変えない。
   *
   * 開始は AudioContext の生成・`resume()`・`<audio>` の `play()` をまたいで await する。
   * その途中で停止が始まるか新しい開始が始まることがあるため、各 await の後に対象が
   * 変わっていないかを確かめる。変わっていたら共有の `<audio>` は触らず、自分が作った
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
    const audioElement = deps.audioRef.current;
    if (audioElement) {
      audioElement.srcObject = playback.destination.stream;
      const outputDeviceId = deps.getSelectedAudioOutputDeviceId();
      if (outputDeviceId !== "") {
        await applyAudioOutputSink(audioElement, outputDeviceId);
        if (await abandonIfStale()) return null;
      }
      await audioElement.play();
      if (await abandonIfStale()) return null;
    }
    return playback;
  }

  /**
   * 音声出力を止め、`<audio>` からストリームを外す
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
        const audioElement = deps.audioRef.current;
        if (audioElement) {
          audioElement.pause();
          audioElement.srcObject = null;
        }
        if (playback !== null) {
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
    const audioElement = deps.audioRef.current;
    if (audioElement) {
      audioElement.pause();
      audioElement.srcObject = null;
    }
    if (playback !== null) {
      // 予約済みで鳴り始めていない音は、閉じると鳴らないまま切り捨てられる
      playout?.recordAudioStopped();
      playout?.resetAudioTimeline();
      // 鳴らす先を外したので、予約の基準・時計の対応・追いつきの観測を取り直す
      playout?.resetAudioPlayback();
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
      // await の間に停止が始まるか、停止の後に新しい開始が始まることがある。開始に使った
      // audio graph が今も対象かと停止中かで、今の再生として確定するかを決める。確定しない
      // ときは共有の `<audio>` を触らず、自分が作った Context だけを閉じる (停止の drain の
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
          deps.mediaPlayoutRef.current?.resetAudioPlayback();
          deps.restartAudioPlayoutCumulative();
          enabled.value = true;
          deps.playAudioEnabled.value = true;
        },
        discard: () => closeStartedAudioPlayback(started),
      });
    } catch (error) {
      // 停止や新しい開始に置き換えられていたら、この失敗は想定内である (停止の pause で
      // play() が中断される AbortError など)。ログにも状態にも出さず、作成済みの graph だけ
      // 後始末して戻る。共有の `<audio>` は触らない (新しい開始か停止が片付ける)
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
      void stopAudioPlayback();
      enabled.value = false;
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

  return {
    attachPlaybackToPlayout,
    hasPlayback,
    toggleAudioPlayback,
    stopAudioPlayback,
  };
}
