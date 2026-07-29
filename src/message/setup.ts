/**
 * MOQT Setup Messages
 * draft-ietf-moq-transport-19 Section 10.3 (SETUP)
 *
 * draft-ietf-moq-transport-19 Section 3.3 (Session initialization):
 * CLIENT_SETUP と SERVER_SETUP は単一の SETUP メッセージに統合された。
 */

import { MOQT_IMPLEMENTATION_VALUE } from "../version";
import { generateGreaseValue } from "../grease";
import {
  type AuthorizationToken,
  assertAuthorizationTokenForSetup,
  decodeAuthorizationToken,
  encodeAuthorizationToken,
} from "./authorizationToken";
import { type Parameter, decodeKeyValuePairs, encodeKeyValuePairs } from "./parameter";
import { MessageType, SetupOptionType } from "./types";
import { decodeVarint, encodeVarint } from "../varint";

/**
 * SETUP メッセージ
 *
 * draft-ietf-moq-transport-19 Section 10.3 (SETUP):
 * CLIENT_SETUP と SERVER_SETUP は単一の SETUP メッセージに統合された。
 * draft-ietf-moq-transport-19 Section 4
 */
export interface Setup {
  type: typeof MessageType.SETUP;
  parameters: Parameter[];
}

/**
 * Setup を作成
 *
 * draft-ietf-moq-transport-19 §10.3.1.1 / §10.3.1.2:
 * AUTHORITY (0x05) / PATH (0x01) は WebTransport 使用時には MUST NOT 送信。
 * moqt-js は WebTransport 専用クライアントのため、これらは作成手段を持たない。
 *
 * authorizationToken を指定すると Section 10.3.1.4 (AUTHORIZATION TOKEN Setup Option)
 * として Option Type 0x03 に積む。Section 10.2.2 より SETUP では Alias Type
 * DELETE / USE_ALIAS は禁止されているため、事前に検証する。
 */
export function createSetup(options?: {
  authorizationToken?: AuthorizationToken;
  maxAuthTokenCacheSize?: number;
  /**
   * MOQT_IMPLEMENTATION Setup Option の制御
   * draft-ietf-moq-transport-19 §13.8 (Implementation Identification Fingerprinting)
   *
   * - undefined: 既定値 (moqt-js/${version}) を送信する
   * - false: MOQT_IMPLEMENTATION を送信しない
   * - string: 指定した値を送信する
   */
  moqtImplementation?: string | false;
  /**
   * GREASE Setup Option の送信を有効化する
   * draft-ietf-moq-transport-19 Section 14 (Grease)
   *
   * true を指定すると、SETUP メッセージに GREASE Setup Option を 1 つ追加する。
   * 既定 (undefined / false) では送信しない。
   */
  grease?: boolean;
}): Setup {
  const encoder = new TextEncoder();
  const parameters: Parameter[] = [];

  if (options?.authorizationToken) {
    assertAuthorizationTokenForSetup(options.authorizationToken);
    parameters.push({
      type: SetupOptionType.AUTHORIZATION_TOKEN,
      value: encodeAuthorizationToken(options.authorizationToken),
    });
  }

  // draft-ietf-moq-transport-19 §10.3.1.3 (MAX_AUTH_TOKEN_CACHE_SIZE):
  // 送信しない場合のデフォルトは 0（Alias の使用禁止）
  if (options?.maxAuthTokenCacheSize !== undefined) {
    parameters.push({
      type: SetupOptionType.MAX_AUTH_TOKEN_CACHE_SIZE,
      value: encodeVarint(BigInt(options.maxAuthTokenCacheSize)),
    });
  }

  // MOQT_IMPLEMENTATION (0x07) - Section 10.3.1.5 (MOQT IMPLEMENTATION)
  // draft-ietf-moq-transport-19 §13.8: プライバシー緩和のため opt-out / override を許可する
  // - undefined: 既定値を送信する (§10.3.1.5 の SHOULD に従う)
  // - false: 送信しない (§13.8 "MAY omit the MOQT_IMPLEMENTATION option entirely")
  // - string: カスタム値を送信する (§13.8 "or send a generic value")
  if (options?.moqtImplementation !== false) {
    const implementationValue =
      typeof options?.moqtImplementation === "string"
        ? options.moqtImplementation
        : MOQT_IMPLEMENTATION_VALUE;
    parameters.push({
      type: SetupOptionType.MOQT_IMPLEMENTATION,
      value: encoder.encode(implementationValue),
    });
  }

  // draft-ietf-moq-transport-19 Section 14 (Grease):
  // GREASE Setup Option は未知の Option Type をピアが正しく無視できることを検証する。
  // 送信は任意（opt-in）。value は任意のバイト列でセマンティクスなし。
  // Key-Value-Pairs は Type の奇偶でワイヤ形式が決まる（奇数 = length-prefixed）。
  // GREASE 値 0x7f * N + 0x9D は N が偶数のとき奇数になるため、N を偶数に限定する。
  if (options?.grease) {
    const greaseIndex = Math.floor(Math.random() * 50) * 2;
    const greaseType = Number(generateGreaseValue(greaseIndex));
    const greasePayload = new Uint8Array(4);
    crypto.getRandomValues(greasePayload);
    parameters.push({
      type: greaseType,
      value: greasePayload,
    });
  }

  return {
    type: MessageType.SETUP,
    parameters,
  };
}

/**
 * Setup のペイロードをエンコード
 *
 * draft-ietf-moq-transport-19 Section 10.3 (SETUP):
 * Setup Options は Key-Value-Pairs (Figure 2) としてシリアライズされ、
 * カウントプレフィックスを持たない。Length フィールドで終端が決まる。
 * delta encoding を使用するため、パラメータは type の昇順でソートしてからエンコードする。
 */
export function encodeSetupPayload(msg: Setup): Uint8Array {
  // delta encoding のために type の昇順でソート
  const sortedParams = [...msg.parameters].sort((a, b) => a.type - b.type);
  return encodeKeyValuePairs(sortedParams);
}

/**
 * Setup のペイロードをデコード
 *
 * draft-ietf-moq-transport-19 Section 10.3 (SETUP), Section 15.4 (IANA registry):
 * Setup Options は Key-Value-Pairs (Figure 2) としてシリアライズされ、
 * カウントプレフィックスを持たない。データ末尾まで KVP を読む。
 * 未知の Setup Option は MUST ignore（§10.3.1）。
 */
export function decodeSetupPayload(data: Uint8Array, offset = 0): Setup {
  const [parameters] = decodeKeyValuePairs(data, offset);
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

/**
 * Setup メッセージから AUTHORIZATION_TOKEN を取得する
 * draft-ietf-moq-transport-19 Section 10.3.1.4 (AUTHORIZATION TOKEN)
 *
 * Setup Option の値は Section 10.2.2 の Token 構造。
 * 複数の Authorization Token を一つの SETUP に載せられるため、配列で返す。
 */
export function getSetupAuthorizationTokens(msg: Setup): AuthorizationToken[] {
  return msg.parameters
    .filter((p) => p.type === SetupOptionType.AUTHORIZATION_TOKEN)
    .map((p) => decodeAuthorizationToken(p.value));
}

/**
 * Setup メッセージから MAX_AUTH_TOKEN_CACHE_SIZE を取得する
 * draft-ietf-moq-transport-19 §10.3.1.3
 *
 * デフォルト値は 0（Alias の使用禁止）。
 */
export function getSetupMaxAuthTokenCacheSize(msg: Setup): number {
  const param = getSetupParameter(msg, SetupOptionType.MAX_AUTH_TOKEN_CACHE_SIZE);
  if (!param) return 0;
  const [value] = decodeVarint(param.value);
  return Number(value);
}

/**
 * SETUP メッセージから MAX_REQUEST_UPDATES を取得する
 *
 * draft-ietf-moq-transport-19 Section 10.3.1.7:
 * 欠落時のデフォルトは 0（無制限）。
 */
export function getSetupMaxRequestUpdates(msg: Setup): number {
  const param = getSetupParameter(msg, SetupOptionType.MAX_REQUEST_UPDATES);
  if (!param) return 0;
  const [value] = decodeVarint(param.value);
  return Number(value);
}

/**
 * SETUP メッセージから MAX_FILTER_RANGES を取得する
 *
 * draft-ietf-moq-transport-19 Section 10.3.1.6:
 * 欠落時のデフォルトは 0（Range Filter 送信禁止）。
 */
export function getSetupMaxFilterRanges(msg: Setup): number {
  const param = getSetupParameter(msg, SetupOptionType.MAX_FILTER_RANGES);
  if (!param) return 0;
  const [value] = decodeVarint(param.value);
  return Number(value);
}
