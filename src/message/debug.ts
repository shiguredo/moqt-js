/**
 * MOQT Debug Utilities
 * draft-ietf-moq-transport-21 Section 9 (Control Messages)
 */

import { MessageType } from "./types";

/**
 * MessageType の数値から名前を取得
 */
export function getMessageTypeName(type: number): string {
  for (const [name, value] of Object.entries(MessageType)) {
    if (value === type) {
      return name;
    }
  }
  return `UNKNOWN(0x${type.toString(16)})`;
}
