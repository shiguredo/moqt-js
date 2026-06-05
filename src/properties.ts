/**
 * MOQT Properties
 * draft-ietf-moq-transport-18 Section 12 (MOQT Properties)
 *
 * Object Properties として定義されている拡張。
 * LOC (draft-ietf-moq-loc) とは別の、MOQT 本体で定義された拡張。
 *
 * draft-ietf-moq-transport-18:
 * Properties は Key-Value-Pair 形式を使用し、delta encoding を適用する。
 */

import { encodeVarint, decodeVarint } from "./varint";
import { MalformedTrackError, ProtocolViolationError, IncompleteDataError } from "./error";

/**
 * MSF_COMPRESSION の Compression Algorithm 値 (draft-ietf-moq-msf-01 §12.1 / §14.4 Table 15)
 *
 * Track Property (§12.1.1) と Object Property (§12.1.2) の双方で共有される。
 *
 *   | Value | Compression Algorithm |
 *   |-------|-----------------------|
 *   | 0     | None (uncompressed)   |
 *   | 1     | GZIP                  |
 *
 * §12.1: All MSF implementations MUST support both uncompressed payloads
 * (value 0 or property absent) and GZIP compressed payloads (value 1).
 *
 * 注: MSF_COMPRESSION の Track / Object Property ID 自体は draft-ietf-moq-msf-01
 * §14.3 で IANA 未割当 (TBD) のため、本モジュールでは Property ID 定数を
 * 追加しない。確定後 (`TrackPropertyId.MSF_COMPRESSION` 等の追加と encode/decode
 * helper、Track / Object Property 併用 MUST NOT 検証) は別 issue で対応する。
 */
export const MsfCompressionAlgorithm = {
  NONE: 0n,
  GZIP: 1n,
} as const;

/**
 * MOQT Property ID (Section 12)
 *
 * ID が偶数の場合: varint value
 * ID が奇数の場合: length (varint) + bytes
 */
export const MOQTPropertyId = {
  /**
   * Immutable Properties (Section 12.7 Immutable Properties)
   * Relay が変更・削除できない拡張のコンテナ
   */
  IMMUTABLE_PROPERTIES: 0x0bn,
  /**
   * Prior Group ID Gap (Section 12.8 Prior Group ID Gap)
   * 現在の Group より前のスキップされた Group 数
   */
  PRIOR_GROUP_ID_GAP: 0x3cn,
  /**
   * Prior Object ID Gap (Section 12.9 Prior Object ID Gap)
   * 現在の Object より前のスキップされた Object 数
   */
  PRIOR_OBJECT_ID_GAP: 0x3en,
} as const;

/**
 * MOQT Track Property ID
 *
 * draft-ietf-moq-transport-18:
 * Track Properties は end-to-end で送信され、Relay が転送する。
 * draft-ietf-moq-transport-18 Section 12
 *
 * PUBLISH, SUBSCRIBE_OK, FETCH_OK の Track Properties で使用。
 *
 * ID が偶数の場合: varint value
 * ID が奇数の場合: length (varint) + bytes
 */
export const TrackPropertyId = {
  /**
   * Object Delivery Timeout (Section 12.2 OBJECT_DELIVERY_TIMEOUT)
   * オブジェクトの配信タイムアウト（ミリ秒）
   *
   * draft-ietf-moq-transport-18:
   * Message Parameter から Track Property に移動。
   */
  OBJECT_DELIVERY_TIMEOUT: 0x02n,
  /**
   * Max Cache Duration (Section 12.3 MAX CACHE DURATION)
   * オブジェクトの最大キャッシュ期間（ミリ秒）
   */
  MAX_CACHE_DURATION: 0x04n,
  /**
   * Subgroup Delivery Timeout (Section 12.1 SUBGROUP_DELIVERY_TIMEOUT)
   *
   * draft-ietf-moq-transport-18:
   * SUBGROUP_DELIVERY_TIMEOUT (Property Type 0x06) は varint。
   * Publisher が Subgroup の配信タイムアウト（ミリ秒）として設定する。
   * 0 はタイムアウトなしを意味する。
   * draft-ietf-moq-transport-18 Section 12.1
   */
  SUBGROUP_DELIVERY_TIMEOUT: 0x06n,
  /**
   * Publisher Priority (Section 12.4 DEFAULT PUBLISHER PRIORITY)
   * Publisher が設定する優先度（0-255）
   */
  DEFAULT_PUBLISHER_PRIORITY: 0x0en,
  /**
   * Publisher Group Order Preference (Section 12.5 DEFAULT PUBLISHER GROUP ORDER)
   *
   * draft-ietf-moq-transport-18:
   * GROUP_ORDER パラメータから分割された Publisher 向けの設定。
   * draft-ietf-moq-transport-18 Section 12
   */
  DEFAULT_PUBLISHER_GROUP_ORDER: 0x22n,
  /**
   * Dynamic Groups (Section 12.6 DYNAMIC GROUPS)
   * トラックが動的グループ作成をサポートするかどうか
   */
  DYNAMIC_GROUPS: 0x30n,
} as const;

/**
 * Property Type の値範囲 (Section 15.8)
 *
 * draft-ietf-moq-transport-18 Section 15.8:
 * - 0x00 - 0x77: Standards Action or IESG Approval (1-byte encoding)
 * - 0x78 - 0x7F: アプリケーション固有 (1-byte encoding, 登録不要)
 * - 0x80 - 0x37FF: Specification Required (2-byte encoding)
 * - 0x3800 - 0x3FFF: アプリケーション固有 (2-byte encoding, 登録不要)
 * - 0x4000 - 0x7FFF: Mandatory Track Properties 用に予約 (Track scope のみ)
 * - 0x8000 以上: First Come First Served
 *
 * アプリケーション固有の範囲は IANA に登録する必要がない。
 * 異なるソースからのトラックを消費するアプリケーションでは
 * 同じコードポイントに異なるセマンティクスが存在する可能性がある。
 * draft-ietf-moq-transport-18 Section 12
 */
/**
 * Track Property の値域を検証する
 *
 * draft-ietf-moq-transport-18 §12 で MUST レベルの値域制約がある Track Property を検証する。
 * 不正値は ProtocolViolationError を throw する (上位ループで PROTOCOL_VIOLATION でセッションを閉じる)。
 *
 * - §12.4 DEFAULT_PUBLISHER_PRIORITY (0x0E): "The value is from 0 to 255 ... Priorities above 255 are invalid."
 * - §12.5 DEFAULT_PUBLISHER_GROUP_ORDER (0x22): "The allowed values are Ascending (0x1) or Descending (0x2). If an endpoint receives a value outside this range, it MUST close the session with PROTOCOL_VIOLATION."
 * - §12.6 DYNAMIC_GROUPS (0x30): "The allowed values are 0 or 1. ... If an endpoint receives a value larger than 1, it MUST close the session with PROTOCOL_VIOLATION."
 */
export function validateTrackPropertyValue(id: bigint, value: bigint): void {
  if (id === TrackPropertyId.DEFAULT_PUBLISHER_PRIORITY) {
    if (value < 0n || value > 255n) {
      throw new ProtocolViolationError(`invalid publisher priority: ${value}, expected 0-255`);
    }
    return;
  }
  if (id === TrackPropertyId.DEFAULT_PUBLISHER_GROUP_ORDER) {
    if (value !== 1n && value !== 2n) {
      throw new ProtocolViolationError(
        `invalid publisher group order preference: 0x${value.toString(16)}, expected 0x1 or 0x2`,
      );
    }
    return;
  }
  if (id === TrackPropertyId.DYNAMIC_GROUPS) {
    if (value !== 0n && value !== 1n) {
      throw new ProtocolViolationError(`invalid dynamic groups: ${value}, expected 0 or 1`);
    }
  }
}

/**
 * Prior Group ID Gap
 *
 * draft-ietf-moq-transport-18 Section 12.8 (Prior Group ID Gap):
 * 現在の Group より前の、存在しない Group の数を示す。
 *
 * 例: Group 10 で gap = 2 の場合、Group 8 と 9 は存在しない。
 */
export interface PriorGroupIdGap {
  gap: bigint;
}

/**
 * Prior Object ID Gap
 *
 * draft-ietf-moq-transport-18 Section 12.9 (Prior Object ID Gap):
 * 現在の Object より前の、存在しない Object の数を示す。
 *
 * 例: Object 10 で gap = 2 の場合、Object 8 と 9 は存在しない。
 */
export interface PriorObjectIdGap {
  gap: bigint;
}

/**
 * Property の共通インターフェース
 *
 * 偶数 ID: varint value 形式
 * 奇数 ID: length + bytes 形式
 */
export interface Property {
  id: bigint;
  value?: bigint;
  data?: Uint8Array;
}

/**
 * Immutable Properties
 *
 * draft-ietf-moq-transport-18 Section 12.7 (Immutable Properties):
 * Relay が変更・削除できない拡張のコンテナ。
 * 内部に Key-Value-Pair をネストできる。
 *
 * Original Publisher のみが追加でき、Relay は変更・削除できない。
 */
export interface ImmutableProperties {
  extensions: Property[];
}

/**
 * パースされた Properties
 */
export interface ParsedProperties {
  priorGroupIdGap?: PriorGroupIdGap;
  priorObjectIdGap?: PriorObjectIdGap;
  immutableProperties?: ImmutableProperties;
  /**
   * 未知の拡張（パースはスキップされたが保持）
   */
  unknownProperties?: Array<{ id: bigint; data: Uint8Array }>;
}

/**
 * Prior Group ID Gap をエンコードする
 *
 * draft-ietf-moq-transport-18 Section 12.8 (Prior Group ID Gap):
 * ID (0x3C) は偶数なので varint value 形式
 */
export function encodePriorGroupIdGap(gap: PriorGroupIdGap): Uint8Array {
  const idBytes = encodeVarint(MOQTPropertyId.PRIOR_GROUP_ID_GAP);
  const valueBytes = encodeVarint(gap.gap);
  const result = new Uint8Array(idBytes.length + valueBytes.length);
  result.set(idBytes, 0);
  result.set(valueBytes, idBytes.length);
  return result;
}

/**
 * Prior Group ID Gap をデコードする
 *
 * @param data - ID を含む完全な拡張データ
 */
export function decodePriorGroupIdGap(data: Uint8Array): PriorGroupIdGap {
  const [_id, idLen] = decodeVarint(data);
  const [gap, _gapLen] = decodeVarint(data.subarray(idLen));
  return { gap };
}

/**
 * Prior Object ID Gap をエンコードする
 *
 * draft-ietf-moq-transport-18 Section 12.9 (Prior Object ID Gap):
 * ID (0x3E) は偶数なので varint value 形式
 */
export function encodePriorObjectIdGap(gap: PriorObjectIdGap): Uint8Array {
  const idBytes = encodeVarint(MOQTPropertyId.PRIOR_OBJECT_ID_GAP);
  const valueBytes = encodeVarint(gap.gap);
  const result = new Uint8Array(idBytes.length + valueBytes.length);
  result.set(idBytes, 0);
  result.set(valueBytes, idBytes.length);
  return result;
}

/**
 * Prior Object ID Gap をデコードする
 *
 * @param data - ID を含む完全な拡張データ
 */
export function decodePriorObjectIdGap(data: Uint8Array): PriorObjectIdGap {
  const [_id, idLen] = decodeVarint(data);
  const [gap, _gapLen] = decodeVarint(data.subarray(idLen));
  return { gap };
}

/**
 * 単一の Property をエンコードする
 *
 * 偶数 ID: ID + varint value 形式
 * 奇数 ID: ID + length + bytes 形式
 */
export function encodeProperty(header: Property): Uint8Array {
  const idBytes = encodeVarint(header.id);

  if (header.id % 2n === 0n) {
    // 偶数 ID: varint value 形式
    if (header.value === undefined) {
      throw new Error(`even extension ID ${header.id} requires a value`);
    }
    const valueBytes = encodeVarint(header.value);
    const result = new Uint8Array(idBytes.length + valueBytes.length);
    result.set(idBytes, 0);
    result.set(valueBytes, idBytes.length);
    return result;
  }

  // 奇数 ID: length + bytes 形式
  if (header.data === undefined) {
    throw new Error(`odd extension ID ${header.id} requires data`);
  }
  const lengthBytes = encodeVarint(BigInt(header.data.length));
  const result = new Uint8Array(idBytes.length + lengthBytes.length + header.data.length);
  result.set(idBytes, 0);
  result.set(lengthBytes, idBytes.length);
  result.set(header.data, idBytes.length + lengthBytes.length);
  return result;
}

/**
 * 単一の Property を delta encoding でエンコードする
 *
 * draft-ietf-moq-transport-18:
 * Key-Value-Pairs encode a Type value as a delta from the previous Type value,
 * or from 0 if there is no previous Type value.
 *
 * @param header - エンコードする拡張ヘッダー
 * @param previousId - 前の拡張ヘッダーの ID（最初の場合は 0n）
 * @returns エンコードされたバイト列
 */
function encodePropertyWithDelta(header: Property, previousId: bigint): Uint8Array {
  const deltaId = header.id - previousId;
  if (deltaId < 0n) {
    throw new Error(
      `delta ID must be non-negative: current ID=${header.id}, previous ID=${previousId}`,
    );
  }

  const deltaBytes = encodeVarint(deltaId);

  if (header.id % 2n === 0n) {
    // 偶数 ID: varint value 形式
    if (header.value === undefined) {
      throw new Error(`even extension ID ${header.id} requires a value`);
    }
    const valueBytes = encodeVarint(header.value);
    const result = new Uint8Array(deltaBytes.length + valueBytes.length);
    result.set(deltaBytes, 0);
    result.set(valueBytes, deltaBytes.length);
    return result;
  }

  // 奇数 ID: length + bytes 形式
  if (header.data === undefined) {
    throw new Error(`odd extension ID ${header.id} requires data`);
  }
  const lengthBytes = encodeVarint(BigInt(header.data.length));
  const result = new Uint8Array(deltaBytes.length + lengthBytes.length + header.data.length);
  result.set(deltaBytes, 0);
  result.set(lengthBytes, deltaBytes.length);
  result.set(header.data, deltaBytes.length + lengthBytes.length);
  return result;
}

/**
 * 複数の Property をエンコードして結合する
 *
 * draft-ietf-moq-transport-18:
 * delta encoding を使用するため、拡張ヘッダーは ID の昇順でソートしてからエンコードする。
 */
export function encodeProperties(headers: Property[]): Uint8Array {
  // delta encoding のために ID の昇順でソート
  const sortedHeaders = [...headers].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const parts: Uint8Array[] = [];
  let previousId = 0n;

  for (const header of sortedHeaders) {
    parts.push(encodePropertyWithDelta(header, previousId));
    previousId = header.id;
  }

  const totalLength = parts.reduce((sum, p) => sum + p.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

/**
 * Immutable Properties をエンコードする
 *
 * draft-ietf-moq-transport-18 Section 12.7 (Immutable Properties):
 * ID (0x0B) は奇数なので length + bytes 形式
 *
 * 内部には複数の Key-Value-Pair (Property) をネストできる。
 * 内部の拡張も delta encoding を使用する。
 *
 * 注意: この関数は単独で使用する場合に ID を絶対値としてエンコードする。
 * encodeProperties 内で使用する場合は delta encoding が適用される。
 */
export function encodeImmutableProperties(immutable: ImmutableProperties): Uint8Array {
  // 内部の拡張を全てエンコードして結合（delta encoding 使用）
  const innerBytes = encodeProperties(immutable.extensions);

  // ID + length + innerBytes
  const idBytes = encodeVarint(MOQTPropertyId.IMMUTABLE_PROPERTIES);
  const lengthBytes = encodeVarint(BigInt(innerBytes.length));

  const result = new Uint8Array(idBytes.length + lengthBytes.length + innerBytes.length);
  result.set(idBytes, 0);
  result.set(lengthBytes, idBytes.length);
  result.set(innerBytes, idBytes.length + lengthBytes.length);
  return result;
}

/**
 * Immutable Properties をデコードする
 *
 * draft-ietf-moq-transport-18:
 * delta encoding を使用して内部の拡張をデコードする。
 *
 * @param data - ID を含む完全な Immutable Properties データ
 */
export function decodeImmutableProperties(data: Uint8Array): ImmutableProperties {
  const [_id, idLen] = decodeVarint(data);
  const [length, lengthLen] = decodeVarint(data.subarray(idLen));
  if (Number(length) > 65535) {
    throw new ProtocolViolationError(
      `immutable properties value length exceeds maximum: ${length} > 65535`,
    );
  }
  const innerData = data.subarray(idLen + lengthLen, idLen + lengthLen + Number(length));

  const extensions: Property[] = [];
  let offset = 0;
  let previousId = 0n;

  while (offset < innerData.length) {
    const [deltaId, deltaIdLen] = decodeVarint(innerData.subarray(offset));
    const extId = previousId + deltaId;
    previousId = extId;

    // draft-ietf-moq-transport-18 §12.7:
    // "An Object contains an Immutable Properties property that contains another
    //  Immutable Properties key." → Track is malformed
    if (extId === MOQTPropertyId.IMMUTABLE_PROPERTIES) {
      throw new MalformedTrackError(
        "immutable properties must not recursively contain another immutable properties key",
      );
    }

    if (extId % 2n === 0n) {
      // 偶数 ID: varint value 形式
      const [value, valueLen] = decodeVarint(innerData.subarray(offset + deltaIdLen));
      validateTrackPropertyValue(extId, value);
      extensions.push({ id: extId, value });
      offset += deltaIdLen + valueLen;
    } else {
      // 奇数 ID: length + bytes 形式
      const [extLength, extLengthLen] = decodeVarint(innerData.subarray(offset + deltaIdLen));
      const extData = innerData.slice(
        offset + deltaIdLen + extLengthLen,
        offset + deltaIdLen + extLengthLen + Number(extLength),
      );
      extensions.push({ id: extId, data: extData });
      offset += deltaIdLen + extLengthLen + Number(extLength);
    }
  }

  return { extensions };
}

/**
 * Track Properties に DYNAMIC_GROUPS=1 が含まれているかを判定する。
 *
 * draft-ietf-moq-transport-18 §12.7:
 * "When looking for the value of a property, processors MUST search both the
 * mutable properties and the contents of Immutable Properties."
 *
 * mutable list と Immutable Properties (Type 0x0B) 配下の両方を検索する。
 * DYNAMIC_GROUPS の値域は §12.6 により 0 / 1 のみで、受信時に
 * validateTrackPropertyValue が PROTOCOL_VIOLATION 検証済みのため、複数値や
 * 範囲外は考慮不要。
 *
 * @param properties - Subscriber.trackProperties (decodeProperties の出力)
 */
export function supportsDynamicGroups(properties: ReadonlyArray<Property>): boolean {
  for (const property of properties) {
    if (property.id === TrackPropertyId.DYNAMIC_GROUPS && property.value === 1n) {
      return true;
    }
    if (property.id === MOQTPropertyId.IMMUTABLE_PROPERTIES && property.data) {
      const immutable = decodeImmutableProperties(property.data);
      for (const inner of immutable.extensions) {
        if (inner.id === TrackPropertyId.DYNAMIC_GROUPS && inner.value === 1n) {
          return true;
        }
      }
    }
  }
  return false;
}

/**
 * Properties をパースする
 *
 * 複数の Property が含まれるデータから、MOQT Core Properties を抽出する。
 * 未知の拡張はスキップされるが、unknownProperties に保持される。
 *
 * draft-ietf-moq-transport-18:
 * delta encoding を使用して ID をデコードする。
 *
 * @param data - Properties データ（複数の Property を含む可能性あり）
 */
export function parseProperties(data: Uint8Array): ParsedProperties {
  const result: ParsedProperties = {};
  const unknownProperties: Array<{ id: bigint; data: Uint8Array }> = [];
  let offset = 0;
  let previousId = 0n;

  while (offset < data.length) {
    const [deltaId, deltaIdLen] = decodeVarint(data.subarray(offset));
    const id = previousId + deltaId;
    previousId = id;

    if (id === MOQTPropertyId.PRIOR_GROUP_ID_GAP) {
      // draft-ietf-moq-transport-18 §12.8:
      // "An Object MUST NOT contain more than one instance of this property."
      if (result.priorGroupIdGap !== undefined) {
        throw new MalformedTrackError(
          "Object contains more than one instance of PRIOR_GROUP_ID_GAP",
        );
      }
      const [gap, gapLen] = decodeVarint(data.subarray(offset + deltaIdLen));
      result.priorGroupIdGap = { gap };
      offset += deltaIdLen + gapLen;
    } else if (id === MOQTPropertyId.PRIOR_OBJECT_ID_GAP) {
      // draft-ietf-moq-transport-18 §12.9: 同上
      if (result.priorObjectIdGap !== undefined) {
        throw new MalformedTrackError(
          "Object contains more than one instance of PRIOR_OBJECT_ID_GAP",
        );
      }
      const [gap, gapLen] = decodeVarint(data.subarray(offset + deltaIdLen));
      result.priorObjectIdGap = { gap };
      offset += deltaIdLen + gapLen;
    } else if (id === MOQTPropertyId.IMMUTABLE_PROPERTIES) {
      // draft-ietf-moq-transport-18 §12.7:
      // "An Object MUST NOT contain more than one instance of this property."
      if (result.immutableProperties !== undefined) {
        throw new MalformedTrackError(
          "Object contains more than one instance of IMMUTABLE_PROPERTIES",
        );
      }
      // Immutable Properties は奇数 ID なので length + bytes 形式
      const [length, lengthLen] = decodeVarint(data.subarray(offset + deltaIdLen));
      if (Number(length) > 65535) {
        throw new ProtocolViolationError(
          `properties value length exceeds maximum: ${length} > 65535`,
        );
      }
      const innerData = data.subarray(
        offset + deltaIdLen + lengthLen,
        offset + deltaIdLen + lengthLen + Number(length),
      );

      // 内部の拡張をパース（delta encoding を使用）
      const extensions: Property[] = [];
      let innerOffset = 0;
      let innerPreviousId = 0n;
      while (innerOffset < innerData.length) {
        const [innerDeltaId, innerDeltaIdLen] = decodeVarint(innerData.subarray(innerOffset));
        const extId = innerPreviousId + innerDeltaId;
        innerPreviousId = extId;

        // draft-ietf-moq-transport-18 §12.7:
        // "An Object contains an Immutable Properties property that contains another
        //  Immutable Properties key." → Track is malformed
        if (extId === MOQTPropertyId.IMMUTABLE_PROPERTIES) {
          throw new MalformedTrackError(
            "immutable properties must not recursively contain another immutable properties key",
          );
        }

        if (extId % 2n === 0n) {
          // 偶数 ID: varint value 形式
          const [value, valueLen] = decodeVarint(innerData.subarray(innerOffset + innerDeltaIdLen));
          validateTrackPropertyValue(extId, value);
          extensions.push({ id: extId, value });
          innerOffset += innerDeltaIdLen + valueLen;
        } else {
          // 奇数 ID: length + bytes 形式
          const [extLength, extLengthLen] = decodeVarint(
            innerData.subarray(innerOffset + innerDeltaIdLen),
          );
          const extData = innerData.slice(
            innerOffset + innerDeltaIdLen + extLengthLen,
            innerOffset + innerDeltaIdLen + extLengthLen + Number(extLength),
          );
          extensions.push({ id: extId, data: extData });
          innerOffset += innerDeltaIdLen + extLengthLen + Number(extLength);
        }
      }

      result.immutableProperties = { extensions };
      offset += deltaIdLen + lengthLen + Number(length);
    } else {
      // 未知の拡張
      // draft-ietf-moq-transport-18 §2.5.1:
      // Mandatory Track Property (0x4000-0x7FFF) かつ未知の場合は
      // トラックを処理してはならない (MUST NOT process or forward)
      if (id >= 0x4000n && id <= 0x7fffn) {
        throw new MalformedTrackError(
          `unknown mandatory track property: type 0x${id.toString(16)}`,
        );
      }

      if (id % 2n === 1n) {
        // 奇数 ID: length + bytes 形式
        const [length, lengthLen] = decodeVarint(data.subarray(offset + deltaIdLen));
        // 注意: unknownProperties にはデコード後の ID と生データを保持
        const extData = data.slice(
          offset + deltaIdLen + lengthLen,
          offset + deltaIdLen + lengthLen + Number(length),
        );
        unknownProperties.push({ id, data: extData });
        offset += deltaIdLen + lengthLen + Number(length);
      } else {
        // 偶数 ID: varint value 形式
        const [value, valueLen] = decodeVarint(data.subarray(offset + deltaIdLen));
        validateTrackPropertyValue(id, value);
        const extData = encodeVarint(value);
        unknownProperties.push({ id, data: extData });
        offset += deltaIdLen + valueLen;
      }
    }
  }

  if (unknownProperties.length > 0) {
    result.unknownProperties = unknownProperties;
  }

  return result;
}

/**
 * Properties をデコードする
 *
 * draft-ietf-moq-transport-18:
 * delta encoding を使用して ID をデコードする。
 *
 * @param data - Properties データ（複数の Property を含む可能性あり）
 * @returns デコードされた Property の配列
 */
export function decodeProperties(data: Uint8Array): Property[] {
  const extensions: Property[] = [];
  let offset = 0;
  let previousId = 0n;

  while (offset < data.length) {
    const [deltaId, deltaIdLen] = decodeVarint(data.subarray(offset));
    const id = previousId + deltaId;
    previousId = id;

    if (id % 2n === 0n) {
      // 偶数 ID: varint value 形式
      const [value, valueLen] = decodeVarint(data.subarray(offset + deltaIdLen));
      validateTrackPropertyValue(id, value);
      extensions.push({ id, value });
      offset += deltaIdLen + valueLen;
    } else {
      // 奇数 ID: length + bytes 形式
      const [length, lengthLen] = decodeVarint(data.subarray(offset + deltaIdLen));
      if (Number(length) > 65535) {
        throw new ProtocolViolationError(
          `properties value length exceeds maximum: ${length} > 65535`,
        );
      }
      const extData = data.slice(
        offset + deltaIdLen + lengthLen,
        offset + deltaIdLen + lengthLen + Number(length),
      );
      // draft-ietf-moq-transport-18 §12.7 (Immutable Properties):
      // IMMUTABLE_PROPERTIES MUST NOT recursively contain an
      // IMMUTABLE_PROPERTIES property. 早期検出のため、内側の KVP を走査して
      // IMMUTABLE_PROPERTIES (0x0B) が再度現れないか検証する。
      // 内側データが不完全な KVP の場合は IncompleteDataError のみ無視する。
      if (id === MOQTPropertyId.IMMUTABLE_PROPERTIES && extData.length > 0) {
        let innerOffset = 0;
        let innerPreviousId = 0n;
        while (innerOffset < extData.length) {
          try {
            const [deltaId, deltaIdLen] = decodeVarint(extData.subarray(innerOffset));
            const innerId = innerPreviousId + deltaId;
            innerPreviousId = innerId;
            if (innerId === MOQTPropertyId.IMMUTABLE_PROPERTIES) {
              throw new MalformedTrackError(
                "immutable properties must not recursively contain another immutable properties key",
              );
            }
            if (innerId % 2n === 0n) {
              const [, valueLen] = decodeVarint(extData.subarray(innerOffset + deltaIdLen));
              innerOffset += deltaIdLen + valueLen;
            } else {
              const [innerLength, innerLengthLen] = decodeVarint(
                extData.subarray(innerOffset + deltaIdLen),
              );
              innerOffset += deltaIdLen + innerLengthLen + Number(innerLength);
            }
          } catch (err) {
            if (err instanceof IncompleteDataError) {
              // 不完全な内側 KVP は後段の decodeImmutableProperties で検出される
              break;
            }
            throw err;
          }
        }
      }
      extensions.push({ id, data: extData });
      offset += deltaIdLen + lengthLen + Number(length);
    }
  }

  return extensions;
}

/**
 * ギャップ情報を使用してスキップされた Group を計算する
 *
 * @param currentGroupId - 現在の Group ID
 * @param gap - Prior Group ID Gap 拡張から取得したギャップ
 * @returns スキップされた Group ID の配列
 *
 * @example
 * // Group 10 で gap = 2 の場合
 * const skipped = calculateSkippedGroups(10n, { gap: 2n });
 * // => [8n, 9n]
 */
export function calculateSkippedGroups(currentGroupId: bigint, gap: PriorGroupIdGap): bigint[] {
  const skipped: bigint[] = [];
  const firstSkipped = currentGroupId - gap.gap;
  for (let i = firstSkipped; i < currentGroupId; i++) {
    skipped.push(i);
  }
  return skipped;
}

/**
 * ギャップ情報を使用してスキップされた Object を計算する
 *
 * @param currentObjectId - 現在の Object ID
 * @param gap - Prior Object ID Gap 拡張から取得したギャップ
 * @returns スキップされた Object ID の配列
 *
 * @example
 * // Object 10 で gap = 2 の場合
 * const skipped = calculateSkippedObjects(10n, { gap: 2n });
 * // => [8n, 9n]
 */
export function calculateSkippedObjects(currentObjectId: bigint, gap: PriorObjectIdGap): bigint[] {
  const skipped: bigint[] = [];
  const firstSkipped = currentObjectId - gap.gap;
  for (let i = firstSkipped; i < currentObjectId; i++) {
    skipped.push(i);
  }
  return skipped;
}
