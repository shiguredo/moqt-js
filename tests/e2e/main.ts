/**
 * Playwright E2E 用のエントリポイント
 *
 * window.__moqtE2E にヘルパーを露出する。
 * - connectSession: SETUP までを検証する低レベル接続チェック (issue 0114)
 * - publishCanvas: Canvas captureStream で生成した MediaStream を VP8 で publish する
 * - subscribeCanvas: 同一 namespace に subscribe して MediaStream を受信する
 *
 * draft-ietf-moq-transport-20 Section 10.3 (SETUP Message)
 */

import {
  connect,
  AuthorizationTokenAliasType,
  createMediaPublisher,
  createMediaSubscriber,
} from "moqt-js";
import type { AuthorizationToken } from "moqt-js";

interface ConnectSessionOptions {
  url: string;
  // TEST_MOQT_AUTH_TOKEN の生文字列。UTF-8 encode して USE_VALUE で送る
  authorizationTokenValue?: string;
}

interface PublishSubscribeOptions {
  url: string;
  authorizationTokenValue?: string;
  namespace: string[];
  durationMs: number;
}

interface PublishResult {
  finalState: string;
  errors: string[];
}

interface SubscribeResult {
  finalState: string;
  errors: string[];
  hasVideoTrack: boolean;
}

declare global {
  interface Window {
    __moqtE2E: {
      connectSession(opts: ConnectSessionOptions): Promise<string>;
      publishCanvas(opts: PublishSubscribeOptions): Promise<PublishResult>;
      subscribeCanvas(opts: PublishSubscribeOptions): Promise<SubscribeResult>;
    };
  }
}

function makeAuthorizationToken(value: string | undefined): AuthorizationToken | undefined {
  if (!value) return undefined;
  return {
    aliasType: AuthorizationTokenAliasType.USE_VALUE,
    tokenType: 0n,
    tokenValue: new TextEncoder().encode(value),
  };
}

/**
 * 320x240 の Canvas を時刻に応じた色で塗り続け、`captureStream(30)` で MediaStream を返す
 * publish が終わったら caller 側で `cancelAnimationFrame` の役割を担う `dispose` を呼ぶ
 */
function createCanvasStream(): { stream: MediaStream; dispose: () => void } {
  const canvas = document.createElement("canvas");
  canvas.width = 320;
  canvas.height = 240;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("failed to get 2d context");

  let intervalId = window.setInterval(() => {
    const t = Date.now() / 1000;
    const r = Math.floor((Math.sin(t) + 1) * 127);
    const g = Math.floor((Math.sin(t + 2) + 1) * 127);
    const b = Math.floor((Math.sin(t + 4) + 1) * 127);
    context.fillStyle = `rgb(${r}, ${g}, ${b})`;
    context.fillRect(0, 0, canvas.width, canvas.height);
  }, 1000 / 30);

  // captureStream は HTMLCanvasElement の標準 API
  const stream = (
    canvas as HTMLCanvasElement & { captureStream: (fps?: number) => MediaStream }
  ).captureStream(30);

  const dispose = () => {
    if (intervalId !== 0) {
      window.clearInterval(intervalId);
      intervalId = 0;
    }
    for (const track of stream.getTracks()) {
      track.stop();
    }
  };

  return { stream, dispose };
}

window.__moqtE2E = {
  async connectSession({ url, authorizationTokenValue }) {
    const authorizationToken = makeAuthorizationToken(authorizationTokenValue);

    const session = await connect(
      url,
      {
        close: () => {},
        error: () => {},
      },
      authorizationToken ? { authorizationToken } : {},
    );

    const state = session.state;
    await session.close();
    return state;
  },

  async publishCanvas({ url, authorizationTokenValue, namespace, durationMs }) {
    const errors: string[] = [];
    const { stream, dispose } = createCanvasStream();
    const authorizationToken = makeAuthorizationToken(authorizationTokenValue);

    const publisher = await createMediaPublisher(
      url,
      {
        namespace,
        video: { codec: "vp8", bitrate: 500_000 },
        ...(authorizationToken ? { authorizationToken } : {}),
      },
      {
        onError: (error) => {
          errors.push(error instanceof Error ? error.message : String(error));
        },
      },
    );

    let finalState = publisher.state;
    try {
      await publisher.start(stream);
      await new Promise<void>((resolve) => window.setTimeout(resolve, durationMs));
      // close 前の state を成功条件として保存する
      finalState = publisher.state;
    } finally {
      dispose();
      await publisher.close();
    }

    return { finalState, errors };
  },

  async subscribeCanvas({ url, authorizationTokenValue, namespace, durationMs }) {
    const errors: string[] = [];
    const authorizationToken = makeAuthorizationToken(authorizationTokenValue);

    const subscriber = await createMediaSubscriber(
      url,
      {
        namespace,
        video: { codec: "vp8" },
        ...(authorizationToken ? { authorizationToken } : {}),
      },
      {
        onError: (error) => {
          errors.push(error instanceof Error ? error.message : String(error));
        },
      },
    );

    try {
      await subscriber.start();
      await new Promise<void>((resolve) => window.setTimeout(resolve, durationMs));
    } finally {
      // subscriber.mediaStream は start() 完了 + Catalog 受信後に確定する
      // close() より先に評価する必要がある
    }

    const hasVideoTrack = (subscriber.mediaStream?.getVideoTracks().length ?? 0) > 0;
    const finalState = subscriber.state;
    await subscriber.close();
    return { finalState, errors, hasVideoTrack };
  },
};

const statusElement = document.getElementById("status");
if (statusElement) {
  statusElement.textContent = "loaded";
}
