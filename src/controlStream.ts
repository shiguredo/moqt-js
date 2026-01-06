/**
 * MOQT Control Stream
 * draft-ietf-moq-transport-15 Section 9
 *
 * Control Message Format: Type (varint) + Length (16-bit) + Payload
 */

import { decodeVarint, encodeVarint } from "./varint";

/**
 * Control Message
 */
export interface ControlMessage {
  type: number;
  payload: Uint8Array;
}

/**
 * Control Stream Reader
 * バッファリングしてメッセージを組み立てる
 */
export class ControlStreamReader {
  private buffer: Uint8Array = new Uint8Array(0);
  private finReceived = false;

  /**
   * データを供給してメッセージを取り出す
   * @returns 完全なメッセージの配列
   */
  feed(data: Uint8Array, fin = false): ControlMessage[] {
    // バッファに追加
    const newBuffer = new Uint8Array(this.buffer.length + data.length);
    newBuffer.set(this.buffer, 0);
    newBuffer.set(data, this.buffer.length);
    this.buffer = newBuffer;

    if (fin) {
      this.finReceived = true;
    }

    return this.processMessages();
  }

  /**
   * バッファをクリア
   */
  clear(): void {
    this.buffer = new Uint8Array(0);
  }

  /**
   * バッファサイズ
   */
  get bufferSize(): number {
    return this.buffer.length;
  }

  /**
   * FIN を受信したか
   */
  get isFinReceived(): boolean {
    return this.finReceived;
  }

  private processMessages(): ControlMessage[] {
    const messages: ControlMessage[] = [];

    while (true) {
      // 最低 3 バイト必要 (Type 1 バイト + Length 2 バイトの最小)
      if (this.buffer.length < 3) {
        break;
      }

      // Type (varint) をデコード
      let messageType: bigint;
      let typeConsumed: number;
      try {
        [messageType, typeConsumed] = decodeVarint(this.buffer, 0);
      } catch {
        // データ不足
        break;
      }

      // Length (16-bit big-endian) をデコード
      if (this.buffer.length < typeConsumed + 2) {
        break;
      }

      const length = (this.buffer[typeConsumed] << 8) | this.buffer[typeConsumed + 1];

      // 全体の長さを計算
      const totalLength = typeConsumed + 2 + length;
      if (this.buffer.length < totalLength) {
        break;
      }

      // Payload を取り出す
      const payload = this.buffer.slice(typeConsumed + 2, totalLength);

      // バッファから削除
      this.buffer = this.buffer.slice(totalLength);

      messages.push({
        type: Number(messageType),
        payload,
      });
    }

    return messages;
  }
}

/**
 * Control Stream Writer
 * メッセージをフレーミングしてエンコード
 */
export class ControlStreamWriter {
  /**
   * メッセージをエンコード
   */
  encode(type: number, payload: Uint8Array): Uint8Array {
    const typeBytes = encodeVarint(type);

    // Length は 16-bit big-endian
    if (payload.length > 0xffff) {
      throw new Error("Payload too large for control message");
    }
    const lengthBytes = new Uint8Array(2);
    lengthBytes[0] = (payload.length >> 8) & 0xff;
    lengthBytes[1] = payload.length & 0xff;

    // Type + Length + Payload
    const result = new Uint8Array(typeBytes.length + 2 + payload.length);
    result.set(typeBytes, 0);
    result.set(lengthBytes, typeBytes.length);
    result.set(payload, typeBytes.length + 2);

    return result;
  }

  /**
   * ControlMessage をエンコード
   */
  encodeMessage(msg: ControlMessage): Uint8Array {
    return this.encode(msg.type, msg.payload);
  }
}
