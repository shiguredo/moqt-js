/**
 * LOC (Low Overhead Container)
 * draft-ietf-moq-loc-04
 *
 * LOC Public Properties は MOQ Object Properties に格納する。
 * MOQ Object Payload は draft-ietf-moq-loc-04 §2.2 に従い
 * LOC Private Properties + LOC Payload で構成する。
 *
 * 空の Private Properties（未使用）のとき Object Payload は
 * EncodedVideoChunk / EncodedAudioChunk の "internal data" （LOC Payload）と
 * ビット一致する（ length prefix 無し）。
 * 非空の Private Properties を載せるときは encodeLocObjectPayload /
 * decodeLocObjectPayload の暫定フレーミングを使う。
 *
 * 注意: loc-04 §2.2 は配置（Private → LOC Payload）のみを定め、
 * Private ブロック全体の長さ prefix は定義しない。本モジュールの
 * 非空時ワイヤ（varint length + Private + LOC Payload）はリポジトリ暫定であり、
 * Secure Objects 取得後に見直しうる。本ヘルパ出力を暗号化 plaintext に
 * そのまま流用しないこと。
 *
 * 注意: 本モジュールの encode*Properties / decode*Properties は Object Properties が
 * 要求する Key-Value-Pair delta 符号化 (draft-ietf-moq-transport-19 §1.4.3 / §11.2.1.2)
 * に追従している。単体エンコーダ / デコーダは単一 Property 前提の絶対 Type ワイヤであり、
 * 複数 Property の連結・分解には使わないこと。
 */

import { IncompleteDataError, ProtocolViolationError } from "./error";
import { encodeVarint, decodeVarint } from "./varint";
import { encodeProperties, decodeObjectPropertiesTolerant, type Property } from "./properties";

/**
 * LOC Property ID (draft-ietf-moq-loc-04 Section 2.3 / §6.1 Table 1)
 *
 * ID が偶数の場合: Length 省略、Value は vi64
 * ID が奇数の場合: length (varint) + bytes
 *
 * 注意: draft-ietf-moq-transport-19 Table 15 の provisional 値は採用しない。
 * LOC Property ID は loc-04 Table 1 に従う。
 */
export const LOCPropertyId = {
  /**
   * Timestamp (draft-ietf-moq-loc-04 Section 2.3.1.1 Timestamp)
   * Timescale がない場合は Unix epoch からのマイクロ秒 (vi64)
   * Timescale がある場合はメディア時間 (vi64)
   */
  TIMESTAMP: 0x10n,
  /**
   * Timescale (draft-ietf-moq-loc-04 Section 2.3.1.2 Timescale)
   * 1 秒あたりの Timestamp 単位数 (vi64)
   */
  TIMESCALE: 0x08n,
  /**
   * Video Frame Marking (draft-ietf-moq-loc-04 Section 2.3.2.2 Video Frame Marking)
   * length prefix 付きバイト列。Value のビット配置は独自レイアウトを維持する
   * (I / D / B / TID / 2bit SID)。RFC9626 の 8-bit LID / TL0PICIDX までは未対応。
   */
  VIDEO_FRAME_MARKING: 0x09n,
  /**
   * Audio Level (draft-ietf-moq-loc-04 Section 2.3.3.2 Audio Level)
   * RFC6464 section 3 準拠のオーディオレベル (vi64 の下位 8 bit)
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
 * Video Frame Marking
 *
 * draft-ietf-moq-loc-04 §2.3.2.2 は RFC9626 を参照するが、
 * 本実装の Value ビット配置は既存の独自レイアウト (I / D / B / TID / 2bit SID) を維持する。
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
  config?: Uint8Array;
}

/**
 * Video Frame Marking の Value バイトからフィールドを解釈する。
 * Length=1 は SID=0 扱い、Length>=2 は先頭 2 バイトから読む。
 */
function parseVideoFrameMarkingValue(value: Uint8Array): VideoFrameMarking {
  const byte1 = value[0] ?? 0;
  const byte2 = value.length >= 2 ? (value[1] ?? 0) : 0;

  return {
    isIndependent: (byte1 & 0x20) !== 0,
    isDiscardable: (byte1 & 0x10) !== 0,
    isBaseLayerSync: (byte1 & 0x08) !== 0,
    temporalLayerId: byte1 & 0x07,
    spatialLayerId: (byte2 >> 4) & 0x03,
  };
}

/**
 * Video Frame Marking の length + value をデコードする共通処理。
 * Length は 1–4 のみ受理。宣言 Length バイトは必ず消費する。
 *
 * @throws ProtocolViolationError Length が不正、または Value バイトが不足する場合
 */
function decodeVideoFrameMarkingAfterId(
  data: Uint8Array,
  idLen: number,
): { marking: VideoFrameMarking; consumed: number } {
  const afterId = data.subarray(idLen);
  const [lengthBig, lengthLen] = decodeVarint(afterId);
  const length = Number(lengthBig);

  if (length < 1 || length > 4) {
    throw new ProtocolViolationError(`invalid VIDEO_FRAME_MARKING length: ${length}, expected 1-4`);
  }

  const valueOffset = idLen + lengthLen;
  if (data.length < valueOffset + length) {
    throw new ProtocolViolationError(
      `insufficient VIDEO_FRAME_MARKING value bytes: need ${length}, got ${data.length - valueOffset}`,
    );
  }

  const value = data.subarray(valueOffset, valueOffset + length);
  return {
    marking: parseVideoFrameMarkingValue(value),
    consumed: idLen + lengthLen + length,
  };
}

/**
 * Timestamp をエンコードする (ID: 0x10)
 *
 * 単一 Property を絶対 Type でエンコードする。複数 Property の連結には
 * encodeVideoProperties / encodeAudioProperties を使うこと。
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
 * Timestamp をデコードする (単一 Property 前提。絶対 Type で書かれたワイヤのみ)
 */
export function decodeTimestamp(data: Uint8Array): bigint {
  const [_id, idLen] = decodeVarint(data);
  const [value, _valueLen] = decodeVarint(data.subarray(idLen));
  return value;
}

/**
 * Timescale をエンコードする (ID: 0x08)
 *
 * 単一 Property を絶対 Type でエンコードする。複数 Property の連結には
 * encodeVideoProperties / encodeAudioProperties を使うこと。
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
 * Timescale をデコードする (単一 Property 前提。絶対 Type で書かれたワイヤのみ)
 */
export function decodeTimescale(data: Uint8Array): bigint {
  const [_id, idLen] = decodeVarint(data);
  const [value, _valueLen] = decodeVarint(data.subarray(idLen));
  return value;
}

/**
 * Video Frame Marking の Value バイト列を生成する (length prefix を含まない)
 */
function encodeVideoFrameMarkingValue(marking: VideoFrameMarking): Uint8Array {
  let byte1 = 0;
  byte1 |= 0x80;
  byte1 |= 0x40;
  if (marking.isIndependent) byte1 |= 0x20;
  if (marking.isDiscardable) byte1 |= 0x10;
  if (marking.isBaseLayerSync) byte1 |= 0x08;
  byte1 |= marking.temporalLayerId & 0x07;

  const byte2 = (marking.spatialLayerId & 0x03) << 4;
  return new Uint8Array([byte1, byte2]);
}

/**
 * Video Frame Marking をエンコードする (ID: 0x09)
 *
 * draft-ietf-moq-loc-04 §2.3.2.2: 奇数 ID のため length + bytes 形式。
 * Value のビット配置は独自レイアウトを維持する:
 * - bit 7: Start of frame (S) — 常に 1
 * - bit 6: End of frame (E) — 常に 1
 * - bit 5: Independent (I)
 * - bit 4: Discardable (D)
 * - bit 3: Base layer sync (B)
 * - bits 2-0: Temporal layer ID (TID)
 * - bits 5-4 (次バイト): Spatial layer ID (SID, 2 bit)
 *
 * 単一 Property を絶対 Type でエンコードする。複数 Property の連結には
 * encodeVideoProperties を使うこと。
 */
export function encodeVideoFrameMarking(marking: VideoFrameMarking): Uint8Array {
  const idBytes = encodeVarint(LOCPropertyId.VIDEO_FRAME_MARKING);
  const valueBytes = encodeVideoFrameMarkingValue(marking);
  const lengthBytes = encodeVarint(BigInt(valueBytes.length));

  const result = new Uint8Array(idBytes.length + lengthBytes.length + valueBytes.length);
  result.set(idBytes, 0);
  result.set(lengthBytes, idBytes.length);
  result.set(valueBytes, idBytes.length + lengthBytes.length);
  return result;
}

/**
 * Video Frame Marking をデコードする (単一 Property 前提。絶対 Type で書かれたワイヤのみ)
 *
 * @throws ProtocolViolationError Length が 1–4 以外、または Value バイトが不足する場合
 */
export function decodeVideoFrameMarking(data: Uint8Array): VideoFrameMarking {
  const [_id, idLen] = decodeVarint(data);
  return decodeVideoFrameMarkingAfterId(data, idLen).marking;
}

/**
 * Audio Level をエンコードする (ID: 0x0C)
 * RFC6464 形式:
 * - bit 7: Voice activity (V)
 * - bits 6-0: Level (0-127)
 *
 * 単一 Property を絶対 Type でエンコードする。複数 Property の連結には
 * encodeAudioProperties を使うこと。
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
 * Audio Level の varint value からフィールドを解釈する
 * RFC6464: 下位 8 bit に level (bits 6-0) と voice activity (bit 7)
 */
function decodeAudioLevelValue(value: bigint): AudioLevel {
  const byte = Number(value & 0xffn);
  return {
    level: byte & 0x7f,
    voiceActivity: (byte & 0x80) !== 0,
  };
}

/**
 * Audio Level をデコードする (単一 Property 前提。絶対 Type で書かれたワイヤのみ)
 */
export function decodeAudioLevel(data: Uint8Array): AudioLevel {
  const [_id, idLen] = decodeVarint(data);
  const [value, _valueLen] = decodeVarint(data.subarray(idLen));
  return decodeAudioLevelValue(value);
}

/**
 * Video Config をエンコードする (ID: 0x0D)
 * ID が奇数なので length + bytes 形式
 * VideoDecoderConfig の description を格納
 *
 * 単一 Property を絶対 Type でエンコードする。複数 Property の連結には
 * encodeVideoProperties を使うこと。
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
 * Video Config をデコードする (単一 Property 前提。絶対 Type で書かれたワイヤのみ)
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
 *
 * 単一 Property を絶対 Type でエンコードする。複数 Property の連結には
 * encodeAudioProperties を使うこと。
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
 * Audio Config をデコードする (単一 Property 前提。絶対 Type で書かれたワイヤのみ)
 */
export function decodeAudioConfig(data: Uint8Array): Uint8Array {
  const [_id, idLen] = decodeVarint(data);
  const [length, lengthLen] = decodeVarint(data.subarray(idLen));
  return data.subarray(idLen + lengthLen, idLen + lengthLen + Number(length));
}

/**
 * Video Properties をエンコードする
 *
 * draft-ietf-moq-transport-19 §11.2.1.2 (Object Properties) は Key-Value-Pairs
 * (Figure 2、delta encoding) でシリアライズされる。LOC Property を Property[] として
 * 組み立て、encodeProperties() に委譲する。encodeProperties() は ID 昇順ソートするため、
 * ワイヤ上の並びは Property 入力順ではなく ID 昇順になる (例: timestamp (0x10) +
 * frameMarking (0x09) は frameMarking が先頭になり、Delta Type は 0x09, 0x07 になる)。
 */
export function encodeVideoProperties(properties: VideoProperties): Uint8Array {
  const headers: Property[] = [];

  if (properties.timestamp !== undefined) {
    headers.push({ id: LOCPropertyId.TIMESTAMP, value: properties.timestamp });
  }

  if (properties.timescale !== undefined) {
    headers.push({ id: LOCPropertyId.TIMESCALE, value: properties.timescale });
  }

  if (properties.frameMarking !== undefined) {
    headers.push({
      id: LOCPropertyId.VIDEO_FRAME_MARKING,
      data: encodeVideoFrameMarkingValue(properties.frameMarking),
    });
  }

  if (properties.config !== undefined) {
    headers.push({ id: LOCPropertyId.VIDEO_CONFIG, data: properties.config });
  }

  return encodeProperties(headers);
}

/**
 * Video Properties をデコードする
 *
 * draft-ietf-moq-transport-19 §11.2.1.2 / §1.4.3 の Key-Value-Pairs (delta encoding) を
 * 寛容にデコードする。不正な delta / Length で PROTOCOL_VIOLATION を送出せず、
 * 抽出できたフィールドのみを設定して配信を継続する。delta 形式は Type が前 Property との
 * 差分で連鎖するため、途中で壊れた場合は後続 Property の抽出が全滅し、先行値のみが
 * 保持される (decodeObjectPropertiesTolerant と同じ既知の制約)。
 *
 * Track 向け decodeProperties の厳密検証 (Mandatory Track Property 0x4000-0x7FFF 拒否、
 * validateTrackPropertyValue、Length 上限 2^16-1) は適用しない (Object バイト列に適用すると
 * 誤って MalformedTrackError になり得る)。
 *
 * VIDEO_FRAME_MARKING の Value が不正 (Length 1-4 外) な場合は frameMarking を未設定として
 * 扱う。
 */
export function decodeVideoProperties(data: Uint8Array): VideoProperties {
  const decoded = decodeObjectPropertiesTolerant(data);
  const extracted = extractLocProperties(decoded.properties, "object");
  return {
    timestamp: extracted.timestamp,
    timescale: extracted.timescale,
    frameMarking: extracted.frameMarking,
    config: extracted.videoConfig,
  };
}

/**
 * Audio Properties をエンコードする
 *
 * エンコード規約は encodeVideoProperties と同じ (encodeProperties() 経由の
 * delta encoding)。ID 昇順ソートのため、ワイヤ上の並びは Property 入力順ではなく
 * ID 昇順になる。
 */
export function encodeAudioProperties(properties: AudioProperties): Uint8Array {
  const headers: Property[] = [];

  if (properties.timestamp !== undefined) {
    headers.push({ id: LOCPropertyId.TIMESTAMP, value: properties.timestamp });
  }

  if (properties.timescale !== undefined) {
    headers.push({ id: LOCPropertyId.TIMESCALE, value: properties.timescale });
  }

  if (properties.audioLevel !== undefined) {
    let value = properties.audioLevel.level & 0x7f;
    if (properties.audioLevel.voiceActivity) value |= 0x80;
    headers.push({ id: LOCPropertyId.AUDIO_LEVEL, value: BigInt(value) });
  }

  if (properties.config !== undefined) {
    headers.push({ id: LOCPropertyId.AUDIO_CONFIG, data: properties.config });
  }

  return encodeProperties(headers);
}

/**
 * Audio Properties をデコードする
 *
 * デコード規約は decodeVideoProperties と同じ (寛容な delta デコード)。不正な
 * delta / Length で PROTOCOL_VIOLATION を送出せず、抽出できたフィールドのみを設定する。
 */
export function decodeAudioProperties(data: Uint8Array): AudioProperties {
  const decoded = decodeObjectPropertiesTolerant(data);
  const extracted = extractLocProperties(decoded.properties, "object");
  return {
    timestamp: extracted.timestamp,
    timescale: extracted.timescale,
    audioLevel: extracted.audioLevel,
    config: extracted.audioConfig,
  };
}

/**
 * LOC Property スコープ (draft-ietf-moq-loc-04 Table 1)
 */
type LocPropertiesScope = "track" | "object";

/**
 * LOC Properties の抽出結果
 */
interface ExtractedLocProperties {
  timestamp?: bigint;
  timescale?: bigint;
  frameMarking?: VideoFrameMarking;
  audioLevel?: AudioLevel;
  videoConfig?: Uint8Array;
  audioConfig?: Uint8Array;
}

/**
 * delta 復元済みの Property[] から LOC の値をスコープ別に抽出する。
 *
 * draft-ietf-moq-loc-04 Table 1 で Scope が Track, Object なのは
 * TIMESCALE (0x08) / VIDEO_CONFIG (0x0D) / AUDIO_CONFIG (0x0F) の 3 つ。
 * TIMESTAMP / VIDEO_FRAME_MARKING / AUDIO_LEVEL は Object スコープのみのため、
 * track 入力に Object スコープのみの ID が現れた場合は抽出しない
 * (現行の extractLocTrackProperties の挙動を維持)。
 * TIMESCALE / AUDIO_LEVEL / TIMESTAMP は偶数 ID (value 形式)、
 * VIDEO_CONFIG / AUDIO_CONFIG / VIDEO_FRAME_MARKING は奇数 ID (data 形式)。
 *
 * 抽出不能・不正な Property は読み飛ばし、抽出できたフィールドのみを返す
 * (セッションを閉じない。寛容性は decodeVideoProperties / decodeAudioProperties と同じ)。
 * VIDEO_FRAME_MARKING の Value が不正 (Length 1-4 外) な場合は frameMarking を
 * 未設定として扱う。
 */
function extractLocProperties(
  properties: ReadonlyArray<Property> | undefined,
  scope: LocPropertiesScope,
): ExtractedLocProperties {
  const result: ExtractedLocProperties = {};
  if (!properties) {
    return result;
  }
  for (const property of properties) {
    if (property.id === LOCPropertyId.TIMESCALE && property.value !== undefined) {
      result.timescale = property.value;
    } else if (property.id === LOCPropertyId.VIDEO_CONFIG && property.data !== undefined) {
      result.videoConfig = property.data;
    } else if (property.id === LOCPropertyId.AUDIO_CONFIG && property.data !== undefined) {
      result.audioConfig = property.data;
    } else if (scope === "object" && property.id === LOCPropertyId.TIMESTAMP) {
      if (property.value !== undefined) {
        result.timestamp = property.value;
      }
    } else if (scope === "object" && property.id === LOCPropertyId.VIDEO_FRAME_MARKING) {
      if (property.data !== undefined && property.data.length > 0 && property.data.length <= 4) {
        result.frameMarking = parseVideoFrameMarkingValue(property.data);
      }
    } else if (scope === "object" && property.id === LOCPropertyId.AUDIO_LEVEL) {
      if (property.value !== undefined) {
        result.audioLevel = decodeAudioLevelValue(property.value);
      }
    }
  }
  return result;
}

/**
 * Video の LOC Properties を Track Property と Object Property の両方から解決する。
 *
 * draft-ietf-moq-transport-19 §12.1 の SUBGROUP_DELIVERY_TIMEOUT 先例に倣い、
 * 同一 Property が両方に存在する場合は Object Property を優先する。
 * trackProperties は decodeProperties() で delta 復元済みの Property[]、
 * objectProperties は delta encoding (Figure 2) の Object Properties バイト列。
 * timestamp / frameMarking は Object スコープのみのため Object から取得する。
 * timescale / config は Track, Object 両スコープを持つため、Object が持たなければ
 * Track でフォールバックする。
 *
 * objectProperties のデコードは寛容であり、不正な delta / Length を含む場合は
 * PROTOCOL_VIOLATION を送出せず、抽出できたフィールドのみを設定する。
 */
export function resolveVideoProperties(
  trackProperties: ReadonlyArray<Property> | undefined,
  objectProperties: Uint8Array | undefined,
): VideoProperties {
  const track = extractLocProperties(trackProperties, "track");
  const object =
    objectProperties && objectProperties.length > 0 ? decodeVideoProperties(objectProperties) : {};
  return {
    timestamp: object.timestamp,
    timescale: object.timescale ?? track.timescale,
    frameMarking: object.frameMarking,
    config: object.config ?? track.videoConfig,
  };
}

/**
 * Audio の LOC Properties を Track Property と Object Property の両方から解決する。
 *
 * 優先規則は resolveVideoProperties と同じ（Object 優先、Track はフォールバック）。
 * timestamp / audioLevel は Object スコープのみのため Object から取得する。
 * objectProperties のデコードも resolveVideoProperties と同じく寛容である。
 */
export function resolveAudioProperties(
  trackProperties: ReadonlyArray<Property> | undefined,
  objectProperties: Uint8Array | undefined,
): AudioProperties {
  const track = extractLocProperties(trackProperties, "track");
  const object =
    objectProperties && objectProperties.length > 0 ? decodeAudioProperties(objectProperties) : {};
  return {
    timestamp: object.timestamp,
    timescale: object.timescale ?? track.timescale,
    audioLevel: object.audioLevel,
    config: object.config ?? track.audioConfig,
  };
}

/**
 * 平文の MOQ Object Payload を組み立てる。
 *
 * draft-ietf-moq-loc-04 §2.2 の配置（LOC Private Properties + LOC Payload）に従う。
 * Private が空のときは LOC Payload のみ（ length prefix 無し）を返し、現行ワイヤとビット一致する。
 * 非空のときは暫定ワイヤ `varint(len) + Private Properties + LOC Payload` を返す。
 * 空のカノニカル形は prefix 無しのみであり、`varint(0) + LOC Payload` は出さない。
 *
 * @param privateProperties LOC Private Properties のバイト列（delta encoding (Figure 2) の
 *   Key-Value-Pairs でエンコードされたバイト列）
 * @param locPayload Encoded*Chunk の internal data
 * @returns Object Payload バイト列（入力との参照同一性は保証しない）
 */
export function encodeLocObjectPayload(
  privateProperties: Uint8Array,
  locPayload: Uint8Array,
): Uint8Array {
  // 空 Private: prefix 無しで LOC Payload とビット一致
  if (privateProperties.length === 0) {
    return new Uint8Array(locPayload);
  }

  const lengthBytes = encodeVarint(privateProperties.length);
  const result = new Uint8Array(lengthBytes.length + privateProperties.length + locPayload.length);
  result.set(lengthBytes, 0);
  result.set(privateProperties, lengthBytes.length);
  result.set(locPayload, lengthBytes.length + privateProperties.length);
  return result;
}

/**
 * 平文の MOQ Object Payload を LOC Private Properties と LOC Payload に分割する。
 *
 * `framed: false`（既定）: 全体を LOC Payload とみなし privateProperties は空。
 * `framed: true`: 先頭 varint を Private Properties Length として分割する。
 * length=0 / 空バッファ / 不完全 varint / privateLength 超過 / Number.MAX_SAFE_INTEGER 超は
 * すべて ProtocolViolationError（IncompleteDataError は外向けに漏らさない）。
 *
 * @param objectPayload MOQ Object Payload 全体
 * @param options.framed 非空 Private を載せた暫定ワイヤとして解釈するか
 * @returns privateProperties / locPayload（いずれも入力の独立コピー）
 * @throws ProtocolViolationError framed=true で不正な区切りのとき
 */
export function decodeLocObjectPayload(
  objectPayload: Uint8Array,
  options?: { framed?: boolean },
): { privateProperties: Uint8Array; locPayload: Uint8Array } {
  // 既定は現行ワイヤ（空 Private = 生チャンク）として扱う
  if (options?.framed !== true) {
    return {
      privateProperties: new Uint8Array(0),
      locPayload: new Uint8Array(objectPayload),
    };
  }

  if (objectPayload.length === 0) {
    throw new ProtocolViolationError("framed LOC Object Payload must not be empty");
  }

  let privateLength: bigint;
  let lengthSize: number;
  try {
    [privateLength, lengthSize] = decodeVarint(objectPayload);
  } catch (error) {
    // 完全に揃った Object Payload 上での次チャンク待ちは起きない
    if (error instanceof IncompleteDataError) {
      throw new ProtocolViolationError(
        `incomplete Private Properties Length varint: ${error.message}`,
      );
    }
    throw error;
  }

  // 空 Private のカノニカル形は prefix 無しのみ。framed 経路で length=0 は拒否する
  if (privateLength === 0n) {
    throw new ProtocolViolationError(
      "framed LOC Object Payload must not use Private Properties Length 0",
    );
  }

  if (privateLength > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ProtocolViolationError(
      `Private Properties Length exceeds Number.MAX_SAFE_INTEGER: ${privateLength}`,
    );
  }

  const remainingAfterLength = objectPayload.length - lengthSize;
  // privateLength は bigint のまま残り長と比較する
  if (privateLength > BigInt(remainingAfterLength)) {
    throw new ProtocolViolationError(
      `Private Properties Length exceeds remaining bytes: length=${privateLength}, remaining=${remainingAfterLength}`,
    );
  }

  const privateEnd = lengthSize + Number(privateLength);
  return {
    privateProperties: new Uint8Array(objectPayload.subarray(lengthSize, privateEnd)),
    locPayload: new Uint8Array(objectPayload.subarray(privateEnd)),
  };
}
