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
    await wt.ready;

    transport.value = wt;
    connectionStatus.value = "connected";

    // Start receiving datagrams
    void receiveDatagrams(wt);

    // Start receiving incoming unidirectional streams
    void receiveIncomingStreams(wt);

    // Handle close
    wt.closed
      .then(() => {
        disconnect();
      })
      .catch((err: unknown) => {
        connectionError.value = (err as Error).message;
        disconnect();
      });
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
    const writer = wt.datagrams.writable.getWriter();
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
