// WebTransport API の静的存在確認
//
// 接続前にネットワーク I/O を行わず、ページロード時に 1 回だけ評価する。
// 仕様根拠: W3C WebTransport Candidate Recommendation Snapshot (2026-07-30)
//   https://www.w3.org/TR/webtransport/
//
// このモジュールが判定するのは「API が存在するか」だけであり、動作・値・例外は保証しない。
// 接続後にしか検証できない項目 (統計の呼び出し、サーバー起点ストリーム、BYOB リーダー、
// datagram のサイズ上限など) はここでは扱わない。接続成功時の任意の実行時チェックに回す。
//
// 評価対象は globalThis (ブラウザでは window) であり、テストでは Node の globalThis を
// そのまま渡せる。モックやスタブは使わない。

export interface StaticApiCheck {
  name: string;
  supported: boolean;
  // 仕様上 deprecated とされ、後継 API に置き換えられた項目を true にする
  // 新ブラウザでは消えているのが期待されるため、未対応でも赤表示にしない
  deprecated?: boolean;
  // サマリの母集団から外す項目を true にする
  // 対になる API (writable と createWritable など) を個別に数えると、実装差で
  // サマリが実態より悪く見えるため、代表となる項目だけを数える
  excludeFromSummary?: boolean;
  // このAPIが無ければ WebTransport 自体が使えないことを示す項目に付ける
  // サマリの unsupported 判定は名前の文字列ではなくこのフラグで行う
  required?: boolean;
  // 補足注記 (「use createWritable」などの移行先案内に利用する)
  note?: string;
  // 機能の 1 行解説 (英語)
  description?: string;
}

export interface StaticApiGroup {
  name: string;
  items: StaticApiCheck[];
}

// サマリの 3 状態
export type ApiPresenceState = "all" | "partial" | "unsupported";

export interface ApiPresenceSummary {
  state: ApiPresenceState;
  // サマリの母集団に含まれる項目のうち、存在が確認できた数
  presentCount: number;
  // サマリの母集団に含まれる項目数
  totalCount: number;
}

/**
 * ブラウザの globalThis 上で WebTransport API の存在を評価する
 *
 * - グローバル / コンストラクタの存在
 * - プロトタイプ上のメンバー
 * - コンストラクタの静的メンバー
 * だけを見る。インスタンス生成やネットワークアクセスは行わない。
 * ただし WebTransportError のコンストラクタだけは、ネットワークを使わずに
 * 生成と既定値 (source === "stream") を確認できるため、存在確認の一部として試す。
 */
export function detectStaticApiPresence(): StaticApiGroup[] {
  const globalScope = globalThis as unknown as Record<string, unknown>;
  const hasGlobal = (name: string): boolean => name in globalScope;

  const ctorOf = (name: string): unknown => globalScope[name];

  // コンストラクタが持つプロトタイプ上のメンバーか
  const hasOnProto = (ctor: unknown, member: string): boolean => {
    // null と undefined の双方を弾く (未実装ブラウザでは global 自体が存在しない)
    if (typeof ctor !== "function") return false;
    const proto = (ctor as { prototype?: object }).prototype;
    if (proto === null || proto === undefined) return false;
    return member in proto;
  };

  // コンストラクタの静的メンバーか
  const hasOnStatic = (ctor: unknown, member: string): boolean => {
    if (typeof ctor !== "function") return false;
    return member in (ctor as object);
  };

  // noPropertyAccessFromIndexSignature が有効なため、index signature 経由の
  // アクセスはブラケット記法で行う
  const WT = ctorOf("WebTransport");
  const DDuplex = ctorOf("WebTransportDatagramDuplexStream");
  const BidiStream = ctorOf("WebTransportBidirectionalStream");
  const SendStream = ctorOf("WebTransportSendStream");
  const RecvStream = ctorOf("WebTransportReceiveStream");
  const SendGroup = ctorOf("WebTransportSendGroup");
  const DatagramsWritable = ctorOf("WebTransportDatagramsWritable");
  const Writer = ctorOf("WebTransportWriter");
  const WTError = ctorOf("WebTransportError");

  // writable (旧 API) と createWritable (現行 API) のどちらかが存在すれば
  // datagram の送信経路は使える。Chrome は writable のみ、Safari は createWritable のみ
  const hasDatagramSendPath =
    hasOnProto(DDuplex, "writable") || hasOnProto(DDuplex, "createWritable");

  // WebTransportSendStream.getWriter は WritableStream を継承するため、単なる `in` では
  // 常に真になる。仕様が定めるのは WebTransportWriter を返す上書き実装なので、
  // WebTransportWriter の存在を必須にしたうえで上書きされていることまで確認する
  const writableStreamCtor = ctorOf("WritableStream");
  const writableStreamGetWriter =
    typeof writableStreamCtor === "function"
      ? (writableStreamCtor as { prototype?: { getWriter?: unknown } }).prototype?.getWriter
      : undefined;
  const sendStreamGetWriter =
    typeof SendStream === "function"
      ? (SendStream as { prototype?: { getWriter?: unknown } }).prototype?.getWriter
      : undefined;
  const hasWebTransportWriterGetWriter =
    hasGlobal("WebTransportWriter") &&
    typeof sendStreamGetWriter === "function" &&
    sendStreamGetWriter !== writableStreamGetWriter;

  // WebTransportError はネットワークを使わずに生成できるため、コンストラクタと既定値を
  // 実際に試して確認する (source の既定値は "stream"。W3C §12)
  const supportsWebTransportErrorConstruction = (): boolean => {
    if (typeof WTError !== "function") return false;
    try {
      const error = new (WTError as new () => { name?: string; source?: string })();
      return error.name === "WebTransportError" && error.source === "stream";
    } catch {
      return false;
    }
  };

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
          required: true,
          description: "Main class representing a WebTransport session",
        },
        {
          name: "WebTransportError",
          supported: hasGlobal("WebTransportError"),
          description: "DOMException subclass carrying WebTransport-specific error details",
        },
        {
          name: "WebTransportBidirectionalStream",
          supported: hasGlobal("WebTransportBidirectionalStream"),
          description: "Bidirectional stream (a readable / writable pair)",
        },
        {
          name: "WebTransportReceiveStream",
          supported: hasGlobal("WebTransportReceiveStream"),
          description: "Receive-only ReadableStream subclass (with getStats)",
        },
        {
          name: "WebTransportSendStream",
          supported: hasGlobal("WebTransportSendStream"),
          description: "Send-only WritableStream subclass (with sendOrder / getStats)",
        },
        {
          name: "WebTransportSendGroup",
          supported: hasGlobal("WebTransportSendGroup"),
          description: "Group that coordinates the send order of multiple streams",
        },
        {
          name: "WebTransportDatagramDuplexStream",
          supported: hasGlobal("WebTransportDatagramDuplexStream"),
          description: "Duplex stream for sending and receiving datagrams",
        },
        {
          name: "WebTransportDatagramsWritable",
          supported: hasGlobal("WebTransportDatagramsWritable"),
          description:
            "Writable stream returned by datagrams.createWritable() (sendOrder / sendGroup)",
        },
        {
          name: "WebTransportWriter",
          supported: hasGlobal("WebTransportWriter"),
          description: "WritableStreamDefaultWriter subclass with atomicWrite() / commit()",
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
          description: "Promise fulfilled when the session is established",
        },
        {
          name: "WebTransport.prototype.closed",
          supported: hasOnProto(WT, "closed"),
          description: "Promise fulfilled on graceful close, rejected on abnormal termination",
        },
        {
          name: "WebTransport.prototype.close",
          supported: hasOnProto(WT, "close"),
          description: "Closes the session (closeCode / reason can be given)",
        },
        {
          name: "WebTransport.prototype.draining",
          supported: hasOnProto(WT, "draining"),
          description: "Promise fulfilled when the server requests draining",
        },
        {
          name: "WebTransport.prototype.reliability",
          supported: hasOnProto(WT, "reliability"),
          description: "Reliability mode (pending / supports-unreliable / reliable-only)",
        },
        {
          name: "WebTransport.prototype.congestionControl",
          supported: hasOnProto(WT, "congestionControl"),
          description: "Congestion control in effect (default / throughput / low-latency)",
        },
        {
          name: "WebTransport.prototype.protocol",
          supported: hasOnProto(WT, "protocol"),
          description: "Application protocol selected by the server",
        },
        {
          name: "WebTransport.prototype.responseHeaders",
          supported: hasOnProto(WT, "responseHeaders"),
          description: "HTTP response headers from the server after the session is established",
        },
        {
          name: "WebTransport.prototype.anticipatedConcurrentIncomingUnidirectionalStreams",
          supported: hasOnProto(WT, "anticipatedConcurrentIncomingUnidirectionalStreams"),
          description: "Hint for the expected number of concurrent incoming unidirectional streams",
        },
        {
          name: "WebTransport.prototype.anticipatedConcurrentIncomingBidirectionalStreams",
          supported: hasOnProto(WT, "anticipatedConcurrentIncomingBidirectionalStreams"),
          description: "Hint for the expected number of concurrent incoming bidirectional streams",
        },
        {
          name: "WebTransport.prototype.datagrams",
          supported: hasOnProto(WT, "datagrams"),
          description:
            "Accessor for sending and receiving datagrams (WebTransportDatagramDuplexStream)",
        },
        {
          name: "WebTransport.prototype.createBidirectionalStream",
          supported: hasOnProto(WT, "createBidirectionalStream"),
          description: "Creates a new bidirectional stream",
        },
        {
          name: "WebTransport.prototype.createUnidirectionalStream",
          supported: hasOnProto(WT, "createUnidirectionalStream"),
          description: "Creates a new send-only (unidirectional) stream",
        },
        {
          name: "WebTransport.prototype.incomingBidirectionalStreams",
          supported: hasOnProto(WT, "incomingBidirectionalStreams"),
          description: "ReadableStream of bidirectional streams received from the server",
        },
        {
          name: "WebTransport.prototype.incomingUnidirectionalStreams",
          supported: hasOnProto(WT, "incomingUnidirectionalStreams"),
          description: "ReadableStream of unidirectional streams received from the server",
        },
        {
          name: "WebTransport.prototype.createSendGroup",
          supported: hasOnProto(WT, "createSendGroup"),
          description: "Creates a new WebTransportSendGroup",
        },
        {
          name: "WebTransport.prototype.getStats",
          supported: hasOnProto(WT, "getStats"),
          description: "Gets session statistics asynchronously",
        },
        {
          name: "WebTransport.prototype.exportKeyingMaterial",
          supported: hasOnProto(WT, "exportKeyingMaterial"),
          description: "Exports TLS keying material for the underlying connection",
        },
        {
          name: "WebTransport.supportsReliableOnly",
          supported: hasOnStatic(WT, "supportsReliableOnly"),
          description: "Static flag indicating support for reliable-only mode",
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
          description: "ReadableStream for incoming datagrams",
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
          description:
            "WritableStream for outgoing datagrams (deprecated because it is a single shared stream)",
        },
        {
          // createWritable は writable と対で使われる送信経路の詳細であり、サマリでは
          // 「Datagram send path」だけを数える (実装差でサマリが実態より悪く見えるのを防ぐ)
          name: "WebTransportDatagramDuplexStream.prototype.createWritable",
          supported: hasOnProto(DDuplex, "createWritable"),
          excludeFromSummary: true,
          description:
            "Creates a WritableStream for sending on each call (concurrent sending, send order can be given)",
        },
        {
          // 送信経路の代表項目。Chrome は writable のみ、Safari は createWritable のみだが、
          // どちらかがあれば datagram は送信できる
          name: "Datagram send path (writable or createWritable)",
          supported: hasDatagramSendPath,
          description: "Either the legacy writable or the current createWritable() is available",
        },
        {
          name: "WebTransportDatagramDuplexStream.prototype.maxDatagramSize",
          supported: hasOnProto(DDuplex, "maxDatagramSize"),
          description: "Maximum datagram size that can be sent (bytes)",
        },
        {
          name: "WebTransportDatagramDuplexStream.prototype.incomingMaxAge",
          supported: hasOnProto(DDuplex, "incomingMaxAge"),
          description: "Maximum age before incoming datagrams are discarded (ms)",
        },
        {
          name: "WebTransportDatagramDuplexStream.prototype.outgoingMaxAge",
          supported: hasOnProto(DDuplex, "outgoingMaxAge"),
          description: "Maximum age before outgoing datagrams are discarded (ms)",
        },
        {
          name: "WebTransportDatagramDuplexStream.prototype.incomingMaxBufferedDatagrams",
          supported: hasOnProto(DDuplex, "incomingMaxBufferedDatagrams"),
          description: "Threshold at which the incoming queue discards from the head",
        },
        {
          name: "WebTransportDatagramDuplexStream.prototype.outgoingMaxBufferedDatagrams",
          supported: hasOnProto(DDuplex, "outgoingMaxBufferedDatagrams"),
          description: "Threshold at which the outgoing queue applies backpressure",
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
          description: "Receiving side (WebTransportReceiveStream)",
        },
        {
          name: "WebTransportBidirectionalStream.prototype.writable",
          supported: hasOnProto(BidiStream, "writable"),
          description: "Sending side (WebTransportSendStream)",
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
          description: "Send priority (integer, higher is sent first)",
        },
        {
          name: "WebTransportSendStream.prototype.sendGroup",
          supported: hasOnProto(SendStream, "sendGroup"),
          description: "WebTransportSendGroup this stream belongs to",
        },
        {
          name: "WebTransportSendStream.prototype.getStats",
          supported: hasOnProto(SendStream, "getStats"),
          description: "Gets statistics of this send stream",
        },
        {
          // 継承元の WritableStream.prototype.getWriter が `in` で真になるため、
          // WebTransportWriter を返す上書き実装かどうかまで確認する
          name: "WebTransportSendStream.prototype.getWriter",
          supported: hasWebTransportWriterGetWriter,
          description: "getWriter() is overridden and WebTransportWriter exists",
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
          description: "Gets statistics of this receive stream",
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
          description: "Gets aggregated statistics of all streams in the group",
        },
      ],
    },
    // WebTransportDatagramsWritable は createWritable() の戻り値
    // 仕様: https://www.w3.org/TR/webtransport/#datagram-writable
    // MDN: https://developer.mozilla.org/en-US/docs/Web/API/WebTransportDatagramsWritable
    {
      name: "Datagrams Writable",
      items: [
        {
          name: "WebTransportDatagramsWritable.prototype.sendGroup",
          supported: hasOnProto(DatagramsWritable, "sendGroup"),
          description: "WebTransportSendGroup this datagram writable belongs to",
        },
        {
          name: "WebTransportDatagramsWritable.prototype.sendOrder",
          supported: hasOnProto(DatagramsWritable, "sendOrder"),
          description: "Send priority for strict ordering of this datagram writable",
        },
      ],
    },
    // WebTransportWriter は WritableStreamDefaultWriter を継承
    // 仕様: https://www.w3.org/TR/webtransport/#web-transport-writer-interface
    // MDN: 独立ページは無い (WebTransportSendStream.getWriter から参照される)
    {
      name: "Writer",
      items: [
        {
          name: "WebTransportWriter.prototype.atomicWrite",
          supported: hasOnProto(Writer, "atomicWrite"),
          description: "Writes a chunk atomically with respect to the flow control window",
        },
        {
          name: "WebTransportWriter.prototype.commit",
          supported: hasOnProto(Writer, "commit"),
          description: "Commits written bytes so they are delivered even after abort",
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
          description: 'Source of the error ("session" or "stream")',
        },
        {
          name: "WebTransportError.prototype.streamErrorCode",
          supported: hasOnProto(WTError, "streamErrorCode"),
          description: "Application error code when a stream is closed (only when applicable)",
        },
        {
          // ネットワークを使わずに生成できるため、既定値まで確認する
          name: "WebTransportError constructor",
          supported: supportsWebTransportErrorConstruction(),
          description: 'new WebTransportError() works and source defaults to "stream"',
        },
      ],
    },
  ];
}

/**
 * 存在確認の結果からサマリを作る
 *
 * 母集団は deprecated と excludeFromSummary を除いた項目とする。
 * deprecated の欠落は新ブラウザでは期待される挙動であり、未対応扱いにすると誤解を招く。
 * WebTransport 本体が無ければ全て未対応と判定する。
 */
export function computePresenceSummary(groups: StaticApiGroup[]): ApiPresenceSummary {
  const currentItems = groups
    .flatMap((group) => group.items)
    .filter((item) => !item.deprecated && !item.excludeFromSummary);
  const totalCount = currentItems.length;
  const presentCount = currentItems.filter((item) => item.supported).length;

  // WebTransport 本体は required を付けた項目で識別する (名前の文字列に依存しない)
  const requiredItem = groups
    .flatMap((group) => group.items)
    .find((item) => item.required === true);
  if (requiredItem !== undefined && !requiredItem.supported) {
    return { state: "unsupported", presentCount, totalCount };
  }
  if (presentCount === totalCount) {
    return { state: "all", presentCount, totalCount };
  }
  return { state: "partial", presentCount, totalCount };
}

/** サマリのバッジ文言を返す */
export function presenceBadgeText(summary: ApiPresenceSummary): string {
  switch (summary.state) {
    case "all":
      return `All Present (${summary.totalCount} / ${summary.totalCount})`;
    case "partial":
      return `Partially Present (${summary.presentCount} / ${summary.totalCount})`;
    default:
      // "unsupported" は WebTransport 自体が存在しないことを示す
      return "WebTransport Not Present";
  }
}

/** サマリのバッジの色クラスを返す */
export function presenceBadgeClass(state: ApiPresenceState): string {
  switch (state) {
    case "all":
      return "bg-green-100 text-green-700 border-green-300";
    case "partial":
      return "bg-yellow-100 text-yellow-700 border-yellow-300";
    default:
      // "unsupported" (WebTransport 自体が存在しない) は赤で表示する
      return "bg-red-100 text-red-700 border-red-300";
  }
}
