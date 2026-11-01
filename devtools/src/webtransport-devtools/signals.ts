import { signal, computed } from "@preact/signals";
import {
  appendMessage,
  clearMessageLog,
  createMessageLogFields,
  type MessageLogFields,
  type StreamMessage,
} from "./messageLog";
import { toHttpVersionLabel } from "moqt-js";
import { detectStaticApiPresence, type StaticApiGroup } from "./staticApiSupport";
import {
  buildRejectedClosedOutcome,
  buildResolvedClosedOutcome,
  type ClosedOutcome,
} from "./closedOutcome";
import {
  parseSettingsQueryString,
  buildSettingsQueryString,
  parseHeadersText,
  parseProtocolsText,
  parseAnticipatedStreams,
  parseDatagramMaxAge,
  parseMaxBufferedDatagrams,
  parseSendOrder,
  parseCloseCode,
  parseCertificateHash,
  truncateCloseReason,
  validateConnectionSettings,
  type CongestionControl,
  type DatagramsReadableType,
  type ConnectionSettings,
} from "./params";

// クエリパラメータからの初期値読み込み
function getInitialParams(): ConnectionSettings {
  return parseSettingsQueryString(window.location.search);
}

const initialParams = getInitialParams();

// 接続設定
export const url = signal(initialParams.url);
export const certificateHash = signal(initialParams.certificateHash);
export const allowPooling = signal(initialParams.allowPooling);
export const requireUnreliable = signal(initialParams.requireUnreliable);
export const congestionControl = signal<CongestionControl>(initialParams.congestionControl);
export const headersText = signal(initialParams.headersText);
export const protocolsText = signal(initialParams.protocolsText);
export const datagramsReadableType = signal<DatagramsReadableType>(
  initialParams.datagramsReadableType,
);
export const anticipatedConcurrentIncomingUnidirectionalStreams = signal(
  initialParams.anticipatedConcurrentIncomingUnidirectionalStreams,
);
export const anticipatedConcurrentIncomingBidirectionalStreams = signal(
  initialParams.anticipatedConcurrentIncomingBidirectionalStreams,
);

/**
 * 現在の設定からクエリ文字列を構築する
 */
export function buildQueryString(): string {
  const settings: ConnectionSettings = {
    url: url.value,
    certificateHash: certificateHash.value,
    allowPooling: allowPooling.value,
    requireUnreliable: requireUnreliable.value,
    congestionControl: congestionControl.value,
    headersText: headersText.value,
    protocolsText: protocolsText.value,
    datagramsReadableType: datagramsReadableType.value,
    anticipatedConcurrentIncomingUnidirectionalStreams:
      anticipatedConcurrentIncomingUnidirectionalStreams.value,
    anticipatedConcurrentIncomingBidirectionalStreams:
      anticipatedConcurrentIncomingBidirectionalStreams.value,
  };
  return buildSettingsQueryString(settings);
}

// 接続状態
export const transport = signal<WebTransport | null>(null);
export const connectionStatus = signal<"disconnected" | "connecting" | "connected" | "error">(
  "disconnected",
);
export const connectionError = signal("");

// WebTransport Promise 状態
export const wtReadyState = signal<string>("pending");
export const wtClosedState = signal<string>("pending");
export const wtDrainingState = signal<string>("pending");

// WebTransport.closed Promise の最終結果 (切断後も保持し、再接続時にクリアする)
// W3C §6.5 / §6.6: graceful close ではピア (またはローカルの close()) が渡した
// WebTransportCloseInfo で fulfill され、異常終了では WebTransportError で reject される。
// disconnect() は Promise 状態表示 (wtClosedState) をリセットするため、
// セッション終了後に closeCode / reason を確認できるよう別に保持する
export const wtClosedOutcome = signal<ClosedOutcome | null>(null);

// WebTransport プロパティ
export const wtReliability = signal<string>("");
export const wtCongestionControl = signal<string>("");
export const wtSupportsReliableOnly = signal<string>("");
export const wtProtocol = signal<string>("");
export const wtResponseHeaders = signal<string>("");

// wtReliability から派生する HTTP バージョンラベル
export const wtHttpVersion = computed(() => toHttpVersionLabel(wtReliability.value));

// WebTransport API 対応状況
export interface ApiSupportNode {
  value: string;
  children?: Record<string, ApiSupportNode>;
}
export type ApiSupport = Record<string, ApiSupportNode>;
export const wtApiSupport = signal<ApiSupport | null>(null);

// 静的な API 存在確認の結果 (接続前にネットワーク I/O なしで評価する)
// 判定の実体は staticApiSupport.ts。ここでは signal として保持するだけ
export const wtStaticApiPresence = signal<StaticApiGroup[]>(detectStaticApiPresence());

// 双方向ストリーム
export interface BidiStreamInfo extends MessageLogFields {
  id: number;
  stream: WebTransportBidirectionalStream;
  writer: WritableStreamDefaultWriter<Uint8Array>;
  closed: boolean;
}
export const bidiStreams = signal<BidiStreamInfo[]>([]);

// 送信側の単方向ストリーム
export interface UniSendStreamInfo extends MessageLogFields {
  id: number;
  stream: WebTransportSendStream;
  writer: WritableStreamDefaultWriter<Uint8Array>;
  closed: boolean;
}
export const uniSendStreams = signal<UniSendStreamInfo[]>([]);

// 受信側の単方向ストリーム
export interface UniRecvStreamInfo extends MessageLogFields {
  id: number;
  closed: boolean;
}
export const uniRecvStreams = signal<UniRecvStreamInfo[]>([]);

// データグラム。配列は破壊的に追記するため signal にしない (上の MessageLogFields と同じ扱い)
export const datagramMessages: StreamMessage[] = [];
export const datagramMessagesVersion = signal(0);

// データグラムの一覧を、ストリームと同じ追記・クリアの手順で扱えるようにする
const datagramLog: MessageLogFields = {
  messages: datagramMessages,
  messagesVersion: datagramMessagesVersion,
};

// ストリーム採番用のカウンタ
let bidiStreamCounter = 0;
let uniSendStreamCounter = 0;
let uniRecvStreamCounter = 0;

// セッション世代
// 接続ごとに増やし、古いセッションの Promise ハンドラが新しいセッションの
// transport / ストリーム / 状態を書き換えないようにする
let sessionGeneration = 0;

// 接続中と接続済みの間だけ設定を無効化する
// error 状態は入力検証の失敗でも設定されるため、設定を無効化すると不正な入力を
// 直せず復帰できなくなる
export const settingsDisabled = computed(
  () => connectionStatus.value === "connecting" || connectionStatus.value === "connected",
);

// 接続後設定 (接続中のみ適用可能)
// 入力値は仕様の setter 制約 (§5.3 / §6.10) に従って検証し、切断時にリセットする
export const datagramIncomingMaxAge = signal("");
export const datagramOutgoingMaxAge = signal("");
export const datagramIncomingMaxBufferedDatagrams = signal("");
export const datagramOutgoingMaxBufferedDatagrams = signal("");
export const closeCode = signal("");
export const closeReason = signal("");

/**
 * 接続中の WebTransport の datagrams 設定を適用する
 * W3C §5.3 の setter 制約（負値・NaN 拒否、0 は null、1 未満は 1 にクランプ）に従う
 */
export function applyDatagramSettings(): void {
  const wt = transport.value;
  if (!wt) {
    return;
  }

  const incomingMaxAgeResult = parseDatagramMaxAge(datagramIncomingMaxAge.value);
  if (!incomingMaxAgeResult.ok) {
    connectionError.value = incomingMaxAgeResult.error;
    return;
  }
  const outgoingMaxAgeResult = parseDatagramMaxAge(datagramOutgoingMaxAge.value);
  if (!outgoingMaxAgeResult.ok) {
    connectionError.value = outgoingMaxAgeResult.error;
    return;
  }
  const incomingMaxBufferedResult = parseMaxBufferedDatagrams(
    datagramIncomingMaxBufferedDatagrams.value,
  );
  if (!incomingMaxBufferedResult.ok) {
    connectionError.value = incomingMaxBufferedResult.error;
    return;
  }
  const outgoingMaxBufferedResult = parseMaxBufferedDatagrams(
    datagramOutgoingMaxBufferedDatagrams.value,
  );
  if (!outgoingMaxBufferedResult.ok) {
    connectionError.value = outgoingMaxBufferedResult.error;
    return;
  }

  // lib.dom.d.ts の WebTransportDatagramDuplexStream には無いが W3C §5.3 で定義されている
  // 属性は any 経由でアクセスする
  // biome-ignore lint/suspicious/noExplicitAny: WebTransportDatagramDuplexStream 型定義が W3C §5.3 に追従していない
  const datagrams = wt.datagrams as any;
  if (incomingMaxAgeResult.value !== undefined) {
    datagrams.incomingMaxAge = incomingMaxAgeResult.value;
  }
  if (outgoingMaxAgeResult.value !== undefined) {
    datagrams.outgoingMaxAge = outgoingMaxAgeResult.value;
  }
  if (incomingMaxBufferedResult.value !== undefined) {
    datagrams.incomingMaxBufferedDatagrams = incomingMaxBufferedResult.value;
  }
  if (outgoingMaxBufferedResult.value !== undefined) {
    datagrams.outgoingMaxBufferedDatagrams = outgoingMaxBufferedResult.value;
  }
}

/**
 * WebTransport.supportsReliableOnly を読む
 *
 * W3C §6.3 の IDL は `static readonly attribute boolean supportsReliableOnly` であり、
 * インスタンスには生えない。未実装のブラウザでは "N/A" を返す。
 */
function readStaticSupportsReliableOnly(): string {
  const ctor = (globalThis as Record<string, unknown>)["WebTransport"] as
    | { supportsReliableOnly?: unknown }
    | undefined;
  const value = ctor?.supportsReliableOnly;
  // 仕様上は boolean である。未実装のブラウザでは undefined なので N/A にする
  return typeof value === "boolean" ? String(value) : "N/A";
}

/**
 * WebTransport サーバーへ接続する
 */
export async function connect(): Promise<void> {
  if (transport.value) {
    return;
  }

  // 前回のセッション結果の表示をクリアし、今回の接続試行だけを表示する。
  // 入力検証で早期に return する場合も前回の rejected 表示を残さない
  wtClosedOutcome.value = null;
  wtReadyState.value = "pending";
  wtClosedState.value = "pending";
  wtDrainingState.value = "pending";

  // 前回セッションの Promise ハンドラを無効化する。入力検証で早期に return する
  // 場合も世代を進め、古いハンドラから状態を守る
  const generation = ++sessionGeneration;

  // 接続時設定の排他・入力検証
  // §6.9 の allowPooling と serverCertificateHashes の排他、§6.2 の headers /
  // protocols の SyntaxError / TypeError 条件を接続前に検証する
  const settings: ConnectionSettings = {
    url: url.value,
    certificateHash: certificateHash.value,
    allowPooling: allowPooling.value,
    requireUnreliable: requireUnreliable.value,
    congestionControl: congestionControl.value,
    headersText: headersText.value,
    protocolsText: protocolsText.value,
    datagramsReadableType: datagramsReadableType.value,
    anticipatedConcurrentIncomingUnidirectionalStreams:
      anticipatedConcurrentIncomingUnidirectionalStreams.value,
    anticipatedConcurrentIncomingBidirectionalStreams:
      anticipatedConcurrentIncomingBidirectionalStreams.value,
  };
  const validationError = validateConnectionSettings(settings);
  if (validationError) {
    connectionStatus.value = "error";
    connectionError.value = validationError;
    return;
  }
  const headersResult = parseHeadersText(headersText.value);
  if (!headersResult.ok) {
    connectionStatus.value = "error";
    connectionError.value = headersResult.error;
    return;
  }
  const protocolsResult = parseProtocolsText(protocolsText.value);
  if (!protocolsResult.ok) {
    connectionStatus.value = "error";
    connectionError.value = protocolsResult.error;
    return;
  }
  const anticipatedUniResult = parseAnticipatedStreams(
    anticipatedConcurrentIncomingUnidirectionalStreams.value,
  );
  if (!anticipatedUniResult.ok) {
    connectionStatus.value = "error";
    connectionError.value = anticipatedUniResult.error;
    return;
  }
  const anticipatedBidiResult = parseAnticipatedStreams(
    anticipatedConcurrentIncomingBidirectionalStreams.value,
  );
  if (!anticipatedBidiResult.ok) {
    connectionStatus.value = "error";
    connectionError.value = anticipatedBidiResult.error;
    return;
  }
  // §6.9 serverCertificateHashes の value は SHA-256 (32 byte) の Base64 である。
  // 空白だけの入力は未指定として扱う
  const certificateHashText = certificateHash.value.trim();
  const certificateHashResult = certificateHashText
    ? parseCertificateHash(certificateHashText)
    : null;
  if (certificateHashResult !== null && !certificateHashResult.ok) {
    connectionStatus.value = "error";
    connectionError.value = certificateHashResult.error;
    return;
  }

  connectionStatus.value = "connecting";
  connectionError.value = "";

  try {
    const options: WebTransportOptions = {};

    if (certificateHashResult !== null && certificateHashResult.ok) {
      options.serverCertificateHashes = [
        {
          algorithm: "sha-256",
          value: certificateHashResult.value,
        },
      ];
    }

    // lib.dom.d.ts の WebTransportOptions には無いが W3C §6.9 で定義されている
    // 辞書メンバーは any 経由で渡す
    // biome-ignore lint/suspicious/noExplicitAny: WebTransportOptions 型定義が W3C §6.9 に追従していない
    const extendedOptions = options as any;
    if (allowPooling.value) {
      extendedOptions.allowPooling = true;
    }
    if (requireUnreliable.value) {
      extendedOptions.requireUnreliable = true;
    }
    if (congestionControl.value !== "default") {
      extendedOptions.congestionControl = congestionControl.value;
    }
    if (headersResult.value && Object.keys(headersResult.value).length > 0) {
      extendedOptions.headers = headersResult.value;
    }
    if (protocolsResult.value.length > 0) {
      extendedOptions.protocols = protocolsResult.value;
    }
    if (datagramsReadableType.value === "bytes") {
      extendedOptions.datagramsReadableType = "bytes";
    }
    if (anticipatedUniResult.value !== null) {
      extendedOptions.anticipatedConcurrentIncomingUnidirectionalStreams =
        anticipatedUniResult.value;
    }
    if (anticipatedBidiResult.value !== null) {
      extendedOptions.anticipatedConcurrentIncomingBidirectionalStreams =
        anticipatedBidiResult.value;
    }

    const wt = new WebTransport(url.value, options);

    // 古いセッションのハンドラが新しいセッションの表示を書き換えないよう、
    // 世代が一致する場合だけ状態を更新する
    wt.ready
      .then(() => {
        if (generation !== sessionGeneration) return;
        wtReadyState.value = "resolved";
      })
      .catch((err: unknown) => {
        if (generation !== sessionGeneration) return;
        wtReadyState.value = `rejected: ${(err as Error).message}`;
      });

    wt.closed
      .then((closeInfo) => {
        if (generation !== sessionGeneration) return;
        wtClosedState.value = "resolved";
        // 受け取った closeInfo (closeCode / reason) は handleSessionClosed が記録する
        handleSessionClosed(buildResolvedClosedOutcome(closeInfo));
      })
      .catch((err: unknown) => {
        if (generation !== sessionGeneration) return;
        wtClosedState.value = `rejected: ${(err as Error).message}`;
        handleSessionClosed(buildRejectedClosedOutcome(err));
      });

    // TypeScript の型定義が最新仕様に追従していないため any 経由でアクセスする
    // biome-ignore lint/suspicious/noExplicitAny: WebTransport API の型定義が不完全
    const wtAny = wt as any;

    if (wtAny.draining) {
      (wtAny.draining as Promise<undefined>)
        .then(() => {
          if (generation !== sessionGeneration) return;
          wtDrainingState.value = "resolved";
        })
        .catch((err: unknown) => {
          if (generation !== sessionGeneration) return;
          wtDrainingState.value = `rejected: ${(err as Error).message}`;
        });
    } else {
      wtDrainingState.value = "N/A";
    }

    await wt.ready;

    // 接続待ちの間に次の接続試行が始まった場合は、このセッションを閉じて終了する
    if (generation !== sessionGeneration) {
      try {
        wt.close();
      } catch {
        // 無視する
      }
      return;
    }
    // ready の解決直後に closed が確定した場合は、閉じたセッションを connected にしない
    if (wtClosedState.value !== "pending") {
      return;
    }

    transport.value = wt;
    connectionStatus.value = "connected";

    // セッション確立後のプロパティを取得する
    wtReliability.value = String(wtAny.reliability ?? "N/A");
    wtCongestionControl.value = String(wtAny.congestionControl ?? "N/A");
    wtSupportsReliableOnly.value = readStaticSupportsReliableOnly();
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
        // typeof で object に絞り込まれているため、アサーションは不要
        const constructorName = val?.constructor?.name;
        return constructorName ?? "object";
      }
      return valueType;
    };
    // 親オブジェクトから単一プロパティを取り出すノードを作る
    const makeLeaf = (parent: unknown, prop: string): ApiSupportNode => {
      if (parent === null || parent === undefined) return { value: "N/A (parent is null)" };
      return { value: inspect((parent as Record<string, unknown>)[prop]) };
    };
    // object 型なら指定した子プロパティを再帰的に展開する
    const makeNode = (parent: unknown, prop: string, childProps?: string[]): ApiSupportNode => {
      if (parent === null || parent === undefined) return { value: "N/A (parent is null)" };
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

    // 受信側の単方向ストリームの受信を開始する
    void receiveIncomingStreams(wt);
  } catch (err) {
    if (generation !== sessionGeneration) return;
    connectionStatus.value = "error";
    connectionError.value = (err as Error).message;
  }
}

/**
 * セッションに紐づくリソースと接続後設定を初期化する
 *
 * ready / closed / draining の Promise 状態は呼び出し側で扱う。接続失敗時は
 * 失敗理由を表示に残す必要があるため、ここでは触らない。
 */
function resetSessionResources(): void {
  transport.value = null;

  // ストリーム一覧をクリアする
  bidiStreams.value = [];
  uniSendStreams.value = [];
  uniRecvStreams.value = [];
  clearMessageLog(datagramLog);
  bidiStreamCounter = 0;
  uniSendStreamCounter = 0;
  uniRecvStreamCounter = 0;

  // 接続後設定をリセットする
  datagramIncomingMaxAge.value = "";
  datagramOutgoingMaxAge.value = "";
  datagramIncomingMaxBufferedDatagrams.value = "";
  datagramOutgoingMaxBufferedDatagrams.value = "";
  closeCode.value = "";
  closeReason.value = "";

  wtReliability.value = "";
  wtCongestionControl.value = "";
  wtSupportsReliableOnly.value = "";
  wtProtocol.value = "";
  wtResponseHeaders.value = "";
  wtApiSupport.value = null;
}

/**
 * WebTransport.closed が確定したときの後始末
 *
 * ハンドシェイク失敗などの異常終了では connectionStatus を error にして失敗を明示する。
 * ready / closed / draining の状態表示は、失敗理由を UI に残すため触らない。
 */
function handleSessionClosed(outcome: ClosedOutcome): void {
  // closed が確定した時点でセッションは閉じているため close() は呼ばない
  resetSessionResources();
  wtClosedOutcome.value = outcome;

  if (outcome.state === "rejected") {
    connectionStatus.value = "error";
    connectionError.value = outcome.errorMessage ?? "WebTransport session failed";
    return;
  }

  // 正常終了 (利用者操作またはサーバー主導) は切断として扱う
  connectionStatus.value = "disconnected";
  connectionError.value = "";
}

/**
 * WebTransport サーバーから切断する
 * ユーザー操作による切断の場合のみ closeInfo を渡す（サーバー起因の切断では渡さない）
 */
export function disconnect(closeInfo?: WebTransportCloseInfo): void {
  if (transport.value) {
    try {
      transport.value.close(closeInfo);
    } catch {
      // 無視する
    }
  }

  resetSessionResources();
  connectionStatus.value = "disconnected";
  connectionError.value = "";
  wtReadyState.value = "pending";
  wtClosedState.value = "pending";
  wtDrainingState.value = "pending";

  // wtClosedOutcome (closed Promise の close info) は意図的にリセットしない。
  // セッション終了後もピアから受け取った closeCode / reason を UI と
  // ブラウザ E2E から確認できるようにするため。クリアは次回の connect() が行う
}

/**
 * closeCode / reason の入力から WebTransportCloseInfo を構築する
 * 空入力のフィールドは含めない。入力が不正な場合は null を返す
 */
export function buildCloseInfo(): WebTransportCloseInfo | null {
  const closeInfo: WebTransportCloseInfo = {};
  const codeResult = parseCloseCode(closeCode.value);
  if (!codeResult.ok) {
    return null;
  }
  if (codeResult.value !== undefined) {
    closeInfo.closeCode = codeResult.value;
  }
  const reason = closeReason.value.trim();
  if (reason) {
    // W3C §6.4 step 6: UTF-8 で 1024 byte を超えない最大の code unit prefix を渡す
    closeInfo.reason = truncateCloseReason(reason).text;
  }
  if (closeInfo.closeCode === undefined && closeInfo.reason === undefined) {
    return null;
  }
  return closeInfo;
}

/**
 * データグラムを受信する
 */
async function receiveDatagrams(wt: WebTransport): Promise<void> {
  const reader = wt.datagrams.readable.getReader();

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      const decoder = new TextDecoder();
      const text = decoder.decode(value);

      appendMessage(datagramLog, "recv", text);
    }
  } catch {
    // ストリームが閉じられた
  } finally {
    reader.releaseLock();
  }
}

/**
 * データグラムメッセージをクリアする
 */
export function clearDatagramMessages(): void {
  clearMessageLog(datagramLog);
}

/**
 * 受信側の単方向ストリームを受信する
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
        ...createMessageLogFields(),
        closed: false,
      };

      uniRecvStreams.value = [...uniRecvStreams.value, streamInfo];
      void readIncomingStream(id, stream);
    }
  } catch {
    // 閉じられた
  } finally {
    reader.releaseLock();
  }
}

/**
 * 受信側の単方向ストリームから読み出す
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

      // 対象のストリームの一覧へ追記する。配列を作り直さないため、ほかの
      // ストリームとパネルは再描画されない
      const streamInfo = uniRecvStreams.value.find((s) => s.id === streamId);
      if (streamInfo) {
        appendMessage(streamInfo, "recv", text);
      }
    }
  } catch {
    // ストリームが閉じられた
  } finally {
    reader.releaseLock();
    // 閉じたものとして記録する
    uniRecvStreams.value = uniRecvStreams.value.map((s) => {
      if (s.id === streamId) {
        return { ...s, closed: true };
      }
      return s;
    });
  }
}

/**
 * 受信側の単方向ストリームを一覧から削除する
 */
export function removeUniRecvStream(streamId: number): void {
  uniRecvStreams.value = uniRecvStreams.value.filter((s) => s.id !== streamId);
}

// ストリーム作成時設定 (W3C §6.11 / §6.12)
// New Stream ボタン付近の入力欄と連動する
export const streamSendOrder = signal("");
export const streamWaitUntilAvailable = signal(false);

/**
 * 双方向ストリームを作成する
 */
export async function createBidiStream(): Promise<void> {
  const wt = transport.value;
  if (!wt) return;

  // ストリーム作成時設定を検証してオプションを構築する
  // W3C §6.11 sendOrder / §6.12 waitUntilAvailable
  const sendOrderResult = parseSendOrder(streamSendOrder.value);
  if (!sendOrderResult.ok) {
    connectionError.value = sendOrderResult.error;
    return;
  }

  try {
    const options: WebTransportSendStreamOptions = {};
    if (sendOrderResult.value !== undefined) {
      options.sendOrder = sendOrderResult.value;
    }
    // lib.dom.d.ts の WebTransportSendStreamOptions には無いが W3C §6.12 で定義されている
    // biome-ignore lint/suspicious/noExplicitAny: WebTransportSendStreamOptions 型定義が W3C §6.12 に追従していない
    const extendedOptions = options as any;
    if (streamWaitUntilAvailable.value) {
      extendedOptions.waitUntilAvailable = true;
    }

    const stream = await wt.createBidirectionalStream(extendedOptions);
    const writer = stream.writable.getWriter();
    const id = bidiStreamCounter++;

    const streamInfo: BidiStreamInfo = {
      id,
      stream,
      writer,
      ...createMessageLogFields(),
      closed: false,
    };

    bidiStreams.value = [...bidiStreams.value, streamInfo];

    // このストリームからの読み出しを開始する
    void readBidiStream(id, stream.readable);
  } catch (err) {
    console.error("Failed to create bidi stream:", err);
  }
}

/**
 * 双方向ストリームから読み出す
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

      const streamInfo = bidiStreams.value.find((s) => s.id === streamId);
      if (streamInfo) {
        appendMessage(streamInfo, "recv", text);
      }
    }
  } catch {
    // ストリームが閉じられた
  } finally {
    reader.releaseLock();
  }
}

/**
 * 双方向ストリームへメッセージを送信する
 */
export async function sendBidiMessage(streamId: number, message: string): Promise<void> {
  const streamInfo = bidiStreams.value.find((s) => s.id === streamId);
  if (!streamInfo || streamInfo.closed) return;

  const encoder = new TextEncoder();
  const data = encoder.encode(message);

  try {
    await streamInfo.writer.write(data);

    appendMessage(streamInfo, "send", message);
  } catch (err) {
    console.error("Failed to send bidi message:", err);
  }
}

/**
 * 双方向ストリームを閉じる
 */
export async function closeBidiStream(streamId: number): Promise<void> {
  const streamInfo = bidiStreams.value.find((s) => s.id === streamId);
  if (!streamInfo) return;

  try {
    await streamInfo.writer.close();
  } catch {
    // 無視する
  }

  bidiStreams.value = bidiStreams.value.map((s) => {
    if (s.id === streamId) {
      return { ...s, closed: true };
    }
    return s;
  });
}

/**
 * 双方向ストリームを一覧から削除する
 */
export function removeBidiStream(streamId: number): void {
  bidiStreams.value = bidiStreams.value.filter((s) => s.id !== streamId);
}

/**
 * 双方向ストリームのメッセージをクリアする
 */
export function clearBidiMessages(streamId: number): void {
  const streamInfo = bidiStreams.value.find((s) => s.id === streamId);
  if (streamInfo) {
    clearMessageLog(streamInfo);
  }
}

/**
 * 単方向ストリームを作成する
 */
export async function createUniStream(): Promise<void> {
  const wt = transport.value;
  if (!wt) return;

  // ストリーム作成時設定を検証してオプションを構築する
  // W3C §6.11 sendOrder / §6.12 waitUntilAvailable
  const sendOrderResult = parseSendOrder(streamSendOrder.value);
  if (!sendOrderResult.ok) {
    connectionError.value = sendOrderResult.error;
    return;
  }

  try {
    const options: WebTransportSendStreamOptions = {};
    if (sendOrderResult.value !== undefined) {
      options.sendOrder = sendOrderResult.value;
    }
    // lib.dom.d.ts の WebTransportSendStreamOptions には無いが W3C §6.12 で定義されている
    // biome-ignore lint/suspicious/noExplicitAny: WebTransportSendStreamOptions 型定義が W3C §6.12 に追従していない
    const extendedOptions = options as any;
    if (streamWaitUntilAvailable.value) {
      extendedOptions.waitUntilAvailable = true;
    }

    const stream = await wt.createUnidirectionalStream(extendedOptions);
    const writer = stream.getWriter();
    const id = uniSendStreamCounter++;

    const streamInfo: UniSendStreamInfo = {
      id,
      stream,
      writer,
      ...createMessageLogFields(),
      closed: false,
    };

    uniSendStreams.value = [...uniSendStreams.value, streamInfo];
  } catch (err) {
    console.error("Failed to create uni stream:", err);
  }
}

/**
 * 単方向ストリームへメッセージを送信する
 */
export async function sendUniMessage(streamId: number, message: string): Promise<void> {
  const streamInfo = uniSendStreams.value.find((s) => s.id === streamId);
  if (!streamInfo || streamInfo.closed) return;

  const encoder = new TextEncoder();
  const data = encoder.encode(message);

  try {
    await streamInfo.writer.write(data);

    appendMessage(streamInfo, "send", message);
  } catch (err) {
    console.error("Failed to send uni message:", err);
  }
}

/**
 * 単方向ストリームを閉じる
 */
export async function closeUniStream(streamId: number): Promise<void> {
  const streamInfo = uniSendStreams.value.find((s) => s.id === streamId);
  if (!streamInfo) return;

  try {
    await streamInfo.writer.close();
  } catch {
    // 無視する
  }

  uniSendStreams.value = uniSendStreams.value.map((s) => {
    if (s.id === streamId) {
      return { ...s, closed: true };
    }
    return s;
  });
}

/**
 * 単方向ストリームを一覧から削除する
 */
export function removeUniStream(streamId: number): void {
  uniSendStreams.value = uniSendStreams.value.filter((s) => s.id !== streamId);
}

/**
 * 単方向ストリームのメッセージをクリアする
 */
export function clearUniMessages(streamId: number): void {
  const streamInfo = uniSendStreams.value.find((s) => s.id === streamId);
  if (streamInfo) {
    clearMessageLog(streamInfo);
  }
}

/**
 * データグラムを送信する
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

    appendMessage(datagramLog, "send", message);
  } catch (err) {
    console.error("Failed to send datagram:", err);
  }
}
