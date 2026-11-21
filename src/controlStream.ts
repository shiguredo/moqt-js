/**
 * MOQT Control Stream
 * draft-ietf-moq-transport-23 Section 9 (Control Messages)
 *
 * Control Message Format: Type (vi64) + Message Length (vi64) + Message Body
 *
 * Message Length は Message Body のバイト長であり、制御ストリームとすべての
 * リクエストストリームでこの形式を使う。受信側は自分が広告した
 * MAX_CONTROL_MESSAGE_SIZE を上限に、送信側はピアが広告した
 * MAX_CONTROL_MESSAGE_SIZE を上限にする (draft-ietf-moq-transport-23 §9.1.8)。
 */

import { ReceiveBuffer } from "./bytes";
import { IncompleteDataError, SessionError, SessionErrorCode } from "./error";
import { DEFAULT_MAX_CONTROL_MESSAGE_SIZE } from "./message/types";
import { decodeVarint, encodeVarint } from "./varint";

/**
 * Control Message
 */
export interface ControlMessage {
  type: number;
  payload: Uint8Array;
}

/**
 * Message Length の上限として使える値かを検証する
 *
 * 本文長は JS の数値で比較するため、0 以上の安全な整数でなければならない。
 * 負値・小数・NaN・Number.MAX_SAFE_INTEGER 超は上限として扱えない。
 *
 * これはフレーミング層の低レベル API の検証であり、接続経路では
 * SETUP 層の assertMaxControlMessageSize が 65535 以上を保証してから渡す。
 *
 * @throws Error - 0 以上の安全な整数でない場合
 */
function assertMaxMessageSize(maxMessageSize: number): void {
  if (!Number.isSafeInteger(maxMessageSize) || maxMessageSize < 0) {
    throw new Error(`maxMessageSize must be a non-negative safe integer, got ${maxMessageSize}`);
  }
}

interface ControlFrameHeader {
  type: number;
  headerLength: number;
  bodyLength: number;
}

/**
 * Control Stream Reader
 *
 * 受信上限は自 endpoint が SETUP で広告した MAX_CONTROL_MESSAGE_SIZE である。
 * ピアの SETUP を受信する前でも、SETUP 自身を含めてこの上限を適用する
 * (draft-ietf-moq-transport-23 §9.1.8)。
 */
export class ControlStreamReader {
  private readonly buffer = new ReceiveBuffer();
  private pendingHeader: ControlFrameHeader | undefined;
  // Number に丸める前に、vi64 の本文長を上限と比較する。
  private readonly maxMessageSizeBigInt: bigint;

  /** 自 endpoint が許可する Message Length の上限を指定する。 */
  constructor(private readonly maxMessageSize: number = DEFAULT_MAX_CONTROL_MESSAGE_SIZE) {
    assertMaxMessageSize(maxMessageSize);
    this.maxMessageSizeBigInt = BigInt(maxMessageSize);
  }

  /**
   * 完全なメッセージを取り出し、未完の末尾だけを保持する。
   * 宣言長が上限を超えたら本文を待たず FIELD_LENGTH_EXCEEDED を投げる (§9)。
   */
  feed(input: Uint8Array): ControlMessage[] {
    const messages: ControlMessage[] = [];
    if (input.length === 0) return messages;

    // 受信チャンクに完全なフレームが収まる場合は、チャンク全体のコピーが不要。
    const buffered = this.hasBufferedBytes;
    let pending = this.pendingHeader;
    if (buffered) {
      this.buffer.append(input);
      if (
        pending !== undefined &&
        pending.bodyLength > this.buffer.byteLength - pending.headerLength
      ) {
        return messages;
      }
    }
    const data = buffered ? this.buffer.view() : input;
    let offset = 0;

    while (offset < data.length) {
      let type: number;
      let headerLength: number;
      let bodyLength: number;
      if (pending !== undefined) {
        ({ type, headerLength, bodyLength } = pending);
      } else {
        let declaredLength: bigint;
        try {
          const [messageType, typeLength] = decodeVarint(data, offset);
          const [length, lengthSize] = decodeVarint(data, offset + typeLength);
          type = Number(messageType);
          headerLength = typeLength + lengthSize;
          declaredLength = length;
        } catch (error) {
          if (error instanceof IncompleteDataError) break;
          throw error;
        }
        if (declaredLength > this.maxMessageSizeBigInt) {
          this.clear();
          throw new SessionError(
            `control message length ${declaredLength} exceeds local maximum ${this.maxMessageSize}`,
            SessionErrorCode.FIELD_LENGTH_EXCEEDED,
          );
        }
        bodyLength = Number(declaredLength);
      }

      const bodyStart = offset + headerLength;
      if (bodyLength > data.length - bodyStart) {
        // 本文が分割されても、完成した Type と Length は読み直さない。
        pending ??= { type, headerLength, bodyLength };
        break;
      }
      const end = bodyStart + bodyLength;
      // 入力やバッファが再利用されても、返却済みの本文は独立している。
      messages.push({ type, payload: data.slice(bodyStart, end) });
      offset = end;
      pending = undefined;
    }

    this.pendingHeader = pending;
    if (buffered) {
      this.buffer.consume(offset);
    } else if (offset < data.length) {
      this.buffer.append(data.subarray(offset));
    }
    return messages;
  }

  clear(): void {
    this.buffer.clear();
    this.pendingHeader = undefined;
  }

  /** 受信した FIN が完全なメッセージの境界にあることを確認する (§9)。 */
  assertFrameBoundary(): void {
    if (this.hasBufferedBytes) {
      throw new SessionError(
        `stream ended in a partial control message: ${this.bufferedBytes} bytes buffered`,
        SessionErrorCode.MALFORMED_MESSAGE,
      );
    }
  }

  /** 半端なメッセージが残っている間は、次の受信を待つ。 */
  get hasBufferedBytes(): boolean {
    return this.buffer.byteLength > 0;
  }

  get bufferedBytes(): number {
    return this.buffer.byteLength;
  }
}

/**
 * Control Stream Writer
 * メッセージをフレーミングしてエンコード
 *
 * 送信上限はピアが SETUP で広告した MAX_CONTROL_MESSAGE_SIZE である。
 * ピアの SETUP を受信する前は既定値 65535 を使う
 * (draft-ietf-moq-transport-23 §9.1.8)。SETUP 受信後に上限が判明したら
 * setMaxMessageSize で更新する。
 */
export class ControlStreamWriter {
  /**
   * ピアが許可する Message Length (本文長) の上限
   *
   * 現在の接続で使う writer は、ピアの SETUP を受信した時点で更新する。
   * 外部からは maxMessageSize の getter と setMaxMessageSize 経由でだけ扱う。
   */
  private maxMessageSizeValue: number;

  constructor(maxMessageSize: number = DEFAULT_MAX_CONTROL_MESSAGE_SIZE) {
    assertMaxMessageSize(maxMessageSize);
    this.maxMessageSizeValue = maxMessageSize;
  }

  /**
   * ピアが許可する Message Length (本文長) の上限
   */
  get maxMessageSize(): number {
    return this.maxMessageSizeValue;
  }

  /**
   * ピアが許可する Message Length (本文長) の上限を更新する
   *
   * ピアの SETUP を受信して広告値が判明した時点で呼ぶ。値は 0 以上
   * Number.MAX_SAFE_INTEGER 以下の安全な整数でなければならない
   * (本文長は JS の数値で比較するため)。
   *
   * @throws Error - 0 以上の安全な整数でない値が渡された場合
   */
  setMaxMessageSize(maxMessageSize: number): void {
    assertMaxMessageSize(maxMessageSize);
    this.maxMessageSizeValue = maxMessageSize;
  }

  /**
   * メッセージをエンコード
   *
   * @throws Error - 本文長がピアの MAX_CONTROL_MESSAGE_SIZE を超えた場合。
   *   draft-ietf-moq-transport-23 §9 の MUST NOT を守るため、送信前に拒否する。
   */
  encode(type: number, payload: Uint8Array): Uint8Array {
    if (payload.length > this.maxMessageSizeValue) {
      throw new Error(
        `control message length ${payload.length} exceeds peer maximum ${this.maxMessageSizeValue}`,
      );
    }

    const typeBytes = encodeVarint(type);
    const lengthBytes = encodeVarint(payload.length);

    // Type + Length + Payload
    const result = new Uint8Array(typeBytes.length + lengthBytes.length + payload.length);
    result.set(typeBytes, 0);
    result.set(lengthBytes, typeBytes.length);
    result.set(payload, typeBytes.length + lengthBytes.length);

    return result;
  }
}
