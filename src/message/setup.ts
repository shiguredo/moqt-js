/**
 * MOQT Setup Messages
 * draft-ietf-moq-transport-23 §9.1 (SETUP)
 *
 * §6.3 (Session initialization): 制御ストリームは単方向ストリームのペアになり、
 * SETUP はその先頭で交換される。CLIENT_SETUP と SERVER_SETUP が単一の SETUP に
 * 統合されたのは draft-17 での変更である (付録 A.7 の変更履歴)。
 *
 * §6.3.2 (Extension Negotiation): 拡張機能のサポートは SETUP の Setup Option で
 * 宣言する。汎用の宣言形式は無く、各拡張仕様が Option の型・値・交渉規則を定める。
 * 将来の拡張を足すときも、汎用形式を仮定せず、その拡張仕様が定める Setup Option を定義する。
 *
 * Setup Option は §16.4 (Setup Options) の IANA レジストリで管理され、
 * Message Parameter (§9.19) とは別の名前空間である (§9.19.1: SETUP に Message
 * Parameter は出現しない)。moqt-js が送る Option は次のとおり。
 * - 0x03 AUTHORIZATION_TOKEN (§9.1.4)
 * - 0x04 MAX_AUTH_TOKEN_CACHE_SIZE (§9.1.3)
 * - 0x06 MAX_FILTER_RANGES (§9.1.6)
 * - 0x07 MOQT_IMPLEMENTATION (§9.1.5)
 * - 0x08 MAX_REQUEST_UPDATES (§9.1.7)
 * - 0x09 MAX_CONTROL_MESSAGE_SIZE (§9.1.8)
 * - GREASE (未使用域を擦る。§13)
 * AUTHORITY (0x05) / PATH (0x01) は WebTransport 利用時の MUST NOT
 * (§9.1.1 / §9.1.2) のため送る手段を持たない。
 * 未知の Option は §9.1 の MUST に従い ignore する。§9.1 は「Receivers MUST allow
 * duplicates of unknown Setup Options」も求めるため、重複していても拒否しない
 * (decodeSetupPayload を参照)。
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
import {
  DEFAULT_MAX_CONTROL_MESSAGE_SIZE,
  MessageType,
  MIN_MAX_CONTROL_MESSAGE_SIZE,
  SetupOptionType,
} from "./types";
import { decodeVarint, encodeVarint } from "../varint";
import { IncompleteDataError, SessionError, SessionErrorCode } from "../error";

/**
 * SETUP メッセージ
 *
 * draft-ietf-moq-transport-23 §9.1 (SETUP):
 * CLIENT_SETUP と SERVER_SETUP は単一の SETUP メッセージに統合された。
 */
export interface Setup {
  type: typeof MessageType.SETUP;
  parameters: Parameter[];
}

/**
 * Setup を作成
 *
 * draft-ietf-moq-transport-23 §9.1.1 / §9.1.2:
 * AUTHORITY (0x05) / PATH (0x01) は WebTransport 使用時には MUST NOT 送信。
 * moqt-js は WebTransport 専用クライアントのため、これらは作成手段を持たない。
 *
 * authorizationToken を指定すると §9.1.4 (AUTHORIZATION TOKEN Setup Option)
 * として Option Type 0x03 に積む。§9.1.4 より SETUP では Alias Type
 * DELETE / USE_ALIAS は禁止されているため、事前に検証する。
 *
 * maxAuthTokenCacheSize / maxRequestUpdates / maxFilterRanges を指定すると
 * それぞれ §9.1.3 (MAX_AUTH_TOKEN_CACHE_SIZE) /
 * §9.1.7 (MAX_REQUEST_UPDATES) / §9.1.6 (MAX FILTER RANGES) を
 * 広告する。未指定時は Option を送信せず、各節の既定値を用いる
 * (順に 0 = Alias 禁止 / 0 = 無制限 / 0 = Range Filter 受信拒否)。
 *
 * maxControlMessageSize を指定すると draft-ietf-moq-transport-23 §9.1.8
 * (MAX_CONTROL_MESSAGE_SIZE) を Option Type 0x09 で広告する。値は vi64 として
 * 符号化し、65535 以上 Number.MAX_SAFE_INTEGER 以下の安全な整数でなければ
 * ならない。未指定時は Option を送信せず、
 * 既定値 65535 を用いる。
 *
 * moqtImplementation で §9.1.5 (MOQT IMPLEMENTATION) の送信を制御する。
 * draft-ietf-moq-transport-23 §15.8 (Implementation Identification Fingerprinting)
 * のプライバシー緩和策に対応する。
 * - 未指定（既定）: MOQT_IMPLEMENTATION_VALUE（`moqt-js/${version}`）を送信する。
 * - false: MOQT_IMPLEMENTATION Option を送信しない（opt-out）。
 * - 文字列: その値をそのまま送信する（override。空文字列も指定どおり送信する）。
 *
 * grease: true で Section 13 (Grease) の GREASE Setup Option を 1 つ追加する。
 * 未知の Option を gracefully に扱えることを対向に保証するための予約値（RFC 9170 §3.3 由来の
 * SHOULD 推奨）を送信する。既定（未指定 / false）では送信しない。
 */
export function createSetup(options?: {
  authorizationToken?: AuthorizationToken;
  maxAuthTokenCacheSize?: number;
  maxRequestUpdates?: number;
  maxFilterRanges?: number;
  maxControlMessageSize?: number;
  moqtImplementation?: string | false;
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

  // draft-ietf-moq-transport-23 §9.1.3 (MAX_AUTH_TOKEN_CACHE_SIZE):
  // 送信しない場合のデフォルトは 0（Alias の使用禁止）
  if (options?.maxAuthTokenCacheSize !== undefined) {
    parameters.push({
      type: SetupOptionType.MAX_AUTH_TOKEN_CACHE_SIZE,
      value: encodeVarint(BigInt(options.maxAuthTokenCacheSize)),
    });
  }

  // draft-ietf-moq-transport-23 §9.1.7 (MAX_REQUEST_UPDATES):
  // 送信しない場合のデフォルトは 0（無制限）
  if (options?.maxRequestUpdates !== undefined) {
    parameters.push({
      type: SetupOptionType.MAX_REQUEST_UPDATES,
      value: encodeVarint(BigInt(options.maxRequestUpdates)),
    });
  }

  // draft-ietf-moq-transport-23 §9.1.6 (MAX FILTER RANGES):
  // 送信しない場合のデフォルトは 0（Range Filter の受信拒否）
  if (options?.maxFilterRanges !== undefined) {
    parameters.push({
      type: SetupOptionType.MAX_FILTER_RANGES,
      value: encodeVarint(BigInt(options.maxFilterRanges)),
    });
  }

  // draft-ietf-moq-transport-23 §9.1.8 (MAX_CONTROL_MESSAGE_SIZE):
  // 値は vi64。65535 未満は仕様違反であり、65535 は既定値と同じ値だが、
  // 明示指定された場合は他の上限 Option と同じく送信する。
  // Option Type 0x09 は奇数型のため、Key-Value-Pair 規則により Length と
  // vi64 の値が続く (値のバイト列は encodeVarint の結果)。
  if (options?.maxControlMessageSize !== undefined) {
    assertMaxControlMessageSize(options.maxControlMessageSize);
    parameters.push({
      type: SetupOptionType.MAX_CONTROL_MESSAGE_SIZE,
      value: encodeVarint(BigInt(options.maxControlMessageSize)),
    });
  }

  // MOQT_IMPLEMENTATION (0x07) - §9.1.5 (MOQT IMPLEMENTATION)
  // draft-ietf-moq-transport-23 §15.8 のプライバシー緩和策として opt-out / override を受け付ける。
  // false のときは送信を抑止する。文字列のときはその値を、未指定のときは既定値を送信する。
  if (options?.moqtImplementation !== false) {
    const moqtImplementation =
      typeof options?.moqtImplementation === "string"
        ? options.moqtImplementation
        : MOQT_IMPLEMENTATION_VALUE;
    parameters.push({
      type: SetupOptionType.MOQT_IMPLEMENTATION,
      value: encoder.encode(moqtImplementation),
    });
  }

  // GREASE Setup Option - draft-ietf-moq-transport-23 §13 (Grease)
  // 0x7f * N + 0x9D パターンの予約値を送信し、対向が未知の Option を gracefully に
  // 扱えることを保証する（RFC 9170 §3.3 由来の SHOULD 推奨）。opt-in のとき 1 つ追加する。
  if (options?.grease) {
    parameters.push({
      type: generateGreaseSetupOptionType(),
      value: new Uint8Array(0),
    });
  }

  return {
    type: MessageType.SETUP,
    parameters,
  };
}

/**
 * GREASE Setup Option の Option Type を生成する
 *
 * draft-ietf-moq-transport-23 §13: GREASE 値は 0x7f * N + 0x9D（N は非負整数）のパターン。
 * Key-Value-Pairs 規則（parameter.ts）では奇数 Type は Length プレフィックス付きバイト列、
 * 偶数 Type は varint 値としてエンコードされる。任意のバイト列を安全に送信するため、
 * N を偶数に固定して Option Type を奇数にする（0x9D は奇数、0x7f * 偶数は偶数、合計は奇数）。
 * Parameter.type は number 型のため、generateGreaseValue() の bigint 結果が
 * Number.MAX_SAFE_INTEGER を超えない範囲で N を選ぶ。
 */
function generateGreaseSetupOptionType(): number {
  const maxN = Math.floor((Number.MAX_SAFE_INTEGER - 0x9d) / 0x7f);
  const n = 2 * Math.floor(Math.random() * Math.floor(maxN / 2));
  return Number(generateGreaseValue(n));
}

/**
 * Setup のペイロードをエンコード
 *
 * draft-ietf-moq-transport-23 §9.1 (SETUP):
 * Setup Options は Key-Value-Pairs (Figure 4) としてシリアライズされ、
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
 * draft-ietf-moq-transport-23 §9.1 (SETUP) / §16.4 (Setup Options):
 * Setup Options は Key-Value-Pairs (Figure 4) としてシリアライズされ、
 * カウントプレフィックスを持たない。データ末尾まで KVP を読む。
 *
 * 未知の Setup Option は §9.1 の MUST に従い ignore する。ここでは解釈せず
 * そのままパラメータ配列に保持し、既知の Option だけを呼び出し側
 * (connectionDecodeAndValidateSetup / getSetupMoqtImplementation) が参照する。
 * §6.3.2 のとおり拡張の宣言形式は拡張ごとに定まるため、未知の Option を
 * 汎用の宣言として解釈しない。
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
 * draft-ietf-moq-transport-23 §9.1.4 (AUTHORIZATION TOKEN)
 *
 * Setup Option の値は Section 8.9 の Token 構造。
 * 複数の Authorization Token を一つの SETUP に載せられるため、配列で返す。
 */
export function getSetupAuthorizationTokens(msg: Setup): AuthorizationToken[] {
  return msg.parameters
    .filter((p) => p.type === SetupOptionType.AUTHORIZATION_TOKEN)
    .map((p) => decodeAuthorizationToken(p.value));
}

/**
 * Setup メッセージから MAX_AUTH_TOKEN_CACHE_SIZE を取得する
 * draft-ietf-moq-transport-23 §9.1.3
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
 * draft-ietf-moq-transport-23 §9.1.7:
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
 * draft-ietf-moq-transport-23 §9.1.6:
 * 欠落時のデフォルトは 0（Range Filter 送信禁止）。
 */
export function getSetupMaxFilterRanges(msg: Setup): number {
  const param = getSetupParameter(msg, SetupOptionType.MAX_FILTER_RANGES);
  if (!param) return 0;
  const [value] = decodeVarint(param.value);
  return Number(value);
}

/**
 * MAX_CONTROL_MESSAGE_SIZE として広告・保持してよい値かを検証する
 *
 * draft-ietf-moq-transport-23 §9.1.8:
 * 65535 以上であり、本文長を JS の数値で比較するため
 * Number.MAX_SAFE_INTEGER 以下の安全な整数でなければならない。
 * ローカル設定の誤りはプロトコル違反ではないため、SessionError ではなく
 * 通常の Error を投げる。この検証は接続経路 (公開設定) 用であり、フレーミング層の
 * ControlStreamReader / ControlStreamWriter は低レベル API として 0 以上を
 * 受け付ける (SETUP 交渉を経由しない低レベル利用や、上限を小さくした境界テストのため)。
 *
 * @throws Error - 値が安全な整数でない、または最小値未満の場合
 */
export function assertMaxControlMessageSize(maxControlMessageSize: number): void {
  if (
    !Number.isSafeInteger(maxControlMessageSize) ||
    maxControlMessageSize < MIN_MAX_CONTROL_MESSAGE_SIZE
  ) {
    throw new Error(
      `maxControlMessageSize must be a safe integer of at least ${MIN_MAX_CONTROL_MESSAGE_SIZE}, got ${maxControlMessageSize}`,
    );
  }
}

/**
 * SETUP メッセージから MAX_CONTROL_MESSAGE_SIZE を取得する
 *
 * draft-ietf-moq-transport-23 §9.1.8:
 * 省略時の既定値は 65535 であり、65535 未満を広告することは仕様違反である。
 * 値は vi64 として読み、宣言された Length が vi64 のバイト数と一致しない場合も
 * 不正な serialization として扱う。
 *
 * 不正な serialization と、値が Type の定義 (65535 以上) に一致しない場合の
 * コードは、draft-ietf-moq-transport-23 §8.3 / §12.2 の MALFORMED_KEY_VALUE で
 * ある。
 *
 * JS の配列長は Number.MAX_SAFE_INTEGER 未満なので、それを超える広告値は
 * Number.MAX_SAFE_INTEGER に丸める (実質的に上限なしとして扱う)。
 *
 * @throws SessionError - 値が最小値未満、または vi64 として読めない場合
 *   (MALFORMED_KEY_VALUE)
 */
export function getSetupMaxControlMessageSize(msg: Setup): number {
  const param = getSetupParameter(msg, SetupOptionType.MAX_CONTROL_MESSAGE_SIZE);
  if (!param) return DEFAULT_MAX_CONTROL_MESSAGE_SIZE;
  let value: bigint;
  let consumed: number;
  try {
    [value, consumed] = decodeVarint(param.value);
  } catch (error) {
    // 空の値や途中で切れた vi64 は §8.3 の serialization 不一致として扱う
    if (error instanceof IncompleteDataError) {
      throw new SessionError(
        `MAX_CONTROL_MESSAGE_SIZE is not a complete vi64: ${error.message}`,
        SessionErrorCode.MALFORMED_KEY_VALUE,
      );
    }
    throw error;
  }
  if (consumed !== param.value.length) {
    throw new SessionError(
      `MAX_CONTROL_MESSAGE_SIZE length ${param.value.length} does not match vi64 length ${consumed}`,
      SessionErrorCode.MALFORMED_KEY_VALUE,
    );
  }
  if (value < BigInt(MIN_MAX_CONTROL_MESSAGE_SIZE)) {
    throw new SessionError(
      `MAX_CONTROL_MESSAGE_SIZE ${value} is below the minimum ${MIN_MAX_CONTROL_MESSAGE_SIZE}`,
      SessionErrorCode.MALFORMED_KEY_VALUE,
    );
  }
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    return Number.MAX_SAFE_INTEGER;
  }
  return Number(value);
}
