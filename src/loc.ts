/**
 * LOC (Low Overhead Container)
 * draft-ietf-moq-loc-04
 *
 * LOC Properties を MOQ Object Properties に格納し、
 * LOC Payload には WebCodecs の EncodedVideoChunk/EncodedAudioChunk の
 * "internal data" をそのまま使用する。
 */

import { encodeVarint, decodeVarint } from "./varint";

/**
 * LOC Property ID (draft-ietf-moq-loc-04 Section 6.1 MOQ Properties Registry)
 *
 * ID が偶数の場合: varint value
 * ID が奇数の場合: length (varint) + bytes
 */
export const LOCPropertyId = {
  /**
   * Timestamp (draft-ietf-moq-loc-04 Section 2.3.1.1 Timestamp)
   * Timescale がない場合は Unix epoch からのマイクロ秒 (varint)
   * Timescale がある場合はメディア時間 (varint)
   */
  TIMESTAMP: 0x10n,
  /**
   * Timescale (draft-ietf-moq-loc-04 Section 2.3.1.2 Timescale)
   * 1 秒あたりの Timestamp 単位数 (varint)
   */
  TIMESCALE: 0x08n,
  /**
   * Video Frame Marking (draft-ietf-moq-loc-04 Section 2.3.2.2 Video Frame Marking)
   * RFC9626 準拠のフレームマーキング (length + bytes)
   */
  VIDEO_FRAME_MARKING: 0x09n,
  /**
   * Audio Level (draft-ietf-moq-loc-04 Section 2.3.3.2 Audio Level)
   * RFC6464 準拠のオーディオレベル (varint)
   */
  AUDIO_LEVEL: 0x0cn,
  /**
   * Video Config (draft-ietf-moq-loc-04 Section 2.3.2.1 Video Config)
   * VideoDecoderConfig の description (length + bytes)
   */
  VIDEO_CONFIG: 0x0dn,
  /**
   * Audio Config (draft-ietf-moq-loc-04 Section 2.3.3.1 Audio Config)
   * AudioDecoderConfig の description (length + bytes)
   */
  AUDIO_CONFIG: 0x0fn,
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
  audioConfig?: Uint8Array;
}

/**
 * Timestamp をエンコードする (ID: 0x10)
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
 * Video Frame Marking をエンコードする (ID: 0x09)
 * ID が奇数なので length + bytes 形式
 * RFC9626 形式の 2 バイト:
 * - byte 1:
 *   - bit 7: Start of frame (S)
 *   - bit 6: End of frame (E)
 *   - bit 5: Independent (I)
 *   - bit 4: Discardable (D)
 *   - bit 3: Base layer sync (B)
 *   - bits 2-0: Temporal layer ID (TID)
 * - byte 2:
 *   - bits 5-4: Spatial layer ID (SID)
 */
export function encodeVideoFrameMarking(marking: VideoFrameMarking): Uint8Array {
  const idBytes = encodeVarint(LOCPropertyId.VIDEO_FRAME_MARKING);

  // RFC9626 形式で 2 バイトにエンコード
  let byte1 = 0;
  byte1 |= 0x80;
  byte1 |= 0x40;
  if (marking.isIndependent) byte1 |= 0x20;
  if (marking.isDiscardable) byte1 |= 0x10;
  if (marking.isBaseLayerSync) byte1 |= 0x08;
  byte1 |= marking.temporalLayerId & 0x07;

  const byte2 = (marking.spatialLayerId & 0x03) << 4;

  // length + bytes 形式: length (varint) + value (2 bytes)
  const lengthBytes = encodeVarint(2n);
  const result = new Uint8Array(idBytes.length + lengthBytes.length + 2);
  result.set(idBytes, 0);
  result.set(lengthBytes, idBytes.length);
  result[idBytes.length + lengthBytes.length] = byte1;
  result[idBytes.length + lengthBytes.length + 1] = byte2;
  return result;
}

/**
 * Video Frame Marking をデコードする
 */
export function decodeVideoFrameMarking(data: Uint8Array): VideoFrameMarking {
  const [_id, idLen] = decodeVarint(data);
  const [_length, lengthLen] = decodeVarint(data.subarray(idLen));
  const valueOffset = idLen + lengthLen;

  const byte1 = data[valueOffset];
  const byte2 = data[valueOffset + 1];

  return {
    isIndependent: (byte1 & 0x20) !== 0,
    isDiscardable: (byte1 & 0x10) !== 0,
    isBaseLayerSync: (byte1 & 0x08) !== 0,
    temporalLayerId: byte1 & 0x07,
    spatialLayerId: (byte2 >> 4) & 0x03,
  };
}

/**
 * Audio Level をエンコードする (ID: 0x0C)
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
 * Video Config をエンコードする (ID: 0x0D)
 * ID が奇数なので length + bytes 形式
 * VideoDecoderConfig の description を格納
 */
export function encodeVideoConfig(description: Uint8Array): Uint8Array {
  const idBytes = encodeVarint(LOCPropertyId.VIDEO_CONFIG);
  const lengthBytes = encodeVarint(BigInt(description.length));
  const result = new Uint8Array(idBytes.length + lengthBytes.length + description.length);
  result.set(idBytes, 0);
  result.set(lengthBytes, idBytes.length);
  result.set(description, idBytes.length + lengthBytes.length);
  return result;
}

/**
 * Video Config をデコードする
 */
export function decodeVideoConfig(data: Uint8Array): Uint8Array {
  const [_id, idLen] = decodeVarint(data);
  const [length, lengthLen] = decodeVarint(data.subarray(idLen));
  return data.subarray(idLen + lengthLen, idLen + lengthLen + Number(length));
}

/**
 * Audio Config をエンコードする (ID: 0x0F)
 * ID が奇数なので length + bytes 形式
 * AudioDecoderConfig の description を格納
 */
export function encodeAudioConfig(description: Uint8Array): Uint8Array {
  const idBytes = encodeVarint(LOCPropertyId.AUDIO_CONFIG);
  const lengthBytes = encodeVarint(BigInt(description.length));
  const result = new Uint8Array(idBytes.length + lengthBytes.length + description.length);
  result.set(idBytes, 0);
  result.set(lengthBytes, idBytes.length);
  result.set(description, idBytes.length + lengthBytes.length);
  return result;
}

/**
 * Audio Config をデコードする
 */
export function decodeAudioConfig(data: Uint8Array): Uint8Array {
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
    parts.push(encodeVideoConfig(properties.config));
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
      const [length, lengthLen] = decodeVarint(data.subarray(offset + idLen));
      const valueOffset = offset + idLen + lengthLen;
      const byte1 = data[valueOffset];
      const byte2 = data[valueOffset + 1];
      result.frameMarking = {
        isIndependent: (byte1 & 0x20) !== 0,
        isDiscardable: (byte1 & 0x10) !== 0,
        isBaseLayerSync: (byte1 & 0x08) !== 0,
        temporalLayerId: byte1 & 0x07,
        spatialLayerId: (byte2 >> 4) & 0x03,
      };
      offset += idLen + lengthLen + Number(length);
    } else if (id === LOCPropertyId.VIDEO_CONFIG) {
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

  if (properties.audioConfig !== undefined) {
    parts.push(encodeAudioConfig(properties.audioConfig));
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
    } else if (id === LOCPropertyId.AUDIO_CONFIG) {
      const [length, lengthLen] = decodeVarint(data.subarray(offset + idLen));
      const configData = data.subarray(
        offset + idLen + lengthLen,
        offset + idLen + lengthLen + Number(length),
      );
      result.audioConfig = new Uint8Array(configData);
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
