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

/**
 * Control Stream Reader
 * バッファリングしてメッセージを組み立てる
 *
 * 受信上限は自 endpoint が SETUP で広告した MAX_CONTROL_MESSAGE_SIZE である。
 * ピアの SETUP を受信する前でも、SETUP 自身を含めてこの上限を適用する
 * (draft-ietf-moq-transport-23 §9.1.8)。
 */
export class ControlStreamReader {
  private buffer: Uint8Array = new Uint8Array(0);
  /**
   * 自 endpoint が許可する Message Length (本文長) の上限 (vi64 比較用)
   *
   * 数値へ変換した後ではなく、vi64 のまま比較する (Number の精度限界より大きい
   * 宣言長を安全に拒否するため)。コンストラクタの maxMessageSize から作る。
   */
  private readonly maxMessageSizeBigInt: bigint;

  /**
   * @param maxMessageSize - 自 endpoint が許可する Message Length の上限。
   *   0 以上 Number.MAX_SAFE_INTEGER 以下の安全な整数を渡す。接続経路では
   *   公開設定の検証を通した値が渡る。
   * @throws Error - 0 以上の安全な整数でない場合
   */
  constructor(private readonly maxMessageSize: number = DEFAULT_MAX_CONTROL_MESSAGE_SIZE) {
    assertMaxMessageSize(maxMessageSize);
    this.maxMessageSizeBigInt = BigInt(maxMessageSize);
  }

  /**
   * データを供給してメッセージを取り出す
   *
   * @returns 完全なメッセージの配列
   * @throws SessionError - 宣言された Message Length がローカル上限を超えた場合
   *   (FIELD_LENGTH_EXCEEDED)。本文が揃う前でも宣言時点で判定する。
   */
  feed(data: Uint8Array): ControlMessage[] {
    // バッファに追加
    const newBuffer = new Uint8Array(this.buffer.length + data.length);
    newBuffer.set(this.buffer, 0);
    newBuffer.set(data, this.buffer.length);
    this.buffer = newBuffer;

    return this.processMessages();
  }

  /**
   * バッファをクリア
   */
  clear(): void {
    this.buffer = new Uint8Array(0);
  }

  /**
   * 半端なメッセージのバイトが残っているか
   *
   * draft-ietf-moq-transport-23 §12.2 (CONTROL_MESSAGE_TIMEOUT):
   * 受信側が半端なメッセージを保持したまま待ち続ける状態を検出するために使う。
   */
  get hasBufferedBytes(): boolean {
    return this.buffer.length > 0;
  }

  /**
   * 保持しているバイト数 (エラーメッセージ用)
   */
  get bufferedBytes(): number {
    return this.buffer.length;
  }

  private processMessages(): ControlMessage[] {
    const messages: ControlMessage[] = [];

    while (true) {
      // Type (vi64) をデコードする。varint が揃っていなければ次のチャンクを待つ。
      let messageType: bigint;
      let typeConsumed: number;
      try {
        [messageType, typeConsumed] = decodeVarint(this.buffer, 0);
      } catch (error) {
        if (error instanceof IncompleteDataError) {
          break;
        }
        throw error;
      }

      // Message Length (vi64) をデコードする。Type の直後で切れていれば待つ。
      let messageLength: bigint;
      let lengthConsumed: number;
      try {
        [messageLength, lengthConsumed] = decodeVarint(this.buffer, typeConsumed);
      } catch (error) {
        if (error instanceof IncompleteDataError) {
          break;
        }
        throw error;
      }

      // 宣言長がローカル上限を超えていれば、本文を待たずにセッションを閉じる。
      // draft-ietf-moq-transport-23 §9:
      // "If an endpoint receives a control message with a length larger than its
      //  MAX_CONTROL_MESSAGE_SIZE, it MUST close the session with
      //  FIELD_LENGTH_EXCEEDED."
      if (messageLength > this.maxMessageSizeBigInt) {
        throw new SessionError(
          `control message length ${messageLength} exceeds local maximum ${this.maxMessageSize}`,
          SessionErrorCode.FIELD_LENGTH_EXCEEDED,
        );
      }
      // 上限 (Number.MAX_SAFE_INTEGER 以下) を確認済みのため安全に数値へ変換できる
      const bodyLength = Number(messageLength);

      // 全体の長さを計算
      const totalLength = typeConsumed + lengthConsumed + bodyLength;
      if (this.buffer.length < totalLength) {
        break;
      }

      // Payload を取り出す
      const payload = this.buffer.slice(typeConsumed + lengthConsumed, totalLength);

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
