import type { DebugMessage } from "moqt-js";
import { addLog } from "../components/DebugPanel";

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
  const payload = message.payload.length > 0 ? new Uint8Array(message.payload) : undefined;
  addLog("info", logMessage, data, payload);
}
