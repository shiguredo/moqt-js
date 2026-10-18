import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { closeVideoLightbox, lightboxVideoKey, openVideoLightbox } from "../signals/layout";
import type { TimingSummary } from "../utils/playoutTimingStats";
import {
  METER_FIELD_CLASS,
  METER_HEADER_CLASS,
  METER_LABEL_CLASS,
  METER_TITLE_CLASS,
  METER_VALUE_CLASS,
} from "./meterLayout";

// 値の幅は、その欄に出うる最も長い文字列の文字数に合わせる。
// 足りないと文字がはみ出し、広すぎると見出しが 1 行に収まらない
/** fps の幅 (`120.0` と `-`) */
const FPS_VALUE_WIDTH_CLASS = "w-[5ch]";
/** 遅延の幅 (`1234.5 ms` と `-`) */
const LATENCY_VALUE_WIDTH_CLASS = "w-[10ch]";
/** 捨てたフレーム数の幅 (0 以上の整数と `-`) */
const DROPPED_VALUE_WIDTH_CLASS = "w-[7ch]";

/** 映像の上に重ねる操作ボタンの見た目 */
const CONTROL_BUTTON_CLASS =
  "p-1.5 rounded bg-black/60 text-white transition-colors hover:bg-black/80 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/80";

/** 映像の上に重ねる操作ボタンのアイコンの大きさ */
const CONTROL_ICON_CLASS = "w-4 h-4";

/** ライトボックスのカードと画面の端の余白 (px) */
const LIGHTBOX_VIEWPORT_MARGIN_PX = 32;

/** ライトボックスでカードの縦に確保する余白 (見出し行と上下の余白の分、px) */
const LIGHTBOX_VERTICAL_RESERVED_PX = 96;

/** 映像の縦横比 (幅 / 高さ)。ライトボックスが画面の高さに収まるかを決める */
const VIDEO_ASPECT_RATIO = 16 / 9;

/** 映像の遅延の 1 項目 (符号化 / 送信 / 受信から表示まで / 復号) */
export interface VideoLatencyField {
  label: string;
  /** 直近の窓の分布。記録が無いときは null */
  summary: TimingSummary | null;
  testId: string;
}

interface VideoCardProps {
  /** data-testid の接頭辞 (受信側は "subscriber-video"、送信側は "publisher-video") */
  testIdPrefix: string;
  /**
   * ライトボックス表示を識別するキー
   *
   * 同時に開く映像は 1 枚だけにしたいため、映像ごとに一意な値を渡す
   * (受信側は Subscriber の ID を含める)
   */
  lightboxKey: string;
  /** 直近 1 秒の fps。映像が出ていないときは null (「-」になる) */
  fps: number | null;
  /** 遅延の項目 (p50 を出す) */
  latency: readonly VideoLatencyField[];
  /** 表示されなかったフレーム数。映像が出ていないときは null (「-」になる) */
  dropped: number | null;
  /** 映像そのもの (video / canvas と、その上に重ねるバッジ) */
  children: ComponentChildren;
}

/** fps を表示用にする。映像が出ていない間は「-」 */
function formatFps(fps: number | null): string {
  return fps === null ? "-" : fps.toFixed(1);
}

/** 遅延 (p50、ms) を表示用にする。記録が無い間は「-」 */
function formatLatency(summary: TimingSummary | null): string {
  return summary === null ? "-" : `${summary.p50.toFixed(1)} ms`;
}

/** 捨てたフレーム数を表示用にする。映像が出ていない間は「-」 */
function formatDropped(dropped: number | null): string {
  return dropped === null ? "-" : String(dropped);
}

/**
 * ライトボックスのカードの幅を決める
 *
 * 通常表示の 2 倍の幅を基本にし、画面の幅と、16:9 の映像が画面の高さに収まる幅の
 * うち小さい方にする。開いた時点の大きさで固定し、閉じるまで変えない
 */
function lightboxWidthFor(card: HTMLElement): number {
  const doubledWidth = card.offsetWidth * 2;
  const viewportWidth = document.documentElement.clientWidth;
  const viewportHeight = document.documentElement.clientHeight;
  const widthLimitedByHeight =
    (viewportHeight - LIGHTBOX_VERTICAL_RESERVED_PX) * VIDEO_ASPECT_RATIO;
  return Math.max(
    1,
    Math.floor(
      Math.min(doubledWidth, viewportWidth - LIGHTBOX_VIEWPORT_MARGIN_PX, widthLimitedByHeight),
    ),
  );
}

/**
 * 映像のカード
 *
 * 映像を AudioMeter と同じ枠で囲み、見出しに映像そのものからは読み取れない値
 * (fps と遅延、捨てたフレーム数) を出す。遅延の区間は publisher が符号化 / 送信、
 * subscriber が受信から表示まで / 復号とする。コーデックと状態のバッジは
 * これまでどおり映像の上に重ねる
 *
 * 映像の右下に 2 つの操作を置く。どちらも映像要素そのものを動かさず、カードの
 * 位置と大きさだけを変えるため、video の再生と canvas の描画は途切れない
 * - ライトボックス: 通常表示の 2 倍の幅でページの上に重ねる。Esc で閉じる
 * - 全画面: ブラウザの Fullscreen API で全画面にする。Esc はブラウザが扱う
 */
export function VideoCard({
  testIdPrefix,
  lightboxKey,
  fps,
  latency,
  dropped,
  children,
}: VideoCardProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  // ライトボックス中のカードの幅。開くたびに測り直す
  const [lightboxWidth, setLightboxWidth] = useState<number | null>(null);
  // このカードが全画面かどうか。ブラウザ側の Esc でも変わるため fullscreenchange を追う
  const [isFullscreen, setIsFullscreen] = useState(false);
  const isLightbox = lightboxVideoKey.value === lightboxKey;

  // 全画面の出入りを状態へ映す
  useEffect(() => {
    const handleFullscreenChange = (): void => {
      setIsFullscreen(document.fullscreenElement === cardRef.current);
    };
    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () => {
      document.removeEventListener("fullscreenchange", handleFullscreenChange);
    };
  }, []);

  // ライトボックスを開いている映像は Esc で閉じる。開いた直後のキー入力を取りこぼさない
  // よう、開閉のたびではなくマウント時に window へ登録し、ハンドラの中で開いているかを見る
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && lightboxVideoKey.value === lightboxKey) {
        closeVideoLightbox();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [lightboxKey]);

  // ライトボックス中は背景がスクロールしないようにする
  useEffect(() => {
    if (!isLightbox) {
      return undefined;
    }
    const previousOverflowY = document.documentElement.style.overflowY;
    document.documentElement.style.overflowY = "hidden";
    return () => {
      document.documentElement.style.overflowY = previousOverflowY;
    };
  }, [isLightbox]);

  // ライトボックスを開いたままカードが消える (購読の削除など) ときに状態を残さない
  useEffect(() => {
    return () => {
      if (lightboxVideoKey.value === lightboxKey) {
        closeVideoLightbox();
      }
    };
  }, [lightboxKey]);

  /** ライトボックスを開く。開いているときは閉じる */
  const toggleLightbox = (): void => {
    if (isLightbox) {
      closeVideoLightbox();
      return;
    }
    const card = cardRef.current;
    if (card === null) {
      return;
    }
    setLightboxWidth(lightboxWidthFor(card));
    openVideoLightbox(lightboxKey);
  };

  /** 全画面に入る。入っているときは出る */
  const toggleFullscreen = async (): Promise<void> => {
    const card = cardRef.current;
    if (card === null) {
      return;
    }
    try {
      if (document.fullscreenElement === card) {
        await document.exitFullscreen();
        return;
      }
      // ライトボックスの中央配置 (transform) と全画面の配置が重ならないよう先に閉じる
      if (isLightbox) {
        closeVideoLightbox();
      }
      await card.requestFullscreen();
    } catch (error) {
      // 全画面を許可しない設定や、ユーザーの操作起点でない呼び出しでは失敗する
      console.warn(`[${testIdPrefix}] failed to toggle fullscreen`, error);
    }
  };

  const cardStyle = isLightbox && lightboxWidth !== null ? { width: `${lightboxWidth}px` } : {};
  const cardClass = isFullscreen
    ? "flex flex-col overflow-hidden bg-slate-50 p-2"
    : isLightbox
      ? "fixed left-1/2 top-1/2 z-[61] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-slate-200 bg-slate-50 p-2 shadow-2xl"
      : "bg-slate-50 border border-slate-200 rounded-lg p-2 mb-4";
  const videoContainerClass = isFullscreen
    ? "relative min-h-0 flex-1 bg-slate-900 rounded-lg overflow-hidden"
    : "relative bg-slate-900 rounded-lg overflow-hidden aspect-video";

  return (
    <>
      {/* ライトボックス中にページを暗くする背景。押すと閉じる */}
      {isLightbox && (
        <div
          data-testid={`${testIdPrefix}-lightbox-backdrop`}
          class="fixed inset-0 z-[60] bg-slate-900/70"
          onClick={closeVideoLightbox}
        />
      )}
      <div ref={cardRef} style={cardStyle} data-testid={`${testIdPrefix}-card`} class={cardClass}>
        <div class={METER_HEADER_CLASS}>
          <h3 class={METER_TITLE_CLASS}>Video</h3>
          <span class={METER_FIELD_CLASS}>
            <span class={METER_LABEL_CLASS}>fps</span>
            <span
              data-testid={`${testIdPrefix}-fps`}
              class={`${METER_VALUE_CLASS} ${FPS_VALUE_WIDTH_CLASS}`}
            >
              {formatFps(fps)}
            </span>
          </span>
          {latency.map((field) => (
            <span key={field.label} class={METER_FIELD_CLASS}>
              <span class={METER_LABEL_CLASS}>{field.label}</span>
              <span
                data-testid={field.testId}
                class={`${METER_VALUE_CLASS} ${LATENCY_VALUE_WIDTH_CLASS}`}
              >
                {formatLatency(field.summary)}
              </span>
            </span>
          ))}
          <span class={METER_FIELD_CLASS}>
            <span class={METER_LABEL_CLASS}>dropped</span>
            <span
              data-testid={`${testIdPrefix}-dropped`}
              class={`${METER_VALUE_CLASS} ${DROPPED_VALUE_WIDTH_CLASS}`}
            >
              {formatDropped(dropped)}
            </span>
          </span>
        </div>
        <div class={videoContainerClass}>
          {children}
          {/* 映像の右下に操作を重ねる。codec などのバッジ (上側) とは重ならない */}
          <div class="absolute bottom-2 right-2 z-10 flex items-center gap-1.5">
            {!isFullscreen && (
              <button
                type="button"
                onClick={toggleLightbox}
                data-testid={`${testIdPrefix}-lightbox-button`}
                aria-expanded={isLightbox}
                aria-label={isLightbox ? "Close the enlarged video" : "Enlarge this video"}
                title={
                  isLightbox ? "Close the enlarged video (Esc)" : "Enlarge this video to 2x width"
                }
                class={CONTROL_BUTTON_CLASS}
              >
                {isLightbox ? (
                  // 閉じる (×)
                  <svg
                    class={CONTROL_ICON_CLASS}
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      stroke-width="2"
                      d="M6 6l12 12M18 6L6 18"
                    />
                  </svg>
                ) : (
                  // 横に広げる (左右の矢印)
                  <svg
                    class={CONTROL_ICON_CLASS}
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      stroke-width="2"
                      d="M3 12h18M7 8l-4 4 4 4M17 8l4 4-4 4"
                    />
                  </svg>
                )}
              </button>
            )}
            <button
              type="button"
              onClick={() => void toggleFullscreen()}
              data-testid={`${testIdPrefix}-fullscreen-button`}
              aria-label={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
              title={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
              class={CONTROL_BUTTON_CLASS}
            >
              {isFullscreen ? (
                // 内側へ戻す (全画面を終える)
                <svg
                  class={CONTROL_ICON_CLASS}
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    stroke-width="2"
                    d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"
                  />
                </svg>
              ) : (
                // 外側へ広げる (全画面に入る)
                <svg
                  class={CONTROL_ICON_CLASS}
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    stroke-width="2"
                    d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"
                  />
                </svg>
              )}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
