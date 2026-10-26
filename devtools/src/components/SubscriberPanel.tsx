import { useMemo, useRef, useEffect } from "preact/hooks";
import { useSignal, type ReadonlySignal } from "@preact/signals";
import type { ComponentChildren } from "preact";
import { useSubscriber } from "../hooks/useSubscriber";
import { AudioMeter } from "./AudioMeter";
import { VideoCard } from "./VideoCard";
import { HttpVersionBadge } from "./HttpVersionBadge";
import {
  EventLog,
  StatGroup,
  StatList,
  StatSection,
  StatTable,
  StatsCollapse,
  TimingTable,
} from "./StatsView";
import {
  AUDIO_PLAYOUT_CATCH_UP_HELP,
  AUDIO_PLAYOUT_MISSED_HELP,
  AUDIO_PLAYOUT_TIMING_HELP,
  AV_SYNC_HELP,
  DECODING_PIPELINE_HELP,
  LOSS_HELP,
  PLAYOUT_TIMING_CAPTION,
  PLAYOUT_TIMING_HELP,
  STALL_CAUSES_HELP,
  SUBSCRIBER_LATENCY_BREAKDOWN_HELP,
  SUBSCRIBER_WARNINGS_HELP,
  TOTAL_LATENCY_SEGMENT,
} from "./statsHelp";
import { formatBytes } from "../utils/logFormatters";
import { formatDbfsShort } from "../utils/audioLevel";
import { formatPreconditionWarning } from "../utils/preconditionWarnings";
import { CatalogTracks } from "./CatalogTracks";
import { MessageList } from "./MessageList";
import { PANEL_OPTION_CAPTION_CLASS, PANEL_OPTION_ROW_CLASS } from "./panelLayout";
import { formatLossEvent, formatStallEvent } from "../utils/playoutTimingStats";
import {
  AUDIO_MISS_REASONS,
  AUDIO_PLAYOUT_BOUNDARY_STEP_THRESHOLD,
  formatAudioMissEvent,
} from "../../../src/playout/audioPlayoutTimingStats.ts";
import { LATENCY_SEGMENTS } from "../utils/latencyBreakdown";
import { STALL_CAUSES } from "../utils/stallAnalysis";
import { subscriberControlState } from "../utils/subscriberControls";
import * as settings from "../signals/connectionSettings";
import { type SubscriberStats, buildSubscriberStats } from "../signals/statsSnapshot";
import { createStatsSignal, startStatsTick } from "../signals/statsTick";
import * as sub from "../signals/subscriber";

interface SubscriberPanelProps {
  subscriberId: string;
  onRemove?: () => void;
  canRemove?: boolean;
}

/** ミリ秒の値を表示用にする。まだ決まっていない値 (基準が未確立など) は "-" */
function formatMs(value: number | null): string {
  return value === null ? "-" : value.toFixed(1);
}

/**
 * Request New Group を押して送れた後、送ったことをボタンに出す時間 (ミリ秒)
 *
 * 押しても何も変わらないと、押せたのか、publisher が要求を無視したのかを切り分けられない。
 * 送れたことだけを一時的に出し、その後に元の表示へ戻す
 */
const NEW_GROUP_REQUEST_FEEDBACK_MS = 1500;

export function SubscriberPanel({
  subscriberId,
  onRemove,
  canRemove = false,
}: SubscriberPanelProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const { startSubscribing, stopSubscribing, requestNewGroup, toggleAudioPlayback } = useSubscriber(
    subscriberId,
    canvasRef,
    audioRef,
  );

  // Request New Group を押して送れた直後だけ、送ったことをボタンに出す。押しても何も
  // 変わらないと、押せたのか、publisher が要求を無視したのかを切り分けられない
  const newGroupRequested = useSignal(false);
  const newGroupRequestedTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    return () => {
      clearTimeout(newGroupRequestedTimerRef.current);
    };
  }, []);
  const onRequestNewGroup = async (): Promise<void> => {
    if (!(await requestNewGroup())) {
      return;
    }
    newGroupRequested.value = true;
    clearTimeout(newGroupRequestedTimerRef.current);
    newGroupRequestedTimerRef.current = setTimeout(() => {
      newGroupRequested.value = false;
    }, NEW_GROUP_REQUEST_FEEDBACK_MS);
  };

  // canvas の背景を slate-800 で初期化する
  useEffect(() => {
    if (canvasRef.current) {
      const ctx = canvasRef.current.getContext("2d");
      if (ctx) {
        ctx.fillStyle = "#1e293b";
        ctx.fillRect(0, 0, canvasRef.current.width, canvasRef.current.height);
      }
    }
  }, []);

  // subscriberInstances Map 全体ではなく、対象 ID 用の派生 signal だけを購読する。
  // ID が変わらない限り同じ ReadonlySignal を使い続ける。
  const instanceSignal = useMemo(
    () => sub.getSubscriberInstanceSignal(subscriberId),
    [subscriberId],
  );
  // 統計は 1 秒に 1 回だけまとめて読み直す (値の signal を直接読むと毎フレーム描き直す)。
  // フックは早期 return より前に呼び、購読が無い間は null を返す
  const statsSignal = useMemo(
    () =>
      createStatsSignal(() => {
        const current = sub.getSubscriber(subscriberId);
        return current === undefined ? null : buildSubscriberStats(current);
      }),
    [subscriberId],
  );
  useEffect(() => {
    startStatsTick();
  }, []);
  const instance = instanceSignal.value;
  if (!instance) {
    return null;
  }

  const status = instance.status.value;
  const catalog = instance.catalog.value;
  const codec = instance.codec.value;
  // 購読の確立を待っている間も購読中として扱い、Stop で止められるようにする
  const {
    active: isSubscribing,
    startDisabled: subscribeBtnDisabled,
    stopDisabled: stopBtnDisabled,
  } = subscriberControlState({
    subscribed: sub.hasEstablishedSubscription(instance),
    starting: instance.isStarting.value,
    stopping: instance.isStopping.value,
  });

  const getStatusClasses = () => {
    // 1 行に収める。長い文言で折り返すと、下の映像の位置が動く (全文は title に持つ)
    const base = "mb-4 px-4 py-2 rounded-lg text-sm truncate";
    if (status === "connected") {
      return `${base} bg-blue-50 text-blue-700`;
    }
    if (status === "error") {
      return `${base} bg-red-50 text-red-700`;
    }
    return `${base} bg-slate-100 text-slate-600`;
  };

  const getBadgeClasses = () => {
    const base = "px-2 py-1 text-xs font-medium rounded-full";
    if (status === "connected") {
      return `${base} bg-blue-400/30 text-white`;
    }
    if (status === "error") {
      return `${base} bg-red-400/30 text-white`;
    }
    return `${base} bg-white/20 text-white`;
  };

  const getBadgeText = () => {
    if (status === "connected") return "Connected";
    if (status === "error") return "Error";
    return "Ready";
  };

  return (
    <div class="bg-white rounded-xl shadow-sm overflow-hidden">
      <div class="bg-gradient-to-r from-blue-500 to-blue-600 px-5 py-3">
        <div class="flex items-center justify-between">
          <h2 class="text-lg font-semibold text-white flex items-center gap-2">
            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
                d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
              />
            </svg>
            Subscriber
            {instance.httpVersion.value !== null && (
              <HttpVersionBadge
                version={instance.httpVersion.value}
                testId="subscriber-http-version"
              />
            )}
          </h2>
          <div class="flex items-center gap-2">
            <span class={getBadgeClasses()}>{getBadgeText()}</span>
            {canRemove && (
              <button
                onClick={onRemove}
                disabled={isSubscribing}
                class="p-1 rounded hover:bg-white/20 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                title="Remove this subscriber"
              >
                <svg
                  class="w-5 h-5 text-white"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    stroke-width="2"
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
              </button>
            )}
          </div>
        </div>
      </div>

      <div class="p-5">
        {/* Status Message。接続の段階を示す。トラックの一覧は Catalog パネルが出す */}
        <div
          class={getStatusClasses()}
          title={instance.statusMessage.value}
          data-testid="subscriber-status-message"
        >
          {instance.statusMessage.value}
        </div>

        {/* Subscribe Options。Publisher の paused 状態の行と同じ高さの枠で描き、
            映像の上端をそろえる。項目の見出しは、その操作がどのメッセージで効くのか
            (SUBSCRIBE か REQUEST_UPDATE か) を表す */}
        <div class={PANEL_OPTION_ROW_CLASS} data-testid="subscriber-option-row">
          {/*
            NEW_GROUP_REQUEST。購読の開始時に送る SUBSCRIBE に載せる指定であり、
            購読中は変更できない (disabled={isSubscribing})。いつ効くのかが読み取れる
            よう、見出しに SUBSCRIBE を出す。REQUEST_UPDATE へ載せる要求は隣のボタンが
            行う (draft-ietf-moq-transport-22 §9.20.19)
          */}
          <label
            class={`flex flex-col gap-0.5 ${
              isSubscribing ? "cursor-not-allowed opacity-60" : "cursor-pointer"
            }`}
            title={
              "NEW_GROUP_REQUEST is sent in the SUBSCRIBE for the video track when subscribing " +
              "starts. It asks the publisher to start a new Group. It cannot be changed while " +
              "subscribing (draft-ietf-moq-transport-22 §9.20.19)"
            }
          >
            <span class={PANEL_OPTION_CAPTION_CLASS}>SUBSCRIBE</span>
            <span class="flex h-7 items-center gap-2">
              <input
                type="checkbox"
                data-testid="subscriber-new-group-request"
                checked={instance.newGroupRequestEnabled.value}
                onChange={(e) => {
                  instance.newGroupRequestEnabled.value = e.currentTarget.checked;
                }}
                disabled={isSubscribing}
                class="w-4 h-4 text-blue-600 border-slate-300 rounded focus:ring-blue-500 disabled:cursor-not-allowed"
              />
              <span class="text-sm text-slate-600">NEW_GROUP_REQUEST</span>
            </span>
          </label>
          {/*
            購読中の NEW_GROUP_REQUEST。REQUEST_UPDATE に載せて送る購読中の操作であり、
            購読の開始時に SUBSCRIBE へ載せる切り替えとは別の経路である。MOQT には
            キーフレームの要求というメッセージは無く、送るのは新しい Group の開始の要求で
            ある。見出しに REQUEST_UPDATE を出す。購読の開始前と、DYNAMIC_GROUPS=1 を
            広告しない Track では押せない (§9.20.19 の MUST NOT)。主要な操作の行
            (Start Subscribing / Stop) には置かない
          */}
          <span class="flex flex-col gap-0.5">
            <span class={PANEL_OPTION_CAPTION_CLASS}>REQUEST_UPDATE</span>
            <button
              onClick={() => void onRequestNewGroup()}
              disabled={
                instance.subscriber.value === null || !instance.dynamicGroupsSupported.value
              }
              data-testid="subscriber-request-new-group"
              class={`w-40 h-7 px-3 shrink-0 text-xs disabled:bg-slate-300 disabled:cursor-not-allowed text-white font-medium rounded-lg transition-colors flex items-center justify-center gap-1.5 ${
                newGroupRequested.value ? "bg-green-500" : "bg-purple-500 hover:bg-purple-600"
              }`}
              title={
                newGroupRequested.value
                  ? "Sent the request. Waiting for the publisher to start a new Group"
                  : instance.subscriber.value === null
                    ? "Subscribe before requesting a new Group"
                    : instance.dynamicGroupsSupported.value
                      ? "Send a REQUEST_UPDATE with NEW_GROUP_REQUEST to ask the publisher to start a new Group. For video, the new Group starts with a keyframe"
                      : "Not available: the track did not include DYNAMIC_GROUPS=1 (draft-ietf-moq-transport-22 §9.20.19)"
              }
            >
              {newGroupRequested.value ? (
                // 送った直後は、送信済みを表すチェックにする
                <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    stroke-width="2"
                    d="M4.5 12.75l6 6 9-13.5"
                  />
                </svg>
              ) : (
                <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    stroke-width="2"
                    d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                  />
                </svg>
              )}
              {newGroupRequested.value ? "Sent" : "NEW_GROUP_REQUEST"}
            </button>
          </span>
        </div>

        {/* Buttons */}
        <div class="flex gap-3 mb-4">
          {/*
            受信した音声の再生。既定では再生しない。相互運用の実測で毎回音が出ると
            邪魔になるため、明示的に有効にしたときだけ音声出力デバイスへ繋ぐ。
            購読の前も購読中も切り替えられる。主要な操作 (Start Subscribing / Stop) の
            隣にトグルボタンとして置く。チェックボックスは設定の有無しか表せず、
            再生中かどうかと、押すと何が起きるのかが読み取りにくいため、押すと
            「Play Audio」から「Stop Audio」へ変わり、色でも状態が分かるようにする。
            停止の drain の間は、AudioContext を閉じる途中であり開始の結果も確定しない
            ため押せないようにする
          */}
          <button
            type="button"
            data-testid="subscriber-audio-playback-toggle"
            disabled={instance.isStopping.value}
            aria-pressed={instance.audioPlaybackEnabled.value}
            onClick={() => void toggleAudioPlayback()}
            title={
              instance.audioPlaybackEnabled.value
                ? "Stop playing the audio received from the subscribed track"
                : "Play the audio received from the subscribed track on this device. " +
                  "Video waits for the audio buffer to keep playback synchronized. " +
                  "It can be enabled before subscribing; the sound starts when audio arrives"
            }
            class={`w-32 py-2.5 shrink-0 font-medium rounded-lg transition-colors flex items-center justify-center gap-2 disabled:bg-slate-300 disabled:cursor-not-allowed ${
              instance.audioPlaybackEnabled.value
                ? "bg-red-500 hover:bg-red-600 text-white"
                : "bg-slate-500 hover:bg-slate-600 text-white"
            }`}
          >
            {instance.audioPlaybackEnabled.value ? (
              // 停止の状態は、音が出ないことを表すスピーカー (×付き) にする
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  stroke-width="2"
                  d="M17.25 9.75L19.5 12m0 0l2.25 2.25M19.5 12l2.25-2.25M19.5 12l-2.25 2.25m-10.5-6l4.72-4.72a.75.75 0 011.28.53v15.88a.75.75 0 01-1.28.53l-4.72-4.72H4.51c-.88 0-1.704-.507-1.938-1.354A9.01 9.01 0 012.25 12c0-.83.112-1.633.322-2.396C2.806 8.756 3.63 8.25 4.51 8.25H6.75z"
                />
              </svg>
            ) : (
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  stroke-width="2"
                  d="M19.114 5.636a9 9 0 010 12.728M16.463 8.288a5.25 5.25 0 010 7.424M6.75 8.25l4.72-4.72a.75.75 0 011.28.53v15.88a.75.75 0 01-1.28.53l-4.72-4.72H4.51c-.88 0-1.704-.507-1.938-1.354A9.01 9.01 0 012.25 12c0-.83.112-1.633.322-2.396C2.806 8.756 3.63 8.25 4.51 8.25H6.75z"
                />
              </svg>
            )}
            {instance.audioPlaybackEnabled.value ? "Stop Audio" : "Play Audio"}
          </button>
          <button
            onClick={() => void startSubscribing()}
            disabled={subscribeBtnDisabled}
            data-testid="subscriber-subscribe-button"
            class="flex-1 px-4 py-2.5 bg-blue-500 hover:bg-blue-600 disabled:bg-slate-300 disabled:cursor-not-allowed text-white font-medium rounded-lg transition-colors flex items-center justify-center gap-2"
          >
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
                d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
              />
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
                d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"
              />
            </svg>
            Start Subscribing
          </button>
          <button
            onClick={() => void stopSubscribing()}
            disabled={stopBtnDisabled}
            data-testid="subscriber-stop-button"
            class="px-4 py-2.5 bg-red-500 hover:bg-red-600 disabled:bg-slate-300 disabled:cursor-not-allowed text-white font-medium rounded-lg transition-colors"
          >
            Stop
          </button>
        </div>

        {/* Catalog。catalog を受け取る前も描き、値を「-」にする */}
        <CatalogTracks
          tracks={catalog?.tracks ?? []}
          trackNamespace={settings.namespaceArray.value}
          tone="blue"
          testId="subscriber-catalog"
        />

        {/* 受信した音声のレベルメーターと波形。音声トラックを購読していない間も描き、
            値を「-」にする (購読の開始でメーターが現れると下の項目の位置が動く) */}
        <AudioMeter
          peakDbfsLeft={instance.audioPeakDbfsLeft}
          peakDbfsRight={instance.audioPeakDbfsRight}
          rmsDbfsLeft={instance.audioRmsDbfsLeft}
          rmsDbfsRight={instance.audioRmsDbfsRight}
          level={instance.audioLastLevel}
          waveformLeft={instance.audioWaveformLeft}
          waveformRight={instance.audioWaveformRight}
          active={instance.audioSubscriber.value !== null}
          levelActive={instance.audioSubscriber.value !== null}
          testIdPrefix="audio"
        />

        {/* 受信した音声の再生先。表示せず、srcObject の設定先としてだけ使う */}
        <audio ref={audioRef} data-testid="subscriber-audio-element" class="hidden" />

        {/* Video。Audio と同じ枠で囲み、映像からは読み取れない値 (表示 fps、受信から
            表示までと復号の遅延、捨てたフレーム数) をヘッダーに出す */}
        <SubscriberVideoCard
          subscriberId={subscriberId}
          statsSignal={statsSignal}
          subscriberActive={instance.subscriber.value !== null}
        >
          <canvas
            ref={canvasRef}
            data-testid="subscriber-video-canvas"
            width="1280"
            height="720"
            class="w-full h-full object-contain"
          />
          <div class="absolute top-2 left-2 px-2 py-1 bg-black/60 rounded text-xs text-white font-medium">
            Remote Stream
          </div>
          {/* 購読の開始に relay の cache から追いつくまでの間、古いフレームは描かない */}
          <div class="absolute top-2 right-2 flex items-center gap-2">
            {instance.catchUpPending.value && (
              <div
                data-testid="subscriber-catching-up"
                class="px-2 py-1 bg-amber-500/80 rounded text-xs text-white font-medium"
              >
                Catching up
              </div>
            )}
            {codec && (
              <div class="px-2 py-1 bg-blue-500/80 rounded text-xs text-white font-medium">
                {codec}
              </div>
            )}
          </div>
        </SubscriberVideoCard>

        {/* 受信した event timeline のメッセージ。audio / video 以外のデータ */}
        <MessageList entries={instance.eventMessages.value} testId="subscriber-messages" />

        {/* Statistics。既定で閉じ、「Statistics」を押すと開く。Audio / Video /
            Messages (event timeline) の種類ごとに分ける (audio → video の順) */}
        <StatsCollapse testId="subscriber-statistics">
          <SubscriberStats statsSignal={statsSignal} />
        </StatsCollapse>
      </div>
    </div>
  );
}

/** 統計。1 秒ごとにまとめて読み直したスナップショットを描く */
function SubscriberStats({ statsSignal }: { statsSignal: ReadonlySignal<SubscriberStats | null> }) {
  const stats = statsSignal.value;
  if (stats === null) {
    return null;
  }
  return (
    <>
      <StatGroup title="Audio">
        <StatSection title="Reception">
          <StatList
            items={[
              { label: "objects", value: stats.audio.objectsReceived },
              {
                label: "datagramObjects",
                value: stats.audio.datagramObjectsReceived,
                testId: "subscriber-audio-datagram-objects",
              },
              { label: "chunksDecoded", value: stats.audio.chunksDecoded },
              {
                // 受信した壁時計 - LOC TIMESTAMP。配信側の送信の遅れ (audio.catchUp.sendLagMs)
                // と対で読み、遅れが配信側にあるのか relay と経路にあるのかを分ける
                label: "receiveDelayMs",
                value: formatMs(stats.audio.receiveDelayMs),
                testId: "subscriber-audio-receive-delay",
              },
              {
                // 到着の遅れの最大。停止 (longtask) の計器と並べて読む
                label: "maxReceiveDelayMs",
                value: formatMs(stats.audio.maxReceiveDelayMs),
                testId: "subscriber-audio-max-receive-delay",
              },
              {
                // relay の cache から追いつくまでに鳴らさなかった音声 Object の数
                label: "catchUpObjectsSkipped",
                value: stats.audio.catchUpObjectsSkipped,
                tone: "warn",
                testId: "subscriber-audio-catch-up-objects-skipped",
              },
              {
                // datagram の冗長化などで同じ Object を 2 回以上受け取り、復号へ渡さず
                // 捨てた数。配信側の冗長度が経路上で効いているかを確かめる
                label: "duplicateObjectsDropped",
                value: stats.audio.duplicateObjectsDropped,
                testId: "subscriber-audio-duplicate-objects-dropped",
              },
              {
                // 受信した Object の Location が、同じ購読で受信済みの最大 Location より
                // 小さかった数。Group が異なる Object の順序は保証されないため
                // (draft-ietf-moq-transport-22 §2.3.1)、順序逆転が起きているかを直接測る。
                // relay の cache から replay された Object は数えない
                label: "outOfOrderObjectsReceived",
                value: stats.audio.outOfOrderObjectsReceived,
                tone: "warn",
                testId: "subscriber-audio-out-of-order-objects-received",
              },
              {
                // 順序逆転した Object が、受信済みの最大 Group から何 Group 戻っていたかの
                // 最大値。音声は 1 Object = 1 Group なので戻り幅の目安になる
                // (moqt-js の Opus では 1 Object = 20 ms、AAC では約 21.3 ms)
                label: "maxOutOfOrderGroupDistance",
                value: stats.audio.maxOutOfOrderGroupDistance,
                tone: "warn",
                testId: "subscriber-audio-max-out-of-order-group-distance",
              },
            ]}
          />
        </StatSection>

        <StatSection title="Playout">
          <StatList
            items={[
              {
                label: "decoderConfigured",
                value: String(stats.audio.decoderConfigured),
              },
              {
                label: "playbackEnabled",
                value: String(stats.audio.playbackEnabled),
              },
              {
                label: "playoutRebases",
                value: stats.audio.playoutRebases,
                tone: "warn",
              },
              {
                label: "playoutDrops",
                value: stats.audio.playoutDrops,
                tone: "warn",
              },
              {
                label: "playoutCompressedMs",
                value: Math.round(stats.audio.playoutCompressedMs),
                tone: "warn",
              },
              {
                label: "playoutConcealedMs",
                value: Math.round(stats.audio.playoutConcealedMs),
                tone: "warn",
              },
              {
                label: "playoutConcealments",
                value: stats.audio.playoutConcealments,
              },
            ]}
          />
        </StatSection>

        <StatSection title="Meter">
          <StatList
            items={[
              { label: "peakDbfs", value: formatDbfsShort(stats.audio.peakDbfs) },
              { label: "rmsDbfs", value: formatDbfsShort(stats.audio.rmsDbfs) },
              {
                label: "peakDbfsRight",
                value: formatDbfsShort(stats.audio.peakDbfsRight),
              },
              {
                label: "rmsDbfsRight",
                value: formatDbfsShort(stats.audio.rmsDbfsRight),
              },
              { label: "lastLevel", value: stats.audio.lastLevel ?? "-" },
              {
                label: "lastVoiceActivity",
                value:
                  stats.audio.lastVoiceActivity === null
                    ? "-"
                    : String(stats.audio.lastVoiceActivity),
              },
            ]}
          />
        </StatSection>
      </StatGroup>

      {/* 音声が鳴るはずの時刻と実際に鳴り始める時刻、鳴らなかった量。音声の語尾が
          聞こえないとき、再生予定に間に合わなかったのか、それとも別の段なのかを
          数値で切り分けるために出す。audio → video の順を守り、Video より前に置く */}
      <StatGroup title="Audio Playback">
        <StatSection
          title="Timing"
          help={AUDIO_PLAYOUT_TIMING_HELP}
          testId="subscriber-audio-playback-timing"
        >
          <TimingTable
            caption={PLAYOUT_TIMING_CAPTION}
            testId="subscriber-audio-playback-timing"
            rows={[
              {
                // 予定に対する余裕。負なら届いた時点で予定を過ぎている
                label: "slack",
                summary: stats.audio.playoutTiming.slackMs,
                testId: "subscriber-audio-playback-slack",
              },
              {
                label: "startDelay",
                summary: stats.audio.playoutTiming.startDelayMs,
                testId: "subscriber-audio-playback-start-delay",
              },
              {
                // 予定からどれだけ遅れて鳴るか。0 なら予定どおり
                label: "lateness",
                summary: stats.audio.playoutTiming.latenessMs,
                testId: "subscriber-audio-playback-lateness",
              },
            ]}
          />
          <StatList
            items={[
              {
                label: "lastTargetMs",
                value: formatMs(stats.audio.playoutTiming.lastTargetMs),
                testId: "subscriber-audio-playback-last-target",
              },
              {
                label: "lastArrivalMs",
                value: formatMs(stats.audio.playoutTiming.lastArrivalMs),
                testId: "subscriber-audio-playback-last-arrival",
              },
              {
                label: "lastStartMs",
                value: formatMs(stats.audio.playoutTiming.lastStartMs),
                testId: "subscriber-audio-playback-last-start",
              },
              {
                label: "lastSlackMs",
                value: formatMs(stats.audio.playoutTiming.lastSlackMs),
                testId: "subscriber-audio-playback-last-slack",
              },
              {
                label: "playedFrames",
                value: stats.audio.playoutTiming.playedFrames,
                testId: "subscriber-audio-playback-played-frames",
              },
              {
                label: "playedMs",
                value: Math.round(stats.audio.playoutTiming.playedMs),
                testId: "subscriber-audio-playback-played-ms",
              },
              {
                // 時間軸の予定を使えず、到着基準の計画で鳴らした音 (TIMESTAMP がずれているなど)
                label: "arrivalPlannedFrames",
                value: stats.audio.playoutTiming.arrivalPlannedFrames,
                testId: "subscriber-audio-playback-arrival-planned-frames",
              },
              {
                // 到着基準の計画も持たないまま鳴らした音。通常は 0
                label: "unplannedFrames",
                value: stats.audio.playoutTiming.unplannedFrames,
                testId: "subscriber-audio-playback-unplanned-frames",
              },
              {
                // 時間圧縮と補間を使えないサンプルレート (4 kHz へ間引く表に無い 44.1 kHz など)
                // で鳴らした音。0 なら使えている。増えていると、遅れが目標へ戻らない原因が
                // これであると分かる
                label: "stretchUnavailableFrames",
                value: stats.audio.playoutTiming.stretchUnavailableFrames,
                testId: "subscriber-audio-playback-stretch-unavailable-frames",
              },
            ]}
          />
          {/* 補間で埋まらなかった無音の穴、予約の追い越しと押し直し、バッファ境界の段差。
              「プチプチ」の原因が無音の穴なのか、段差なのか、予約の遅れなのかを分ける。
              すべて購読の開始からの累積である (docs/AUDIO_PLAYOUT_GAPS_AND_TAIL.md) */}
          <StatList
            items={[
              {
                // 補間で埋まらなかった穴の回数と長さ。長い途絶も 1 回の穴として入る
                label: "gapCount",
                value: stats.audio.playoutTiming.gapCount,
                tone: "warn",
                testId: "subscriber-audio-playback-gap-count",
              },
              {
                label: "gapMs",
                value: Math.round(stats.audio.playoutTiming.gapMs),
                tone: "warn",
                testId: "subscriber-audio-playback-gap-ms",
              },
              {
                label: "gapMaxMs",
                value: Math.round(stats.audio.playoutTiming.gapMaxMs),
                tone: "warn",
                testId: "subscriber-audio-playback-gap-max-ms",
              },
              {
                // 予約できる最も早い時刻 (今 + 余裕) より前だった穴。事後には埋められない
                label: "unrecoverableGapCount",
                value: stats.audio.playoutTiming.unrecoverableGapCount,
                tone: "warn",
                testId: "subscriber-audio-playback-unrecoverable-gap-count",
              },
              {
                label: "unrecoverableGapMs",
                value: Math.round(stats.audio.playoutTiming.unrecoverableGapMs),
                tone: "warn",
                testId: "subscriber-audio-playback-unrecoverable-gap-ms",
              },
              {
                // 予約した時刻を currentTime が追い越した回数。0 より大きいことは、
                // 予約の処理の間にメインスレッドが遅れた証拠である
                label: "lateStartCount",
                value: stats.audio.playoutTiming.lateStartCount,
                tone: "warn",
                testId: "subscriber-audio-playback-late-start-count",
              },
              {
                label: "lateStartMaxMs",
                value: formatMs(stats.audio.playoutTiming.lateStartMaxMs),
                testId: "subscriber-audio-playback-late-start-max",
              },
              {
                // 予約時刻を currentTime + 余裕へ押し直した回数 (追い越しの有無を問わない)
                label: "pushStartCount",
                value: stats.audio.playoutTiming.pushStartCount,
                tone: "warn",
                testId: "subscriber-audio-playback-push-start-count",
              },
              {
                label: "pushStartMaxMs",
                value: formatMs(stats.audio.playoutTiming.pushStartMaxMs),
                testId: "subscriber-audio-playback-push-start-max",
              },
              {
                // バッファ境界の段差がしきい値を超えた回数。無音の前後と media 時刻の飛び、
                // 通常の音の切れ目を含む
                label: "boundaryStepCount",
                value: stats.audio.playoutTiming.boundaryStepCount,
                tone: "warn",
                testId: "subscriber-audio-playback-boundary-step-count",
              },
              {
                // 段差の最大 (0 から 1 の振幅)。しきい値 (440 Hz トーンの正常な差分の約 3 倍)
                // を超えたときだけ色をつける
                label: "boundaryStepMax",
                value: Number(stats.audio.playoutTiming.boundaryStepMax.toFixed(3)),
                tone:
                  stats.audio.playoutTiming.boundaryStepMax > AUDIO_PLAYOUT_BOUNDARY_STEP_THRESHOLD
                    ? "warn"
                    : undefined,
                testId: "subscriber-audio-playback-boundary-step-max",
              },
              {
                // 直近の停止で予約済みの音を鳴らし切った量
                label: "drainPlayedMs",
                value: formatMs(stats.audio.playoutTiming.lastDrain?.playedMs ?? null),
                testId: "subscriber-audio-playback-drain-played-ms",
              },
              {
                // 停止で上限まで待っても鳴らせずに切った量
                label: "drainCutMs",
                value:
                  stats.audio.playoutTiming.lastDrain === null
                    ? "-"
                    : Math.round(stats.audio.playoutTiming.lastDrain.cutMs),
                tone: "warn",
                testId: "subscriber-audio-playback-drain-cut-ms",
              },
              {
                label: "drainWaitedMs",
                value: formatMs(stats.audio.playoutTiming.lastDrain?.waitedMs ?? null),
                testId: "subscriber-audio-playback-drain-waited-ms",
              },
              {
                label: "drainRequestedMs",
                value: formatMs(stats.audio.playoutTiming.lastDrain?.requestedMs ?? null),
                testId: "subscriber-audio-playback-drain-requested-ms",
              },
            ]}
          />
          {/* 目標遅延の閉ループが広げた上限と、直近 1 秒に詰めた長さ。圧縮が続くと声が
              粗くなるため、上限へ張り付いているかを併せて読む
              (src/playout/audioDelayFeedback.ts) */}
          <StatList
            items={[
              {
                // 実際に使う目標遅延。揺らぎだけから求めた値 (jitterTargetMs) と閉ループの
                // 目標の大きい方を上限で切った値
                label: "appliedMs",
                value: formatMs(stats.audio.audioDelayFeedback.appliedMs),
                testId: "subscriber-audio-playback-applied-ms",
              },
              {
                // 揺らぎだけから求めた目標遅延 (NetEq の移植)
                label: "jitterTargetMs",
                value: formatMs(stats.audio.audioDelayFeedback.jitterTargetMs),
                testId: "subscriber-audio-playback-jitter-target-ms",
              },
              {
                // 直前に目標を動かした理由 (initial / compression / gap / backlog など)
                label: "delayReason",
                value: stats.audio.audioDelayFeedback.reason,
                testId: "subscriber-audio-playback-delay-reason",
              },
              {
                label: "appliedCeilingMs",
                value: formatMs(stats.audio.appliedCeilingMs),
                testId: "subscriber-audio-playback-applied-ceiling",
              },
              {
                // 0 より大きい間は時間圧縮が続いている
                label: "compressionMsPerSecond",
                value: Number(stats.audio.compressionMsPerSecond.toFixed(1)),
                tone: "warn",
                testId: "subscriber-audio-playback-compression-ms-per-second",
              },
            ]}
          />
          {/* メインスレッドの停止 (longtask) の計器。音声の到着の遅れ (receiveDelayMs) には、
              経路と relay の遅れだけでなく、同じページのメインスレッドが止まっていた分も
              混ざる。停止の回数と長さ、停止の間に待たされた到着の数を並べて出す */}
          <StatList
            items={[
              {
                // 直近の窓で観測した longtask の回数
                label: "stallCount",
                value: stats.audio.hostDelay.stallCount,
                tone: "warn",
                testId: "subscriber-audio-host-stall-count",
              },
              {
                // 直近の窓で観測した停止の合計
                label: "stallMs",
                value: Math.round(stats.audio.hostDelay.stallMs),
                tone: "warn",
                testId: "subscriber-audio-host-stall-ms",
              },
              {
                // 直前の到着から今回の到着までの間隔が停止区間と重なった数。
                // 止まっている間は到着のコールバックが動かないため、停止の直後に
                // 観測された到着がここに入る
                label: "overlappedArrivals",
                value: stats.audio.hostDelay.overlappedArrivalCount,
                tone: "warn",
                testId: "subscriber-audio-host-overlapped-arrivals",
              },
            ]}
          />
        </StatSection>

        <StatSection
          title="Catch-up"
          help={AUDIO_PLAYOUT_CATCH_UP_HELP}
          testId="subscriber-audio-playback-catch-up"
        >
          {/* 復号の出力が送られた TIMESTAMP から遅れ続けたときに、復号器を作り直して
              live へ戻した量。鳴らす音は捨てず、復号器の中に溜まった分を捨てる
              (src/playout/audioReceiveCatchUp.ts) */}
          <StatList
            items={[
              {
                // 判定に使う「復号が足している遅れ」。復号の出力の遅れ (lagMs) から、
                // 受信の入口の入力の遅れと、意図した復号前の遅延を引いた値である。
                // 追いつきを始めるかはこの値と limitMs の比較で決まる
                label: "decodeLagMs",
                value: formatMs(stats.audio.playoutCatchUp.decodeLagMs),
                testId: "subscriber-audio-playback-catch-up-decode-lag",
              },
              {
                // 復号が足している遅れの上限。床 (健全時の遅れ) + 40 ms と 60 ms の大きい方
                label: "limitMs",
                value: stats.audio.playoutCatchUp.limitMs.toFixed(1),
                testId: "subscriber-audio-playback-catch-up-limit",
              },
              {
                // 直近に観測した、復号の出力の遅れそのもの。判定には使わず、入力の遅れを
                // 含む生の値を参考として残す
                label: "lagMs",
                value: formatMs(stats.audio.playoutCatchUp.lagMs),
                testId: "subscriber-audio-playback-catch-up-lag",
              },
              {
                // 健全時の遅れ (直近の窓の最小値)。環境ごとの値であり、これとの差で判定する
                label: "floorMs",
                value: formatMs(stats.audio.playoutCatchUp.floorMs),
                testId: "subscriber-audio-playback-catch-up-floor",
              },
              {
                label: "maxLagMs",
                value: formatMs(stats.audio.playoutCatchUp.maxLagMs),
                testId: "subscriber-audio-playback-catch-up-max-lag",
              },
              {
                label: "catchingUp",
                value: String(stats.audio.playoutCatchUp.catchingUp),
                tone: stats.audio.playoutCatchUp.catchingUp ? ("warn" as const) : undefined,
                testId: "subscriber-audio-playback-catch-up-active",
              },
              {
                label: "catchUpStarts",
                value: stats.audio.playoutCatchUp.catchUpStarts,
                tone: "warn",
                testId: "subscriber-audio-playback-catch-up-starts",
              },
              {
                // 追いつきで飛んだ音。復号器が捨てた分であり、鳴らなかった音 (Missed) とは別に数える
                label: "skippedFrames",
                value: stats.audio.playoutCatchUp.skippedFrames,
                testId: "subscriber-audio-playback-catch-up-skipped-frames",
              },
              {
                label: "skippedMs",
                value: stats.audio.playoutCatchUp.skippedMs.toFixed(1),
                testId: "subscriber-audio-playback-catch-up-skipped-ms",
              },
              {
                label: "lastSkippedMs",
                value: formatMs(stats.audio.playoutCatchUp.lastSkippedMs),
                testId: "subscriber-audio-playback-catch-up-last-skipped",
              },
            ]}
          />
        </StatSection>

        <StatSection
          title="Missed"
          help={AUDIO_PLAYOUT_MISSED_HELP}
          testId="subscriber-audio-playback-missed"
        >
          <StatTable
            caption="since start"
            columns={["count", "ms"]}
            testId="subscriber-audio-playback-missed"
            rows={[
              ...AUDIO_MISS_REASONS.map((reason) => {
                const total = stats.audio.playoutTiming.missedByReason[reason];
                return {
                  label: reason,
                  values: [String(total.count), String(Math.round(total.ms))],
                  testId: `subscriber-audio-playback-missed-${reason}`,
                  // 起きた理由だけを目立たせる (catchUp は追いつき中の意図的なもの)
                  tone: total.count > 0 ? ("warn" as const) : undefined,
                };
              }),
              // 理由ごとの和は、鳴らさなかった音の数と長さの合計に一致する
              {
                label: "total",
                values: [
                  String(stats.audio.playoutTiming.missedFrames),
                  String(Math.round(stats.audio.playoutTiming.missedMs)),
                ],
                testId: "subscriber-audio-playback-missed-total",
                total: true,
              },
            ]}
          />
          <EventLog
            label="recentMisses"
            hint="UTC, newest first"
            lines={[...stats.audio.playoutTiming.recentMisses]
              .reverse()
              .map((miss) => formatAudioMissEvent(miss))}
            testId="subscriber-audio-playback-recent-misses"
          />
        </StatSection>
      </StatGroup>

      <StatGroup title="Video">
        <StatSection title="Reception">
          <StatList
            items={[
              { label: "objects", value: stats.objectsReceived },
              { label: "withExtensions", value: stats.objectsWithExtensions },
              { label: "bytes", value: formatBytes(stats.bytesReceived) },
            ]}
          />
        </StatSection>

        <StatSection
          title="Decoding"
          help={DECODING_PIPELINE_HELP}
          testId="subscriber-decoding-pipeline"
        >
          <StatList
            items={[
              { label: "chunksCreated", value: stats.chunksCreated },
              { label: "chunksDecoded", value: stats.chunksDecoded },
              { label: "chunksSkipped", value: stats.chunksSkipped, tone: "warn" },
              {
                label: "staleFramesDropped",
                value: stats.staleFramesDropped,
                tone: "warn",
              },
              {
                label: "missingReferenceFramesDropped",
                value: stats.missingReferenceFramesDropped,
                tone: "warn",
              },
              { label: "decodeErrors", value: stats.decodeErrors, tone: "error" },
            ]}
          />
        </StatSection>

        <StatSection title="Output">
          <StatList
            items={[
              { label: "framesDecoded", value: stats.framesDecoded },
              {
                // relay の cache から追いつくまでに描かなかったフレームの数
                label: "catchUpFramesSkipped",
                value: stats.catchUpFramesSkipped,
                tone: "warn",
                testId: "subscriber-catch-up-frames-skipped",
              },
              { label: "keyFrames", value: stats.keyFramesDecoded },
              { label: "currentGroup", value: stats.currentGroup },
              { label: "currentSubGroup", value: stats.currentSubGroup },
              { label: "decoderState", value: stats.decoderState },
            ]}
          />
        </StatSection>

        <StatSection
          title="Playback Timing"
          help={PLAYOUT_TIMING_HELP}
          testId="subscriber-playback-timing"
        >
          <TimingTable
            caption={PLAYOUT_TIMING_CAPTION}
            rows={[
              {
                label: "arrivalJitter",
                summary: stats.playoutTiming.arrivalJitterMs,
                testId: "subscriber-arrival-jitter",
              },
              {
                label: "latency",
                summary: stats.playoutTiming.latencyMs,
                testId: "subscriber-latency",
              },
              {
                label: "decodeTime",
                summary: stats.playoutTiming.decodeTimeMs,
                testId: "subscriber-decode-time",
              },
              {
                label: "displayInterval",
                summary: stats.playoutTiming.displayIntervalMs,
                testId: "subscriber-display-interval",
              },
            ]}
          />
          <StatList
            items={[
              {
                label: "displayFps",
                value: stats.playoutTiming.displayFps,
                testId: "subscriber-display-fps",
              },
              {
                label: "displayStalls",
                value: stats.playoutTiming.displayStalls,
                tone: "warn",
                testId: "subscriber-display-stalls",
              },
              {
                label: "displayStallMs",
                value: Math.round(stats.playoutTiming.displayStallMs),
                tone: "warn",
                testId: "subscriber-display-stall-ms",
              },
              {
                label: "displayQueueDrops",
                value: stats.playoutTiming.displayQueueDrops,
                tone: "warn",
                testId: "subscriber-display-queue-drops",
              },
              {
                label: "playoutDelayMs",
                value:
                  stats.playoutTiming.playoutDelayMs === null
                    ? "-"
                    : stats.playoutTiming.playoutDelayMs.toFixed(1),
                testId: "subscriber-playout-delay",
              },
              {
                label: "lateFramesDropped",
                value: stats.playoutTiming.lateFramesDropped,
                tone: "warn",
                testId: "subscriber-late-frames-dropped",
              },
            ]}
          />
        </StatSection>

        <StatSection
          title="Latency Breakdown"
          help={SUBSCRIBER_LATENCY_BREAKDOWN_HELP}
          testId="subscriber-latency-breakdown"
        >
          <TimingTable
            caption={PLAYOUT_TIMING_CAPTION}
            testId="subscriber-latency-breakdown"
            rows={LATENCY_SEGMENTS.map((segment) => ({
              label: segment,
              summary: stats.playoutTiming.latencyBreakdown[segment],
              testId: `subscriber-latency-breakdown-${segment}`,
              // 表示の遅延はほかの区間の和のため、合計の行として区切る
              total: segment === TOTAL_LATENCY_SEGMENT,
            }))}
          />
        </StatSection>

        <StatSection title="Stall Causes" help={STALL_CAUSES_HELP} testId="subscriber-stall-causes">
          <StatTable
            caption="since start"
            columns={["count", "ms"]}
            testId="subscriber-stall-causes"
            rows={[
              ...STALL_CAUSES.map((cause) => {
                const total = stats.playoutTiming.stallCauses[cause];
                return {
                  label: cause,
                  values: [String(total.count), String(Math.round(total.ms))],
                  testId: `subscriber-stall-cause-${cause}`,
                  // 起きた原因だけを目立たせる
                  tone: total.count > 0 ? ("warn" as const) : undefined,
                };
              }),
              // 原因ごとの和は止まりの回数と時間に一致する
              {
                label: "total",
                values: [
                  String(stats.playoutTiming.displayStalls),
                  String(Math.round(stats.playoutTiming.displayStallMs)),
                ],
                testId: "subscriber-stall-cause-total",
                total: true,
              },
            ]}
          />
          <EventLog
            label="recentStalls"
            hint="UTC, newest first"
            lines={[...stats.playoutTiming.recentStalls]
              .reverse()
              .map((stall) => formatStallEvent(stall))}
            testId="subscriber-recent-stalls"
          />
        </StatSection>

        <StatSection title="Loss" help={LOSS_HELP} testId="subscriber-loss">
          <StatList
            items={[
              {
                label: "missingObjects",
                value: stats.playoutTiming.missingObjects,
                tone: "error",
                testId: "subscriber-missing-objects",
              },
              {
                label: "missingGroups",
                value: stats.playoutTiming.missingGroups,
                tone: "error",
                testId: "subscriber-missing-groups",
              },
              {
                label: "subgroupStreamResets",
                value: stats.playoutTiming.subgroupStreamResets,
                tone: "error",
                testId: "subscriber-subgroup-stream-resets",
              },
              {
                label: "groupSwitchHoldExpirations",
                value: stats.playoutTiming.groupSwitchHoldExpirations,
                tone: "warn",
                testId: "subscriber-group-switch-hold-expirations",
              },
            ]}
          />
          <EventLog
            label="subgroupStreamResetsByCode"
            hint="count per error code"
            showCount={false}
            lines={Object.entries(stats.playoutTiming.subgroupStreamResetsByCode).map(
              ([code, count]) => `${code}: ${count}`,
            )}
            testId="subscriber-subgroup-stream-resets-by-code"
          />
          <EventLog
            label="recentLossEvents"
            hint="UTC, newest first"
            lines={[...stats.playoutTiming.recentLossEvents]
              .reverse()
              .map((lossEvent) => formatLossEvent(lossEvent))}
            testId="subscriber-recent-loss-events"
          />
        </StatSection>

        <StatSection title="Largest Location">
          <StatList
            items={[
              {
                label: "largestGroup",
                value: stats.largestLocation?.group ?? "-",
              },
              {
                label: "largestObject",
                value: stats.largestLocation?.object ?? "-",
              },
            ]}
          />
        </StatSection>
      </StatGroup>

      <StatGroup title="Messages">
        <StatSection title="Reception">
          <StatList
            items={[
              { label: "objects", value: stats.event.objectsReceived },
              {
                // 表示している履歴の件数。event timeline は Group の先頭 Object に
                // その時点の履歴を載せるため、受信した Object の数とは別
                label: "entries",
                value: stats.event.entries,
                testId: "subscriber-message-entries",
              },
            ]}
          />
        </StatSection>
      </StatGroup>

      {/* 音声と映像の同期の推定値と、遅延の内訳。値の意味はライブラリの AvSyncStats と
              同じで、未購読や jitter buffer が無効のときは既定値 (null / 0 / false) になる。
              内訳は、表示の遅れがどこで生じているか (基準の遅れ・jitter buffer の遅延・
              同期の制御が足した分) と、2 つのトラックを同じ時計として扱えているかを
              分けて出す。音声と映像の遅れを比べて改善するために要る */}
      <StatGroup title="A/V Sync">
        {/* 前提から外れた状態 (合わせる量の上限に張り付いたまま、共有の解除の保持が続く)。
            外れていなければ "-" を出す。値は既にある計器から組み立てる */}
        <StatSection title="Warnings" help={SUBSCRIBER_WARNINGS_HELP} testId="subscriber-warnings">
          <EventLog
            label="broken preconditions"
            hint="checked every 1 s"
            lines={stats.warnings.map((warning) => formatPreconditionWarning(warning))}
            testId="subscriber-warnings-log"
          />
        </StatSection>
        <StatSection title="Estimate" help={AV_SYNC_HELP} testId="subscriber-av-sync">
          <StatList
            items={[
              {
                label: "skewMs",
                value: stats.avSync.skewMs === null ? "-" : stats.avSync.skewMs.toFixed(1),
                testId: "subscriber-av-sync-skew",
              },
              {
                label: "targetLatencyMs",
                value: stats.avSync.targetLatencyMs ?? "-",
                testId: "subscriber-av-sync-target-latency",
              },
              {
                label: "targetLatencyLimitedMs",
                value: stats.avSync.targetLatencyLimitedMs,
                tone: stats.avSync.targetLatencyLimitedMs > 0 ? "warn" : undefined,
                testId: "subscriber-av-sync-target-latency-limited",
              },
              {
                label: "audioClockFallback",
                value: String(stats.avSync.audioClockFallback),
                testId: "subscriber-av-sync-audio-clock-fallback",
              },
              {
                label: "audioPlayoutCorrectionMs",
                value: formatMs(stats.avSync.delays.audioPlayoutCorrectionMs),
                testId: "subscriber-av-sync-audio-playout-correction",
              },
            ]}
          />
        </StatSection>
        <StatSection title="Delays (audio)">
          <StatList
            items={[
              {
                label: "baseDelayMs",
                value: formatMs(stats.avSync.delays.audio.baseDelayMs),
                testId: "subscriber-av-sync-audio-base",
              },
              {
                label: "jitterDelayMs",
                value: formatMs(stats.avSync.delays.audio.jitterDelayMs),
                testId: "subscriber-av-sync-audio-jitter",
              },
              {
                label: "syncExtraDelayMs",
                value: formatMs(stats.avSync.delays.audio.syncExtraDelayMs),
                testId: "subscriber-av-sync-audio-extra",
              },
              {
                label: "presentationDelayMs",
                value: formatMs(stats.avSync.delays.audio.presentationDelayMs),
                testId: "subscriber-av-sync-audio-presentation",
              },
            ]}
          />
        </StatSection>
        <StatSection title="Delay target (audio)">
          <StatList
            items={[
              {
                label: "appliedMs",
                value: formatMs(stats.avSync.delays.audioDelayFeedback.appliedMs),
                testId: "subscriber-av-sync-audio-target-applied",
              },
              {
                label: "targetMs",
                value: formatMs(stats.avSync.delays.audioDelayFeedback.targetMs),
                testId: "subscriber-av-sync-audio-target",
              },
              {
                label: "jitterTargetMs",
                value: formatMs(stats.avSync.delays.audioDelayFeedback.jitterTargetMs),
                testId: "subscriber-av-sync-audio-jitter-target",
              },
              {
                label: "ceilingMs",
                value:
                  stats.avSync.delays.audioDelayFeedback.ceilingMs === null
                    ? "-"
                    : formatMs(stats.avSync.delays.audioDelayFeedback.ceilingMs),
                // 明示された上限で自動の目標が止まっていると、遅れが残っていても増えない
                tone:
                  stats.avSync.delays.audioDelayFeedback.ceilingMs !== null &&
                  stats.avSync.delays.audioDelayFeedback.appliedMs >=
                    stats.avSync.delays.audioDelayFeedback.ceilingMs
                    ? "warn"
                    : undefined,
                testId: "subscriber-av-sync-audio-target-ceiling",
              },
              {
                label: "reason",
                value: stats.avSync.delays.audioDelayFeedback.reason,
                testId: "subscriber-av-sync-audio-target-reason",
              },
              {
                label: "lastChangeMs",
                value: formatMs(stats.avSync.delays.audioDelayFeedback.lastChangeMs),
                testId: "subscriber-av-sync-audio-target-change",
              },
              {
                label: "adjustments",
                value: stats.avSync.delays.audioDelayFeedback.adjustments,
                testId: "subscriber-av-sync-audio-target-adjustments",
              },
              {
                label: "latenessP50Ms",
                value: formatMs(stats.avSync.delays.audioDelayFeedback.latenessP50Ms),
                testId: "subscriber-av-sync-audio-target-lateness",
              },
              {
                label: "startDelayP50Ms",
                value: formatMs(stats.avSync.delays.audioDelayFeedback.startDelayP50Ms),
                testId: "subscriber-av-sync-audio-target-start-delay",
              },
              {
                label: "slackP50Ms",
                value: formatMs(stats.avSync.delays.audioDelayFeedback.slackP50Ms),
                testId: "subscriber-av-sync-audio-target-slack",
              },
            ]}
          />
        </StatSection>
        <StatSection title="Delays (video)">
          <StatList
            items={[
              {
                label: "baseDelayMs",
                value: formatMs(stats.avSync.delays.video.baseDelayMs),
                testId: "subscriber-av-sync-video-base",
              },
              {
                label: "jitterDelayMs",
                value: formatMs(stats.avSync.delays.video.jitterDelayMs),
                testId: "subscriber-av-sync-video-jitter",
              },
              {
                label: "syncExtraDelayMs",
                value: formatMs(stats.avSync.delays.video.syncExtraDelayMs),
                testId: "subscriber-av-sync-video-extra",
              },
              {
                label: "presentationDelayMs",
                value: formatMs(stats.avSync.delays.video.presentationDelayMs),
                testId: "subscriber-av-sync-video-presentation",
              },
            ]}
          />
        </StatSection>
        <StatSection title="Shared base">
          <StatList
            items={[
              {
                label: "baseDifferenceMs",
                value: formatMs(stats.avSync.delays.baseDifferenceMs),
                testId: "subscriber-av-sync-base-difference",
              },
              {
                // 動きの判定が使う値 (直近 2 秒の窓の最小値の差)。基準 (baseDifferenceMs)
                // との隔たりが、経路と復号の乱れの大きさになる
                label: "baseDifferenceRecentMs",
                value: formatMs(stats.avSync.delays.baseDifferenceRecentMs),
                testId: "subscriber-av-sync-base-difference-recent",
              },
              {
                // 水準からの隔たり。この値が baseDriftLimitMs を超えたまま
                // PLAYOUT_BASE_DRIFT_CONFIRM_MS 続くと共有をやめる (段差は待たない)
                label: "baseDifferenceDeviationMs",
                value: formatMs(stats.avSync.delays.baseDifferenceDeviationMs),
                testId: "subscriber-av-sync-base-difference-deviation",
              },
              {
                label: "sharingBases",
                value: String(stats.avSync.delays.sharingBases),
                tone: stats.avSync.delays.sharingBases ? undefined : "warn",
                testId: "subscriber-av-sync-sharing",
              },
              {
                label: "unsharedReason",
                value: stats.avSync.delays.unsharedReason,
                testId: "subscriber-av-sync-unshared-reason",
              },
              {
                label: "baseDriftMsPerSecond",
                value: formatMs(stats.avSync.delays.baseDriftMsPerSecond),
                testId: "subscriber-av-sync-drift",
              },
              {
                // 共有できていない理由が hold のとき、解除の条件 (きっかけが去って差が戻った
                // 状態) がどこまで続いたかを読む。PLAYOUT_BASE_UNSHARED_RELEASE_MS に達すると
                // 保持を待たずに共有を戻す
                label: "baseUnsharedReturnMs",
                value: formatMs(stats.avSync.delays.baseUnsharedReturnMs),
                testId: "subscriber-av-sync-unshared-return",
              },
            ]}
          />
        </StatSection>
      </StatGroup>

      <StatGroup title="Session">
        <StatList
          items={[
            {
              label: "controlMessagesSent",
              value: stats.sessionStatistics?.controlMessagesSent ?? "-",
            },
            {
              label: "controlMessagesReceived",
              value: stats.sessionStatistics?.controlMessagesReceived ?? "-",
            },
            {
              label: "unidirectionalStreamsReceived",
              value: stats.sessionStatistics?.unidirectionalStreamsReceived ?? "-",
            },
          ]}
        />
      </StatGroup>
    </>
  );
}

/**
 * Video カード
 *
 * 統計 (表示 fps、受信から表示までと復号の遅延、捨てたフレーム数) は 1 秒ごとに
 * まとめて読み直し、このコンポーネントだけを描き直す
 */
function SubscriberVideoCard({
  subscriberId,
  statsSignal,
  subscriberActive,
  children,
}: {
  subscriberId: string;
  statsSignal: ReadonlySignal<SubscriberStats | null>;
  subscriberActive: boolean;
  children: ComponentChildren;
}) {
  const stats = statsSignal.value;
  if (stats === null) {
    return null;
  }
  // 表示されなかったフレーム数の合計。relay の cache から追いつくまでに意図的に
  // 描かなかった分 (catchUpFramesSkipped) は含めない
  const dropped =
    stats.staleFramesDropped +
    stats.missingReferenceFramesDropped +
    stats.playoutTiming.lateFramesDropped +
    stats.playoutTiming.displayQueueDrops;
  return (
    <VideoCard
      testIdPrefix="subscriber-video"
      lightboxKey={`subscriber-video-${subscriberId}`}
      fps={subscriberActive ? stats.playoutTiming.displayFps : null}
      latency={[
        {
          label: "latency",
          summary: stats.playoutTiming.latencyMs,
          testId: "subscriber-video-latency",
        },
        {
          label: "decode",
          summary: stats.playoutTiming.decodeTimeMs,
          testId: "subscriber-video-decode",
        },
      ]}
      dropped={subscriberActive ? dropped : null}
    >
      {children}
    </VideoCard>
  );
}
