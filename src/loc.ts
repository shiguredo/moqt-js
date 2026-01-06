/**
 * LOC (Low Overhead Container)
 * draft-ietf-moq-loc-01
 *
 * LOC Header Extensions を MOQ Object Header Extensions に格納し、
 * LOC Payload には WebCodecs の EncodedVideoChunk/EncodedAudioChunk の
 * "internal data" をそのまま使用する。
 */

import { encodeVarint, decodeVarint } from "./varint";

/**
 * LOC Header Extension ID (draft-ietf-moq-loc-01 Section 2.3)
 *
 * ID が偶数の場合: varint value
 * ID が奇数の場合: length (varint) + bytes
 */
export const LOCHeaderExtensionId = {
  /** Capture Timestamp - Unix epoch からのマイクロ秒 (varint) */
  CAPTURE_TIMESTAMP: 2n,
  /** Video Frame Marking - RFC9626 準拠のフレームマーキング (varint) */
  VIDEO_FRAME_MARKING: 4n,
  /** Audio Level - RFC6464 準拠のオーディオレベル (varint) */
  AUDIO_LEVEL: 6n,
  /** Config - VideoDecoderConfig の description (length + bytes) */
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
 * Video Header Extensions
 */
export interface VideoHeaderExtensions {
  captureTimestamp?: bigint;
  frameMarking?: VideoFrameMarking;
  config?: Uint8Array;
}

/**
 * Audio Header Extensions
 */
export interface AudioHeaderExtensions {
  captureTimestamp?: bigint;
  audioLevel?: AudioLevel;
}

/**
 * Capture Timestamp をエンコードする (ID: 2)
 */
export function encodeCaptureTimestamp(timestamp: bigint): Uint8Array {
  const idBytes = encodeVarint(LOCHeaderExtensionId.CAPTURE_TIMESTAMP);
  const valueBytes = encodeVarint(timestamp);
  const result = new Uint8Array(idBytes.length + valueBytes.length);
  result.set(idBytes, 0);
  result.set(valueBytes, idBytes.length);
  return result;
}

/**
 * Capture Timestamp をデコードする
 */
export function decodeCaptureTimestamp(data: Uint8Array): bigint {
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
  const idBytes = encodeVarint(LOCHeaderExtensionId.VIDEO_FRAME_MARKING);

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
  const idBytes = encodeVarint(LOCHeaderExtensionId.AUDIO_LEVEL);

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
  const idBytes = encodeVarint(LOCHeaderExtensionId.CONFIG);
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
 * Video Header Extensions をエンコードする
 */
export function encodeVideoHeaderExtensions(extensions: VideoHeaderExtensions): Uint8Array {
  const parts: Uint8Array[] = [];

  if (extensions.captureTimestamp !== undefined) {
    parts.push(encodeCaptureTimestamp(extensions.captureTimestamp));
  }

  if (extensions.frameMarking !== undefined) {
    parts.push(encodeVideoFrameMarking(extensions.frameMarking));
  }

  if (extensions.config !== undefined) {
    parts.push(encodeConfig(extensions.config));
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
 * Video Header Extensions をデコードする
 */
export function decodeVideoHeaderExtensions(data: Uint8Array): VideoHeaderExtensions {
  const result: VideoHeaderExtensions = {};
  let offset = 0;

  while (offset < data.length) {
    const [id, idLen] = decodeVarint(data.subarray(offset));

    if (id === LOCHeaderExtensionId.CAPTURE_TIMESTAMP) {
      const [value, valueLen] = decodeVarint(data.subarray(offset + idLen));
      result.captureTimestamp = value;
      offset += idLen + valueLen;
    } else if (id === LOCHeaderExtensionId.VIDEO_FRAME_MARKING) {
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
    } else if (id === LOCHeaderExtensionId.CONFIG) {
      const [length, lengthLen] = decodeVarint(data.subarray(offset + idLen));
      const configData = data.subarray(
        offset + idLen + lengthLen,
        offset + idLen + lengthLen + Number(length),
      );
      result.config = new Uint8Array(configData);
      offset += idLen + lengthLen + Number(length);
    } else {
      // 未知の extension をスキップ
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
 * Audio Header Extensions をエンコードする
 */
export function encodeAudioHeaderExtensions(extensions: AudioHeaderExtensions): Uint8Array {
  const parts: Uint8Array[] = [];

  if (extensions.captureTimestamp !== undefined) {
    parts.push(encodeCaptureTimestamp(extensions.captureTimestamp));
  }

  if (extensions.audioLevel !== undefined) {
    parts.push(encodeAudioLevel(extensions.audioLevel.level, extensions.audioLevel.voiceActivity));
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
 * Audio Header Extensions をデコードする
 */
export function decodeAudioHeaderExtensions(data: Uint8Array): AudioHeaderExtensions {
  const result: AudioHeaderExtensions = {};
  let offset = 0;

  while (offset < data.length) {
    const [id, idLen] = decodeVarint(data.subarray(offset));

    if (id === LOCHeaderExtensionId.CAPTURE_TIMESTAMP) {
      const [value, valueLen] = decodeVarint(data.subarray(offset + idLen));
      result.captureTimestamp = value;
      offset += idLen + valueLen;
    } else if (id === LOCHeaderExtensionId.AUDIO_LEVEL) {
      const [value, valueLen] = decodeVarint(data.subarray(offset + idLen));
      const byte = Number(value & 0xffn);
      result.audioLevel = {
        level: byte & 0x7f,
        voiceActivity: (byte & 0x80) !== 0,
      };
      offset += idLen + valueLen;
    } else {
      // 未知の extension をスキップ
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
