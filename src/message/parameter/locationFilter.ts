/**
 * MOQT Location Filter
 * draft-ietf-moq-transport-22 Section 3.3.1 / Section 9.20.9
 *
 * LOCATION_FILTER Parameter (Type 0x21) の Value は Location Filter Type (vi64) と
 * その型が定める optional な vi64 フィールドで構成される。v21 の Length (vi64)
 * プレフィックス方式は廃止され、Value の長さは Type とフィールド数で決まるため、
 * Message Parameter 側では外側 Length を付加しない (§9.20.9)。
 */

import { InvalidFilterError, ProtocolViolationError } from "../../error";
import { decodeVarint, encodeVarint, MAX_VARINT } from "../../varint";
import { concatUint8Arrays } from "../../bytes";
import { type Parameter } from "./common";

/**
 * Location Filter (Section 3.3.1, Section 9.20.9)
 *
 * draft-ietf-moq-transport-22 §9.20.9 の構造:
 *
 *   LOCATION_FILTER Parameter {
 *     Parameter Type (vi64) = 0x21,
 *     Location Filter Type (vi64),
 *     [StartGroup (vi64),]
 *     [StartObject (vi64),]
 *     [EndGroupDelta (vi64),]
 *     [EndObject (vi64),]
 *   }
 *
 * Location Filter Type が後続フィールドの有無と意味を決める (Table 6):
 * - 0x00 (None): フィールドなし。フィルタなし
 * - 0x01 (Relative Start): StartGroup のみ。開始は
 *   {Largest Object.Group + 1 - StartGroup, 0} (0 未満は 0、2^64-1 超は 2^64-1)
 * - 0x02 (Absolute Start): StartGroup + StartObject。開始のみ (終端なし)
 * - 0x03 (Absolute Start, Group End): + EndGroupDelta。End Group は
 *   StartGroup + EndGroupDelta で、その Group の全 Object が対象
 * - 0x04 (Absolute Range): + EndObject。End Group 内の EndObject までが対象
 * - 0x05 (Next Object): フィールドなし。開始は Largest Object の次の Object
 * - 上記以外の Type は PROTOCOL_VIOLATION
 *
 * 0:0 の特例 (v21 の「2 フィールドで StartGroup = StartObject = 0 は Next Object」)
 * は廃止された。0x02 の 0:0 は絶対位置 {0, 0} を表し、Next Object は 0x05 が表す。
 *
 * EndGroupDelta は StartGroup からの差分であり、End Group = StartGroup +
 * EndGroupDelta。End Group が 2^64-1 を超える場合は PROTOCOL_VIOLATION
 * (§9.20.9 の MUST)。送信側は encodeLocationFilter が送信前に
 * InvalidFilterError で、受信デコード時は decodeLocationFilter が
 * ProtocolViolationError で超過を拒否する。
 */
export type LocationFilter =
  // 0x00 (None): フィルタなし (REQUEST_UPDATE での除去など)
  | { reset: true }
  // 0x01 (Relative Start): StartGroup のみ。Largest Object 基準の相対指定
  | { startGroup: bigint }
  // 0x02 (Absolute Start): StartGroup + StartObject
  | { startGroup: bigint; startObject: bigint }
  // 0x03 (Absolute Start, Group End): StartGroup + StartObject + EndGroupDelta
  | { startGroup: bigint; startObject: bigint; endGroupDelta: bigint }
  // 0x04 (Absolute Range): StartGroup + StartObject + EndGroupDelta + EndObject
  | { startGroup: bigint; startObject: bigint; endGroupDelta: bigint; endObject: bigint }
  // 0x05 (Next Object): Largest Object の次の Object から
  | { nextObject: true };

/** 0x00 (None): フィルタなし (draft-ietf-moq-transport-22 §9.20.9 Table 6) */
const LOCATION_FILTER_TYPE_NONE = 0x00n;
/** 0x01 (Relative Start): Largest Object 基準の相対開始 */
const LOCATION_FILTER_TYPE_RELATIVE_START = 0x01n;
/** 0x02 (Absolute Start): 絶対開始 */
const LOCATION_FILTER_TYPE_ABSOLUTE_START = 0x02n;
/** 0x03 (Absolute Start, Group End): 絶対開始 + End Group */
const LOCATION_FILTER_TYPE_ABSOLUTE_GROUP_END = 0x03n;
/** 0x04 (Absolute Range): 絶対開始 + End Group + End Object */
const LOCATION_FILTER_TYPE_ABSOLUTE_RANGE = 0x04n;
/** 0x05 (Next Object): Largest Object の次の Object */
const LOCATION_FILTER_TYPE_NEXT_OBJECT = 0x05n;

/**
 * Location Filter のワイヤ形式 (Type と Type に続く vi64 フィールド列)
 */
interface LocationFilterForm {
  /** Location Filter Type (vi64) */
  type: bigint;
  /** Type に続く vi64 フィールド列 (Type が個数を決める) */
  fields: bigint[];
}

/**
 * 公開型をワイヤ形式 (Type とフィールド列) に写す
 *
 * 公開型の場合分けとワイヤの Type・フィールド列を 1 箇所で対応させる。
 * encode は Type を先頭に書いてフィールドを続け、isSameLocationFilter は Type と
 * フィールド列を比較するため、判別を共有して両者がずれないようにする。
 * 0x00 (reset) と 0x05 (nextObject) はどちらもフィールド列が空になるため、
 * 等価判定は必ず Type を先に比較すること。
 */
function locationFilterFormOf(filter: LocationFilter): LocationFilterForm {
  if ("reset" in filter) {
    return { type: LOCATION_FILTER_TYPE_NONE, fields: [] };
  }
  if ("nextObject" in filter) {
    return { type: LOCATION_FILTER_TYPE_NEXT_OBJECT, fields: [] };
  }
  if (!("startObject" in filter)) {
    return { type: LOCATION_FILTER_TYPE_RELATIVE_START, fields: [filter.startGroup] };
  }
  if (!("endGroupDelta" in filter)) {
    return {
      type: LOCATION_FILTER_TYPE_ABSOLUTE_START,
      fields: [filter.startGroup, filter.startObject],
    };
  }
  if (!("endObject" in filter)) {
    return {
      type: LOCATION_FILTER_TYPE_ABSOLUTE_GROUP_END,
      fields: [filter.startGroup, filter.startObject, filter.endGroupDelta],
    };
  }
  return {
    type: LOCATION_FILTER_TYPE_ABSOLUTE_RANGE,
    fields: [filter.startGroup, filter.startObject, filter.endGroupDelta, filter.endObject],
  };
}

/** Location Filter の 3 / 4 フィールド表現の End Group 超過を検証する */
function validateLocationFilterEndGroup(startGroup: bigint, endGroupDelta: bigint): void {
  if (startGroup + endGroupDelta > MAX_VARINT) {
    throw new InvalidFilterError(
      `absolute range end group exceeds maximum: ${startGroup} + ${endGroupDelta} > ${MAX_VARINT}`,
    );
  }
}

/**
 * Next Object 形式 (0x05) の Location Filter かどうかを判定する
 *
 * draft-ietf-moq-transport-22 §9.20.9 Table 6: Next Object は専用の
 * Location Filter Type 0x05 が表す。v21 の「2 フィールドで
 * StartGroup = StartObject = 0」という特例は廃止されたため、絶対位置 {0, 0} の
 * 指定 (0x02) は Next Object と判定しない。
 */
export function isNextObjectLocationFilter(filter: LocationFilter): filter is { nextObject: true } {
  return "nextObject" in filter;
}

/**
 * Location Filter の構造等価を判定する
 *
 * draft-ietf-moq-transport-22 §9.10 (PUBLISH_STATE_NOTIFY):
 * "If a parameter is not present, its value is unchanged."
 * 値の変化したパラメータのみを運ぶため、同じ内容の LOCATION_FILTER が
 * 再報告されることはない。しかし再報告された場合に再解決すると、
 * 進んだ LARGEST_OBJECT で相対指定が再評価されて開始位置が前進し得る。
 * 呼び出し側が再解決の要否を判断できるよう、等価判定をここに置く。
 *
 * 未設定 (undefined) 同士は等価、undefined と設定済みは非等価とする。
 * 0x00 (reset) と 0x05 (nextObject) はフィールド列がどちらも空になるため、
 * Type の比較を先に行わないと別の種別を等価と誤判定する。
 *
 * undefined と { reset: true } は、どちらも resolveFilter ではフィルタなしに
 * 解決されるが、ここでは非等価とする。フィルタを明示的に除去する指定を
 * 「未設定のまま」と同一視すると、除去の通知が送られなくなるためである。
 */
export function isSameLocationFilter(
  a: LocationFilter | undefined,
  b: LocationFilter | undefined,
): boolean {
  if (a === undefined || b === undefined) {
    return a === b;
  }
  const aForm = locationFilterFormOf(a);
  const bForm = locationFilterFormOf(b);
  if (aForm.type !== bForm.type) {
    return false;
  }
  return (
    aForm.fields.length === bForm.fields.length &&
    aForm.fields.every((value, i) => value === bForm.fields[i])
  );
}

/**
 * Location Filter をエンコードする
 * draft-ietf-moq-transport-22 §9.20.9 (LOCATION FILTER Parameter)
 *
 * 先頭に Location Filter Type (vi64) を書き、型が定める個数の vi64 を続ける。
 * フィールド数は型で決まるため、Value の長さは自己区切りになる。
 *
 * 3 / 4 フィールド表現は End Group (StartGroup + EndGroupDelta) の 2^64-1 超過を
 * 送信前に検証し、InvalidFilterError で拒否する (§9.20.9 の MUST)。負値 (startGroup /
 * startObject / endGroupDelta / endObject のいずれ) と、和の検証に捕捉されない
 * startObject / endObject の単体超過は encodeVarint 由来の Error として throw
 * される。節番号は仕様将来版で変わる可能性がある。
 */
export function encodeLocationFilter(filter: LocationFilter): Uint8Array {
  const { type, fields } = locationFilterFormOf(filter);
  const typeBytes = encodeVarint(type);
  if (fields.length === 0) {
    // 0x00 (None) / 0x05 (Next Object) は Type のみ
    return typeBytes;
  }

  // draft-ietf-moq-transport-22 §9.20.9 (LOCATION FILTER Parameter):
  // "If StartGroup + EndGroupDelta exceeds 2^64 - 1, the endpoint MUST
  //  close the session with a PROTOCOL_VIOLATION."
  // 超過ワイヤを受信した endpoint はこの MUST でセッションを閉じる
  // ため、送信前に InvalidFilterError でローカル拒否する
  if ("endGroupDelta" in filter) {
    validateLocationFilterEndGroup(filter.startGroup, filter.endGroupDelta);
  }

  return concatUint8Arrays([typeBytes, ...fields.map((field) => encodeVarint(field))]);
}

/**
 * Location Filter をデコードする
 * draft-ietf-moq-transport-22 §9.20.9 (LOCATION FILTER Parameter)
 *
 * 先頭の Location Filter Type (vi64) を読み、型が定める個数の vi64 を読む。
 * Type 0x00 / 0x05 はフィールドを持たないため Type のみを消費する。
 *
 * 未知の Location Filter Type は PROTOCOL_VIOLATION (ProtocolViolationError) を
 * throw する (§9.20.9。受信経路に載った場合は PROTOCOL_VIOLATION のセッション
 * 終了変換規則に乗る)。
 *
 * 3 / 4 フィールド表現は End Group (StartGroup + EndGroupDelta) の 2^64-1 超過を
 * ProtocolViolationError で throw する (§9.20.9 の MUST。この MUST は超過に対して
 * PROTOCOL_VIOLATION を一択としており、§3.3.1 が Location Filter に対して定める
 * REQUEST_ERROR は充足不能範囲の INVALID_RANGE であるため、デコード段階では
 * ProtocolViolationError で検出する)。
 *
 * @returns [filter, consumed bytes]
 */
export function decodeLocationFilter(data: Uint8Array, offset = 0): [LocationFilter, number] {
  const { type, fields, consumed: totalConsumed } = scanLocationFilter(data, offset);

  switch (type) {
    case LOCATION_FILTER_TYPE_NONE:
      // 0x00 (None): フィルタなし (REQUEST_UPDATE での除去など)
      return [{ reset: true }, totalConsumed];

    case LOCATION_FILTER_TYPE_RELATIVE_START:
      // 0x01 (Relative Start): StartGroup のみ
      return [{ startGroup: requireLocationField(fields[0], "start group") }, totalConsumed];

    case LOCATION_FILTER_TYPE_ABSOLUTE_START:
      // 0x02 (Absolute Start): StartGroup + StartObject。0:0 も絶対位置 {0, 0} を表す
      return [
        {
          startGroup: requireLocationField(fields[0], "start group"),
          startObject: requireLocationField(fields[1], "start object"),
        },
        totalConsumed,
      ];

    case LOCATION_FILTER_TYPE_ABSOLUTE_GROUP_END: {
      // draft-ietf-moq-transport-22 §9.20.9 (LOCATION FILTER Parameter):
      // "If StartGroup + EndGroupDelta exceeds 2^64 - 1, the endpoint MUST
      //  close the session with a PROTOCOL_VIOLATION."
      const startGroup = requireLocationField(fields[0], "start group");
      const startObject = requireLocationField(fields[1], "start object");
      const endGroupDelta = requireLocationField(fields[2], "end group delta");
      assertEndGroupWithinMaximum(startGroup, endGroupDelta);
      return [{ startGroup, startObject, endGroupDelta }, totalConsumed];
    }

    case LOCATION_FILTER_TYPE_ABSOLUTE_RANGE: {
      const startGroup = requireLocationField(fields[0], "start group");
      const startObject = requireLocationField(fields[1], "start object");
      const endGroupDelta = requireLocationField(fields[2], "end group delta");
      const endObject = requireLocationField(fields[3], "end object");
      assertEndGroupWithinMaximum(startGroup, endGroupDelta);
      return [{ startGroup, startObject, endGroupDelta, endObject }, totalConsumed];
    }

    case LOCATION_FILTER_TYPE_NEXT_OBJECT:
      // 0x05 (Next Object): フィールドなし
      return [{ nextObject: true }, totalConsumed];

    default:
      // locationFilterFieldCount が 0x00〜0x05 以外を拒否するため到達しない。
      // 将来 Type を追加したときに無言で Next Object と解釈しないための防御
      // (§9.20.9「Any other Location Filter Type is a PROTOCOL_VIOLATION.」)
      throw new ProtocolViolationError(`unknown location filter type: 0x${type.toString(16)}`);
  }
}

/**
 * Location Filter のフレーミング (Type と Type が定める個数の vi64) を読み取る
 *
 * framing の走査を decodeLocationFilter と locationFilterEncodedLength で共有する。
 * 両者は同じ入力に対して必ず同じ消費バイト数を返さなければならず (次の
 * パラメータの位置がこれで決まる)、走査を 2 本持つと片方の変更で静かに
 * フレーミングが壊れるためである。
 *
 * 値の意味論 (End Group の超過検証など) は検証しない。未知の Location Filter
 * Type はフィールド数を確定できず後続の位置も決まらないため、framing の時点で
 * PROTOCOL_VIOLATION とする (§9.20.9)。data が途中で尽きた場合は decodeVarint の
 * IncompleteDataError がそのまま伝播する。
 *
 * @returns 読み取った Type・フィールド列と消費バイト数
 */
function scanLocationFilter(
  data: Uint8Array,
  offset: number,
): { type: bigint; fields: bigint[]; consumed: number } {
  const [type, typeConsumed] = decodeVarint(data, offset);
  const fieldCount = locationFilterFieldCount(type);

  const fields: bigint[] = [];
  let current = offset + typeConsumed;
  for (let i = 0; i < fieldCount; i++) {
    const [value, consumed] = decodeVarint(data, current);
    fields.push(value);
    current += consumed;
  }
  return { type, fields, consumed: current - offset };
}

/**
 * Location Filter のフレーミングが占めるバイト数を返す
 *
 * draft-ietf-moq-transport-22 §9.20.9: Location Filter は Length を持たず、
 * Location Filter Type (vi64) と型が定める個数の vi64 で自己区切りになる。
 * Message Parameter の層で次のパラメータの位置を確定するために、値の意味論
 * (End Group の超過検証など) は行わずバイト数だけを求める。意味論の検証は
 * decodeLocationFilter / decodeLocationFilterParameter が担う。
 *
 * 注意: Type が宣言する個数より実際のフィールドが少ない不正ワイヤでは、続く
 * パラメータのバイトを自分のフィールドとして吸収し得る。Length を廃止した v22 では
 * 原理的に検出できず、吸収後にパラメータ個数と Body 長がともに一致するワイヤ
 * (例: フィールド不足の LOCATION_FILTER + 別パラメータ) はそのまま解釈される。
 *
 * @returns 消費バイト数
 */
export function locationFilterEncodedLength(data: Uint8Array, offset = 0): number {
  return scanLocationFilter(data, offset).consumed;
}

/**
 * Location Filter Type が定める後続フィールド数を返す
 *
 * draft-ietf-moq-transport-22 §9.20.9 (LOCATION FILTER Parameter):
 * 0x00 / 0x05 は 0、0x01 は 1、0x02 は 2、0x03 は 3、0x04 は 4。
 * 未知の Type は PROTOCOL_VIOLATION
 * ("Any other Location Filter Type is a PROTOCOL_VIOLATION.")。
 *
 * @param type - Location Filter Type
 */
function locationFilterFieldCount(type: bigint): number {
  switch (type) {
    case LOCATION_FILTER_TYPE_NONE:
    case LOCATION_FILTER_TYPE_NEXT_OBJECT:
      return 0;
    case LOCATION_FILTER_TYPE_RELATIVE_START:
      return 1;
    case LOCATION_FILTER_TYPE_ABSOLUTE_START:
      return 2;
    case LOCATION_FILTER_TYPE_ABSOLUTE_GROUP_END:
      return 3;
    case LOCATION_FILTER_TYPE_ABSOLUTE_RANGE:
      return 4;
    default:
      throw new ProtocolViolationError(`unknown location filter type: 0x${type.toString(16)}`);
  }
}

/**
 * StartGroup + EndGroupDelta が vi64 の上限を超えないことを検証する
 *
 * draft-ietf-moq-transport-22 §9.20.9 (LOCATION FILTER Parameter):
 * "If StartGroup + EndGroupDelta exceeds 2^64 - 1, the endpoint MUST close the
 *  session with a PROTOCOL_VIOLATION."
 *
 * @param startGroup - Start Group
 * @param endGroupDelta - End Group Delta
 */
function assertEndGroupWithinMaximum(startGroup: bigint, endGroupDelta: bigint): void {
  if (startGroup + endGroupDelta > MAX_VARINT) {
    throw new ProtocolViolationError(
      `absolute range end group exceeds maximum: ${startGroup} + ${endGroupDelta} > ${MAX_VARINT}`,
    );
  }
}

/**
 * 解析済みフィールドを 1 つ取り出す
 *
 * Type ごとのフィールド数だけ読み取った後は必ず存在するが、
 * `noUncheckedIndexedAccess` により型上 `undefined` を含む。到達しない防御として
 * 構造不正 (PROTOCOL_VIOLATION) にする。
 *
 * @param field - 取り出すフィールド
 * @param label - エラー文言に使うフィールド名
 */
function requireLocationField(field: bigint | undefined, label: string): bigint {
  if (field === undefined) {
    throw new ProtocolViolationError(`malformed location filter: missing ${label}`);
  }
  return field;
}

/**
 * Location Filter を LOCATION_FILTER パラメータとしてエンコードする
 *
 * draft-ietf-moq-transport-22 §9.20.9 (LOCATION FILTER Parameter):
 * Parameter Type 0x21 の値は Location Filter Type (vi64) で始まる自己区切り構造で、
 * Length フィールドを持たない。外側 Length を付けるとピアが Type を Length と
 * 誤読するため、encodeLocationFilter の出力をそのまま value にする。
 */
export function encodeLocationFilterParameter(filter: LocationFilter): Parameter {
  const value = encodeLocationFilter(filter);
  return {
    type: 0x21,
    value,
  };
}

/**
 * LOCATION_FILTER パラメータをデコードする
 *
 * 構造の消費バイト数が value 長と一致しない場合は構造不正として
 * PROTOCOL_VIOLATION (ProtocolViolationError) を throw する。
 * 仕様は Length を持たないため余剰バイトの扱いを規定しないが、制御メッセージの
 * Body 長と消費バイト数の不一致検出と同方針の堅牢性検証として拒否する
 * (decodeFillParameters の内側 Parameters 列の検証と同形)。
 * 送信側生成 (encodeLocationFilter() 経由) では encode 出力そのままが
 * param.value になるため発火しない。raw 手組みの value では発火し得て、
 * 送信ガードでは InvalidFilterError に変換される。
 */
export function decodeLocationFilterParameter(param: Parameter): LocationFilter {
  if (param.type !== 0x21) {
    throw new Error(`Invalid parameter type: expected 0x21, got 0x${param.type.toString(16)}`);
  }
  const [filter, consumed] = decodeLocationFilter(param.value, 0);
  if (consumed !== param.value.length) {
    throw new ProtocolViolationError(
      `malformed location filter parameter: declared length does not match filter: ${consumed} !== ${param.value.length}`,
    );
  }
  return filter;
}
