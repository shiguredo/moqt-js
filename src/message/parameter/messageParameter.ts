/**
 * MOQT Message Parameter
 * draft-ietf-moq-transport-21 Section 9.20 (Control Message Parameters)
 *
 * Message Parameter {
 *   Type Delta (vi64),
 *   Value (..)
 * }
 *
 * draft-ietf-moq-transport-21 §9.20 (Control Message Parameters):
 * Type Delta は前のパラメータの Type との差分で、パラメータは Type の昇順に
 * 並べる。Value のエンコーディングは各パラメータの定義が個別に定める
 * ("The encoding is specified by each parameter definition.")。このファイルでは
 * MESSAGE_PARAMETER_VALUE_ENCODING が型ごとのエンコーディングを持つ。
 *
 * 「偶数型: varint 値 / 奇数型: Length プレフィックス付きバイト列」という規則は
 * §8.3 (Key-Value-Pair Structure) のものであり、Message Parameter には適用されない。
 * Key-Value-Pair は ./kvp が扱う。
 *
 * FILL_PARAMETERS (§9.20.16) は内側に Parameters 列 (count-prefixed) を格納する
 * Message Parameter のため、本モジュールで扱う。
 */

import { InvalidFilterError, ProtocolViolationError } from "../../error";
import { decodeVarint, encodeVarint, MAX_VARINT } from "../../varint";
import { assertLengthWithinData } from "../../length";
import { MessageParameterType, type Location } from "../types";
import { concatUint8Arrays } from "../../bytes";
import { MAX_KVP_VALUE_LENGTH, type Parameter } from "./common";
import { decodeTrackNamespace } from "./trackNamespace";
import { decodeLocationFilterParameter } from "./locationFilter";
import {
  decodeRangeFilter,
  rangeFilterTypeOf,
  validateRangeFilterCombination,
} from "./rangeFilter";

/**
 * パラメータから Location 値を取得
 *
 * LARGEST_OBJECT (0x09) パラメータなど、Location を含むパラメータ用
 * draft-ietf-moq-transport-21 Section 9.20.18 (LARGEST OBJECT Parameter)
 */
export function getParameterLocationValue(param: Parameter): Location {
  const [location] = decodeLocation(param.value, 0);
  return location;
}

/**
 * GROUP_ORDER パラメータの値を検証する
 *
 * draft-ietf-moq-transport-21 Section 9.20.9:
 * "The allowed values are Ascending (0x1) or Descending (0x2).
 *  If an endpoint receives a value outside this range, it MUST close
 *  the session with PROTOCOL_VIOLATION."
 */
export function validateGroupOrderValue(value: number): void {
  if (value !== 0x01 && value !== 0x02) {
    throw new ProtocolViolationError(
      `invalid GROUP_ORDER value: 0x${value.toString(16)}, expected 0x1 or 0x2`,
    );
  }
}

/**
 * FORWARD パラメータの値を検証する
 *
 * draft-ietf-moq-transport-21 Section 9.20.19:
 * "The allowed values are 0 (don't forward) or 1 (forward).
 *  If an endpoint receives a value outside this range, it MUST close
 *  the session with PROTOCOL_VIOLATION."
 */
export function validateForwardValue(value: number): void {
  if (value !== 0 && value !== 1) {
    throw new ProtocolViolationError(`invalid FORWARD value: ${value}, expected 0 or 1`);
  }
}

/**
 * INCLUDE_PROPERTIES パラメータの値を検証する
 *
 * draft-ietf-moq-transport-21 Section 9.20.22:
 * "The allowed values are 0 (do not send Properties)
 *  or 1 (send Properties), and the default is 1.
 *  If an endpoint receives a value outside this range, it MUST close
 *  the session with PROTOCOL_VIOLATION."
 */
export function validateIncludePropertiesValue(value: number): void {
  if (value !== 0 && value !== 1) {
    throw new ProtocolViolationError(`invalid INCLUDE_PROPERTIES value: ${value}, expected 0 or 1`);
  }
}

/**
 * uint8 型の Message Parameter Value をエンコードする
 *
 * draft-ietf-moq-transport-21 Section 9.20.8 / 9.20.9 / 9.20.19:
 * SUBSCRIBER_PRIORITY / GROUP_ORDER / FORWARD は varint ではなく uint8。
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
 * draft-ietf-moq-transport-21 Section 9.20:
 * Value のエンコーディングはパラメータ定義ごとに異なる。
 * - uint8: 1 バイトの符号なし整数
 * - varint: 可変長整数
 * - location: 2 つの連続した varint (Group, Object)
 * - length-prefixed: varint 長 + バイト列 (外側に Length を付加する)
 * - self-length-prefixed: 値が自ら Length (vi64) を内包する 1 Length 構造
 *   (外側 Length は付加しない。draft-ietf-moq-transport-21 §9.20.10 / §8.6
 *   の Range Filter と LOCATION_FILTER が該当)
 * - track-namespace: Track Namespace (Number of Track Namespace Fields + 各
 *   フィールドの Length + Value) の自己区切り構造 (外側 Length は付加しない。
 *   draft-ietf-moq-transport-21 §9.20.21 が参照する §8.7 のエンコーディング)
 */
type MessageParameterValueEncoding =
  | "uint8"
  | "varint"
  | "location"
  | "length-prefixed"
  | "self-length-prefixed"
  | "track-namespace";

/**
 * パラメータ型ごとの Value エンコーディング定義
 *
 * draft-ietf-moq-transport-21 Section 9.20:
 * Message Parameters は Key-Value-Pair (Figure 2) とは異なり、
 * 各パラメータ型が独自の Value エンコーディングを定義する。
 */
const MESSAGE_PARAMETER_VALUE_ENCODING: Record<number, MessageParameterValueEncoding> = {
  // OBJECT_DELIVERY_TIMEOUT (Section 9.20.5)
  0x02: "varint",
  // AUTHORIZATION_TOKEN (Section 9.20.3)
  0x03: "length-prefixed",
  // RENDEZVOUS_TIMEOUT (Section 9.20.7)
  0x04: "varint",
  // SUBGROUP_DELIVERY_TIMEOUT (Section 9.20.4)
  0x06: "varint",
  // EXPIRES (Section 9.20.17)
  0x08: "varint",
  // LARGEST_OBJECT (Section 9.20.18)
  0x09: "location",
  // FILL_TIMEOUT (Section 9.20.6)
  0x0a: "varint",
  // FORWARD (Section 9.20.19)
  0x10: "uint8",
  // SUBSCRIBER_PRIORITY (Section 9.20.8)
  0x20: "uint8",
  // LOCATION_FILTER (Section 9.20.10)
  // draft-ietf-moq-transport-21 §9.20.10: Value は Length (vi64) + optional
  // vi64 フィールド (0〜4) の 1 Length 構造。外側 Length は付加しない
  // (Range Filter と同一形式。Appendix A.2 #1809 で「match the other filter
  //  parameters」と再構成された)
  0x21: "self-length-prefixed",
  // GROUP_ORDER (Section 9.20.9)
  0x22: "uint8",
  // FILL_PARAMETERS (Section 9.20.16)
  // Value は Parameters 列 (count-prefixed) を格納する length-prefixed 構造。
  // 内側は別メッセージの Parameters としてエンコードする (§9.20.16)。
  0x23: "length-prefixed",
  // NEW_GROUP_REQUEST (Section 9.20.20)
  0x32: "varint",
  // TRACK_NAMESPACE_PREFIX (Section 9.20.21)
  // Value は §8.7 の Track Namespace エンコーディングそのもの。
  // フィールド数 + 各フィールドの Length + Value で自己区切りになるため
  // 外側 Length は付加しない (length-prefixed ではない)。
  0x34: "track-namespace",
  // INCLUDE_PROPERTIES (Section 9.20.22)
  0x35: "uint8",
  // Range Filters (draft-ietf-moq-transport-21 Section 3.3.2 / 9.20.11–9.20.15)
  // Value は Length (vi64) + [SetID + [Property Type] + Range 列] の 1 Length 構造。
  // 外側に Length を付加しない (length-prefixed から分離した専用種別)。
  0x25: "self-length-prefixed", // SUBGROUP_FILTER
  0x26: "self-length-prefixed", // OBJECTID_FILTER
  0x27: "self-length-prefixed", // PRIORITY_FILTER
  0x28: "self-length-prefixed", // OBJECT_PROPERTY_FILTER
  0x29: "self-length-prefixed", // TRACK_PROPERTY_FILTER
};

/**
 * パラメータ型から Value エンコーディングを取得する
 *
 * draft-ietf-moq-transport-21 Section 9.20:
 * "An endpoint that receives an unknown Message Parameter MUST close
 *  the session with PROTOCOL_VIOLATION."
 * https://www.ietf.org/archive/id/draft-ietf-moq-transport-21.html#section-9.20
 *
 * 未知のパラメータ型の場合はエラーをスローする。
 */
function getMessageParameterValueEncoding(paramType: number): MessageParameterValueEncoding {
  const encoding = MESSAGE_PARAMETER_VALUE_ENCODING[paramType];
  if (encoding === undefined) {
    throw new ProtocolViolationError(`unknown message parameter type: 0x${paramType.toString(16)}`);
  }
  return encoding;
}

/**
 * 単一の Message Parameter をエンコードする (delta encoding)
 *
 * draft-ietf-moq-transport-21 Section 9.20:
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

  // uint8, varint, location, self-length-prefixed, track-namespace:
  // Value をそのまま書き込む。self-length-prefixed の Value は self エンコードの
  // 出力 (自ら Length を含む 1 Length 構造)、track-namespace の Value は
  // §8.7 の自己区切り構造のため、いずれも外側 Length は付加しない
  // (draft-ietf-moq-transport-21 §9.20.10 / §8.6 / §9.20.21)
  return concatUint8Arrays([deltaBytes, param.value]);
}

/**
 * 単一の Message Parameter をデコードする (delta encoding)
 *
 * draft-ietf-moq-transport-21 Section 9.20:
 * Message Parameter {
 *   Type Delta (vi64),
 *   Value (..)
 * }
 *
 * 主に decodeParameters の内部実装として使用される。テスト用に公開するが、
 * 公開 API (src/message/index.ts) には含めない。
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
  const [deltaType, deltaConsumed] = decodeVarint(data, offset);
  const paramType = previousType + deltaType;

  // draft-ietf-moq-transport-21 Section 9.20 (Message Parameters):
  // "If the resulting Type would be greater than 2^64 - 1, the endpoint MUST
  //  close the session with a PROTOCOL_VIOLATION."
  if (paramType > MAX_VARINT) {
    throw new ProtocolViolationError(
      `delta type addition exceeds maximum: ${paramType} > ${MAX_VARINT}`,
    );
  }

  const paramTypeNumber = Number(paramType);
  let totalConsumed = deltaConsumed;

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
        );
      }
      // draft-ietf-moq-transport-21 §9.20.9 / §9.20.19:
      // FORWARD (0x10) / GROUP_ORDER (0x22) は受信時に値域 MUST 検証
      // draft-ietf-moq-transport-21 §9.20.22:
      // INCLUDE_PROPERTIES (0x35) も 0/1 以外は PROTOCOL_VIOLATION
      if (paramTypeNumber === 0x10) {
        validateForwardValue(valueByte);
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
      const [length, lengthConsumed] = decodeVarint(data, offset + totalConsumed);
      totalConsumed += lengthConsumed;
      if (Number(length) > MAX_KVP_VALUE_LENGTH) {
        throw new ProtocolViolationError(
          `message parameter value length exceeds maximum: ${length} > ${MAX_KVP_VALUE_LENGTH}`,
        );
      }
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
      // draft-ietf-moq-transport-21 Section 8.6 / 9.20.10:
      // Range Filter / LOCATION_FILTER の Value は Length (vi64) で始まり、
      // その後にペイロードが続く 1 Length 構造。
      // 内側 Length を読んで全体を value として保持する (decodeLocationFilter /
      // decodeRangeFilter の入力形式に合わせる。Length を剥がすと先頭フィールド
      // を Length と誤読する)。
      const [length, lengthConsumed] = decodeVarint(data, offset + totalConsumed);
      totalConsumed += lengthConsumed;
      // 既存 length-prefixed 分岐と同じ上限を維持する (防御的制限。
      // フィルタの Length は仕様で上限が明記されていないが、
      // 6 万バイト超のフィルタは実用上存在せず、過大宣言の DoS を防ぐ)
      if (Number(length) > MAX_KVP_VALUE_LENGTH) {
        throw new ProtocolViolationError(
          `message parameter value length exceeds maximum: ${length} > ${MAX_KVP_VALUE_LENGTH}`,
        );
      }
      // 内側 Length が残りバイト数を超える場合はフレーミング破損として
      // PROTOCOL_VIOLATION で扱う (短い slice を作らない)
      assertLengthWithinData("filter value", length, offset + totalConsumed, data.length);
      value = data.slice(
        offset + totalConsumed - lengthConsumed,
        offset + totalConsumed + Number(length),
      );
      totalConsumed += Number(length);
      break;
    }
    case "track-namespace": {
      // draft-ietf-moq-transport-21 §9.20.21:
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
  }

  return [{ type: paramTypeNumber, value }, totalConsumed, paramType];
}

/**
 * Message Parameter リストをエンコードする
 *
 * draft-ietf-moq-transport-21 Section 9.20:
 * Message Parameters はカウントプレフィックス付きでエンコードする。
 * delta encoding を使用して Type を効率的にエンコードする。
 * パラメータは Type の昇順でソートされる。
 */
export function encodeParameters(params: Parameter[]): Uint8Array {
  // draft-ietf-moq-transport-21 §9.20 (Control Message Parameters):
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
 * draft-ietf-moq-transport-21 Section 9.20:
 * Message Parameters はカウントプレフィックス付きでデコードする。
 * delta encoding を使用して Type をデコードする。
 * Value のエンコーディングはパラメータ型ごとに異なる。
 *
 * @returns [parameters, consumed bytes]
 */
export function decodeParameters(data: Uint8Array, offset = 0): [Parameter[], number] {
  const [numParams, consumed] = decodeVarint(data, offset);
  let totalConsumed = consumed;
  const parameters: Parameter[] = [];
  let previousType = 0n;
  const seenTypes = new Set<number>();

  for (let i = 0; i < Number(numParams); i++) {
    const [param, paramConsumed, paramType] = decodeMessageParameter(
      data,
      offset + totalConsumed,
      previousType,
    );

    // draft-ietf-moq-transport-21 Section 9.20:
    // "Receivers SHOULD check that there are no unexpected duplicate parameters
    //  and close the session with PROTOCOL_VIOLATION if found."
    // 反復が許可される型の判定は送信側と共通の isRepeatableMessageParameterType を使う。
    if (seenTypes.has(param.type) && !isRepeatableMessageParameterType(param.type)) {
      throw new ProtocolViolationError(
        `duplicate message parameter type: 0x${param.type.toString(16)}`,
      );
    }
    seenTypes.add(param.type);

    parameters.push(param);
    totalConsumed += paramConsumed;
    previousType = paramType;
  }

  return [parameters, totalConsumed];
}

/**
 * 1 つのメッセージ内で複数回出現できる Parameter Type か判定する
 *
 * draft-ietf-moq-transport-21 §9.20 (Control Message Parameters):
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
 * draft-ietf-moq-transport-21 §9.20 (Control Message Parameters):
 * "Senders MUST NOT repeat the same Parameter Type in a message unless the
 *  parameter definition explicitly allows multiple instances of that type to be
 *  sent in a single message."
 * 受信側 (decodeParameters) は違反を PROTOCOL_VIOLATION でセッションクローズするが、
 * 送信側で生成したワイヤはピアのセッションを落とすため、エンコード前にローカルで
 * 拒否する。エラーはローカル API の誤用を表す汎用 Error とする
 * (受信側の ProtocolViolationError と区別する)。
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
 * FILL_PARAMETERS の内側に出現可能なパラメータ型
 *
 * draft-ietf-moq-transport-21 §9.20.16 Table 6:
 * FILL_TIMEOUT (0x0A) / SUBSCRIBER_PRIORITY (0x20) / LOCATION_FILTER (0x21) /
 * GROUP_ORDER (0x22) / Range Filters (0x25-0x28)。TRACK_PROPERTY_FILTER (0x29)
 * は SUBSCRIBE_TRACKS 専用のため含まない。
 * 上記以外を受信した endpoint は PROTOCOL_VIOLATION でセッションを閉じる。
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
 * FILL_PARAMETERS パラメータをエンコードする
 *
 * draft-ietf-moq-transport-21 §9.20.16 (FILL PARAMETERS Parameter):
 * Parameter Type 0x23、length-prefixed encoding。値は fill fetch ストリームに
 * 適用する Parameters 列を、別メッセージの Parameters としてエンコードした
 * もの (count-prefixed の delta encoding 列)。
 */
export function encodeFillParameters(innerParameters: Parameter[]): Parameter {
  return {
    type: MessageParameterType.FILL_PARAMETERS,
    value: encodeParameters(innerParameters),
  };
}

/**
 * FILL_PARAMETERS パラメータをデコードする
 *
 * draft-ietf-moq-transport-21 §9.20.16 (FILL PARAMETERS Parameter):
 * 内側の Parameters 列をデコードし、Table 6 の一覧に無い型が含まれる場合は
 * PROTOCOL_VIOLATION で拒否する ("An endpoint that receives a parameter
 *  inside FILL_PARAMETERS that is not listed above MUST close the session
 *  with a PROTOCOL_VIOLATION.")。
 */
export function decodeFillParameters(param: Parameter): Parameter[] {
  if (param.type !== MessageParameterType.FILL_PARAMETERS) {
    throw new Error(`Invalid parameter type: expected 0x23, got 0x${param.type.toString(16)}`);
  }
  const [innerParameters, consumed] = decodeParameters(param.value, 0);
  if (consumed !== param.value.length) {
    throw new ProtocolViolationError(
      `malformed fill parameters: declared length does not match parameters: ${consumed} !== ${param.value.length}`,
    );
  }
  // 内側 LOCATION_FILTER の値検証 (§9.20.10 MUST は内側にも適用される)。
  // 内側 Range Filter の値・重複検証は外側と同一規則で行い、違反は
  // InvalidFilterError として呼び出し側の経路別処理に委ねる
  // (PUBLISH_OK では PROTOCOL_VIOLATION、REQUEST_UPDATE では
  // REQUEST_ERROR (INVALID_FILTER))。
  // 内側の除去 (Length=0) は一回限りの fill に意味を持たないため拒否する。
  const innerRanges: Parameter[] = [];
  for (const inner of innerParameters) {
    if (!FILL_PARAMETERS_ALLOWED_TYPES.has(inner.type)) {
      throw new ProtocolViolationError(
        `unsupported parameter inside FILL_PARAMETERS: 0x${inner.type.toString(16)}`,
      );
    }
    if (inner.type === MessageParameterType.LOCATION_FILTER) {
      decodeLocationFilterParameter(inner);
    } else if (inner.type >= 0x25 && inner.type <= 0x28) {
      // 範囲は上限合算側 (bidiSendRequestUpdate の prepareRawFillForUpdate) と
      // 一致させること (§9.20.16 の Table 6 に Range 系の型が追加された場合は両方を更新する)
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
