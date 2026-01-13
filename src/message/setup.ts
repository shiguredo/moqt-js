/**
 * MOQT Setup Messages
 * draft-ietf-moq-transport-16 Section 9.3
 */

import { encodeVarint } from "../varint";
import { MOQT_IMPLEMENTATION_VALUE } from "../version";
import {
  type Parameter,
  decodeParameters,
  encodeParameters,
  getParameterVarintValue,
} from "./parameter";
import { MessageType, SetupParameterType } from "./types";

/**
 * CLIENT_SETUP メッセージ
 */
export interface ClientSetup {
  type: typeof MessageType.CLIENT_SETUP;
  parameters: Parameter[];
}

/**
 * SERVER_SETUP メッセージ
 */
export interface ServerSetup {
  type: typeof MessageType.SERVER_SETUP;
  parameters: Parameter[];
}

/**
 * ClientSetup を作成
 */
export function createClientSetup(options?: {
  path?: string;
  maxRequestId?: bigint;
  authority?: string;
}): ClientSetup {
  const encoder = new TextEncoder();
  const parameters: Parameter[] = [];

  if (options?.path) {
    parameters.push({
      type: SetupParameterType.PATH,
      value: encoder.encode(options.path),
    });
  }

  if (options?.maxRequestId !== undefined) {
    parameters.push({
      type: SetupParameterType.MAX_REQUEST_ID,
      value: encodeVarint(options.maxRequestId),
    });
  }

  if (options?.authority) {
    parameters.push({
      type: SetupParameterType.AUTHORITY,
      value: encoder.encode(options.authority),
    });
  }

  // MOQT_IMPLEMENTATION (0x07) - Section 9.3.1.6
  // 実装名とバージョンを送信
  parameters.push({
    type: SetupParameterType.MOQT_IMPLEMENTATION,
    value: encoder.encode(MOQT_IMPLEMENTATION_VALUE),
  });

  return {
    type: MessageType.CLIENT_SETUP,
    parameters,
  };
}

/**
 * ServerSetup を作成
 */
export function createServerSetup(options?: { maxRequestId?: bigint }): ServerSetup {
  const parameters: Parameter[] = [];

  if (options?.maxRequestId !== undefined) {
    parameters.push({
      type: SetupParameterType.MAX_REQUEST_ID,
      value: encodeVarint(options.maxRequestId),
    });
  }

  return {
    type: MessageType.SERVER_SETUP,
    parameters,
  };
}

/**
 * ClientSetup のペイロードをエンコード
 *
 * draft-ietf-moq-transport-16:
 * delta encoding を使用するため、パラメータは type の昇順でソートしてからエンコードする。
 */
export function encodeClientSetupPayload(msg: ClientSetup): Uint8Array {
  // delta encoding のために type の昇順でソート
  const sortedParams = [...msg.parameters].sort((a, b) => a.type - b.type);
  return encodeParameters(sortedParams);
}

/**
 * ServerSetup のペイロードをエンコード
 *
 * draft-ietf-moq-transport-16:
 * delta encoding を使用するため、パラメータは type の昇順でソートしてからエンコードする。
 */
export function encodeServerSetupPayload(msg: ServerSetup): Uint8Array {
  // delta encoding のために type の昇順でソート
  const sortedParams = [...msg.parameters].sort((a, b) => a.type - b.type);
  return encodeParameters(sortedParams);
}

/**
 * ClientSetup のペイロードをデコード
 */
export function decodeClientSetupPayload(data: Uint8Array, offset = 0): ClientSetup {
  const [parameters] = decodeParameters(data, offset);
  return {
    type: MessageType.CLIENT_SETUP,
    parameters,
  };
}

/**
 * ServerSetup のペイロードをデコード
 */
export function decodeServerSetupPayload(data: Uint8Array, offset = 0): ServerSetup {
  const [parameters] = decodeParameters(data, offset);
  return {
    type: MessageType.SERVER_SETUP,
    parameters,
  };
}

/**
 * Setup メッセージからパラメータを取得
 */
export function getSetupParameter(
  msg: ClientSetup | ServerSetup,
  paramType: number,
): Parameter | undefined {
  return msg.parameters.find((p) => p.type === paramType);
}

/**
 * Setup メッセージから PATH を取得
 */
export function getSetupPath(msg: ClientSetup): string | undefined {
  const param = getSetupParameter(msg, SetupParameterType.PATH);
  if (!param) return undefined;
  return new TextDecoder().decode(param.value);
}

/**
 * Setup メッセージから MAX_REQUEST_ID を取得
 */
export function getSetupMaxRequestId(msg: ClientSetup | ServerSetup): bigint | undefined {
  const param = getSetupParameter(msg, SetupParameterType.MAX_REQUEST_ID);
  if (!param) return undefined;
  return getParameterVarintValue(param);
}

/**
 * Setup メッセージから AUTHORITY を取得
 */
export function getSetupAuthority(msg: ClientSetup): string | undefined {
  const param = getSetupParameter(msg, SetupParameterType.AUTHORITY);
  if (!param) return undefined;
  return new TextDecoder().decode(param.value);
}

/**
 * Setup メッセージから MOQT_IMPLEMENTATION を取得
 */
export function getSetupMoqtImplementation(msg: ClientSetup | ServerSetup): string | undefined {
  const param = getSetupParameter(msg, SetupParameterType.MOQT_IMPLEMENTATION);
  if (!param) return undefined;
  return new TextDecoder().decode(param.value);
}
