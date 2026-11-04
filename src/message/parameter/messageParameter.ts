/**
 * MOQT Message Parameter
 * draft-ietf-moq-transport-23 Section 9.19 (Control Message Parameters)
 *
 * Message Parameter {
 *   Type Delta (vi64),
 *   Value (..)
 * }
 *
 * draft-ietf-moq-transport-23 §9.19 (Control Message Parameters):
 * Type Delta は前のパラメータの Type との差分で、パラメータは Type の昇順に
 * 並べる。Value のエンコーディングは各パラメータの定義が個別に定める
 * ("The encoding is specified by each parameter definition.")。このファイルでは
 * MESSAGE_PARAMETER_VALUE_ENCODING が型ごとのエンコーディングを持つ。
 *
 * 「偶数型: varint 値 / 奇数型: Length プレフィックス付きバイト列」という規則は
 * §8.3 (Key-Value-Pair Structure) のものであり、Message Parameter には適用されない。
 * Key-Value-Pair は ./kvp が扱う。
 *
 * FILL_PARAMETERS (§9.19.15) は内側に Parameters 列 (Number of Parameters で
 * 個数を指定する自己区切り構造) を格納する Message Parameter のため、
 * 本モジュールで扱う。
 */

import { InvalidFilterError, ProtocolViolationError, SessionErrorCode } from "../../error";
import { decodeVarint, encodeVarint, MAX_VARINT } from "../../varint";
import { assertLengthWithinData } from "../../length";
import { MessageParameterType, type Location } from "../types";
import { concatUint8Arrays } from "../../bytes";
import { type Parameter } from "./types";
import { decodeTrackNamespace } from "./trackNamespace";
import { decodeLocationFilterParameter, locationFilterEncodedLength } from "./locationFilter";
import {
  decodeRangeFilter,
  rangeFilterTypeOf,
  validateRangeFilterCombination,
} from "./rangeFilter";

/**
 * パラメータから Location 値を取得
 *
 * LARGEST_OBJECT (0x09) パラメータなど、Location を含むパラメータ用
 * draft-ietf-moq-transport-23 Section 9.19.17 (LARGEST OBJECT Parameter)
 */
export function getParameterLocationValue(param: Parameter): Location {
  const [location] = decodeLocation(param.value, 0);
  return location;
}

/**
 * GROUP_ORDER パラメータの値を検証する
 *
 * draft-ietf-moq-transport-23 Section 9.19.8:
 * "The allowed values are Ascending (0x1) or Descending (0x2).
 *  If an endpoint receives a value outside this range, it MUST close
 *  the session with INVALID_PARAMETER."
 */
export function validateGroupOrderValue(value: number): void {
  if (value !== 0x01 && value !== 0x02) {
    throw new ProtocolViolationError(
      `invalid GROUP_ORDER value: 0x${value.toString(16)}, expected 0x1 or 0x2`,
      SessionErrorCode.INVALID_PARAMETER,
    );
  }
}

/**
 * PAUSED パラメータの値を検証する
 *
 * draft-ietf-moq-transport-23 Section 9.19.18:
 * "The allowed values are 0 (unpaused) or 1 (paused).
 *  If an endpoint receives a value outside this range, it MUST close
 *  the session with INVALID_PARAMETER."
 */
export function validatePausedValue(value: number): void {
  if (value !== 0 && value !== 1) {
    throw new ProtocolViolationError(
      `invalid PAUSED value: ${value}, expected 0 or 1`,
      SessionErrorCode.INVALID_PARAMETER,
    );
  }
}

/**
 * INCLUDE_PROPERTIES パラメータの値を検証する
 *
 * draft-ietf-moq-transport-23 Section 9.19.22:
 * "The allowed values are 0 (do not send Properties)
 *  or 1 (send Properties), and the default is 1.
 *  If an endpoint receives a value outside this range, it MUST close
 *  the session with INVALID_PARAMETER."
 */
export function validateIncludePropertiesValue(value: number): void {
  if (value !== 0 && value !== 1) {
    throw new ProtocolViolationError(
      `invalid INCLUDE_PROPERTIES value: ${value}, expected 0 or 1`,
      SessionErrorCode.INVALID_PARAMETER,
    );
  }
}

/**
 * uint8 型の Message Parameter Value をエンコードする
 *
 * draft-ietf-moq-transport-23 §9.19.7 / §9.19.8 / §9.19.18:
 * SUBSCRIBER_PRIORITY / GROUP_ORDER / PAUSED は varint ではなく uint8。
 */
export function encodeUint8ParameterValue(
  value: number | bigint,
  parameterName: string,
): Uint8Array {
  const numericValue = typeof value === "bigint" ? Number(value) : value;
  if (!Number.isInteger(numericValue) || numericValue < 0 || numericValue > 0xff) {
    throw new Error(`invalid ${parameterName} value: ${numericValue}, expected 0..255`);
  }
  return new Uint8Array([numericValue]);
}

/**
 * Location をエンコードする
 */
export function encodeLocation(location: Location): Uint8Array {
  const groupBytes = encodeVarint(location.group);
  const objectBytes = encodeVarint(location.object);
  return concatUint8Arrays([groupBytes, objectBytes]);
}

/**
 * Location をデコードする
 * @returns [location, consumed bytes]
 */
export function decodeLocation(data: Uint8Array, offset = 0): [Location, number] {
  const [group, groupConsumed] = decodeVarint(data, offset);
  const [object, objectConsumed] = decodeVarint(data, offset + groupConsumed);
  return [{ group, object }, groupConsumed + objectConsumed];
}

/**
 * Message Parameter の Value エンコーディング種別
 *
 * draft-ietf-moq-transport-23 Section 9.19:
 * Value のエンコーディングはパラメータ定義ごとに異なる。
 * - uint8: 1 バイトの符号なし整数
 * - varint: 可変長整数
 * - location: 2 つの連続した varint (Group, Object)
 * - length-prefixed: varint 長 + バイト列 (外側に Length を付加する)
 * - self-length-prefixed: 値が自ら Length (vi64) を内包する 1 Length 構造
 *   (外側 Length は付加しない。draft-ietf-moq-transport-23 §8.6 の Range Filter
 *   が該当)
 * - location-filter: 値が Location Filter Type (vi64) と型ごとの vi64 フィールドで
 *   自己区切りになる構造 (外側 Length は付加しない。
 *   draft-ietf-moq-transport-23 §9.19.9 の LOCATION_FILTER が該当)
 * - track-namespace: Track Namespace (Number of Track Namespace Fields + 各
 *   フィールドの Length + Value) の自己区切り構造 (外側 Length は付加しない。
 *   draft-ietf-moq-transport-23 §9.19.20 が参照する §8.7 のエンコーディング)
 * - fill-parameters: 値が Number of Parameters (vi64) とその個数の Parameters で
 *   自己区切りになる構造 (外側 Length は付加しない。
 *   draft-ietf-moq-transport-23 §9.19.15 の FILL_PARAMETERS が該当)
 */
type MessageParameterValueEncoding =
  | "uint8"
  | "varint"
  | "location"
  | "length-prefixed"
  | "self-length-prefixed"
  | "location-filter"
  | "track-namespace"
  | "fill-parameters";

/**
 * パラメータ型ごとの Value エンコーディング定義
 *
 * draft-ietf-moq-transport-23 Section 9.19:
 * Message Parameters は Key-Value-Pair (Figure 3) とは異なり、
 * 各パラメータ型が独自の Value エンコーディングを定義する。
 */
const MESSAGE_PARAMETER_VALUE_ENCODING: Record<number, MessageParameterValueEncoding> = {
  // OBJECT_DELIVERY_TIMEOUT (Section 9.19.4)
  0x02: "varint",
  // AUTHORIZATION_TOKEN (Section 9.19.2)
  0x03: "length-prefixed",
  // RENDEZVOUS_TIMEOUT (Section 9.19.6)
  0x04: "varint",
  // SUBGROUP_DELIVERY_TIMEOUT (Section 9.19.3)
  0x06: "varint",
  // EXPIRES (Section 9.19.16)
  0x08: "varint",
  // LARGEST_OBJECT (Section 9.19.17)
  0x09: "location",
  // FILL_TIMEOUT (Section 9.19.5)
  0x0a: "varint",
  // PAUSED (draft-ietf-moq-transport-23 Section 9.19.18)
  // draft-22 の FORWARD (0x10) を置き換えた型。0 = unpaused / 1 = paused で、
  // draft-22 FORWARD とは値の意味が反転している。0x10 は draft-23 に定義が無く、
  // 受信すると未知パラメータとして拒否される (draft-22 との自動判別は行わない)。
  0x11: "uint8",
  // SUBSCRIBER_PRIORITY (Section 9.19.7)
  0x20: "uint8",
  // LOCATION_FILTER (draft-ietf-moq-transport-23 Section 9.19.9)
  // Value は Location Filter Type (vi64) で始まり、型ごとの vi64 フィールドが続く
  // 自己区切り構造。Length フィールドを持たないため外側 Length は付加しない
  // (Range Filter とは形式が異なる)
  0x21: "location-filter",
  // GROUP_ORDER (draft-ietf-moq-transport-23 Section 9.19.8)
  0x22: "uint8",
  // FILL_PARAMETERS (draft-ietf-moq-transport-23 Section 9.19.15)
  // Value は Number of Parameters (vi64) + その個数の Parameters。
  // draft-22 の外側 Length は廃止された (Appendix A.1 "Encode FILL_PARAMETERS
  // as a count of Parameters instead of a length")。count と内側 Parameters の
  // 消費バイト数で自己区切りになるため外側 Length は付加しない。
  0x23: "fill-parameters",
  // NEW_GROUP_REQUEST (Section 9.19.19)
  0x32: "varint",
  // TRACK_NAMESPACE_PREFIX (Section 9.19.20)
  // Value は §8.7 の Track Namespace エンコーディングそのもの。
  // フィールド数 + 各フィールドの Length + Value で自己区切りになるため
  // 外側 Length は付加しない (length-prefixed ではない)。
  0x34: "track-namespace",
  // INCLUDE_PROPERTIES (Section 9.19.22)
  0x35: "uint8",
  // Range Filters (draft-ietf-moq-transport-23 Section 3.3.2 / §9.19.10–§9.19.14)
  // Value は Length (vi64) + [SetID + [Property Type] + Range 列] の 1 Length 構造。
  // 外側に Length を付加しない (length-prefixed から分離した専用種別)。
  0x25: "self-length-prefixed", // SUBGROUP_FILTER
  0x26: "self-length-prefixed", // OBJECTID_FILTER
  0x27: "self-length-prefixed", // PRIORITY_FILTER
  0x28: "self-length-prefixed", // OBJECT_PROPERTY_FILTER
  0x29: "self-length-prefixed", // TRACK_PROPERTY_FILTER
};

/**
 * FILL_PARAMETERS の内側に出現可能なパラメータ型
 *
 * draft-ietf-moq-transport-23 §9.19.15 Table 7:
 * FILL_TIMEOUT (0x0A) / SUBSCRIBER_PRIORITY (0x20) / LOCATION_FILTER (0x21) /
 * GROUP_ORDER (0x22) / Range Filters (0x25-0x28)。TRACK_PROPERTY_FILTER (0x29)
 * は SUBSCRIBE_TRACKS 系 (SUBSCRIBE_TRACKS とその REQUEST_UPDATE) 専用のため
 * 含まない。
 * "An endpoint that receives a parameter inside FILL_PARAMETERS that is not
 *  listed above MUST close the session with INVALID_PARAMETER."
 */
export const FILL_PARAMETERS_ALLOWED_TYPES: ReadonlySet<number> = new Set([
  MessageParameterType.FILL_TIMEOUT,
  MessageParameterType.SUBSCRIBER_PRIORITY,
  MessageParameterType.LOCATION_FILTER,
  MessageParameterType.GROUP_ORDER,
  MessageParameterType.SUBGROUP_FILTER,
  MessageParameterType.OBJECTID_FILTER,
  MessageParameterType.PRIORITY_FILTER,
  MessageParameterType.OBJECT_PROPERTY_FILTER,
]);

/**
 * Message Parameter 列のデコードスコープ
 *
 * draft-ietf-moq-transport-23 §9.19.15:
 * FILL_PARAMETERS の Value は「別メッセージの Parameters として」エンコードされた
 * 独立した parameter scope を持つ ("The value of FILL_PARAMETERS is a separate
 * parameter scope.")。そのため外側の Parameters 列とは Type Delta の基準・
 * 重複検証・許可型を共有しない。
 */
type MessageParameterScope = "message" | "fill-parameters";

/**
 * パラメータ型から Value エンコーディングを取得する
 *
 * draft-ietf-moq-transport-23 Section 9.19:
 * "An endpoint that receives an unknown Message Parameter MUST close the
 *  session with INVALID_PARAMETER."
 *
 * 未知のパラメータ型の場合はエラーをスローする。
 */
function getMessageParameterValueEncoding(paramType: number): MessageParameterValueEncoding {
  const encoding = MESSAGE_PARAMETER_VALUE_ENCODING[paramType];
  if (encoding === undefined) {
    throw new ProtocolViolationError(
      `unknown message parameter type: 0x${paramType.toString(16)}`,
      SessionErrorCode.INVALID_PARAMETER,
    );
  }
  return encoding;
}

/**
 * 単一の Message Parameter をエンコードする (delta encoding)
 *
 * draft-ietf-moq-transport-23 Section 9.19:
 * Message Parameter {
 *   Type Delta (vi64),
 *   Value (..)
 * }
 */
function encodeMessageParameter(param: Parameter, previousType: number): Uint8Array {
  const deltaType = param.type - previousType;
  if (deltaType < 0) {
    throw new Error(
      `parameters must be in ascending order: current type=${param.type}, previous type=${previousType}`,
    );
  }

  const deltaBytes = encodeVarint(deltaType);
  const encoding = getMessageParameterValueEncoding(param.type);

  if (encoding === "length-prefixed") {
    const lengthBytes = encodeVarint(param.value.length);
    return concatUint8Arrays([deltaBytes, lengthBytes, param.value]);
  }

  // uint8, varint, location, self-length-prefixed, location-filter,
  // track-namespace, fill-parameters: Value をそのまま書き込む。
  // self-length-prefixed の Value は self エンコードの出力 (自ら Length を含む
  // 1 Length 構造)、location-filter の Value は Location Filter Type と型ごとの
  // フィールドで自己区切り、track-namespace の Value は §8.7 の自己区切り構造、
  // fill-parameters の Value は Number of Parameters (vi64) とその個数の
  // Parameters で自己区切りになるため、いずれも外側 Length は付加しない
  // (draft-ietf-moq-transport-23 §8.6 / §9.19.9 / §9.19.15 / §9.19.20。
  // track-namespace の自己区切り構造は §8.7)
  return concatUint8Arrays([deltaBytes, param.value]);
}

/**
 * 単一の Message Parameter をデコードする (delta encoding)
 *
 * draft-ietf-moq-transport-23 Section 9.19:
 * Message Parameter {
 *   Type Delta (vi64),
 *   Value (..)
 * }
 *
 * @param scope - デコード中の Parameters 列のスコープ。FILL_PARAMETERS の内側
 *                ("fill-parameters") では §9.19.15 Table 7 の許可型だけを受け付け、
 *                FILL_PARAMETERS の入れ子を拒否する (§9.19.15 の parameter scope は
 *                外側の Parameters 列と独立している)。
 */
function decodeMessageParameterInScope(
  data: Uint8Array,
  offset: number,
  previousType: bigint,
  scope: MessageParameterScope,
): [Parameter, number, bigint] {
  const [deltaType, deltaConsumed] = decodeVarint(data, offset);
  const paramType = previousType + deltaType;

  // draft-ietf-moq-transport-23 Section 9.19 (Message Parameters):
  // "If the resulting Type would be greater than 2^64 - 1, the endpoint MUST
  //  close the session with DELTA_ENCODING_OVERFLOW."
  if (paramType > MAX_VARINT) {
    throw new ProtocolViolationError(
      `delta type addition exceeds maximum: ${paramType} > ${MAX_VARINT}`,
      SessionErrorCode.DELTA_ENCODING_OVERFLOW,
    );
  }

  const paramTypeNumber = Number(paramType);
  let totalConsumed = deltaConsumed;

  if (scope === "fill-parameters") {
    // draft-ietf-moq-transport-23 §9.19.15:
    // FILL_PARAMETERS の内側には Table 7 の型だけを置ける。入れ子の
    // FILL_PARAMETERS も Table 7 に無いため拒否する。Value を解釈する前に
    // Type Delta だけで判定する (未知型は Value 長を確定できないため、
    // 「一覧外」として検出した時点で拒否する)。
    if (!isFillParameterAllowed(paramTypeNumber)) {
      if (paramTypeNumber === MessageParameterType.FILL_PARAMETERS) {
        throw new ProtocolViolationError(
          "FILL_PARAMETERS must not be nested inside FILL_PARAMETERS",
          SessionErrorCode.INVALID_PARAMETER,
        );
      }
      throw new ProtocolViolationError(
        `unsupported parameter inside FILL_PARAMETERS: 0x${paramTypeNumber.toString(16)}`,
        SessionErrorCode.INVALID_PARAMETER,
      );
    }
  }

  const encoding = getMessageParameterValueEncoding(paramTypeNumber);
  let value: Uint8Array;

  switch (encoding) {
    case "uint8": {
      assertLengthWithinData("uint8 parameter value", 1n, offset + totalConsumed, data.length);
      value = data.slice(offset + totalConsumed, offset + totalConsumed + 1);
      totalConsumed += 1;
      const valueByte = value[0];
      if (valueByte === undefined) {
        // 上の assertLengthWithinData で 1 バイトの存在を検証済みのため到達しない
        // (noUncheckedIndexedAccess で型上 undefined を含むための防御)
        throw new ProtocolViolationError(
          `uint8 parameter value is missing: type 0x${paramTypeNumber.toString(16)}`,
          SessionErrorCode.MALFORMED_MESSAGE,
        );
      }
      // draft-ietf-moq-transport-23 §9.19.18 (PAUSED) /
      // draft-ietf-moq-transport-23 §9.19.8 (GROUP_ORDER):
      // PAUSED (0x11) / GROUP_ORDER (0x22) は受信時に値域 MUST 検証
      // draft-ietf-moq-transport-23 §9.19.22:
      // INCLUDE_PROPERTIES (0x35) も 0/1 以外は INVALID_PARAMETER (§9.19.22)
      if (paramTypeNumber === 0x11) {
        validatePausedValue(valueByte);
      } else if (paramTypeNumber === 0x22) {
        validateGroupOrderValue(valueByte);
      } else if (paramTypeNumber === 0x35) {
        validateIncludePropertiesValue(valueByte);
      }
      break;
    }
    case "varint": {
      const [val, valConsumed] = decodeVarint(data, offset + totalConsumed);
      value = encodeVarint(val);
      totalConsumed += valConsumed;
      break;
    }
    case "location": {
      // Location: 2 つの連続した varint (Group, Object)
      const [group, groupConsumed] = decodeVarint(data, offset + totalConsumed);
      totalConsumed += groupConsumed;
      const [obj, objConsumed] = decodeVarint(data, offset + totalConsumed);
      totalConsumed += objConsumed;
      value = encodeLocation({ group, object: obj });
      break;
    }
    case "length-prefixed": {
      // draft-ietf-moq-transport-23 §9.19:
      // Message Parameter の個々の Value 長に上限はなく、制御メッセージ全体の長さが
      // MAX_CONTROL_MESSAGE_SIZE で制限される (§15.5 も、より大きな
      // MAX_CONTROL_MESSAGE_SIZE がより大きな Authorization Token を許すと明記する)。
      // §8.3 の 2^16-1 上限は Key-Value-Pair (Setup Option / Property) の規則であり、
      // Message Parameter には適用しない。宣言長が残りバイト数を超える場合は
      // assertLengthWithinData が MALFORMED_MESSAGE で拒否する。
      const [length, lengthConsumed] = decodeVarint(data, offset + totalConsumed);
      totalConsumed += lengthConsumed;
      assertLengthWithinData(
        "message parameter value",
        length,
        offset + totalConsumed,
        data.length,
      );
      value = data.slice(offset + totalConsumed, offset + totalConsumed + Number(length));
      totalConsumed += Number(length);
      break;
    }
    case "self-length-prefixed": {
      // draft-ietf-moq-transport-23 Section 8.6:
      // Range Filter の Value は Length (vi64) で始まり、
      // その後にペイロードが続く 1 Length 構造。
      // 内側 Length を読んで全体を value として保持する (decodeRangeFilter の
      // 入力形式に合わせる。Length を剥がすと先頭フィールドを Length と誤読する)。
      const [length, lengthConsumed] = decodeVarint(data, offset + totalConsumed);
      totalConsumed += lengthConsumed;
      // draft-ietf-moq-transport-23 §9.19 / §15.5:
      // Message Parameter の Value 長の上限は制御メッセージ全体の長さのみであり、
      // 内側 Length も同じ扱いとする (§8.3 の KVP 上限は適用しない)。
      // 内側 Length が残りバイト数を超える場合はフレーミング破損として
      // MALFORMED_MESSAGE で扱う (短い slice を作らない)
      assertLengthWithinData("filter value", length, offset + totalConsumed, data.length);
      value = data.slice(
        offset + totalConsumed - lengthConsumed,
        offset + totalConsumed + Number(length),
      );
      totalConsumed += Number(length);
      break;
    }
    case "location-filter": {
      // draft-ietf-moq-transport-23 §9.19.9:
      // LOCATION_FILTER の Value は Location Filter Type (vi64) と型ごとの vi64
      // フィールドで自己区切りになる。Length が無いため、Type とフィールド数から
      // 消費バイト数を確定して次の Type Delta の位置を決める (Length を読むと
      // Type を Length と誤読する)。値の意味論の検証 (End Group の超過など) は
      // パラメータ層の decodeLocationFilterParameter が担う。
      const valueLength = locationFilterEncodedLength(data, offset + totalConsumed);
      value = data.slice(offset + totalConsumed, offset + totalConsumed + valueLength);
      totalConsumed += valueLength;
      break;
    }
    case "track-namespace": {
      // draft-ietf-moq-transport-23 §9.19.20:
      // TRACK_NAMESPACE_PREFIX の Value は §8.7 の Track Namespace
      // エンコーディング (Number of Track Namespace Fields + 各フィールドの
      // Length + Value) の自己区切り構造。外側 Length は存在しないため、
      // decodeTrackNamespace が返す消費バイト数で次の Type Delta の位置を
      // 確定する (Length を読むと先頭フィールド数を Length と誤読する)。
      const [, namespaceConsumed] = decodeTrackNamespace(data, offset + totalConsumed);
      value = data.slice(offset + totalConsumed, offset + totalConsumed + namespaceConsumed);
      totalConsumed += namespaceConsumed;
      break;
    }
    case "fill-parameters": {
      // draft-ietf-moq-transport-23 §9.19.15:
      // FILL_PARAMETERS の Value は Number of Parameters (vi64) + その個数の
      // Parameters であり、外側 Length を持たない。次の Type Delta の位置は
      // count と内側 Parameters の消費バイト数だけで確定する
      // (Length を読むと Number of Parameters を Length と誤読し、後続の
      // パラメータや Track Properties の位置がずれる)。Value には count と内側
      // Parameters の bytes をそのまま保持する (decodeFillParameters が同じ
      // Value を先頭から再度デコードする)。境界確定のための 1 回目の走査と
      // 公開 API 用の 2 回目の走査が重複するが、公開 API (Parameter[] を返す)
      // を維持したまま実装を簡潔にするための意図的なトレードオフである。
      const [, fillConsumed] = decodeFillParameterList(data, offset + totalConsumed);
      value = data.slice(offset + totalConsumed, offset + totalConsumed + fillConsumed);
      totalConsumed += fillConsumed;
      break;
    }
  }

  return [{ type: paramTypeNumber, value }, totalConsumed, paramType];
}

/**
 * 単一の Message Parameter をデコードする (delta encoding)
 *
 * draft-ietf-moq-transport-23 Section 9.19:
 * Message Parameter {
 *   Type Delta (vi64),
 *   Value (..)
 * }
 *
 * 外側の Parameters 列 (message スコープ) のパラメータ 1 件をデコードする。
 * テスト用に公開するが、公開 API (src/message/index.ts) には含めない。
 *
 * @returns [parameter, consumed bytes, paramType (bigint)]
 *          paramType は次のパラメータの previousType に使う。
 *          Parameter.type (number) への変換は丸めが発生するため、
 *          連続デコードのアキュムレータには bigint の paramType を使うこと。
 */
export function decodeMessageParameter(
  data: Uint8Array,
  offset: number,
  previousType: bigint,
): [Parameter, number, bigint] {
  return decodeMessageParameterInScope(data, offset, previousType, "message");
}

/**
 * FILL_PARAMETERS の Value (Number of Parameters + Parameters 列) をデコードする
 *
 * draft-ietf-moq-transport-23 §9.19.15:
 * "Its value is a Number of Parameters (vi64) followed by that many Parameters
 *  that apply to the fill fetch stream (see Section 3.4), encoded as if they
 *  were Parameters for a separate message (see Section 9.19)."
 * 外側 Length を持たないため、Number of Parameters と内側 Parameters の消費
 * バイト数だけで Value の終端を確定する。
 *
 * 内側 (fill) は外側 (message) から独立した parameter scope を持ち、Type Delta の
 * 基準は内側の先頭で 0、重複検証も内側の列だけで完結する。
 *
 * @returns [inner parameters, consumed bytes] consumed bytes には Number of
 *          Parameters のバイト数を含む
 */
function decodeFillParameterList(data: Uint8Array, offset: number): [Parameter[], number] {
  return decodeParameterListInScope(
    data,
    offset,
    "fill-parameters",
    (type) => `duplicate message parameter type inside FILL_PARAMETERS: 0x${type.toString(16)}`,
  );
}

/**
 * Parameters 列 (count + その個数の Parameters) をデコードする
 *
 * draft-ietf-moq-transport-23 §9.19:
 * Message Parameters は Number of Parameters (vi64) + その個数の Parameters で
 * 区切る。Type Delta の基準と重複検証は scope ごとに独立させる (§9.19.15)。
 *
 * @param scope - デコード中の Parameters 列のスコープ
 * @param duplicateMessage - 重複時のエラーメッセージを組み立てる関数
 * @returns [parameters, consumed bytes] consumed bytes には count のバイト数を含む
 */
function decodeParameterListInScope(
  data: Uint8Array,
  offset: number,
  scope: MessageParameterScope,
  duplicateMessage: (type: number) => string,
): [Parameter[], number] {
  const [numParameters, countConsumed] = decodeVarint(data, offset);
  let totalConsumed = countConsumed;
  const parameters: Parameter[] = [];
  let previousType = 0n;
  const seenTypes = new Set<number>();

  for (let i = 0; i < Number(numParameters); i++) {
    // count より内側が不足する切り詰めは、後続の外側パラメータを内側として
    // 読み進めようとする。多くの不正 count は scope の許可型検証
    // (fill の場合は §9.19.15 Table 7) かデータ末尾の IncompleteDataError で
    // 検出されるが、count 自体が境界を定義するため、後続バイトが偶然すべて
    // 許可型として解釈できる場合は原理的に切り詰めと判別できない
    // (仕様上 Length が無いことの帰結)。
    const [parameter, parameterConsumed, parameterType] = decodeMessageParameterInScope(
      data,
      offset + totalConsumed,
      previousType,
      scope,
    );

    if (seenTypes.has(parameter.type) && !isRepeatableMessageParameterType(parameter.type)) {
      throw new ProtocolViolationError(
        duplicateMessage(parameter.type),
        SessionErrorCode.INVALID_PARAMETER,
      );
    }
    seenTypes.add(parameter.type);

    parameters.push(parameter);
    totalConsumed += parameterConsumed;
    previousType = parameterType;
  }

  return [parameters, totalConsumed];
}

/**
 * Message Parameter リストをエンコードする
 *
 * draft-ietf-moq-transport-23 Section 9.19:
 * Message Parameters はカウントプレフィックス付きでエンコードする。
 * delta encoding を使用して Type を効率的にエンコードする。
 * パラメータは Type の昇順でソートされる。
 */
export function encodeParameters(params: Parameter[]): Uint8Array {
  // draft-ietf-moq-transport-23 §9.19 (Control Message Parameters):
  // "Senders MUST NOT repeat the same Parameter Type in a message unless the
  //  parameter definition explicitly allows multiple instances of that type to be
  //  sent in a single message."
  // 送信側の違反はローカル API の誤用であるため、受信側の ProtocolViolationError とは
  // 区別して汎用 Error で通知する。
  assertNoDuplicateMessageParameterTypes(params);

  // Type 昇順でソート
  const sorted = [...params].sort((a, b) => a.type - b.type);

  const countBytes = encodeVarint(sorted.length);
  const paramBytes: Uint8Array[] = [];
  let previousType = 0;

  for (const param of sorted) {
    paramBytes.push(encodeMessageParameter(param, previousType));
    previousType = param.type;
  }

  return concatUint8Arrays([countBytes, ...paramBytes]);
}

/**
 * Message Parameter リストをデコードする
 *
 * draft-ietf-moq-transport-23 Section 9.19:
 * Message Parameters はカウントプレフィックス付きでデコードする。
 * delta encoding を使用して Type をデコードする。
 * Value のエンコーディングはパラメータ型ごとに異なる。
 *
 * @returns [parameters, consumed bytes]
 */
export function decodeParameters(data: Uint8Array, offset = 0): [Parameter[], number] {
  // draft-ietf-moq-transport-23 Section 9.19:
  // "Receivers SHOULD check that there are no unexpected duplicate parameters
  //  and close the session with INVALID_PARAMETER if found."
  // 反復が許可される型の判定は送信側と共通の isRepeatableMessageParameterType を使う。
  return decodeParameterListInScope(
    data,
    offset,
    "message",
    (type) => `duplicate message parameter type: 0x${type.toString(16)}`,
  );
}

/**
 * 1 つのメッセージ内で複数回出現できる Parameter Type か判定する
 *
 * draft-ietf-moq-transport-23 §9.19 (Control Message Parameters):
 * "Senders MUST NOT repeat the same Parameter Type in a message unless the
 *  parameter definition explicitly allows multiple instances of that type to be
 *  sent in a single message."
 * 型として反復が許可されるのは次の 2 種である。
 *
 * - AUTHORIZATION TOKEN (0x03): 複数のトークンを 1 メッセージに載せられる
 * - Range Filter (0x25-0x29): §3.3.2 が複数回の出現を MAY とする
 *
 * 値レベルの一意性 (Alias 解決後の Token、Parameter Type と SetID と Property Type の
 * 組み合わせ) は本判定の対象外であり、それぞれ §8.9 / §3.3.2 の規則として扱う。
 */
export function isRepeatableMessageParameterType(paramType: number): boolean {
  return (
    paramType === MessageParameterType.AUTHORIZATION_TOKEN ||
    (paramType >= 0x25 && paramType <= 0x29)
  );
}

/**
 * 同一 Parameter Type の重複を検査する (送信側)
 *
 * draft-ietf-moq-transport-23 §9.19 (Control Message Parameters):
 * "Senders MUST NOT repeat the same Parameter Type in a message unless the
 *  parameter definition explicitly allows multiple instances of that type to be
 *  sent in a single message."
 * 受信側 (decodeParameters) は違反を draft-23 の INVALID_PARAMETER でクローズ
 * エンコード前にローカルで拒否する。エラーはローカル API の誤用を表す汎用 Error
 * とする (受信側の ProtocolViolationError と区別する)。
 *
 * @throws Error 反復可能でない型が 2 件以上ある場合
 */
export function assertNoDuplicateMessageParameterTypes(params: readonly { type: number }[]): void {
  const seenTypes = new Set<number>();
  for (const param of params) {
    if (seenTypes.has(param.type) && !isRepeatableMessageParameterType(param.type)) {
      throw new Error(
        `duplicate message parameter type: 0x${param.type.toString(16)} (senders MUST NOT repeat a Parameter Type)`,
      );
    }
    seenTypes.add(param.type);
  }
}

/**
 * FILL_PARAMETERS の内側 Parameters 列の送信前検証
 *
 * draft-ietf-moq-transport-23 §9.19.15:
 * "An endpoint that receives a parameter inside FILL_PARAMETERS that is not
 *  listed above MUST close the session with INVALID_PARAMETER."
 * 一覧外の型や FILL_PARAMETERS の入れ子を載せたワイヤを生成するとピアの
 * セッションが閉じるため、ローカル API の誤用として送信前に拒否する。
 * 同一 Type の重複検査 (§9.19 の MUST NOT repeat) は encodeParameters が行う。
 *
 * @throws Error 許可されない型または入れ子を含む場合
 */
function assertFillParametersForSend(innerParameters: readonly Parameter[]): void {
  for (const parameter of innerParameters) {
    if (parameter.type === MessageParameterType.FILL_PARAMETERS) {
      throw new Error("FILL_PARAMETERS must not be nested inside FILL_PARAMETERS");
    }
    if (!isFillParameterAllowed(parameter.type)) {
      throw new Error(
        `parameter type 0x${parameter.type.toString(16)} is not allowed inside FILL_PARAMETERS`,
      );
    }
  }
}

/**
 * FILL_PARAMETERS の内側に置ける型か判定する
 *
 * draft-ietf-moq-transport-23 §9.19.15 Table 7 の許可型かつ
 * FILL_PARAMETERS の入れ子でないことを判定する。送信前検証と受信側検証で
 * 同じ規則を使い、片側だけ更新される事故を防ぐ。
 *
 * @param paramType - 判定する Parameter Type
 * @returns 内側に置けるなら true
 */
function isFillParameterAllowed(paramType: number): boolean {
  return (
    paramType !== MessageParameterType.FILL_PARAMETERS &&
    FILL_PARAMETERS_ALLOWED_TYPES.has(paramType)
  );
}

/**
 * FILL_PARAMETERS パラメータをエンコードする
 *
 * draft-ietf-moq-transport-23 §9.19.15 (FILL PARAMETERS Parameter):
 * Parameter Type 0x23。Value は Number of Parameters (vi64) + その個数の
 * Parameters であり、外側 Length を持たない ("Its value is a Number of
 * Parameters (vi64) followed by that many Parameters ... encoded as if they
 * were Parameters for a separate message")。内側の Parameters 列は別メッセージの
 * Parameters としてエンコードする (count-prefixed の delta encoding 列)。
 *
 * ここでは構造 (Table 7 の許可型と FILL_PARAMETERS の非入れ子) だけを検証する。
 * Range Filter の remove 指定や LOCATION_FILTER の意味検証は、型付きの送信経路
 * (bidiSendRequestUpdate など) と受信側の decodeFillParameters が行う。
 *
 * @throws Error 内側に許可されない型または FILL_PARAMETERS の入れ子を含む場合、
 *   または反復不可の型が重複している場合 (encodeParameters が検出する)
 */
export function encodeFillParameters(innerParameters: Parameter[]): Parameter {
  assertFillParametersForSend(innerParameters);
  return {
    type: MessageParameterType.FILL_PARAMETERS,
    value: encodeParameters(innerParameters),
  };
}

/**
 * FILL_PARAMETERS パラメータをデコードする
 *
 * draft-ietf-moq-transport-23 §9.19.15 (FILL PARAMETERS Parameter):
 * Value の Number of Parameters と内側 Parameters の消費バイト数から内側の
 * Parameters 列をデコードする。Table 7 の一覧に無い型と FILL_PARAMETERS の入れ子は
 * デコード時に拒否される ("An endpoint that receives a parameter inside
 * FILL_PARAMETERS that is not listed above MUST close the session with
 */
export function decodeFillParameters(param: Parameter): Parameter[] {
  if (param.type !== MessageParameterType.FILL_PARAMETERS) {
    throw new Error(`Invalid parameter type: expected 0x23, got 0x${param.type.toString(16)}`);
  }
  const [innerParameters, consumed] = decodeFillParameterList(param.value, 0);
  // Value の終端は Number of Parameters と内側 Parameters で決まるため、
  // 残余バイトは Value の構築不正を表す。受信した param.value は
  // decodeMessageParameterInScope が消費バイト数で正確に切り出すため通常は
  // 到達しないが、受信経路 (validateLocationAndFillParameters) もこの関数を
  // 通るため、不変条件が崩れた場合にセッション終了へ安全側で倒せるよう
  // ProtocolViolationError とする (decodeLocationFilterParameter の残余バイトと
  // 同じ扱い)。
  if (consumed !== param.value.length) {
    throw new ProtocolViolationError(
      `malformed fill parameters: consumed ${consumed} bytes but value has ${param.value.length} bytes`,
      SessionErrorCode.MALFORMED_MESSAGE,
    );
  }
  // 内側 LOCATION_FILTER の値検証 (§9.19.9 MUST は内側にも適用される)。
  // 内側 Range Filter の値・重複検証は外側と同一規則で行い、違反は
  // InvalidFilterError として呼び出し側の経路別処理に委ねる
  // (REQUEST_UPDATE の受信では REQUEST_ERROR (INVALID_FILTER) として応答する)。
  // 内側 Range Filter の除去 (Length=0) は一回限りの fill に意味を持たないため
  // 拒否する (内側 LOCATION_FILTER は Type 0x00 を検証するのみで、fill 範囲の
  // 解釈は呼び出し側が行う)。
  const innerRanges: Parameter[] = [];
  for (const inner of innerParameters) {
    if (inner.type === MessageParameterType.LOCATION_FILTER) {
      decodeLocationFilterParameter(inner);
    } else if (inner.type >= 0x25 && inner.type <= 0x28) {
      // 範囲は上限合算側 (bidiSendRequestUpdate の prepareRawFillForUpdate) と
      // 一致させること (§9.19.15 の Table 7 に Range 系の型が追加された場合は両方を更新する)
      const [decodedRange] = decodeRangeFilter(rangeFilterTypeOf(inner.type), inner.value);
      if ("remove" in decodedRange) {
        throw new InvalidFilterError(
          `remove is not allowed inside FILL_PARAMETERS: 0x${inner.type.toString(16)}`,
        );
      }
      innerRanges.push(inner);
    }
  }
  validateRangeFilterCombination(innerRanges);
  return innerParameters;
}
