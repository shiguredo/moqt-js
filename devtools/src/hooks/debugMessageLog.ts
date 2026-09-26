import type { DebugMessage } from "moqt-js";
import { addLog } from "../signals/debugLog";

/**
 * ログへコピーする payload の上限 (byte)
 *
 * 120 fps や 4K の映像では 1 Object が数十 KB になり、毎 Object の payload を
 * コピーするとメインスレッドの負荷で再生がかくつく。上限を超える payload は
 * コピーせず、サイズ (payloadSize) だけをログに残す。
 */
const MAX_LOGGED_PAYLOAD_BYTES = 4096;

/**
 * payload に AUTHORIZATION_TOKEN を載せうるメッセージの名前
 *
 * draft-ietf-moq-transport-21 §9.1.4 (SETUP の AUTHORIZATION TOKEN Setup Option) と
 * §9.20.3 (AUTHORIZATION_TOKEN Message Parameter) により、次のメッセージの payload には
 * 認可トークンの値が入りうる。名前は moqt-js が `DebugMessage.typeName` に載せる値
 * (`getMessageTypeName` の逆引き) に合わせる。
 * テストが moqt-js のメッセージ型と突き合わせて、名前がずれたら落ちるようにしてある。
 */
const CREDENTIAL_MESSAGE_TYPE_NAMES: ReadonlySet<string> = new Set([
  "SETUP",
  "PUBLISH",
  "SUBSCRIBE",
  "FETCH",
  "TRACK_STATUS",
  "PUBLISH_NAMESPACE",
  "SUBSCRIBE_NAMESPACE",
  "SUBSCRIBE_TRACKS",
  "REQUEST_UPDATE",
]);

/**
 * payload をログへ残してよいか
 *
 * 認可トークンを載せうるメッセージは残さない。payload からトークンのバイト範囲は
 * 特定できないため、hex dump の一部だけを伏せることはできない。残さなければ
 * 画面の Binary タブ、行コピー、Copy for LLM のどこにも値が出ない。
 * 何バイトだったかは `data` の `payloadSize` で読める。
 */
function canStorePayload(message: DebugMessage): boolean {
  return !CREDENTIAL_MESSAGE_TYPE_NAMES.has(message.typeName);
}

/**
 * DebugMessage をログパネルへ 1 件追加する。
 *
 * `prefix` はどの接続のログかを示す識別子で、Publisher は `[publisher]`、
 * Subscriber は `[subscriber-1]` のような ID を渡す。
 */
export function logDebugMessage(prefix: string, message: DebugMessage): void {
  const direction = message.direction === "send" ? "SEND" : "RECV";
  const logMessage = `${prefix} [${direction}] ${message.typeName}`;

  const data: Record<string, unknown> = {
    type: message.type,
    payloadSize: message.payload.length,
  };

  if (message.decoded) {
    Object.assign(data, message.decoded);
  }

  // moqt-js の DebugMessage.payload はライフタイム契約が JSDoc 上明文化されて
  // いないため、ログ保持 (最大 MAX_LOGS 件) に備えて独立 Uint8Array へコピーする。
  // new Uint8Array(typedArray) は新規 ArrayBuffer を確保した独立コピーを返す
  // (TC39 ECMA-262 %TypedArray%(typedArray) 抽象操作)。
  // 上限を超える payload と、認可トークンを載せうるメッセージの payload はコピーしない
  const payload =
    canStorePayload(message) &&
    message.payload.length > 0 &&
    message.payload.length <= MAX_LOGGED_PAYLOAD_BYTES
      ? new Uint8Array(message.payload)
      : undefined;
  addLog("info", logMessage, data, payload);
}
