import { signal, computed } from "@preact/signals";

// クエリパラメータからの初期値読み込み
function getInitialParams(): { url: string; certificateHash: string } {
  const params = new URLSearchParams(window.location.search);
  return {
    url: params.get("url") || "https://127.0.0.1:4443/wt",
    certificateHash: params.get("certificateHash") || "",
  };
}

const initialParams = getInitialParams();

// Connection settings
export const url = signal(initialParams.url);
export const certificateHash = signal(initialParams.certificateHash);

/**
 * 現在の設定からクエリ文字列を構築する
 */
export function buildQueryString(): string {
  const params = new URLSearchParams();
  params.set("url", url.value);
  if (certificateHash.value) {
    params.set("certificateHash", certificateHash.value);
  }
  return params.toString();
}

// Connection state
export const transport = signal<WebTransport | null>(null);
export const connectionStatus = signal<"disconnected" | "connecting" | "connected" | "error">(
  "disconnected",
);
export const connectionError = signal("");

// WebTransport Promise 状態
export const wtReadyState = signal<string>("pending");
export const wtClosedState = signal<string>("pending");
export const wtDrainingState = signal<string>("pending");

// WebTransport プロパティ
export const wtReliability = signal<string>("");
export const wtCongestionControl = signal<string>("");
export const wtSupportsReliableOnly = signal<string>("");
export const wtProtocol = signal<string>("");
export const wtResponseHeaders = signal<string>("");

// WebTransport API 対応状況
export interface ApiSupportNode {
  value: string;
  children?: Record<string, ApiSupportNode>;
}
export type ApiSupport = Record<string, ApiSupportNode>;
export const wtApiSupport = signal<ApiSupport | null>(null);

// 静的な WebTransport API 対応状況 (接続前チェック)
// 評価は WebTransport.prototype 等のグローバル / プロトタイプ上で行い、
// ブラウザ実装そのものを判定する。ページロード時に 1 回だけ評価する。
// 仕様: https://www.w3.org/TR/webtransport/
export interface StaticApiCheck {
  name: string;
  supported: boolean;
  // 仕様上 deprecated とされ、後継 API に置き換えられた項目を true にする
  // 新ブラウザでは消えているのが期待されるため、未対応でも赤表示にしない
  deprecated?: boolean;
  // 補足注記 (「use createWritable」などの移行先案内に利用する)
  note?: string;
  // 機能の 1 行解説 (日本語)
  description?: string;
}
export interface StaticApiGroup {
  name: string;
  items: StaticApiCheck[];
}

function detectStaticApiSupport(): StaticApiGroup[] {
  const globalObj = self as unknown as Record<string, unknown>;

  const hasGlobal = (name: string): boolean => name in globalObj;

  // biome-ignore lint/suspicious/noExplicitAny: 静的チェック対象の型定義が不完全
  const hasOnProto = (ctor: any, member: string): boolean => {
    if (ctor == null) return false;
    const proto = ctor.prototype;
    if (proto == null) return false;
    return member in proto;
  };

  // biome-ignore lint/suspicious/noExplicitAny: 静的チェック対象の型定義が不完全
  const hasOnStatic = (ctor: any, member: string): boolean => {
    if (ctor == null) return false;
    return member in ctor;
  };

  const WT = globalObj.WebTransport;
  const DDuplex = globalObj.WebTransportDatagramDuplexStream;
  const BidiStream = globalObj.WebTransportBidirectionalStream;
  const SendStream = globalObj.WebTransportSendStream;
  const RecvStream = globalObj.WebTransportReceiveStream;
  const SendGroup = globalObj.WebTransportSendGroup;
  const WTError = globalObj.WebTransportError;

  return [
    // Global interfaces の存在確認
    // 各インターフェースは W3C WebTransport 仕様で定義されている
    // https://www.w3.org/TR/webtransport/
    {
      name: "Global",
      items: [
        {
          name: "WebTransport",
          supported: hasGlobal("WebTransport"),
          description: "WebTransport セッションを表すメインクラス",
        },
        {
          name: "WebTransportError",
          supported: hasGlobal("WebTransportError"),
          description: "WebTransport 固有のエラー情報を持つ DOMException サブクラス",
        },
        {
          name: "WebTransportBidirectionalStream",
          supported: hasGlobal("WebTransportBidirectionalStream"),
          description: "双方向ストリーム (readable / writable の対) を表す",
        },
        {
          name: "WebTransportReceiveStream",
          supported: hasGlobal("WebTransportReceiveStream"),
          description: "受信専用の ReadableStream サブクラス (getStats 付き)",
        },
        {
          name: "WebTransportSendStream",
          supported: hasGlobal("WebTransportSendStream"),
          description: "送信専用の WritableStream サブクラス (sendOrder / getStats 付き)",
        },
        {
          name: "WebTransportSendGroup",
          supported: hasGlobal("WebTransportSendGroup"),
          description: "複数ストリームの送信順序を協調させるグループ",
        },
        {
          name: "WebTransportDatagramDuplexStream",
          supported: hasGlobal("WebTransportDatagramDuplexStream"),
          description: "データグラムの送受信を扱うデュプレックスストリーム",
        },
      ],
    },
    // WebTransport インターフェースのメンバー
    // 仕様: https://www.w3.org/TR/webtransport/#web-transport
    // MDN: https://developer.mozilla.org/en-US/docs/Web/API/WebTransport
    {
      name: "WebTransport",
      items: [
        {
          name: "WebTransport.prototype.ready",
          supported: hasOnProto(WT, "ready"),
          description: "セッション確立完了時に fulfill する Promise",
        },
        {
          name: "WebTransport.prototype.closed",
          supported: hasOnProto(WT, "closed"),
          description: "graceful close 時に fulfill、異常終了時に reject する Promise",
        },
        {
          name: "WebTransport.prototype.close",
          supported: hasOnProto(WT, "close"),
          description: "セッションを終了する (closeCode / reason を付与可能)",
        },
        {
          name: "WebTransport.prototype.draining",
          supported: hasOnProto(WT, "draining"),
          description: "サーバーからの drain 要求開始時に fulfill する Promise",
        },
        {
          name: "WebTransport.prototype.reliability",
          supported: hasOnProto(WT, "reliability"),
          description: "信頼性モード (pending / supports-unreliable / supports-reliable-only)",
        },
        {
          name: "WebTransport.prototype.congestionControl",
          supported: hasOnProto(WT, "congestionControl"),
          description: "適用された輻輳制御アルゴリズム (default / throughput / low-latency)",
        },
        {
          name: "WebTransport.prototype.protocol",
          supported: hasOnProto(WT, "protocol"),
          description: "サーバーが選択したアプリケーションプロトコル名",
        },
        {
          name: "WebTransport.prototype.responseHeaders",
          supported: hasOnProto(WT, "responseHeaders"),
          description: "セッション確立後のサーバー応答 HTTP ヘッダー",
        },
        {
          name: "WebTransport.prototype.anticipatedConcurrentIncomingUnidirectionalStreams",
          supported: hasOnProto(WT, "anticipatedConcurrentIncomingUnidirectionalStreams"),
          description: "想定される同時受信単方向ストリーム数のヒント",
        },
        {
          name: "WebTransport.prototype.anticipatedConcurrentIncomingBidirectionalStreams",
          supported: hasOnProto(WT, "anticipatedConcurrentIncomingBidirectionalStreams"),
          description: "想定される同時受信双方向ストリーム数のヒント",
        },
        {
          name: "WebTransport.prototype.datagrams",
          supported: hasOnProto(WT, "datagrams"),
          description: "データグラム送受信用のアクセサ (WebTransportDatagramDuplexStream)",
        },
        {
          name: "WebTransport.prototype.createBidirectionalStream",
          supported: hasOnProto(WT, "createBidirectionalStream"),
          description: "新しい双方向ストリームを作成する",
        },
        {
          name: "WebTransport.prototype.createUnidirectionalStream",
          supported: hasOnProto(WT, "createUnidirectionalStream"),
          description: "新しい送信専用 (単方向) ストリームを作成する",
        },
        {
          name: "WebTransport.prototype.incomingBidirectionalStreams",
          supported: hasOnProto(WT, "incomingBidirectionalStreams"),
          description: "サーバーから受信した双方向ストリームの ReadableStream",
        },
        {
          name: "WebTransport.prototype.incomingUnidirectionalStreams",
          supported: hasOnProto(WT, "incomingUnidirectionalStreams"),
          description: "サーバーから受信した単方向ストリームの ReadableStream",
        },
        {
          name: "WebTransport.prototype.createSendGroup",
          supported: hasOnProto(WT, "createSendGroup"),
          description: "新しい WebTransportSendGroup を作成する",
        },
        {
          name: "WebTransport.prototype.getStats",
          supported: hasOnProto(WT, "getStats"),
          description: "セッションの統計情報を非同期取得する",
        },
        {
          name: "WebTransport.supportsReliableOnly",
          supported: hasOnStatic(WT, "supportsReliableOnly"),
          description: "信頼性のみモード対応かの static フラグ",
        },
      ],
    },
    // WebTransportDatagramDuplexStream の属性群
    // 仕様: https://www.w3.org/TR/webtransport/#web-transport-datagram-duplex-stream
    // MDN: https://developer.mozilla.org/en-US/docs/Web/API/WebTransportDatagramDuplexStream
    {
      name: "Datagrams",
      items: [
        {
          name: "WebTransportDatagramDuplexStream.prototype.readable",
          supported: hasOnProto(DDuplex, "readable"),
          description: "受信データグラム用 ReadableStream",
        },
        {
          // writable は W3C 現行仕様からは削除済み。MDN では Deprecated かつ Non-standard 扱い
          // https://developer.mozilla.org/en-US/docs/Web/API/WebTransportDatagramDuplexStream/writable
          // 現行仕様では createWritable() が正規の代替
          // https://www.w3.org/TR/webtransport/#dom-webtransportdatagramduplexstream-createwritable
          name: "WebTransportDatagramDuplexStream.prototype.writable",
          supported: hasOnProto(DDuplex, "writable"),
          deprecated: true,
          note: "use createWritable",
          description: "送信データグラム用 WritableStream (単一シェアのため非推奨)",
        },
        {
          name: "WebTransportDatagramDuplexStream.prototype.createWritable",
          supported: hasOnProto(DDuplex, "createWritable"),
          description: "送信用 WritableStream を都度生成する (並行送信対応、送信順序指定可)",
        },
        {
          name: "WebTransportDatagramDuplexStream.prototype.maxDatagramSize",
          supported: hasOnProto(DDuplex, "maxDatagramSize"),
          description: "送信可能な最大データグラムサイズ (byte)",
        },
        {
          name: "WebTransportDatagramDuplexStream.prototype.incomingMaxAge",
          supported: hasOnProto(DDuplex, "incomingMaxAge"),
          description: "受信側で破棄されるまでの最大滞在時間 (ms)",
        },
        {
          name: "WebTransportDatagramDuplexStream.prototype.outgoingMaxAge",
          supported: hasOnProto(DDuplex, "outgoingMaxAge"),
          description: "送信側で破棄されるまでの最大滞在時間 (ms)",
        },
        {
          name: "WebTransportDatagramDuplexStream.prototype.incomingHighWaterMark",
          supported: hasOnProto(DDuplex, "incomingHighWaterMark"),
          description: "受信キュー溢れ時に先頭から破棄する閾値",
        },
        {
          name: "WebTransportDatagramDuplexStream.prototype.outgoingHighWaterMark",
          supported: hasOnProto(DDuplex, "outgoingHighWaterMark"),
          description: "送信キュー溢れ時に backpressure を掛ける閾値",
        },
      ],
    },
    // WebTransportBidirectionalStream は readable / writable の対を持つ
    // 仕様: https://www.w3.org/TR/webtransport/#web-transport-bidirectional-stream
    // MDN: https://developer.mozilla.org/en-US/docs/Web/API/WebTransportBidirectionalStream
    {
      name: "Bidirectional Stream",
      items: [
        {
          name: "WebTransportBidirectionalStream.prototype.readable",
          supported: hasOnProto(BidiStream, "readable"),
          description: "受信側 WebTransportReceiveStream",
        },
        {
          name: "WebTransportBidirectionalStream.prototype.writable",
          supported: hasOnProto(BidiStream, "writable"),
          description: "送信側 WebTransportSendStream",
        },
      ],
    },
    // WebTransportSendStream は WritableStream を継承
    // 仕様: https://www.w3.org/TR/webtransport/#web-transport-send-stream
    // MDN: https://developer.mozilla.org/en-US/docs/Web/API/WebTransportSendStream
    {
      name: "Send Stream",
      items: [
        {
          name: "WebTransportSendStream.prototype.sendOrder",
          supported: hasOnProto(SendStream, "sendOrder"),
          description: "送信優先度 (整数値、大きいほど優先)",
        },
        {
          name: "WebTransportSendStream.prototype.sendGroup",
          supported: hasOnProto(SendStream, "sendGroup"),
          description: "所属する WebTransportSendGroup",
        },
        {
          name: "WebTransportSendStream.prototype.getStats",
          supported: hasOnProto(SendStream, "getStats"),
          description: "この送信ストリームの統計情報を取得する",
        },
      ],
    },
    // WebTransportReceiveStream は ReadableStream を継承
    // 仕様: https://www.w3.org/TR/webtransport/#web-transport-receive-stream
    // MDN: https://developer.mozilla.org/en-US/docs/Web/API/WebTransportReceiveStream
    {
      name: "Receive Stream",
      items: [
        {
          name: "WebTransportReceiveStream.prototype.getStats",
          supported: hasOnProto(RecvStream, "getStats"),
          description: "この受信ストリームの統計情報を取得する",
        },
      ],
    },
    // WebTransportSendGroup は送信順序の協調単位
    // 仕様: https://www.w3.org/TR/webtransport/#web-transport-send-group
    // MDN: https://developer.mozilla.org/en-US/docs/Web/API/WebTransportSendGroup
    {
      name: "Send Group",
      items: [
        {
          name: "WebTransportSendGroup.prototype.getStats",
          supported: hasOnProto(SendGroup, "getStats"),
          description: "グループ内全ストリームの集約統計を取得する",
        },
      ],
    },
    // WebTransportError は DOMException を継承したエラー型
    // 仕様: https://www.w3.org/TR/webtransport/#web-transport-error-interface
    // MDN: https://developer.mozilla.org/en-US/docs/Web/API/WebTransportError
    {
      name: "Error",
      items: [
        {
          name: "WebTransportError.prototype.source",
          supported: hasOnProto(WTError, "source"),
          description: 'エラー発生元 ("session" または "stream")',
        },
        {
          name: "WebTransportError.prototype.streamErrorCode",
          supported: hasOnProto(WTError, "streamErrorCode"),
          description: "ストリーム終了時のアプリケーションエラーコード (該当時のみ)",
        },
      ],
    },
  ];
}

// ページロード時に 1 回評価する
export const wtStaticApiSupport = signal<StaticApiGroup[]>(detectStaticApiSupport());

// Message type
export interface StreamMessage {
  direction: "send" | "recv";
  data: string;
  timestamp: number;
}

// Bidirectional streams
export interface BidiStreamInfo {
  id: number;
  stream: WebTransportBidirectionalStream;
  writer: WritableStreamDefaultWriter<Uint8Array>;
  messages: StreamMessage[];
  closed: boolean;
}
export const bidiStreams = signal<BidiStreamInfo[]>([]);

// Outgoing unidirectional streams
export interface UniSendStreamInfo {
  id: number;
  stream: WebTransportSendStream;
  writer: WritableStreamDefaultWriter<Uint8Array>;
  messages: StreamMessage[];
  closed: boolean;
}
export const uniSendStreams = signal<UniSendStreamInfo[]>([]);

// Incoming unidirectional streams
export interface UniRecvStreamInfo {
  id: number;
  messages: StreamMessage[];
  closed: boolean;
}
export const uniRecvStreams = signal<UniRecvStreamInfo[]>([]);

// Datagram
export const datagramMessages = signal<StreamMessage[]>([]);

// Stream counters
let bidiStreamCounter = 0;
let uniSendStreamCounter = 0;
let uniRecvStreamCounter = 0;

// Settings disabled when connected
export const settingsDisabled = computed(() => connectionStatus.value !== "disconnected");

/**
 * Base64 encoded string to ArrayBuffer
 */
export function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes.buffer;
}

/**
 * Format timestamp for display
 */
export function formatTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toLocaleTimeString("ja-JP", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
  });
}

/**
 * Connect to WebTransport server
 */
export async function connect(): Promise<void> {
  if (transport.value) {
    return;
  }

  connectionStatus.value = "connecting";
  connectionError.value = "";

  try {
    const options: WebTransportOptions = {};

    if (certificateHash.value) {
      options.serverCertificateHashes = [
        {
          algorithm: "sha-256",
          value: base64ToArrayBuffer(certificateHash.value),
        },
      ];
    }

    const wt = new WebTransport(url.value, options);

    wtReadyState.value = "pending";
    wtClosedState.value = "pending";
    wtDrainingState.value = "pending";

    wt.ready
      .then(() => {
        wtReadyState.value = "resolved";
      })
      .catch((err: unknown) => {
        wtReadyState.value = `rejected: ${(err as Error).message}`;
      });

    wt.closed
      .then(() => {
        wtClosedState.value = "resolved";
        disconnect();
      })
      .catch((err: unknown) => {
        wtClosedState.value = `rejected: ${(err as Error).message}`;
        connectionError.value = (err as Error).message;
        disconnect();
      });

    // TypeScript の型定義が最新仕様に追従していないため any 経由でアクセスする
    // biome-ignore lint/suspicious/noExplicitAny: WebTransport API の型定義が不完全
    const wtAny = wt as any;

    if (wtAny.draining) {
      (wtAny.draining as Promise<undefined>)
        .then(() => {
          wtDrainingState.value = "resolved";
        })
        .catch((err: unknown) => {
          wtDrainingState.value = `rejected: ${(err as Error).message}`;
        });
    } else {
      wtDrainingState.value = "N/A";
    }

    await wt.ready;

    transport.value = wt;
    connectionStatus.value = "connected";

    // セッション確立後のプロパティを取得する
    wtReliability.value = String(wtAny.reliability ?? "N/A");
    wtCongestionControl.value = String(wtAny.congestionControl ?? "N/A");
    wtSupportsReliableOnly.value = String(wtAny.supportsReliableOnly ?? "N/A");
    wtProtocol.value = String(wtAny.protocol ?? "");
    const responseHeaders = wtAny.responseHeaders as Headers | null | undefined;
    if (responseHeaders) {
      const entries: string[] = [];
      responseHeaders.forEach((value: string, key: string) => {
        entries.push(`${key}: ${value}`);
      });
      wtResponseHeaders.value = entries.join("\n");
    } else if (responseHeaders === null) {
      wtResponseHeaders.value = "null";
    } else {
      wtResponseHeaders.value = "N/A";
    }

    // API 対応状況を検出する
    // biome-ignore lint/suspicious/noExplicitAny: WebTransport API の型定義が不完全
    const wtCheck = wt as any;
    // 値を人間が読める表記に整形する
    const inspect = (val: unknown): string => {
      if (val === undefined) return "undefined";
      if (val === null) return "null";
      const valueType = typeof val;
      if (valueType === "string") return `"${val as string}"`;
      if (valueType === "object") {
        const constructorName = (val as object).constructor?.name;
        return constructorName ?? "object";
      }
      return valueType;
    };
    // 親オブジェクトから単一プロパティを取り出すノードを作る
    const makeLeaf = (parent: unknown, prop: string): ApiSupportNode => {
      if (parent == null) return { value: "N/A (parent is null)" };
      return { value: inspect((parent as Record<string, unknown>)[prop]) };
    };
    // object 型なら指定した子プロパティを再帰的に展開する
    const makeNode = (parent: unknown, prop: string, childProps?: string[]): ApiSupportNode => {
      if (parent == null) return { value: "N/A (parent is null)" };
      const val = (parent as Record<string, unknown>)[prop];
      const node: ApiSupportNode = { value: inspect(val) };
      if (childProps && val !== null && typeof val === "object") {
        const children: Record<string, ApiSupportNode> = {};
        for (const childProp of childProps) {
          children[childProp] = makeLeaf(val, childProp);
        }
        node.children = children;
      }
      return node;
    };
    wtApiSupport.value = {
      datagrams: makeNode(wt, "datagrams", ["readable", "writable", "createWritable"]),
      incomingBidirectionalStreams: makeNode(wt, "incomingBidirectionalStreams"),
      incomingUnidirectionalStreams: makeNode(wt, "incomingUnidirectionalStreams"),
      createBidirectionalStream: makeNode(wt, "createBidirectionalStream"),
      createUnidirectionalStream: makeNode(wt, "createUnidirectionalStream"),
      closed: makeNode(wt, "closed"),
      ready: makeNode(wt, "ready"),
      draining: makeNode(wtCheck, "draining"),
      reliability: makeNode(wtCheck, "reliability"),
      congestionControl: makeNode(wtCheck, "congestionControl"),
      protocol: makeNode(wtCheck, "protocol"),
      getStats: makeNode(wt, "getStats"),
    };

    // Start receiving datagrams (datagrams が存在する場合のみ)
    if (wtCheck.datagrams?.readable) {
      void receiveDatagrams(wt);
    }

    // Start receiving incoming unidirectional streams
    void receiveIncomingStreams(wt);
  } catch (err) {
    connectionStatus.value = "error";
    connectionError.value = (err as Error).message;
  }
}

/**
 * Disconnect from WebTransport server
 */
export function disconnect(): void {
  if (transport.value) {
    try {
      transport.value.close();
    } catch {
      // ignore
    }
    transport.value = null;
  }

  // Clear streams
  bidiStreams.value = [];
  uniSendStreams.value = [];
  uniRecvStreams.value = [];
  datagramMessages.value = [];
  bidiStreamCounter = 0;
  uniSendStreamCounter = 0;
  uniRecvStreamCounter = 0;

  connectionStatus.value = "disconnected";
  wtReadyState.value = "pending";
  wtClosedState.value = "pending";
  wtDrainingState.value = "pending";
  wtReliability.value = "";
  wtCongestionControl.value = "";
  wtSupportsReliableOnly.value = "";
  wtProtocol.value = "";
  wtResponseHeaders.value = "";
  wtApiSupport.value = null;
}

/**
 * Receive datagrams
 */
async function receiveDatagrams(wt: WebTransport): Promise<void> {
  const reader = wt.datagrams.readable.getReader();

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      const decoder = new TextDecoder();
      const text = decoder.decode(value);

      datagramMessages.value = [
        ...datagramMessages.value,
        { direction: "recv", data: text, timestamp: Date.now() },
      ];
    }
  } catch {
    // Stream closed
  } finally {
    reader.releaseLock();
  }
}

/**
 * Clear datagram messages
 */
export function clearDatagramMessages(): void {
  datagramMessages.value = [];
}

/**
 * Receive incoming unidirectional streams
 */
async function receiveIncomingStreams(wt: WebTransport): Promise<void> {
  const reader = wt.incomingUnidirectionalStreams.getReader();

  try {
    while (true) {
      const { value: stream, done } = await reader.read();
      if (done) break;

      const id = uniRecvStreamCounter++;
      const streamInfo: UniRecvStreamInfo = {
        id,
        messages: [],
        closed: false,
      };

      uniRecvStreams.value = [...uniRecvStreams.value, streamInfo];
      void readIncomingStream(id, stream);
    }
  } catch {
    // Closed
  } finally {
    reader.releaseLock();
  }
}

/**
 * Read from incoming unidirectional stream
 */
async function readIncomingStream(
  streamId: number,
  stream: ReadableStream<Uint8Array>,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      const text = decoder.decode(value);

      uniRecvStreams.value = uniRecvStreams.value.map((s) => {
        if (s.id === streamId) {
          return {
            ...s,
            messages: [
              ...s.messages,
              { direction: "recv" as const, data: text, timestamp: Date.now() },
            ],
          };
        }
        return s;
      });
    }
  } catch {
    // Stream closed
  } finally {
    reader.releaseLock();
    // Mark as closed
    uniRecvStreams.value = uniRecvStreams.value.map((s) => {
      if (s.id === streamId) {
        return { ...s, closed: true };
      }
      return s;
    });
  }
}

/**
 * Remove incoming unidirectional stream from list
 */
export function removeUniRecvStream(streamId: number): void {
  uniRecvStreams.value = uniRecvStreams.value.filter((s) => s.id !== streamId);
}

/**
 * Create a bidirectional stream
 */
export async function createBidiStream(): Promise<void> {
  const wt = transport.value;
  if (!wt) return;

  try {
    const stream = await wt.createBidirectionalStream();
    const writer = stream.writable.getWriter();
    const id = bidiStreamCounter++;

    const streamInfo: BidiStreamInfo = {
      id,
      stream,
      writer,
      messages: [],
      closed: false,
    };

    bidiStreams.value = [...bidiStreams.value, streamInfo];

    // Start reading from this stream
    void readBidiStream(id, stream.readable);
  } catch (err) {
    console.error("Failed to create bidi stream:", err);
  }
}

/**
 * Read from bidirectional stream
 */
async function readBidiStream(
  streamId: number,
  readable: ReadableStream<Uint8Array>,
): Promise<void> {
  const reader = readable.getReader();
  const decoder = new TextDecoder();

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      const text = decoder.decode(value);

      bidiStreams.value = bidiStreams.value.map((s) => {
        if (s.id === streamId) {
          return {
            ...s,
            messages: [
              ...s.messages,
              { direction: "recv" as const, data: text, timestamp: Date.now() },
            ],
          };
        }
        return s;
      });
    }
  } catch {
    // Stream closed
  } finally {
    reader.releaseLock();
  }
}

/**
 * Send message on bidirectional stream
 */
export async function sendBidiMessage(streamId: number, message: string): Promise<void> {
  const streamInfo = bidiStreams.value.find((s) => s.id === streamId);
  if (!streamInfo || streamInfo.closed) return;

  const encoder = new TextEncoder();
  const data = encoder.encode(message);

  try {
    await streamInfo.writer.write(data);

    bidiStreams.value = bidiStreams.value.map((s) => {
      if (s.id === streamId) {
        return {
          ...s,
          messages: [
            ...s.messages,
            { direction: "send" as const, data: message, timestamp: Date.now() },
          ],
        };
      }
      return s;
    });
  } catch (err) {
    console.error("Failed to send bidi message:", err);
  }
}

/**
 * Close bidirectional stream
 */
export async function closeBidiStream(streamId: number): Promise<void> {
  const streamInfo = bidiStreams.value.find((s) => s.id === streamId);
  if (!streamInfo) return;

  try {
    await streamInfo.writer.close();
  } catch {
    // ignore
  }

  bidiStreams.value = bidiStreams.value.map((s) => {
    if (s.id === streamId) {
      return { ...s, closed: true };
    }
    return s;
  });
}

/**
 * Remove bidirectional stream from list
 */
export function removeBidiStream(streamId: number): void {
  bidiStreams.value = bidiStreams.value.filter((s) => s.id !== streamId);
}

/**
 * Clear messages in bidirectional stream
 */
export function clearBidiMessages(streamId: number): void {
  bidiStreams.value = bidiStreams.value.map((s) => {
    if (s.id === streamId) {
      return { ...s, messages: [] };
    }
    return s;
  });
}

/**
 * Create a unidirectional stream
 */
export async function createUniStream(): Promise<void> {
  const wt = transport.value;
  if (!wt) return;

  try {
    const stream = await wt.createUnidirectionalStream();
    const writer = stream.getWriter();
    const id = uniSendStreamCounter++;

    const streamInfo: UniSendStreamInfo = {
      id,
      stream,
      writer,
      messages: [],
      closed: false,
    };

    uniSendStreams.value = [...uniSendStreams.value, streamInfo];
  } catch (err) {
    console.error("Failed to create uni stream:", err);
  }
}

/**
 * Send message on unidirectional stream
 */
export async function sendUniMessage(streamId: number, message: string): Promise<void> {
  const streamInfo = uniSendStreams.value.find((s) => s.id === streamId);
  if (!streamInfo || streamInfo.closed) return;

  const encoder = new TextEncoder();
  const data = encoder.encode(message);

  try {
    await streamInfo.writer.write(data);

    uniSendStreams.value = uniSendStreams.value.map((s) => {
      if (s.id === streamId) {
        return {
          ...s,
          messages: [
            ...s.messages,
            { direction: "send" as const, data: message, timestamp: Date.now() },
          ],
        };
      }
      return s;
    });
  } catch (err) {
    console.error("Failed to send uni message:", err);
  }
}

/**
 * Close unidirectional stream
 */
export async function closeUniStream(streamId: number): Promise<void> {
  const streamInfo = uniSendStreams.value.find((s) => s.id === streamId);
  if (!streamInfo) return;

  try {
    await streamInfo.writer.close();
  } catch {
    // ignore
  }

  uniSendStreams.value = uniSendStreams.value.map((s) => {
    if (s.id === streamId) {
      return { ...s, closed: true };
    }
    return s;
  });
}

/**
 * Remove unidirectional stream from list
 */
export function removeUniStream(streamId: number): void {
  uniSendStreams.value = uniSendStreams.value.filter((s) => s.id !== streamId);
}

/**
 * Clear messages in unidirectional stream
 */
export function clearUniMessages(streamId: number): void {
  uniSendStreams.value = uniSendStreams.value.map((s) => {
    if (s.id === streamId) {
      return { ...s, messages: [] };
    }
    return s;
  });
}

/**
 * Send datagram
 */
export async function sendDatagram(message: string): Promise<void> {
  const wt = transport.value;
  if (!wt) return;

  const encoder = new TextEncoder();
  const data = encoder.encode(message);

  try {
    // biome-ignore lint/suspicious/noExplicitAny: WebTransport API の仕様差異を吸収する
    const datagrams = wt.datagrams as any;
    // 最新仕様: createWritable() メソッド (Safari 26.4)
    // 旧仕様: writable プロパティ (Chrome)
    const writable =
      typeof datagrams.createWritable === "function"
        ? datagrams.createWritable()
        : datagrams.writable;
    if (!writable) {
      console.error("Failed to send datagram: no writable available");
      return;
    }
    const writer = writable.getWriter();
    await writer.write(data);
    writer.releaseLock();

    datagramMessages.value = [
      ...datagramMessages.value,
      { direction: "send", data: message, timestamp: Date.now() },
    ];
  } catch (err) {
    console.error("Failed to send datagram:", err);
  }
}
