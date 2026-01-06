/**
 * MOQT Extension Headers
 * draft-ietf-moq-transport-15 Section 11
 *
 * Object Extension Headers として定義されている拡張。
 * LOC (draft-ietf-moq-loc) とは別の、MOQT 本体で定義された拡張。
 */

import { encodeVarint, decodeVarint } from "./varint";

/**
 * MOQT Extension Header ID (Section 11)
 *
 * ID が偶数の場合: varint value
 * ID が奇数の場合: length (varint) + bytes
 */
export const MOQTExtensionHeaderId = {
  /**
   * Immutable Extensions (Section 11)
   * Relay が変更・削除できない拡張のコンテナ
   */
  IMMUTABLE_EXTENSIONS: 0x0bn,
  /**
   * Prior Group ID Gap (Section 11.1)
   * 現在の Group より前のスキップされた Group 数
   */
  PRIOR_GROUP_ID_GAP: 0x3cn,
  /**
   * Prior Object ID Gap (Section 11.2)
   * 現在の Object より前のスキップされた Object 数
   */
  PRIOR_OBJECT_ID_GAP: 0x3en,
} as const;

/**
 * Prior Group ID Gap
 *
 * draft-ietf-moq-transport-15 Section 11.1:
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
 * draft-ietf-moq-transport-15 Section 11.2:
 * 現在の Object より前の、存在しない Object の数を示す。
 *
 * 例: Object 10 で gap = 2 の場合、Object 8 と 9 は存在しない。
 */
export interface PriorObjectIdGap {
  gap: bigint;
}

/**
 * Extension Header の共通インターフェース
 *
 * 偶数 ID: varint value 形式
 * 奇数 ID: length + bytes 形式
 */
export interface ExtensionHeader {
  id: bigint;
  value?: bigint;
  data?: Uint8Array;
}

/**
 * Immutable Extensions
 *
 * draft-ietf-moq-transport-15 Section 11:
 * Relay が変更・削除できない拡張のコンテナ。
 * 内部に Key-Value-Pair をネストできる。
 *
 * Original Publisher のみが追加でき、Relay は変更・削除できない。
 */
export interface ImmutableExtensions {
  extensions: ExtensionHeader[];
}

/**
 * パースされた Extension Headers
 */
export interface ParsedExtensionHeaders {
  priorGroupIdGap?: PriorGroupIdGap;
  priorObjectIdGap?: PriorObjectIdGap;
  immutableExtensions?: ImmutableExtensions;
  /**
   * 未知の拡張（パースはスキップされたが保持）
   */
  unknownExtensions?: Array<{ id: bigint; data: Uint8Array }>;
}

/**
 * Prior Group ID Gap をエンコードする
 *
 * draft-ietf-moq-transport-15 Section 11.1:
 * ID (0x3C) は偶数なので varint value 形式
 */
export function encodePriorGroupIdGap(gap: PriorGroupIdGap): Uint8Array {
  const idBytes = encodeVarint(MOQTExtensionHeaderId.PRIOR_GROUP_ID_GAP);
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
 * draft-ietf-moq-transport-15 Section 11.2:
 * ID (0x3E) は偶数なので varint value 形式
 */
export function encodePriorObjectIdGap(gap: PriorObjectIdGap): Uint8Array {
  const idBytes = encodeVarint(MOQTExtensionHeaderId.PRIOR_OBJECT_ID_GAP);
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
 * 単一の Extension Header をエンコードする
 *
 * 偶数 ID: ID + varint value 形式
 * 奇数 ID: ID + length + bytes 形式
 */
export function encodeExtensionHeader(header: ExtensionHeader): Uint8Array {
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
 * 複数の Extension Header をエンコードして結合する
 */
export function encodeExtensionHeaders(headers: ExtensionHeader[]): Uint8Array {
  const parts = headers.map(encodeExtensionHeader);
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
 * Immutable Extensions をエンコードする
 *
 * draft-ietf-moq-transport-15 Section 11:
 * ID (0x0B) は奇数なので length + bytes 形式
 *
 * 内部には複数の Key-Value-Pair (Extension Header) をネストできる。
 */
export function encodeImmutableExtensions(immutable: ImmutableExtensions): Uint8Array {
  // 内部の拡張を全てエンコードして結合
  const innerBytes = encodeExtensionHeaders(immutable.extensions);

  // ID + length + innerBytes
  const idBytes = encodeVarint(MOQTExtensionHeaderId.IMMUTABLE_EXTENSIONS);
  const lengthBytes = encodeVarint(BigInt(innerBytes.length));

  const result = new Uint8Array(idBytes.length + lengthBytes.length + innerBytes.length);
  result.set(idBytes, 0);
  result.set(lengthBytes, idBytes.length);
  result.set(innerBytes, idBytes.length + lengthBytes.length);
  return result;
}

/**
 * Immutable Extensions をデコードする
 *
 * @param data - ID を含む完全な Immutable Extensions データ
 */
export function decodeImmutableExtensions(data: Uint8Array): ImmutableExtensions {
  const [_id, idLen] = decodeVarint(data);
  const [length, lengthLen] = decodeVarint(data.subarray(idLen));
  const innerData = data.subarray(idLen + lengthLen, idLen + lengthLen + Number(length));

  const extensions: ExtensionHeader[] = [];
  let offset = 0;

  while (offset < innerData.length) {
    const [extId, extIdLen] = decodeVarint(innerData.subarray(offset));

    if (extId % 2n === 0n) {
      // 偶数 ID: varint value 形式
      const [value, valueLen] = decodeVarint(innerData.subarray(offset + extIdLen));
      extensions.push({ id: extId, value });
      offset += extIdLen + valueLen;
    } else {
      // 奇数 ID: length + bytes 形式
      const [extLength, extLengthLen] = decodeVarint(innerData.subarray(offset + extIdLen));
      const extData = innerData.slice(
        offset + extIdLen + extLengthLen,
        offset + extIdLen + extLengthLen + Number(extLength),
      );
      extensions.push({ id: extId, data: extData });
      offset += extIdLen + extLengthLen + Number(extLength);
    }
  }

  return { extensions };
}

/**
 * Extension Headers をパースする
 *
 * 複数の拡張が含まれるデータから、MOQT Core Extensions を抽出する。
 * 未知の拡張はスキップされるが、unknownExtensions に保持される。
 *
 * @param data - Extensions データ（複数の拡張を含む可能性あり）
 */
export function parseExtensionHeaders(data: Uint8Array): ParsedExtensionHeaders {
  const result: ParsedExtensionHeaders = {};
  const unknownExtensions: Array<{ id: bigint; data: Uint8Array }> = [];
  let offset = 0;

  while (offset < data.length) {
    const [id, idLen] = decodeVarint(data.subarray(offset));
    const startOffset = offset;

    if (id === MOQTExtensionHeaderId.PRIOR_GROUP_ID_GAP) {
      const [gap, gapLen] = decodeVarint(data.subarray(offset + idLen));
      result.priorGroupIdGap = { gap };
      offset += idLen + gapLen;
    } else if (id === MOQTExtensionHeaderId.PRIOR_OBJECT_ID_GAP) {
      const [gap, gapLen] = decodeVarint(data.subarray(offset + idLen));
      result.priorObjectIdGap = { gap };
      offset += idLen + gapLen;
    } else if (id === MOQTExtensionHeaderId.IMMUTABLE_EXTENSIONS) {
      // Immutable Extensions は奇数 ID なので length + bytes 形式
      const [length, lengthLen] = decodeVarint(data.subarray(offset + idLen));
      const innerData = data.subarray(
        offset + idLen + lengthLen,
        offset + idLen + lengthLen + Number(length),
      );

      // 内部の拡張をパース
      const extensions: ExtensionHeader[] = [];
      let innerOffset = 0;
      while (innerOffset < innerData.length) {
        const [extId, extIdLen] = decodeVarint(innerData.subarray(innerOffset));

        if (extId % 2n === 0n) {
          // 偶数 ID: varint value 形式
          const [value, valueLen] = decodeVarint(innerData.subarray(innerOffset + extIdLen));
          extensions.push({ id: extId, value });
          innerOffset += extIdLen + valueLen;
        } else {
          // 奇数 ID: length + bytes 形式
          const [extLength, extLengthLen] = decodeVarint(
            innerData.subarray(innerOffset + extIdLen),
          );
          const extData = innerData.slice(
            innerOffset + extIdLen + extLengthLen,
            innerOffset + extIdLen + extLengthLen + Number(extLength),
          );
          extensions.push({ id: extId, data: extData });
          innerOffset += extIdLen + extLengthLen + Number(extLength);
        }
      }

      result.immutableExtensions = { extensions };
      offset += idLen + lengthLen + Number(length);
    } else {
      // 未知の拡張
      if (id % 2n === 1n) {
        // 奇数 ID: length + bytes 形式
        const [length, lengthLen] = decodeVarint(data.subarray(offset + idLen));
        const extData = data.slice(startOffset, offset + idLen + lengthLen + Number(length));
        unknownExtensions.push({ id, data: extData });
        offset += idLen + lengthLen + Number(length);
      } else {
        // 偶数 ID: varint value 形式
        const [_value, valueLen] = decodeVarint(data.subarray(offset + idLen));
        const extData = data.slice(startOffset, offset + idLen + valueLen);
        unknownExtensions.push({ id, data: extData });
        offset += idLen + valueLen;
      }
    }
  }

  if (unknownExtensions.length > 0) {
    result.unknownExtensions = unknownExtensions;
  }

  return result;
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
