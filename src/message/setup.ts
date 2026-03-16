/**
 * MOQT Setup Messages
 * draft-ietf-moq-transport-17 Section 9.4
 *
 * draft-ietf-moq-transport-17 Section 9.4:
 * CLIENT_SETUP と SERVER_SETUP は単一の SETUP メッセージに統合された。
 * https://github.com/moq-wg/moq-transport/pull/1510
 */

import { MOQT_IMPLEMENTATION_VALUE } from "../version";
import { type Parameter, decodeParameters, encodeParameters } from "./parameter";
import { MessageType, SetupOptionType } from "./types";

/**
 * SETUP メッセージ
 *
 * draft-ietf-moq-transport-17 Section 9.4:
 * CLIENT_SETUP と SERVER_SETUP は単一の SETUP メッセージに統合された。
 * https://github.com/moq-wg/moq-transport/pull/1510
 */
export interface Setup {
  type: typeof MessageType.SETUP;
  parameters: Parameter[];
}

/**
 * Setup を作成
 */
export function createSetup(options?: { path?: string; authority?: string }): Setup {
  const encoder = new TextEncoder();
  const parameters: Parameter[] = [];

  if (options?.path) {
    parameters.push({
      type: SetupOptionType.PATH,
      value: encoder.encode(options.path),
    });
  }

  if (options?.authority) {
    parameters.push({
      type: SetupOptionType.AUTHORITY,
      value: encoder.encode(options.authority),
    });
  }

  // MOQT_IMPLEMENTATION (0x07) - Section 9.4.1.4
  // 実装名とバージョンを送信
  parameters.push({
    type: SetupOptionType.MOQT_IMPLEMENTATION,
    value: encoder.encode(MOQT_IMPLEMENTATION_VALUE),
  });

  return {
    type: MessageType.SETUP,
    parameters,
  };
}

/**
 * Setup のペイロードをエンコード
 *
 * draft-ietf-moq-transport-17:
 * delta encoding を使用するため、パラメータは type の昇順でソートしてからエンコードする。
 */
export function encodeSetupPayload(msg: Setup): Uint8Array {
  // delta encoding のために type の昇順でソート
  const sortedParams = [...msg.parameters].sort((a, b) => a.type - b.type);
  return encodeParameters(sortedParams);
}

/**
 * Setup のペイロードをデコード
 */
export function decodeSetupPayload(data: Uint8Array, offset = 0): Setup {
  const [parameters] = decodeParameters(data, offset);
  return {
    type: MessageType.SETUP,
    parameters,
  };
}

/**
 * Setup メッセージからパラメータを取得
 */
export function getSetupParameter(msg: Setup, paramType: number): Parameter | undefined {
  return msg.parameters.find((p) => p.type === paramType);
}

/**
 * Setup メッセージから PATH を取得
 */
export function getSetupPath(msg: Setup): string | undefined {
  const param = getSetupParameter(msg, SetupOptionType.PATH);
  if (!param) return undefined;
  return new TextDecoder().decode(param.value);
}

/**
 * Setup メッセージから AUTHORITY を取得
 */
export function getSetupAuthority(msg: Setup): string | undefined {
  const param = getSetupParameter(msg, SetupOptionType.AUTHORITY);
  if (!param) return undefined;
  return new TextDecoder().decode(param.value);
}

/**
 * Setup メッセージから MOQT_IMPLEMENTATION を取得
 */
export function getSetupMoqtImplementation(msg: Setup): string | undefined {
  const param = getSetupParameter(msg, SetupOptionType.MOQT_IMPLEMENTATION);
  if (!param) return undefined;
  return new TextDecoder().decode(param.value);
}
