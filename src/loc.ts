/**
 * LOC (Low Overhead Container)
 * draft-ietf-moq-loc-02
 *
 * LOC Properties を MOQ Object Properties に格納し、
 * LOC Payload には WebCodecs の EncodedVideoChunk/EncodedAudioChunk の
 * "internal data" をそのまま使用する。
 */

import { encodeVarint, decodeVarint } from "./varint";

/**
 * LOC Property ID (draft-ietf-moq-loc-02 Section 2.3 LOC Properties)
 *
 * ID が偶数の場合: varint value
 * ID が奇数の場合: length (varint) + bytes
 */
export const LOCPropertyId = {
  /**
   * Timestamp (draft-ietf-moq-loc-02 Section 2.3.1.1 Timestamp)
   * Timescale がない場合は Unix epoch からのマイクロ秒 (varint)
   * Timescale がある場合はメディア時間 (varint)
   */
  TIMESTAMP: 0x06n,
  /**
   * Timescale (draft-ietf-moq-loc-02 Section 2.3.1.2 Timescale)
   * 1 秒あたりの Timestamp 単位数 (varint)
   */
  TIMESCALE: 0x08n,
  /**
   * Video Frame Marking (draft-ietf-moq-loc-02 Section 2.3.2.2 Video Frame Marking)
   * RFC9626 準拠のフレームマーキング (varint)
   */
  VIDEO_FRAME_MARKING: 4n,
  /**
   * Audio Level (draft-ietf-moq-loc-02 Section 2.3.3.1 Audio Level)
   * RFC6464 準拠のオーディオレベル (varint)
   *
   * 注意: AUDIO_LEVEL の ID は 6 (= 0x06) であり、TIMESTAMP (0x06) と衝突している。
   * これは draft-ietf-moq-loc-02 の仕様上のバグである。
   * IANA による正式な ID 再割り当てが必要。
   */
  AUDIO_LEVEL: 6n,
  /**
   * Config (draft-ietf-moq-loc-02 Section 2.3.2.1 Video Config)
   * VideoDecoderConfig の description (length + bytes)
   */
  CONFIG: 13n,
} as const;

/**
 * Video Frame Marking (RFC9626)
 */
export interface VideoFrameMarking {
  isIndependent: boolean;
  isDiscardable: boolean;
  isBaseLayerSync: boolean;
  temporalLayerId: number;
  spatialLayerId: number;
}

/**
 * Audio Level (RFC6464)
 */
export interface AudioLevel {
  level: number;
  voiceActivity: boolean;
}

/**
 * Video Properties
 */
export interface VideoProperties {
  timestamp?: bigint;
  timescale?: bigint;
  frameMarking?: VideoFrameMarking;
  config?: Uint8Array;
}

/**
 * Audio Properties
 */
export interface AudioProperties {
  timestamp?: bigint;
  timescale?: bigint;
  audioLevel?: AudioLevel;
}

/**
 * Timestamp をエンコードする (ID: 0x06)
 */
export function encodeTimestamp(timestamp: bigint): Uint8Array {
  const idBytes = encodeVarint(LOCPropertyId.TIMESTAMP);
  const valueBytes = encodeVarint(timestamp);
  const result = new Uint8Array(idBytes.length + valueBytes.length);
  result.set(idBytes, 0);
  result.set(valueBytes, idBytes.length);
  return result;
}

/**
 * Timestamp をデコードする
 */
export function decodeTimestamp(data: Uint8Array): bigint {
  const [_id, idLen] = decodeVarint(data);
  const [value, _valueLen] = decodeVarint(data.subarray(idLen));
  return value;
}

/**
 * Timescale をエンコードする (ID: 0x08)
 */
export function encodeTimescale(timescale: bigint): Uint8Array {
  const idBytes = encodeVarint(LOCPropertyId.TIMESCALE);
  const valueBytes = encodeVarint(timescale);
  const result = new Uint8Array(idBytes.length + valueBytes.length);
  result.set(idBytes, 0);
  result.set(valueBytes, idBytes.length);
  return result;
}

/**
 * Timescale をデコードする
 */
export function decodeTimescale(data: Uint8Array): bigint {
  const [_id, idLen] = decodeVarint(data);
  const [value, _valueLen] = decodeVarint(data.subarray(idLen));
  return value;
}

/**
 * Video Frame Marking をエンコードする (ID: 4)
 * RFC9626 準拠のフォーマット:
 * - bit 7: Start of frame (S)
 * - bit 6: End of frame (E)
 * - bit 5: Independent (I)
 * - bit 4: Discardable (D)
 * - bit 3: Base layer sync (B)
 * - bits 2-0: Temporal layer ID (TID)
 * - bits 5-4: Spatial layer ID (SID) (次のバイト)
 */
export function encodeVideoFrameMarking(marking: VideoFrameMarking): Uint8Array {
  const idBytes = encodeVarint(LOCPropertyId.VIDEO_FRAME_MARKING);

  // RFC9626 形式でエンコード
  let byte1 = 0;
  byte1 |= 0x80;
  byte1 |= 0x40;
  if (marking.isIndependent) byte1 |= 0x20;
  if (marking.isDiscardable) byte1 |= 0x10;
  if (marking.isBaseLayerSync) byte1 |= 0x08;
  byte1 |= marking.temporalLayerId & 0x07;

  const byte2 = (marking.spatialLayerId & 0x03) << 4;

  const value = BigInt((byte1 << 8) | byte2);
  const valueBytes = encodeVarint(value);

  const result = new Uint8Array(idBytes.length + valueBytes.length);
  result.set(idBytes, 0);
  result.set(valueBytes, idBytes.length);
  return result;
}

/**
 * Video Frame Marking をデコードする
 */
export function decodeVideoFrameMarking(data: Uint8Array): VideoFrameMarking {
  const [_id, idLen] = decodeVarint(data);
  const [value, _valueLen] = decodeVarint(data.subarray(idLen));

  const byte1 = Number((value >> 8n) & 0xffn);
  const byte2 = Number(value & 0xffn);

  return {
    isIndependent: (byte1 & 0x20) !== 0,
    isDiscardable: (byte1 & 0x10) !== 0,
    isBaseLayerSync: (byte1 & 0x08) !== 0,
    temporalLayerId: byte1 & 0x07,
    spatialLayerId: (byte2 >> 4) & 0x03,
  };
}

/**
 * Audio Level をエンコードする (ID: 6)
 * RFC6464 形式:
 * - bit 7: Voice activity (V)
 * - bits 6-0: Level (0-127)
 */
export function encodeAudioLevel(level: number, voiceActivity: boolean): Uint8Array {
  const idBytes = encodeVarint(LOCPropertyId.AUDIO_LEVEL);

  let value = level & 0x7f;
  if (voiceActivity) value |= 0x80;

  const valueBytes = encodeVarint(BigInt(value));

  const result = new Uint8Array(idBytes.length + valueBytes.length);
  result.set(idBytes, 0);
  result.set(valueBytes, idBytes.length);
  return result;
}

/**
 * Audio Level をデコードする
 */
export function decodeAudioLevel(data: Uint8Array): AudioLevel {
  const [_id, idLen] = decodeVarint(data);
  const [value, _valueLen] = decodeVarint(data.subarray(idLen));

  const byte = Number(value & 0xffn);
  return {
    level: byte & 0x7f,
    voiceActivity: (byte & 0x80) !== 0,
  };
}

/**
 * Config をエンコードする (ID: 13)
 * ID が奇数なので length + bytes 形式
 * VideoDecoderConfig の description を格納
 */
export function encodeConfig(description: Uint8Array): Uint8Array {
  const idBytes = encodeVarint(LOCPropertyId.CONFIG);
  const lengthBytes = encodeVarint(BigInt(description.length));
  const result = new Uint8Array(idBytes.length + lengthBytes.length + description.length);
  result.set(idBytes, 0);
  result.set(lengthBytes, idBytes.length);
  result.set(description, idBytes.length + lengthBytes.length);
  return result;
}

/**
 * Config をデコードする
 */
export function decodeConfig(data: Uint8Array): Uint8Array {
  const [_id, idLen] = decodeVarint(data);
  const [length, lengthLen] = decodeVarint(data.subarray(idLen));
  return data.subarray(idLen + lengthLen, idLen + lengthLen + Number(length));
}

/**
 * Video Properties をエンコードする
 */
export function encodeVideoProperties(properties: VideoProperties): Uint8Array {
  const parts: Uint8Array[] = [];

  if (properties.timestamp !== undefined) {
    parts.push(encodeTimestamp(properties.timestamp));
  }

  if (properties.timescale !== undefined) {
    parts.push(encodeTimescale(properties.timescale));
  }

  if (properties.frameMarking !== undefined) {
    parts.push(encodeVideoFrameMarking(properties.frameMarking));
  }

  if (properties.config !== undefined) {
    parts.push(encodeConfig(properties.config));
  }

  const totalLength = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

/**
 * Video Properties をデコードする
 */
export function decodeVideoProperties(data: Uint8Array): VideoProperties {
  const result: VideoProperties = {};
  let offset = 0;

  while (offset < data.length) {
    const [id, idLen] = decodeVarint(data.subarray(offset));

    if (id === LOCPropertyId.TIMESTAMP) {
      const [value, valueLen] = decodeVarint(data.subarray(offset + idLen));
      result.timestamp = value;
      offset += idLen + valueLen;
    } else if (id === LOCPropertyId.TIMESCALE) {
      const [value, valueLen] = decodeVarint(data.subarray(offset + idLen));
      result.timescale = value;
      offset += idLen + valueLen;
    } else if (id === LOCPropertyId.VIDEO_FRAME_MARKING) {
      const [value, valueLen] = decodeVarint(data.subarray(offset + idLen));
      const byte1 = Number((value >> 8n) & 0xffn);
      const byte2 = Number(value & 0xffn);
      result.frameMarking = {
        isIndependent: (byte1 & 0x20) !== 0,
        isDiscardable: (byte1 & 0x10) !== 0,
        isBaseLayerSync: (byte1 & 0x08) !== 0,
        temporalLayerId: byte1 & 0x07,
        spatialLayerId: (byte2 >> 4) & 0x03,
      };
      offset += idLen + valueLen;
    } else if (id === LOCPropertyId.CONFIG) {
      const [length, lengthLen] = decodeVarint(data.subarray(offset + idLen));
      const configData = data.subarray(
        offset + idLen + lengthLen,
        offset + idLen + lengthLen + Number(length),
      );
      result.config = new Uint8Array(configData);
      offset += idLen + lengthLen + Number(length);
    } else {
      // 未知のプロパティをスキップ
      if (id % 2n === 1n) {
        const [length, lengthLen] = decodeVarint(data.subarray(offset + idLen));
        offset += idLen + lengthLen + Number(length);
      } else {
        const [_value, valueLen] = decodeVarint(data.subarray(offset + idLen));
        offset += idLen + valueLen;
      }
    }
  }

  return result;
}

/**
 * Audio Properties をエンコードする
 */
export function encodeAudioProperties(properties: AudioProperties): Uint8Array {
  const parts: Uint8Array[] = [];

  if (properties.timestamp !== undefined) {
    parts.push(encodeTimestamp(properties.timestamp));
  }

  if (properties.timescale !== undefined) {
    parts.push(encodeTimescale(properties.timescale));
  }

  if (properties.audioLevel !== undefined) {
    parts.push(encodeAudioLevel(properties.audioLevel.level, properties.audioLevel.voiceActivity));
  }

  const totalLength = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

/**
 * Audio Properties をデコードする
 */
export function decodeAudioProperties(data: Uint8Array): AudioProperties {
  const result: AudioProperties = {};
  let offset = 0;

  while (offset < data.length) {
    const [id, idLen] = decodeVarint(data.subarray(offset));

    if (id === LOCPropertyId.TIMESTAMP) {
      const [value, valueLen] = decodeVarint(data.subarray(offset + idLen));
      result.timestamp = value;
      offset += idLen + valueLen;
    } else if (id === LOCPropertyId.TIMESCALE) {
      const [value, valueLen] = decodeVarint(data.subarray(offset + idLen));
      result.timescale = value;
      offset += idLen + valueLen;
    } else if (id === LOCPropertyId.AUDIO_LEVEL) {
      const [value, valueLen] = decodeVarint(data.subarray(offset + idLen));
      const byte = Number(value & 0xffn);
      result.audioLevel = {
        level: byte & 0x7f,
        voiceActivity: (byte & 0x80) !== 0,
      };
      offset += idLen + valueLen;
    } else {
      // 未知のプロパティをスキップ
      if (id % 2n === 1n) {
        const [length, lengthLen] = decodeVarint(data.subarray(offset + idLen));
        offset += idLen + lengthLen + Number(length);
      } else {
        const [_value, valueLen] = decodeVarint(data.subarray(offset + idLen));
        offset += idLen + valueLen;
      }
    }
  }

  return result;
}
