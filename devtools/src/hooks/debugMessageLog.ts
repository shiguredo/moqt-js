import type { DebugMessage } from "moqt-js";
import { MessageType } from "../../../src/message/types.ts";
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
 * payload に認可トークンを載せうるメッセージの型
 *
 * draft-ietf-moq-transport-21 §9.1.4 (SETUP の AUTHORIZATION TOKEN Setup Option) と
 * §9.20.3 (AUTHORIZATION TOKEN Parameter) により、次のメッセージの payload には認可
 * トークンの値が入りうる。判定はメッセージ型の数値で行う (表示名は変わりうるため)。
 *
 * 根拠にしている仕様はドラフトであり、将来の版で対象のメッセージが増えうる。
 * メッセージ型を足したらこの一覧を見直すこと (テストが全型の分類を強制する)。
 */
const CREDENTIAL_MESSAGE_TYPES: ReadonlySet<number> = new Set([
  MessageType.SETUP,
  MessageType.PUBLISH,
  MessageType.SUBSCRIBE,
  MessageType.FETCH,
  MessageType.TRACK_STATUS,
  MessageType.PUBLISH_NAMESPACE,
  MessageType.SUBSCRIBE_NAMESPACE,
  MessageType.SUBSCRIBE_TRACKS,
  MessageType.REQUEST_UPDATE,
]);

/**
 * payload をログへ残してよいか
 *
 * 認可トークンを載せうるメッセージは残さない。payload からトークンのバイト範囲は
 * 特定できないため、hex dump の一部だけを伏せることはできない。残さなければ
 * 画面の Binary タブ、行コピー、Copy for LLM のどこにも値が出ない。
 * 何バイトだったかは `data` の `payloadSize` で読める。
 *
 * 仕様に無い型にトークンを載せて送る peer (仕様違反) の payload は残る。
 * 自 endpoint が送るトークンはこの一覧で必ず落ちる。
 */
function canStorePayload(message: DebugMessage): boolean {
  return !CREDENTIAL_MESSAGE_TYPES.has(message.type);
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

  const storePayload = canStorePayload(message);
  const data: Record<string, unknown> = {
    type: message.type,
    payloadSize: message.payload.length,
    // payload を残さなかった理由。payload が無いメッセージと区別できるようにする
    ...(storePayload ? {} : { payloadOmitted: "authorization-token" }),
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
    storePayload && message.payload.length > 0 && message.payload.length <= MAX_LOGGED_PAYLOAD_BYTES
      ? new Uint8Array(message.payload)
      : undefined;
  addLog("info", logMessage, data, payload);
}
