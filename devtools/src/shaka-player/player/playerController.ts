import type {
  ShakaErrorEvent,
  ShakaMsfCatalog,
  ShakaPlayer,
  ShakaStats,
  ShakaVariantTrack,
} from "../shaka";
import { formatShakaError } from "../utils/error";

export interface PlayerCallbacks {
  onError: (message: string) => void;
  onLog: (message: string) => void;
  onStats: (stats: ShakaStats, variants: ShakaVariantTrack[]) => void;
}

export interface LoadOptions {
  relayUrl: string;
  namespaces: string[];
  version: string;
  fingerprintUri: string;
  authorizationToken: string;
  evictionGoalSeconds: number;
  disableAudio: boolean;
}

/**
 * shaka.Player の生成から破棄までをまとめる。
 *
 * 画面の状態管理と shaka のライフサイクルを分離し、Load / Stop のたびに
 * Player を作り直す。MSF は URL の拡張子から MIME を推測できないため、
 * player.load の第 3 引数に application/msf を明示する。
 */
export class PlayerController {
  private readonly video: HTMLVideoElement;
  private readonly callbacks: PlayerCallbacks;
  private player: ShakaPlayer | null = null;
  private statsTimer: number | null = null;

  private readonly handleError = (event: ShakaErrorEvent): void => {
    this.callbacks.onError(formatShakaError(event.detail));
  };

  constructor(video: HTMLVideoElement, callbacks: PlayerCallbacks) {
    this.video = video;
    this.callbacks = callbacks;
  }

  async load(options: LoadOptions): Promise<void> {
    const shaka = window.shaka;
    if (shaka === undefined) {
      throw new Error("shaka-player is not loaded; the experimental build is missing");
    }

    shaka.polyfill.installAll();
    await this.stop();

    const player = new shaka.Player();
    this.player = player;
    player.addEventListener("error", this.handleError);

    try {
      await player.attach(this.video);
      player.configure({
        manifest: {
          msf: {
            namespaces: options.namespaces,
            version: options.version,
            ...(options.fingerprintUri === "" ? {} : { fingerprintUri: options.fingerprintUri }),
            ...(options.authorizationToken === ""
              ? {}
              : { authorizationToken: options.authorizationToken }),
            ...(options.disableAudio
              ? {
                  catalogPreprocessor: (catalog: ShakaMsfCatalog) => {
                    // 音声 LOC トラックがあると shaka が Loading のまま止まるため、
                    // フォールバックでは音声トラックを catalog から外して映像だけを再生する。
                    if (catalog.tracks !== undefined) {
                      catalog.tracks = catalog.tracks.filter((track) => track.role !== "audio");
                    }
                  },
                }
              : {}),
          },
        },
        mediaSource: {
          transmuxWorkerUrl: new URL("./shaka-player.transmuxer-worker.js", window.location.href)
            .href,
        },
        streaming: {
          evictionGoal: options.evictionGoalSeconds,
        },
      });
      this.callbacks.onLog(
        `loading ${options.relayUrl} (version=${options.version}, namespace=${options.namespaces.join("/")})`,
      );
      await player.load(options.relayUrl, null, "application/msf");
      this.callbacks.onLog("manifest loaded");
    } catch (error) {
      await this.stop();
      throw error;
    }

    // 音声トラックの初期化が止まっていると play() の Promise が解決しないことが
    // ある。ここで待つと Load 全体が止まり、音声なしの再試行も始められないため、
    // 再生開始は待たずに進行し、拒否だけログに残す。
    void this.video.play().catch((error: unknown) => {
      this.callbacks.onLog(`play() was rejected: ${String(error)}`);
    });
    this.startPolling();
  }

  async stop(): Promise<void> {
    this.stopPolling();
    const player = this.player;
    this.player = null;
    if (player !== null) {
      try {
        await player.destroy();
      } finally {
        this.video.pause();
        this.video.removeAttribute("src");
        this.video.load();
      }
    }
  }

  private startPolling(): void {
    this.stopPolling();
    this.statsTimer = window.setInterval(() => {
      const player = this.player;
      if (player === null) {
        return;
      }
      this.callbacks.onStats(player.getStats(), player.getVariantTracks());
    }, 500);
  }

  private stopPolling(): void {
    if (this.statsTimer !== null) {
      window.clearInterval(this.statsTimer);
      this.statsTimer = null;
    }
  }
}
