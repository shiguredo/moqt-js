/**
 * MOQT Location Filter
 * draft-ietf-moq-transport-21 Section 3.3.1 / Section 9.20.10
 *
 * LOCATION_FILTER Parameter の Value (Length (vi64) + optional な vi64 フィールド)
 * のエンコードとデコードを扱う。Value 自体が Length を含む 1 Length 構造のため、
 * Message Parameter 側では外側 Length を付加しない (§9.20.10)。
 */

import { IncompleteDataError, InvalidFilterError, ProtocolViolationError } from "../../error";
import { decodeVarint, encodeVarint, MAX_VARINT } from "../../varint";
import { concatUint8Arrays } from "../../bytes";
import { type Parameter } from "./common";

/**
 * Location Filter (Section 3.3.1, Section 9.20.10)
 *
 * draft-ietf-moq-transport-21:
 * LOCATION_FILTER Parameter は Length (バイト長) と optional な vi64 フィールド
 * で構成され、Length がフィールド数を決める。
 * フィールド数 0 (Length 0) はフィルタなし (REQUEST_UPDATE での除去など)。
 *
 *   LOCATION_FILTER Parameter {
 *     Parameter Type (vi64) = 0x21,
 *     Length (vi64),
 *     [StartGroup (vi64),]
 *     [StartObject (vi64),]
 *     [EndGroupDelta (vi64),]
 *     [EndObject (vi64),]
 *   }
 *
 * フィールドの有無による意味論:
 * - 1 フィールド (startGroup): 相対指定。Next Group 基準
 * - 2 フィールド (startGroup + startObject): 両方 0 は Next Object、
 *   それ以外は絶対開始 (終端なし)
 * - 3 フィールド (startGroup + startObject + endGroupDelta): 絶対開始 +
 *   End Group Delta
 * - 4 フィールド (+ endObject): 絶対開始 + End Group Delta + End Object
 *
 * EndGroupDelta は StartGroup からの差分であり、End Group = StartGroup +
 * EndGroupDelta。End Group が 2^64-1 を超える場合は PROTOCOL_VIOLATION
 * (§9.20.10 の MUST)。送信側は encodeLocationFilter が送信前に
 * InvalidFilterError で、受信デコード時は decodeLocationFilter が
 * ProtocolViolationError で超過を拒否する。
 *
 * 公開表現はフィールドの有無で場合分けし、draft-19 の Filter Type
 * (NextGroupStart / LargestObject / AbsoluteStart / AbsoluteRange) は
 * 以下の等価表現で置き換えた:
 * - NextGroupStart → { startGroup: 0n }
 * - LargestObject → { startGroup: 0n, startObject: 0n }
 * - AbsoluteStart → { startGroup, startObject }
 * - AbsoluteRange → { startGroup, startObject, endGroupDelta }
 */
export type LocationFilter =
  // Length 0: フィルタなし (REQUEST_UPDATE での除去など)
  | { reset: true }
  // 1 フィールド: StartGroup のみ。相対指定 (Next Group 基準)
  | { startGroup: bigint }
  // 2 フィールド: StartGroup + StartObject
  | { startGroup: bigint; startObject: bigint }
  // 3 フィールド: StartGroup + StartObject + EndGroupDelta
  | { startGroup: bigint; startObject: bigint; endGroupDelta: bigint }
  // 4 フィールド: StartGroup + StartObject + EndGroupDelta + EndObject
  | { startGroup: bigint; startObject: bigint; endGroupDelta: bigint; endObject: bigint };

/** Location Filter の 3 / 4 フィールド表現の End Group 超過を検証する */
function validateLocationFilterEndGroup(startGroup: bigint, endGroupDelta: bigint): void {
  if (startGroup + endGroupDelta > MAX_VARINT) {
    throw new InvalidFilterError(
      `absolute range end group exceeds maximum: ${startGroup} + ${endGroupDelta} > ${MAX_VARINT}`,
    );
  }
}

/**
 * Next Object 形式の Location Filter かどうかを判定する
 *
 * draft-ietf-moq-transport-21 §9.20.10: 2 フィールドで StartGroup = StartObject = 0
 * の場合は Start Location が Next Object (旧 LargestObject 相当) になる。
 * endGroupDelta を持つ 3 / 4 フィールド表現は endGroupDelta による絶対指定の
 * ため対象外。
 */
export function isNextObjectLocationFilter(filter: LocationFilter): boolean {
  return (
    "startObject" in filter &&
    !("endGroupDelta" in filter) &&
    filter.startGroup === 0n &&
    filter.startObject === 0n
  );
}

/**
 * Location Filter を比較用の正規形 (フィールド列) に変換する
 *
 * 公開型はフィールドの有無で表現が変わる (Length 0〜4) ため、
 * フィールドの有無をそのまま列の長さと値に写す。写像は単射であり、
 * 同じワイヤ表現になる Location Filter は必ず同じ列になる。
 * `{ reset: true }` (Length 0) は空列になる。
 */
function locationFilterToFields(filter: LocationFilter): bigint[] {
  if ("reset" in filter) {
    return [];
  }
  const fields = [filter.startGroup];
  if ("startObject" in filter) {
    fields.push(filter.startObject);
    if ("endGroupDelta" in filter) {
      fields.push(filter.endGroupDelta);
      if ("endObject" in filter) {
        fields.push(filter.endObject);
      }
    }
  }
  return fields;
}

/**
 * Location Filter の構造等価を判定する
 *
 * draft-ietf-moq-transport-21 §9.10 (PUBLISH_STATE_NOTIFY):
 * "If a parameter is not present, its value is unchanged."
 * 値の変化したパラメータのみを運ぶため、同じ内容の LOCATION_FILTER が
 * 再報告されることはない。しかし再報告された場合に再解決すると、
 * 進んだ LARGEST_OBJECT で相対指定が再評価されて開始位置が前進し得る。
 * 呼び出し側が再解決の要否を判断できるよう、等価判定をここに置く。
 *
 * 未設定 (undefined) 同士は等価、undefined と設定済みは非等価とする。
 */
export function isSameLocationFilter(
  a: LocationFilter | undefined,
  b: LocationFilter | undefined,
): boolean {
  if (a === undefined || b === undefined) {
    return a === b;
  }
  const aFields = locationFilterToFields(a);
  const bFields = locationFilterToFields(b);
  return aFields.length === bFields.length && aFields.every((value, i) => value === bFields[i]);
}

/**
 * Location Filter をエンコードする
 * draft-ietf-moq-transport-21 §9.20.10 (LOCATION FILTER Parameter)
 *
 * バイト Length プレフィックス付きでエンコードする。フィールド数は公開型の
 * 場合分けで 0〜4 に静的に制約される (送信側で 4 超にはなり得ない)。
 * フィールド数 0 (reset) は Length 0 のみで表現する (REQUEST_UPDATE での除去)。
 *
 * 3 / 4 フィールド表現は End Group (StartGroup + EndGroupDelta) の 2^64-1 超過を
 * 送信前に検証し、InvalidFilterError で拒否する (§9.20.10)。負値 (startGroup /
 * startObject / endGroupDelta / endObject のいずれ) と、和の検証に捕捉されない
 * startObject / EndObject の単体超過は encodeVarint 由来の Error として throw
 * される。節番号は仕様将来版で変わる可能性がある。
 */
export function encodeLocationFilter(filter: LocationFilter): Uint8Array {
  // Length 0 (フィルタなし) は Length フィールドのみで表現する
  if ("reset" in filter) {
    return encodeVarint(0n);
  }

  const parts: Uint8Array[] = [];

  if ("startObject" in filter) {
    if ("endGroupDelta" in filter) {
      // draft-ietf-moq-transport-21 §9.20.10 (LOCATION FILTER Parameter):
      // "If StartGroup + EndGroupDelta exceeds 2^64 - 1, the endpoint MUST
      //  close the session with a PROTOCOL_VIOLATION."
      // 超過ワイヤを受信した endpoint はこの MUST でセッションを閉じる
      // ため、送信前に InvalidFilterError でローカル拒否する
      validateLocationFilterEndGroup(filter.startGroup, filter.endGroupDelta);
      parts.push(encodeVarint(filter.startGroup));
      parts.push(encodeVarint(filter.startObject));
      parts.push(encodeVarint(filter.endGroupDelta));
      if ("endObject" in filter) {
        parts.push(encodeVarint(filter.endObject));
      }
    } else {
      parts.push(encodeVarint(filter.startGroup));
      parts.push(encodeVarint(filter.startObject));
    }
  } else {
    // 1 フィールド: StartGroup のみ
    parts.push(encodeVarint(filter.startGroup));
  }

  // Length フィールド (vi64) を先頭に付けてフィールド列を連結する
  const totalLength = parts.reduce((sum, p) => sum + p.length, 0);
  const lengthBytes = encodeVarint(BigInt(totalLength));
  return concatUint8Arrays([lengthBytes, ...parts]);
}

/**
 * Location Filter をデコードする
 *
 * Length (バイト) が示す範囲内の vi64 フィールド数を数えて 0〜4 の場合分けに
 * 解決する。Length のバイト値はフィールド数と直接対応しない (Length=2 を
 * 「2 フィールド」と解釈しない)。
 *
 * 以下の場合は PROTOCOL_VIOLATION (ProtocolViolationError) を throw する
 * (§3.3.1 / §9.20.10。受信経路に載った場合は PROTOCOL_VIOLATION のセッション
 * 終了変換規則に乗る):
 * - Length が示す範囲に vi64 フィールドが 4 つより多く含まれる
 * - vi64 フィールドが Length 境界を跨ぐ、または Length と消費バイト数が不一致
 *
 * 3 / 4 フィールド表現は End Group (StartGroup + EndGroupDelta) の 2^64-1 超過を
 * ProtocolViolationError で throw する (§9.20.10 の MUST。この MUST は超過に対して
 * PROTOCOL_VIOLATION を一択としており、§3.3.1 が Location Filter に対して定める
 * REQUEST_ERROR は充足不能範囲の INVALID_RANGE であるため、デコード段階では
 * ProtocolViolationError で検出する)。
 *
 * @returns [filter, consumed bytes]
 */
export function decodeLocationFilter(data: Uint8Array, offset = 0): [LocationFilter, number] {
  const [length, lengthConsumed] = decodeVarint(data, offset);
  const start = offset + lengthConsumed;
  const end = start + Number(length);

  // Length が示す範囲が data の末尾を超える場合は不完全データとして扱う
  // (varint デコードと同じく、呼び出し側が全バイトを渡していない)。
  // 宣言時点拒否 (ProtocolViolationError) に変えない。直接呼び出しでは
  // ストリーミング待ちの意味を保ち、制御メッセージ経路では
  // decodeMessageParameter の self-length ガードが先に遮断するためである。
  if (end > data.length) {
    throw new IncompleteDataError(
      `incomplete location filter: length ${length} exceeds available data`,
    );
  }

  // Length が示す範囲内の vi64 フィールドを読み取る (最大 4 個)
  const fields: bigint[] = [];
  let current = start;
  while (current < end && fields.length < 4) {
    let value: bigint;
    let consumed: number;
    try {
      [value, consumed] = decodeVarint(data, current);
    } catch (error) {
      // end <= data.length は検証済みであり、Length 境界内の varint が
      // IncompleteDataError になるのは「境界内に収まらない vi64」の時のみ
      // (次のフィールドが Length を跨ぎ、data 末尾側へはみ出す)。
      // 構造不正として PROTOCOL_VIOLATION にする (decodeVarint の
      // 不完全データ待ちではなく、宣言 Length との不一致)
      if (error instanceof IncompleteDataError) {
        throw new ProtocolViolationError(
          `malformed location filter: field crosses length boundary: ${length}`,
        );
      }
      throw error;
    }
    fields.push(value);
    current += consumed;
  }

  // Length 境界を跨ぐ vi64 / 4 超のフィールド (Length が示す範囲に余りが残る)
  // は構造不正として PROTOCOL_VIOLATION にする
  if (current !== end) {
    throw new ProtocolViolationError(
      `malformed location filter: length ${length} does not match field boundaries`,
    );
  }

  // fields の要素は fields.length による分岐後は必ず存在するが、
  // noUncheckedIndexedAccess により型上は undefined を含むため、
  // 各 case で使う要素だけを helper で取り出す
  switch (fields.length) {
    case 0:
      // Length 0: フィルタなし (REQUEST_UPDATE での除去など)
      return [{ reset: true }, lengthConsumed];

    case 1:
      // 1 フィールド: StartGroup のみ (相対指定)
      return [{ startGroup: requireLocationField(fields[0], "start group") }, end - offset];

    case 2:
      return [
        {
          startGroup: requireLocationField(fields[0], "start group"),
          startObject: requireLocationField(fields[1], "start object"),
        },
        end - offset,
      ];

    case 3: {
      // draft-ietf-moq-transport-21 §9.20.10 (LOCATION FILTER Parameter):
      // "If StartGroup + EndGroupDelta exceeds 2^64 - 1, the endpoint MUST
      //  close the session with a PROTOCOL_VIOLATION."
      const startGroup = requireLocationField(fields[0], "start group");
      const startObject = requireLocationField(fields[1], "start object");
      const endGroupDelta = requireLocationField(fields[2], "end group delta");
      assertEndGroupWithinMaximum(startGroup, endGroupDelta);
      return [{ startGroup, startObject, endGroupDelta }, end - offset];
    }

    case 4: {
      const startGroup = requireLocationField(fields[0], "start group");
      const startObject = requireLocationField(fields[1], "start object");
      const endGroupDelta = requireLocationField(fields[2], "end group delta");
      const endObject = requireLocationField(fields[3], "end object");
      assertEndGroupWithinMaximum(startGroup, endGroupDelta);
      return [{ startGroup, startObject, endGroupDelta, endObject }, end - offset];
    }

    default:
      // ループの境界 (fields.length < 4) と current !== end の検証により
      // 到達しない (フィールド数 5 以上は上で PROTOCOL_VIOLATION 済み)。
      // 防御的に構造不正として PROTOCOL_VIOLATION にする
      throw new ProtocolViolationError(
        `malformed location filter: unexpected number of fields: ${fields.length}`,
      );
  }
}

/**
 * StartGroup + EndGroupDelta が vi64 の上限を超えないことを検証する
 *
 * draft-ietf-moq-transport-21 §9.20.10 (LOCATION FILTER Parameter):
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
 * `fields.length` による分岐後は必ず存在するが、`noUncheckedIndexedAccess` により
 * 型上は `undefined` を含む。到達しない防御として構造不正 (PROTOCOL_VIOLATION) にする。
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
 * draft-ietf-moq-transport-21 §9.20.10 (LOCATION FILTER Parameter):
 * "A Location filter parameter has the following length-prefixed structure:"
 * Parameter Type 0x21 の値が Length プレフィックス付き構造を持つのは、§9.20.10 が
 * 値の構造として定めているためである (§8.3 (Key-Value-Pair Structure) の
 * 偶数 / 奇数規則は Message Parameter には適用されない)。
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
 * 構造の消費バイト数が宣言 Length (param.value.length) と一致しない場合は
 * 構造不正として PROTOCOL_VIOLATION (ProtocolViolationError) を throw する。
 * 仕様は Length 内余剰バイトの扱いを規定しないが、制御メッセージの Body 長と
 * 消費バイト数の不一致検出と同方針の堅牢性検証として拒否する
 * (decodeFillParameters の内側 Parameters 列の検証と同形)。
 * 送信側生成 (encodeLocationFilter() 経由) では encode 出力そのままが
 * param.value になるため発火しない。raw 手組みの value では発火し得て、
 * 送信ガードでは InvalidFilterError に変換される。
 */
export function decodeLocationFilterParameter(param: Parameter): LocationFilter {
  if (param.type !== 0x21) {
    throw new Error(`Invalid parameter type: expected 0x21, got ${param.type}`);
  }
  const [filter, consumed] = decodeLocationFilter(param.value, 0);
  if (consumed !== param.value.length) {
    throw new ProtocolViolationError(
      `malformed location filter parameter: declared length does not match filter: ${consumed} !== ${param.value.length}`,
    );
  }
  return filter;
}
