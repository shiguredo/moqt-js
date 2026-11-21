/**
 * MOQT Properties
 * draft-ietf-moq-transport-23 Section 10 (MOQT Properties)
 *
 * Object Properties として定義されている拡張。
 * LOC (draft-ietf-moq-loc) とは別の、MOQT 本体で定義された拡張。
 *
 * draft-ietf-moq-transport-23:
 * Properties は Key-Value-Pair 形式を使用し、delta encoding を適用する。
 */

import { encodeVarint, decodeVarint, MAX_VARINT } from "./varint";
import { isLengthWithinData } from "./length";
import {
  MalformedTrackError,
  ProtocolViolationError,
  IncompleteDataError,
  SessionError,
  SessionErrorCode,
} from "./error";
import { generateGreaseValue, isGreaseValue } from "./grease";

/**
 * MSF_COMPRESSION の Compression Algorithm 値 (draft-ietf-moq-msf-02 §12.1 Table 14 / §14.4)
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
 * draft-02 §12.1.1 / §12.1.2 で Track / Object Property の Type は 0x78 に確定した。
 * 0x78 は draft-ietf-moq-transport-23 §16.8 のアプリケーション固有範囲にあり、
 * IANA への登録は不要である。encode / decode helper は後続の issue で実装する。
 */
export const MsfCompressionAlgorithm = {
  NONE: 0n,
  GZIP: 1n,
} as const;

/**
 * MSF の Track Property Type (draft-ietf-moq-msf-02 §12.1.1 / §12.3.1)
 *
 * | Type | Property                          | Scope          |
 * |------|-----------------------------------|----------------|
 * | 0x78 | MSF_COMPRESSION                   | Track / Object |
 * | 0x7B | MSF_EVENT_TIMELINE_HEADER         | Track          |
 *
 * いずれも draft-ietf-moq-transport-23 §16.8 のアプリケーション固有範囲 (0x78-0x7F) に
 * あり、IANA への登録は不要である。
 */
export const MSFPropertyId = {
  /** MSF_COMPRESSION (Track / Object の両 scope で同じ Type を使う) */
  MSF_COMPRESSION: 0x78n,
  /** MSF_EVENT_TIMELINE_HEADER (Track scope のみ) */
  MSF_EVENT_TIMELINE_HEADER: 0x7bn,
} as const;

/**
 * LOC の Audio Level の Property ID と Value の上限
 *
 * draft-ietf-moq-loc-05 §2.3.3.2:
 * Value 行は "vi64 (1-2 bytes to encode values 0x00-0xFF)" と値域を 0x00-0xFF に
 * 限定する (TIMESTAMP / TIMESCALE の "vi64 (1-9 bytes)" とは異なる)。
 * Description 行の "encoded in the least significant 8 bits of a vi64" は
 * RFC6464 のビット配置 (下位 7 bit が level、bit 7 が voice activity) の説明であり、
 * 8 bit を超える値を受け入れる意味ではない。8 bit を超える値を下位 8 bit に丸めると
 * 誤った level と voice activity になるため、値域外として扱う。
 *
 * Object Properties の検証 (assertKnownPropertyValueInObjectProperties) が値域を
 * 見るため、ID と値域の規則をここに置く。loc.ts の LOCPropertyId と
 * decodeAudioLevelValue はこの定数と関数を参照する。
 */
export const LOC_AUDIO_LEVEL_PROPERTY_ID = 0x0cn;

/** LOC の Audio Level の Value の上限 (Value 行の 0x00-0xFF の上限) */
export const LOC_AUDIO_LEVEL_MAX_VALUE = 0xffn;

/**
 * Audio Level の Value が値域 (0x00-0xFF) を超えないかを判定する
 *
 * Value は vi64 として読んだ非負の bigint を渡す (負値は現れない)。
 */
export function isLocAudioLevelValueInRange(value: bigint): boolean {
  return value <= LOC_AUDIO_LEVEL_MAX_VALUE;
}

/**
 * Audio Level の Value が値域外のときの SessionError を生成する
 *
 * draft-ietf-moq-transport-23 §8.3:
 * "If a receiver understands a Type, and the following Value or Length/Value
 *  does not match the serialization defined by that Type, the receiver MUST
 *  close the session with MALFORMED_KEY_VALUE."
 *
 * メッセージは decodeKnownPropertyVarint と同じ「既知 Type の前置き + 詳細」の形に揃える。
 */
export function locAudioLevelValueRangeError(value: bigint): SessionError {
  return new SessionError(
    `key-value-pair value does not match serialization for known type 0x${LOC_AUDIO_LEVEL_PROPERTY_ID.toString(16)}: audio level 0x${value.toString(16)} > 0x${LOC_AUDIO_LEVEL_MAX_VALUE.toString(16)}`,
    SessionErrorCode.MALFORMED_KEY_VALUE,
  );
}

/**
 * LOC の Video Frame Marking の Property ID
 *
 * draft-ietf-moq-loc-05 §2.3.2.2 (Video Frame Marking):
 * Length は "Varies (1-4 bytes)"、Value は RFC 9626 §3.1 の Long Extension 形式の
 * バイト列である。奇数 ID のため length + bytes で運ぶ。
 * loc.ts の LOCPropertyId.VIDEO_FRAME_MARKING はこの定数を参照する。
 */
export const LOC_VIDEO_FRAME_MARKING_PROPERTY_ID = 0x09n;

/** LOC の Video Frame Marking の Length の下限 (draft-ietf-moq-loc-05 §2.3.2.2) */
export const LOC_VIDEO_FRAME_MARKING_MIN_LENGTH = 1;

/** LOC の Video Frame Marking の Length の上限 (draft-ietf-moq-loc-05 §2.3.2.2) */
export const LOC_VIDEO_FRAME_MARKING_MAX_LENGTH = 4;

/**
 * LOC-05 の CODEC_STRING Property ID
 *
 * draft-ietf-moq-loc-05 Section 2.3.1.3 (Codec String):
 * WebCodecs の codec に対応する UTF-8 文字列を length + bytes で運ぶ。
 * Track / Object の両スコープを持つ (同 draft §6.1 Table 1)。
 * loc.ts の LOCPropertyId.CODEC_STRING はこの定数を参照する。
 *
 * draft-ietf-moq-loc-05 は Work in Progress であり、将来の改訂で ID や
 * Value の形式が変更されうる。
 */
export const LOC_CODEC_STRING_PROPERTY_ID = 0x11n;

/**
 * CODEC_STRING の Value を UTF-8 文字列として解釈するときの TextDecoder 設定
 *
 * fatal: true で不正な UTF-8 を検出し、受信検証と寛容な読み取りで同じ設定を共有する。
 * ignoreBOM: true で先頭の BOM (U+FEFF) をデコード結果に残す。TextDecoder の既定
 * (ignoreBOM: false) は先頭 BOM を除去するため、BOM を含む codec 文字列を送信すると
 * 受信結果から BOM だけが消え、encode / decode の往復が崩れる。CODEC_STRING の Value は
 * UTF-8 バイト列そのものであり、BOM も Value の一部として保持する。
 */
const LOC_CODEC_STRING_TEXT_DECODER_OPTIONS: TextDecoderOptions = {
  fatal: true,
  ignoreBOM: true,
};

/**
 * CODEC_STRING の Value を UTF-8 文字列として読む (寛容版)
 *
 * 不正な UTF-8 は undefined を返す。受信検証層 (assertLocCodecStringValue /
 * assertKnownPropertyValueInObjectProperties / decodeProperties) が
 * MALFORMED_KEY_VALUE で拒否するため、抽出だけを行う経路では寛容に読み飛ばす。
 * 長さ 0 の Value は空文字列として返す (draft-ietf-moq-loc-05 §2.3.1.3 の
 * Length は Varies であり 0 を禁止していない)。
 */
export function decodeLocCodecStringValue(data: Uint8Array): string | undefined {
  try {
    return new TextDecoder("utf-8", LOC_CODEC_STRING_TEXT_DECODER_OPTIONS).decode(data);
  } catch {
    return undefined;
  }
}

/**
 * CODEC_STRING の Value が UTF-8 として妥当かを検証する
 *
 * draft-ietf-moq-transport-23 §8.3:
 * "If a receiver understands a Type, and the following Value or Length/Value
 *  does not match the serialization defined by that Type, the receiver MUST
 *  close the session with error code MALFORMED_KEY_VALUE."
 * CODEC_STRING の serialization は UTF-8 文字列であるため、UTF-8 として
 * 解釈できないバイト列は MALFORMED_KEY_VALUE で拒否する。
 *
 * @throws ProtocolViolationError UTF-8 として不正な場合
 */
function assertLocCodecStringValue(data: Uint8Array): void {
  if (decodeLocCodecStringValue(data) === undefined) {
    throw new ProtocolViolationError(
      `key-value-pair value does not match serialization for known type 0x${LOC_CODEC_STRING_PROPERTY_ID.toString(16)}: codec string is not valid UTF-8`,
      SessionErrorCode.MALFORMED_KEY_VALUE,
    );
  }
}

/**
 * 文字列中の孤立サロゲートの位置を返す (見つからなければ -1)
 *
 * TextEncoder は対になっていないサロゲートを U+FFFD に置換するため、送信値が
 * 入力と変わる。送信前に検出できるよう、UTF-16 のコード単位を走査して
 * 上位サロゲート (U+D800-U+DBFF) の直後が下位サロゲート (U+DC00-U+DFFF) でない場合、
 * または単独の下位サロゲートの場合にその位置を返す。
 */
function findUnpairedSurrogateIndex(value: string): number {
  for (let index = 0; index < value.length; index++) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const nextCodeUnit = value.charCodeAt(index + 1);
      if (!(nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff)) {
        return index;
      }
      // 対になっている上位・下位サロゲートは 2 コード単位で 1 文字なので次へ進める
      index++;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return index;
    }
  }
  return -1;
}

/**
 * 送信する CODEC_STRING が WebCodecs の codec 文字列として送信可能かを検証する
 *
 * 空文字列は WebCodecs の codec 文字列として無効なため送信しない
 * (draft-ietf-moq-loc-05 §2.3.1.3 の Value は UTF-8 文字列であり、
 * WebCodecs の Codec Registry は空文字列を codec として定義しない)。
 * 孤立サロゲートは TextEncoder が U+FFFD に置換し、入力と送信値が変わるため
 * 同じく送信しない。受信側は仕様どおり長さ 0 の Value を受理する
 * (Length は Varies であり 0 を禁止していない) ため、この検証は送信側だけの規則である。
 *
 * 公開オプションの型 (PublishOptions.locCodecString / VideoProperties.codecString など) は
 * string に制限されるが、JavaScript からは任意の値が渡り得る。TextEncoder へ渡す前に
 * 実行時の型もここで検証する。
 *
 * @param codecString - 送信する CODEC_STRING の値
 * @throws Error 文字列でない場合、空文字列の場合、または孤立サロゲートを含む場合
 */
export function assertLocCodecStringForSend(codecString: unknown): void {
  if (typeof codecString !== "string") {
    throw new Error(`LOC CODEC_STRING must be a string: got ${typeof codecString}`);
  }
  if (codecString.length === 0) {
    throw new Error("LOC CODEC_STRING must not be empty");
  }
  const unpairedIndex = findUnpairedSurrogateIndex(codecString);
  if (unpairedIndex !== -1) {
    throw new Error(
      `LOC CODEC_STRING contains an unpaired surrogate at index ${unpairedIndex}: 0x${codecString.charCodeAt(unpairedIndex).toString(16)}`,
    );
  }
}

/**
 * CODEC_STRING の Value を UTF-8 バイト列にエンコードする (送信側)
 *
 * draft-ietf-moq-loc-05 §2.3.1.3 (Codec String):
 * WebCodecs の Codec Registry が定義する codec 文字列を UTF-8 で運ぶ。
 * WebCodecs の codec は ASCII で表現できるが、仕様は UTF-8 と定めるため
 * マルチバイト文字もそのままエンコードする。
 *
 * 空文字列・孤立サロゲート・文字列以外は assertLocCodecStringForSend が
 * 送信前に拒否する (TextEncoder は孤立サロゲートを U+FFFD に置換するため、
 * そのまま通すと入力と送信値が変わる)。Value の 2^16-1 バイト上限は
 * encodeProperties のエンコード時に assertPropertyValueLength が検査する。
 *
 * @throws Error codecString が文字列でない・空文字列・孤立サロゲートを含む場合
 */
export function encodeLocCodecStringValue(codecString: string): Uint8Array {
  assertLocCodecStringForSend(codecString);
  return new TextEncoder().encode(codecString);
}

/**
 * VIDEO_FRAME_MARKING の Length が仕様の 1-4 バイトかを検証する
 *
 * draft-ietf-moq-loc-05 §2.3.2.2 は Length を "Varies (1-4 bytes)" と定める。
 * draft-ietf-moq-transport-23 §8.3:
 * "If a receiver understands a Type, and the following Value or Length/Value
 *  does not match the serialization defined by that Type, the receiver MUST
 *  close the session with MALFORMED_KEY_VALUE."
 *
 * @throws ProtocolViolationError Length が 1-4 の範囲外の場合 (MALFORMED_KEY_VALUE)
 */
function assertLocVideoFrameMarkingLength(data: Uint8Array): void {
  if (
    data.length < LOC_VIDEO_FRAME_MARKING_MIN_LENGTH ||
    data.length > LOC_VIDEO_FRAME_MARKING_MAX_LENGTH
  ) {
    throw new ProtocolViolationError(
      `key-value-pair length does not match serialization for known type 0x${LOC_VIDEO_FRAME_MARKING_PROPERTY_ID.toString(16)}: video frame marking length ${data.length}, expected ${LOC_VIDEO_FRAME_MARKING_MIN_LENGTH}-${LOC_VIDEO_FRAME_MARKING_MAX_LENGTH}`,
      SessionErrorCode.MALFORMED_KEY_VALUE,
    );
  }
}

/**
 * 既知 Type の Value バイト列が Type 固有の serialization に一致するか検証する
 *
 * draft-ietf-moq-transport-23 §8.3 の「既知 Type の Value が定義と一致しない
 * 場合は MALFORMED_KEY_VALUE」を、Value の内容まで見る LOC の length-prefixed Type
 * に対して実装する。
 *
 * - 0x09 (VIDEO_FRAME_MARKING): draft-ietf-moq-loc-05 §2.3.2.2 の Length 1-4
 * - 0x11 (CODEC_STRING): draft-ietf-moq-loc-05 §2.3.1.3 の UTF-8 文字列
 *
 * 外側の KVP 列・Immutable Properties の内側・decodeImmutableProperties が同じ規則を
 * 使えるよう、Type ごとの分岐をここへ集約する。Track / Object の受信文脈は問わない。
 *
 * @throws ProtocolViolationError VIDEO_FRAME_MARKING の Length が 1-4 の範囲外、
 *   または CODEC_STRING が UTF-8 として不正な場合 (MALFORMED_KEY_VALUE)
 */
function assertKnownPropertyDataValue(id: bigint, data: Uint8Array): void {
  if (id === LOC_VIDEO_FRAME_MARKING_PROPERTY_ID) {
    assertLocVideoFrameMarkingLength(data);
    return;
  }
  if (id === LOC_CODEC_STRING_PROPERTY_ID) {
    assertLocCodecStringValue(data);
  }
}

/**
 * 既知 Type の varint Value (偶数 Type) が Type 固有の serialization に一致するか検証する
 *
 * draft-ietf-moq-transport-23 §8.3:
 * "If a receiver understands a Type, and the following Value or Length/Value
 *  does not match the serialization defined by that Type, the receiver MUST
 *  close the session with MALFORMED_KEY_VALUE."
 * 現在は LOC の AUDIO_LEVEL (0x0C) の値域 (draft-ietf-moq-loc-05 §2.3.3.2 の
 * 0x00-0xFF) だけを担う。外側の KVP 列と Immutable Properties の内側で共有する。
 *
 * @throws SessionError AUDIO_LEVEL の Value が 0x00-0xFF の範囲外の場合
 *   (MALFORMED_KEY_VALUE)
 */
function assertKnownPropertyVarintValue(id: bigint, value: bigint): void {
  if (id === LOC_AUDIO_LEVEL_PROPERTY_ID && !isLocAudioLevelValueInRange(value)) {
    throw locAudioLevelValueRangeError(value);
  }
}

/**
 * MOQT Property ID (Section 10)
 *
 * ID が偶数の場合: varint value
 * ID が奇数の場合: length (varint) + bytes
 */
export const MOQTPropertyId = {
  /**
   * Immutable Properties (Section 10.7 Immutable Properties)
   * Relay が変更・削除できない拡張のコンテナ
   */
  IMMUTABLE_PROPERTIES: 0x0bn,
  /**
   * Prior Group ID Gap (Section 10.8 Prior Group ID Gap)
   * 現在の Group より前のスキップされた Group 数
   */
  PRIOR_GROUP_ID_GAP: 0x3cn,
  /**
   * Prior Object ID Gap (Section 10.9 Prior Object ID Gap)
   * 現在の Object より前のスキップされた Object 数
   */
  PRIOR_OBJECT_ID_GAP: 0x3en,
} as const;

/**
 * MOQT Track Property ID
 *
 * draft-ietf-moq-transport-23:
 * Track Properties は end-to-end で送信され、Relay が転送する。
 * draft-ietf-moq-transport-23 Section 10
 *
 * PUBLISH, SUBSCRIBE_OK, TRACK_STATUS_OK, FETCH_OK の Track Properties で使用。
 * draft-ietf-moq-transport-23 §9.3 (REQUEST_OK) は REQUEST_OK のうち
 * TRACK_STATUS_OK と FETCH_OK が Track Properties を載せると定める。
 *
 * ID が偶数の場合: varint value
 * ID が奇数の場合: length (varint) + bytes
 */
export const TrackPropertyId = {
  /**
   * Object Delivery Timeout (Section 10.2 OBJECT_DELIVERY_TIMEOUT)
   * オブジェクトの配信タイムアウト（ミリ秒）
   *
   * draft-ietf-moq-transport-23:
   * Message Parameter から Track Property に移動。
   */
  OBJECT_DELIVERY_TIMEOUT: 0x02n,
  /**
   * Max Cache Duration (Section 10.3 MAX CACHE DURATION)
   * オブジェクトの最大キャッシュ期間（ミリ秒）
   */
  MAX_CACHE_DURATION: 0x04n,
  /**
   * Subgroup Delivery Timeout (Section 10.1 SUBGROUP_DELIVERY_TIMEOUT)
   *
   * draft-ietf-moq-transport-23:
   * SUBGROUP_DELIVERY_TIMEOUT (Property Type 0x06) は varint。
   * Publisher が Subgroup の配信タイムアウト（ミリ秒）として設定する。
   * 0 はタイムアウトなしを意味する。
   * draft-ietf-moq-transport-23 Section 10.1
   */
  SUBGROUP_DELIVERY_TIMEOUT: 0x06n,
  /**
   * Publisher Priority (Section 10.4 DEFAULT PUBLISHER PRIORITY)
   * Publisher が設定する優先度（0-255）
   */
  DEFAULT_PUBLISHER_PRIORITY: 0x0en,
  /**
   * Publisher Group Order Preference (Section 10.5 DEFAULT PUBLISHER GROUP ORDER)
   *
   * draft-ietf-moq-transport-23:
   * GROUP_ORDER パラメータから分割された Publisher 向けの設定。
   * draft-ietf-moq-transport-23 Section 10
   */
  DEFAULT_PUBLISHER_GROUP_ORDER: 0x22n,
  /**
   * Dynamic Groups (Section 10.6 DYNAMIC GROUPS)
   * トラックが動的グループ作成をサポートするかどうか
   */
  DYNAMIC_GROUPS: 0x30n,
} as const;

/**
 * Mandatory Track Property の ID 範囲
 *
 * draft-ietf-moq-transport-23 §3.7 (Mandatory to Understand Track Properties):
 * 0x4000-0x7FFF は Mandatory Track Properties 用に予約され、Track scope でのみ意味を持つ。
 * 受信側が未知の Mandatory Track Property を含む Track を受け取った場合、Track Properties
 * では track を拒否し (REQUEST_ERROR UNSUPPORTED_EXTENSION)、Object Properties では
 * malformed と判定する。
 */
const MANDATORY_TRACK_PROPERTY_ID_MIN = 0x4000n;
const MANDATORY_TRACK_PROPERTY_ID_MAX = 0x7fffn;

/**
 * ID が Mandatory Track Property か (範囲 0x4000-0x7FFF かつ GREASE でない) を判定する
 *
 * draft-ietf-moq-transport-23 §3.7 (Mandatory to Understand Track Properties):
 * この範囲は Track scope 専用であり、受信側が未知なら track を拒否する
 * (Track Properties) か malformed とする (Object Properties)。同節はこの範囲の
 * GREASE 値 (§13) を Mandatory Track Property ではないと定めるため、GREASE は
 * 未知 Property として扱い、既知型の意味論や一意性を適用しない。
 * 判定を 1 箇所に集約し、各 decoder が個別に値域を比較しないようにする。
 */
export function isMandatoryTrackPropertyId(id: bigint): boolean {
  if (isGreaseValue(id)) {
    // draft-ietf-moq-transport-23 §3.7: この範囲の GREASE 値は Mandatory Track
    // Property ではない。未知 Mandatory として track を拒否しない。
    return false;
  }
  return id >= MANDATORY_TRACK_PROPERTY_ID_MIN && id <= MANDATORY_TRACK_PROPERTY_ID_MAX;
}

/**
 * 未知の Mandatory Track Property の Type 一覧を持つ MalformedTrackError を生成する
 *
 * draft-ietf-moq-transport-23 §3.7 (Mandatory to Understand Track Properties):
 * 未知の Mandatory Track Property を含む Track Properties は処理・転送してはならない。
 * §9.4.2.2 (UNSUPPORTED_PROPERTY) は、UNSUPPORTED_EXTENSION で要求を拒否する送信側に
 * 理解できなかった各 Type の Error Detail を載せることを SHOULD とする。そのため
 * Type 一覧を構造情報として保持し、呼び出し側が理由文字列を解析せずに使えるようにする。
 *
 * Type は検出順にそのまま保持する (重複の除去は行わない)。
 *
 * @param propertyTypes - 未知の Mandatory Track Property の Type (検出順)
 */
function unknownMandatoryTrackPropertiesError(
  propertyTypes: readonly bigint[],
): MalformedTrackError {
  const typeList = propertyTypes.map((type) => `0x${type.toString(16)}`).join(", ");
  return new MalformedTrackError(`unknown mandatory track properties: ${typeList}`, [
    ...propertyTypes,
  ]);
}

/**
 * Property Type の値範囲 (Section 16.8)
 *
 * draft-ietf-moq-transport-23 Section 16.8:
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
 * draft-ietf-moq-transport-23 Section 10
 */
/**
 * Track Property の値域を検証する
 *
 * draft-ietf-moq-transport-23 §10 で MUST レベルの値域制約がある Track Property を検証する。
 * 不正値は ProtocolViolationError (MALFORMED_KEY_VALUE) を throw する
 * (§8.3「既知 Type の Value が serialization に一致しない」)。
 *
 * - §10.4 DEFAULT_PUBLISHER_PRIORITY (0x0E): "If an endpoint receives a value
 *   above 255, it MUST close the session with MALFORMED_KEY_VALUE."
 * - §10.5 DEFAULT_PUBLISHER_GROUP_ORDER (0x22): "If an endpoint receives a value
 *   outside this range, it MUST close the session with MALFORMED_KEY_VALUE."
 * - §10.6 DYNAMIC_GROUPS (0x30): "If an endpoint receives a value larger than 1,
 *   it MUST close the session with MALFORMED_KEY_VALUE."
 */
export function validateTrackPropertyValue(id: bigint, value: bigint): void {
  if (id === TrackPropertyId.DEFAULT_PUBLISHER_PRIORITY) {
    if (value < 0n || value > 255n) {
      throw new ProtocolViolationError(
        `invalid publisher priority: ${value}, expected 0-255`,
        SessionErrorCode.MALFORMED_KEY_VALUE,
      );
    }
    return;
  }
  if (id === TrackPropertyId.DEFAULT_PUBLISHER_GROUP_ORDER) {
    if (value !== 1n && value !== 2n) {
      throw new ProtocolViolationError(
        `invalid publisher group order preference: 0x${value.toString(16)}, expected 0x1 or 0x2`,
        SessionErrorCode.MALFORMED_KEY_VALUE,
      );
    }
    return;
  }
  if (id === TrackPropertyId.DYNAMIC_GROUPS) {
    if (value !== 0n && value !== 1n) {
      throw new ProtocolViolationError(
        `invalid dynamic groups: ${value}, expected 0 or 1`,
        SessionErrorCode.MALFORMED_KEY_VALUE,
      );
    }
  }
}

/**
 * 受信者が理解する (既知の) MOQT Property Type の集合
 *
 * draft-ietf-moq-transport-23 §8.3 (Key-Value-Pair Structure):
 * "If a receiver understands a Type, and the following Value or Length/Value
 *  does not match the serialization defined by that Type, the receiver MUST
 *  close the session with MALFORMED_KEY_VALUE."
 * MOQT 本体で定義された Track / Object Property (MOQTPropertyId /
 * TrackPropertyId) に加え、LOC の Property のうち CODEC_STRING (0x11) と
 * VIDEO_FRAME_MARKING (0x09) を既知 Type として扱う。CODEC_STRING は Value を
 * UTF-8 文字列として解釈し、VIDEO_FRAME_MARKING は Length を 1-4 バイトとして解釈する
 * ため、serialization と一致しない場合は §8.3 の MALFORMED_KEY_VALUE で拒否できる。
 * どちらも assertKnownPropertyDataValue が Value / Length の内容を検証する。
 * TIMESCALE (0x08) / VIDEO_CONFIG (0x0D) / AUDIO_CONFIG (0x0F) など他の LOC Property は、
 * この集合では未知 Type として扱う (LOC helper 側の寛容な解釈という既存の扱いを変えない)。
 * AUDIO_LEVEL (0x0C) の値域検証は
 * assertKnownPropertyValueInObjectProperties が別途行う。
 */
const KNOWN_PROPERTY_TYPES: ReadonlySet<bigint> = new Set<bigint>([
  ...Object.values(MOQTPropertyId),
  ...Object.values(TrackPropertyId),
  LOC_VIDEO_FRAME_MARKING_PROPERTY_ID,
  LOC_CODEC_STRING_PROPERTY_ID,
]);

/**
 * Property の scope (Track / Object / 両方)
 *
 * draft-ietf-moq-transport-23 §8.4 (Track and Object Properties):
 * "An endpoint that supports a Property and receives it outside its scope
 *  (e.g. a Track-only Property as an Object Property) MUST treat the Track as
 *  malformed (see Section 12.1)."
 */
export type PropertyScope = "track" | "object" | "both";

/**
 * 既知 Property の scope 一覧
 *
 * draft-ietf-moq-transport-23 §16.8 Table 15 (MOQ Properties) と、
 * draft-ietf-moq-loc-05 §6.1 Table 1 (LOC Properties の暫定登録) に基づく。
 * 0x0B (IMMUTABLE_PROPERTIES) は Track / Object の両 scope を持ち、内側の
 * Property は周囲の scope を継承する (§10.7)。
 *
 * 0x11 (CODEC_STRING) は LOC-05 で Track, Object の両 scope を持つ。
 */
const PROPERTY_SCOPES: ReadonlyMap<bigint, PropertyScope> = new Map<bigint, PropertyScope>([
  // draft-ietf-moq-transport-23 §16.8 Table 15
  [0x02n, "both"], // OBJECT_DELIVERY_TIMEOUT
  [0x04n, "track"], // MAX_CACHE_DURATION
  [0x06n, "both"], // SUBGROUP_DELIVERY_TIMEOUT
  [0x0bn, "both"], // IMMUTABLE_PROPERTIES (内側は周囲の scope を継承)
  [0x0en, "track"], // DEFAULT_PUBLISHER_PRIORITY
  [0x22n, "track"], // DEFAULT_PUBLISHER_GROUP_ORDER
  [0x30n, "track"], // DYNAMIC_GROUPS
  [0x3cn, "object"], // PRIOR_GROUP_ID_GAP
  [0x3en, "object"], // PRIOR_OBJECT_ID_GAP
  // draft-ietf-moq-msf-02 §12.1.1 / §12.1.2 / §12.3.1
  [0x78n, "both"], // MSF_COMPRESSION
  [0x7bn, "track"], // MSF_EVENT_TIMELINE_HEADER
  // draft-ietf-moq-loc-05 §6.1 Table 1
  [0x08n, "both"], // TIMESCALE
  [0x09n, "object"], // VIDEO_FRAME_MARKING
  [0x0cn, "object"], // AUDIO_LEVEL
  [0x0dn, "both"], // VIDEO_CONFIG
  [0x0fn, "both"], // AUDIO_CONFIG
  [0x10n, "object"], // TIMESTAMP
  // CODEC_STRING
  [LOC_CODEC_STRING_PROPERTY_ID, "both"],
]);

/**
 * 本実装が意味論を解釈できる (対応済み) Property Type の集合
 *
 * draft-ietf-moq-transport-23 §8.4:
 * scope 違反を malformed とする MUST は「endpoint that supports a Property」に
 * 適用される。未知 Property は scope を知らないため、この規則だけでは拒否しない。
 *
 * MOQT 本体の Track / Object Property に加え、LOC-05 の Property のうち本実装が
 * 解釈するものを含める。CODEC_STRING (0x11) も WebCodecs の codec 文字列として
 * 解釈するため含める。
 */
const SUPPORTED_PROPERTY_TYPES: ReadonlySet<bigint> = new Set<bigint>([
  ...Object.values(MOQTPropertyId),
  ...Object.values(TrackPropertyId),
  0x08n, // TIMESCALE
  0x09n, // VIDEO_FRAME_MARKING
  0x0cn, // AUDIO_LEVEL
  0x0dn, // VIDEO_CONFIG
  0x0fn, // AUDIO_CONFIG
  0x10n, // TIMESTAMP
  // CODEC_STRING
  LOC_CODEC_STRING_PROPERTY_ID,
  // draft-ietf-moq-msf-02 §12.1 / §12.3.1
  0x78n, // MSF_COMPRESSION
  0x7bn, // MSF_EVENT_TIMELINE_HEADER
]);

/**
 * Property Type の scope を返す (未登録・未知 Type は undefined)
 *
 * draft-ietf-moq-transport-23 §16.8 / draft-ietf-moq-loc-05 §6.1 の登録に基づく。
 */
export function getPropertyScope(id: bigint): PropertyScope | undefined {
  return PROPERTY_SCOPES.get(id);
}

/**
 * 複数インスタンスを明示的に許す対応済み Property Type の集合
 *
 * draft-ietf-moq-transport-23 §8.4 (Track and Object Properties):
 * "Unless those rules permit otherwise: ... A Track or Object MUST NOT
 *  contain more than one instance of the Property."
 * 現在の対応済み型に複数出現を許す定義は無い。将来、定義が複数値を許す型を
 * 追加する場合はこの集合へ加える (scope の PROPERTY_SCOPES と同じ Type で管理する)。
 */
const REPEATABLE_PROPERTY_TYPES: ReadonlySet<bigint> = new Set<bigint>();

/**
 * 個別の規則で重複を検証する Type の集合
 *
 * IMMUTABLE_PROPERTIES (§10.7) と Prior Gap (§10.8 / §10.9) は専用の
 * カウンタ規則 (mutable list と Immutable 内側の合算) が既にあり、エラー文言も
 * 個別テストが固定しているため、汎用の重複検証では除外する。
 */
const DEDICATED_DUPLICATE_RULE_TYPES: ReadonlySet<bigint> = new Set<bigint>([
  MOQTPropertyId.IMMUTABLE_PROPERTIES,
  MOQTPropertyId.PRIOR_GROUP_ID_GAP,
  MOQTPropertyId.PRIOR_OBJECT_ID_GAP,
]);

/**
 * 対応済みで反復不可の Property の重複 Type を探す (見つからなければ undefined)
 *
 * draft-ietf-moq-transport-23 §8.4 / §10.7:
 * 既定では同一 Track / Object に 1 インスタンスだけ許され、mutable list と
 * Immutable Properties 内側は「両方を検索する」対象である。したがって
 * mutable 同士・Immutable 内側同士・mutable と Immutable のまたがりのいずれも
 * 重複として数える。カウンタを再帰呼び出しで共有する。
 * 未知 Type は仕様上複数出現を許容するため数えない (§8.4)。
 *
 * @param properties - delta 復元済みの Property 列
 * @param counts - 再帰呼び出しで持ち回る出現回数
 * @param includeDedicatedRules - 個別規則の Type も数えるなら true (Track 側)
 * @returns 重複した Type
 * @throws ProtocolViolationError Immutable Properties の内側の既知 Type
 *   (CODEC_STRING (0x11) の UTF-8 / VIDEO_FRAME_MARKING (0x09) の Length 1-4) が
 *   serialization と一致しない場合 (MALFORMED_KEY_VALUE)
 */
export function findDuplicateSupportedProperty(
  properties: readonly Property[],
  counts = new Map<bigint, number>(),
  includeDedicatedRules = false,
): bigint | undefined {
  for (const property of properties) {
    if (
      SUPPORTED_PROPERTY_TYPES.has(property.id) &&
      !REPEATABLE_PROPERTY_TYPES.has(property.id) &&
      (includeDedicatedRules || !DEDICATED_DUPLICATE_RULE_TYPES.has(property.id))
    ) {
      const nextCount = (counts.get(property.id) ?? 0) + 1;
      counts.set(property.id, nextCount);
      if (nextCount > 1) {
        return property.id;
      }
    }
    if (property.id === MOQTPropertyId.IMMUTABLE_PROPERTIES && property.data !== undefined) {
      // §10.7: 内側の Property は同じ Track / Object の一部として数える。
      const inner = readImmutablePropertyList(property.data);
      const duplicate = findDuplicateSupportedProperty(inner, counts, includeDedicatedRules);
      if (duplicate !== undefined) {
        return duplicate;
      }
    }
  }
  return undefined;
}

/**
 * 対応済み Property の重複を malformed として拒否する (受信側)
 *
 * draft-ietf-moq-transport-23 §8.4 / §12.1 (Malformed Tracks) 条件 9:
 * "A Track or Object contains more than one instance of a Property that does
 *  not allow multiple instances."
 * Track / Object の通常受信では MalformedTrackError とし、セッションは閉じない。
 *
 * @param properties - delta 復元済みの Property 列
 * @param contextName - エラーメッセージ用の文脈名
 * @param includeDedicatedRules - 個別規則の Type も数えるなら true
 * @throws MalformedTrackError 対応済み Property が重複した場合
 * @throws ProtocolViolationError Immutable Properties の内側の既知 Type
 *   (CODEC_STRING (0x11) の UTF-8 / VIDEO_FRAME_MARKING (0x09) の Length 1-4) が
 *   serialization と一致しない場合 (MALFORMED_KEY_VALUE)
 */
export function assertNoDuplicateSupportedProperties(
  properties: readonly Property[],
  contextName: string,
  includeDedicatedRules = false,
): void {
  const duplicate = findDuplicateSupportedProperty(
    properties,
    new Map<bigint, number>(),
    includeDedicatedRules,
  );
  if (duplicate !== undefined) {
    throw new MalformedTrackError(
      `duplicate supported property in ${contextName}: type 0x${duplicate.toString(16)}`,
    );
  }
}

/**
 * 送信する Property 列が対応済み型の不正な重複を含まないことを検証する
 *
 * draft-ietf-moq-transport-23 §8.4:
 * 定義が複数インスタンスを許さない Property を重複させた Track / Object を
 * 送信すると、ピアは Track を malformed とする。送信前にローカル API 誤用として
 * 拒否する。未知 Type の反復は仕様上許容されるため拒否しない。
 *
 * 汎用エンコーダ encodeProperties はテストや relay 実装が不正ワイヤを構築できるよう
 * 検証しない。公開送信 API (buildPublishTrackProperties) が本関数を呼ぶ。
 *
 * @param headers - 送信する Property 列
 * @throws Error 対応済み Property が重複した場合
 */
export function assertNoDuplicatePropertiesForSend(headers: readonly Property[]): void {
  const duplicate = findDuplicateSupportedProperty(headers, new Map<bigint, number>(), true);
  if (duplicate !== undefined) {
    throw new Error(`duplicate property type 0x${duplicate.toString(16)}`);
  }
}

/**
 * Property scope が受信文脈 (Track / Object) で許されるかを判定する
 *
 * "both" の Property は両方の文脈で許される。未知の Property は scope を
 * 持たないため、この判定の対象外である。
 */
export function isPropertyScopeAllowed(
  propertyScope: PropertyScope,
  receivedAs: "track" | "object",
): boolean {
  return propertyScope === "both" || propertyScope === receivedAs;
}

/**
 * 対応済み Property が受信文脈の scope に収まっていることを検証する
 *
 * draft-ietf-moq-transport-23 §8.4 / §12.1 (Malformed Tracks) 条件 8:
 * "A supported Property is received outside its scope, such as a Track-only
 *  Property received as an Object Property."
 * 違反は Track を malformed とする (MalformedTrackError)。セッションは閉じない。
 *
 * 未知 Property は scope を知らないため拒否しない (§8.4)。IMMUTABLE_PROPERTIES
 * (0x0B) の内側は周囲の scope を継承するため、内側も同じ scope で検証する。
 *
 * @param properties - delta 復元済みの Property 列
 * @param receivedAs - 受信文脈 ("track" | "object")
 * @throws MalformedTrackError 対応済み Property が scope 外の場合
 * @throws ProtocolViolationError Immutable Properties の内側の既知 Type
 *   (CODEC_STRING (0x11) の UTF-8 / VIDEO_FRAME_MARKING (0x09) の Length 1-4) が
 *   serialization と一致しない場合 (MALFORMED_KEY_VALUE)
 */
export function assertPropertyScopes(
  properties: readonly Property[],
  receivedAs: "track" | "object",
): void {
  for (const property of properties) {
    const propertyScope = PROPERTY_SCOPES.get(property.id);
    if (
      propertyScope !== undefined &&
      !isPropertyScopeAllowed(propertyScope, receivedAs) &&
      SUPPORTED_PROPERTY_TYPES.has(property.id)
    ) {
      throw new MalformedTrackError(
        `supported ${propertyScope}-scoped property received as ${receivedAs} property: type 0x${property.id.toString(16)}`,
      );
    }
    if (property.id === MOQTPropertyId.IMMUTABLE_PROPERTIES && property.data !== undefined) {
      // draft-ietf-moq-transport-23 §10.7: 内側の Property は周囲の scope を継承する。
      const inner = readImmutablePropertyList(property.data);
      assertPropertyScopes(inner, receivedAs);
    }
  }
}

/**
 * Length に書ける値の最大値 (2^16-1)
 *
 * draft-ietf-moq-transport-23 §8.3 (Key-Value-Pair Structure):
 * "The maximum length of a value is 2^16-1 bytes. If an endpoint receives a
 *  length larger than the maximum, it MUST close the session with
 *  FIELD_LENGTH_EXCEEDED."
 */
const MAX_PROPERTY_VALUE_LENGTH = 65535n;

/**
 * 奇数 Type の Length が最大値 (2^16-1) を超えるか判定する
 *
 * draft-ietf-moq-transport-23 §8.3 (Key-Value-Pair Structure):
 * "The maximum length of a value is 2^16-1 bytes. If an endpoint receives a
 *  length larger than the maximum, it MUST close the session with
 *  FIELD_LENGTH_EXCEEDED."
 *
 * Type の既知 / 未知を問わない (MUST は Type に依存しない)。厳密デコーダ
 * (decodeProperties / parseProperties / decodeImmutableProperties) と
 * Object Properties の検証 (assertKnownPropertyValueInObjectProperties) の
 * 双方から呼び、上限判定を 1 箇所に固定する。
 *
 * @param length - 宣言された Length
 */
function isPropertyLengthOverLimit(length: bigint): boolean {
  return length > MAX_PROPERTY_VALUE_LENGTH;
}

/**
 * 送信する Property の Value 長を検査する
 *
 * draft-ietf-moq-transport-23 §8.3:
 * Key-Value-Pair の Value の最大長は 2^16-1 バイトである。超過する値を送ると
 * ピアが FIELD_LENGTH_EXCEEDED でセッションを閉じるため、送信前に拒否する。
 *
 * @param dataLength - Value のバイト長
 * @throws Error - 最大長を超える場合
 */
export function assertPropertyValueLength(dataLength: number): void {
  if (dataLength > Number(MAX_PROPERTY_VALUE_LENGTH)) {
    throw new Error(
      `property value length ${dataLength} exceeds maximum ${MAX_PROPERTY_VALUE_LENGTH}`,
    );
  }
}

/**
 * 既知 Type の Length 宣言超過が serialization 不一致に当たるか判定する
 *
 * draft-ietf-moq-transport-23 §8.3:
 * Length が最大値 (2^16-1) を超える場合は最大値超過の MUST を優先するため、
 * 上限内の既知 Type だけを MALFORMED_KEY_VALUE の対象とする
 * (上限超過そのものは isPropertyLengthOverLimit が FIELD_LENGTH_EXCEEDED とする)。
 * IMMUTABLE_PROPERTIES の内側にも 0x11 (CODEC_STRING) などの既知 odd Type が
 * 現れるため、内側の残量検査でも同じ判定を使う。
 *
 * @param id - Property Type
 * @param length - 宣言された Length
 */
function isKnownPropertyWithinLengthLimit(id: bigint, length: bigint): boolean {
  return KNOWN_PROPERTY_TYPES.has(id) && !isPropertyLengthOverLimit(length);
}

/**
 * 既知 Type の Length 宣言超過に対応する SessionError を生成する
 *
 * draft-ietf-moq-transport-23 §8.3:
 * "If a receiver understands a Type, and the following Value or Length/Value
 *  does not match the serialization defined by that Type, the receiver MUST
 *  close the session with MALFORMED_KEY_VALUE."
 *
 * メッセージは decodeKnownPropertyVarint と同じ「既知 Type の前置き + 詳細」の
 * 形に揃える (対象の説明は Type が示すため重ねない)。
 *
 * @param id - Property Type
 * @param length - 宣言された Length
 * @param remaining - Length の varint を読んだ直後の残りバイト数
 */
function knownPropertyLengthOverrunError(
  id: bigint,
  length: bigint,
  remaining: number,
): SessionError {
  return new SessionError(
    `key-value-pair value does not match serialization for known type 0x${id.toString(16)}: length exceeds remaining data: ${length} > ${remaining}`,
    SessionErrorCode.MALFORMED_KEY_VALUE,
  );
}

/**
 * 既知 Type の Value (偶数 Type) / Length (奇数 Type) を varint としてデコードする
 *
 * draft-ietf-moq-transport-23 §8.3:
 * 既知 Type の Value / Length が仕様の serialization に一致しない場合
 * (varint がバッファ内で完結しない場合) は MALFORMED_KEY_VALUE で
 * セッションを閉じる。未知 Type は受信者が理解しないため、通常の
 * IncompleteDataError (フレーミング破損) 経路に委ねる。
 */
function decodeKnownPropertyVarint(id: bigint, data: Uint8Array, offset: number): [bigint, number] {
  try {
    return decodeVarint(data, offset);
  } catch (error) {
    if (error instanceof IncompleteDataError && KNOWN_PROPERTY_TYPES.has(id)) {
      throw new SessionError(
        `key-value-pair value does not match serialization for known type 0x${id.toString(16)}: ${error.message}`,
        SessionErrorCode.MALFORMED_KEY_VALUE,
      );
    }
    throw error;
  }
}

/**
 * Length 宣言超過のエラーを送出する
 *
 * draft-ietf-moq-transport-23 §8.3 (Key-Value-Pair Structure):
 * "The maximum length of a value is 2^16-1 bytes. If an endpoint receives a
 *  length larger than the maximum, it MUST close the session with
 *  FIELD_LENGTH_EXCEEDED."
 * "If a receiver understands a Type, and the following Value or Length/Value
 *  does not match the serialization defined by that Type, the receiver MUST
 *  close the session with MALFORMED_KEY_VALUE."
 *
 * Length の varint は完結したが宣言値が残りバイトを超えて Value を読めない場合、
 * 既知 Type は serialization 不一致として MALFORMED_KEY_VALUE、未知 Type は
 * 受信者が理解しないため制御本文 / Object の構造破損として MALFORMED_MESSAGE と
 * する (データプレーンの呼び出し元は独自のコードへ読み替える)。
 * Length が最大値を超える場合は最大値超過の MUST を優先し、既知 Type でも
 * FIELD_LENGTH_EXCEEDED とする。
 *
 * @param id - Property Type
 * @param length - 宣言された Length
 * @param remaining - Length の varint を読んだ直後の残りバイト数
 * @param label - 未知 Type のエラーメッセージに含める対象の説明 (呼び出し元の文脈)
 * @throws SessionError MALFORMED_KEY_VALUE 既知 Type かつ Length が最大値以下の場合
 * @throws ProtocolViolationError 未知 Type (MALFORMED_MESSAGE)、または Length が
 *   最大値を超える場合 (FIELD_LENGTH_EXCEEDED)
 */
function throwLengthOverrunError(
  id: bigint,
  length: bigint,
  remaining: number,
  label: string,
): never {
  // draft-ietf-moq-transport-23 §12.2:
  // "When more than one code applies, an endpoint uses DELTA_ENCODING_OVERFLOW
  //  or FIELD_LENGTH_EXCEEDED in preference to the other codes."
  // Length の最大値超過は、既知 Type の serialization 不一致や残量不足より先に
  // 判定する。
  if (length > MAX_PROPERTY_VALUE_LENGTH) {
    throw new ProtocolViolationError(
      `${label} length ${length} exceeds maximum ${MAX_PROPERTY_VALUE_LENGTH}`,
      SessionErrorCode.FIELD_LENGTH_EXCEEDED,
    );
  }
  if (isKnownPropertyWithinLengthLimit(id, length)) {
    throw knownPropertyLengthOverrunError(id, length, remaining);
  }
  throw new ProtocolViolationError(
    `${label} length exceeds remaining data: ${length} > ${remaining}`,
    SessionErrorCode.MALFORMED_MESSAGE,
  );
}

/**
 * Prior Group ID Gap
 *
 * draft-ietf-moq-transport-23 Section 10.8 (Prior Group ID Gap):
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
 * draft-ietf-moq-transport-23 Section 10.9 (Prior Object ID Gap):
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
 * draft-ietf-moq-transport-23 Section 10.7 (Immutable Properties):
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
 * draft-ietf-moq-transport-23 Section 10.8 (Prior Group ID Gap):
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
  const [gap, _gapLen] = decodeKnownPropertyVarint(MOQTPropertyId.PRIOR_GROUP_ID_GAP, data, idLen);
  return { gap };
}

/**
 * Prior Object ID Gap をエンコードする
 *
 * draft-ietf-moq-transport-23 Section 10.9 (Prior Object ID Gap):
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
  const [gap, _gapLen] = decodeKnownPropertyVarint(MOQTPropertyId.PRIOR_OBJECT_ID_GAP, data, idLen);
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
  assertPropertyValueLength(header.data.length);
  const lengthBytes = encodeVarint(BigInt(header.data.length));
  const result = new Uint8Array(idBytes.length + lengthBytes.length + header.data.length);
  result.set(idBytes, 0);
  result.set(lengthBytes, idBytes.length);
  result.set(header.data, idBytes.length + lengthBytes.length);
  return result;
}

// ============================================================================
// GREASE Property
// draft-ietf-moq-transport-23 Section 13 (Grease) / Section 16.8 (MOQ Properties)
// ============================================================================

/**
 * GREASE Property の N の取りうる偶数個数
 *
 * N は [0, 126] の偶数（0, 2, ..., 126）から選ぶ。個数は (126 - 0) / 2 + 1 = 64。
 */
const GREASE_PROPERTY_N_CHOICES = 64;
const EMPTY_OBJECT_PROPERTIES = new Uint8Array(0);

/**
 * GREASE Property を生成する
 *
 * draft-ietf-moq-transport-23 §13 (Grease): GREASE 値は 0x7f * N + 0x9D（N は非負整数）。
 * Properties は §8.4 / §11.1.2 の Key-Value-Pairs（Figure 4）に従い、奇数 ID は
 * Length プレフィックス付きバイト列、偶数 ID は varint 値としてエンコードされる。
 * 任意のバイト列を安全に送信するため、N を偶数に固定して Property ID を奇数にする
 * （0x9D は奇数、0x7f * 偶数は偶数、合計は奇数）。値は空バイト列とする。
 *
 * draft-ietf-moq-transport-23 §3.7 (Mandatory to Understand Track Properties): 0x4000-0x7FFF は
 * Mandatory Track Property 範囲。0x7f * N + 0x9D は N ∈ [128, 256] でこの範囲に落入し、
 * 受信側は未知の Mandatory Track Property として Track Properties では track を拒否
 * （REQUEST_ERROR UNSUPPORTED_EXTENSION）、Object Properties では malformed と判定する。
 * そのため N は [0, 126] の偶数から選ぶ（GREASE 値は 0x9D 〜 0x3F1F、奇数 ID、0x4000 未満）。
 */
export function generateGreaseProperty(): Property {
  return {
    id: generateGreasePropertyType(),
    data: new Uint8Array(0),
  };
}

function generateGreasePropertyType(): bigint {
  const n = 2 * Math.floor(Math.random() * GREASE_PROPERTY_N_CHOICES);
  return generateGreaseValue(n);
}

/**
 * 既存の Object Properties バイト列に GREASE Property を 1 つ追加する
 *
 * draft-ietf-moq-transport-23 §8.3: Type 順に挿入し、直後の既存 KVP の
 * Delta Type だけを差し替える。既存の Value と Length の符号化はそのまま保つ。
 * 末尾が不完全な場合は、Object Property Filter と同じく、そこまでに完全に
 * 読めた KVP を使う。完全な KVP の Type と Length は規定の上限を検証する。
 *
 * @param existing - 既存の Object Properties バイト列（undefined / 空は GREASE のみ返す）
 * @returns GREASE Property を追加した Object Properties バイト列
 */
export function appendGreaseObjectProperty(existing: Uint8Array | undefined): Uint8Array {
  const source = existing ?? EMPTY_OBJECT_PROPERTIES;
  const greaseType = generateGreasePropertyType();
  let previousType = 0n;
  let validEnd = 0;
  let insertAt = 0;
  let typeBeforeInsertion = 0n;
  let following: { type: bigint; valueOffset: number } | undefined;

  while (validEnd < source.length) {
    try {
      const [delta, deltaLength] = decodeVarint(source, validEnd);
      const type = previousType + delta;
      const valueOffset = validEnd + deltaLength;
      const [value, valueLength] = decodeVarint(source, valueOffset);
      let end = valueOffset + valueLength;
      if ((type & 1n) !== 0n) {
        if (!isLengthWithinData(value, end, source.length)) break;
        assertPropertyValueLength(Number(value));
        end += Number(value);
      }
      if (type > MAX_VARINT) {
        throw new Error(`property type ${type} exceeds maximum ${MAX_VARINT}`);
      }
      if (type <= greaseType) {
        insertAt = end;
        typeBeforeInsertion = type;
      } else {
        following ??= { type, valueOffset };
      }
      validEnd = end;
      previousType = type;
    } catch (error) {
      if (error instanceof IncompleteDataError) break;
      throw error;
    }
  }

  const greaseDelta = encodeVarint(greaseType - typeBeforeInsertion);
  // GREASE Value は空。Uint8Array の初期値 0 を Length として使う。
  const afterGrease = insertAt + greaseDelta.length + 1;
  const followingDelta =
    following === undefined ? undefined : encodeVarint(following.type - greaseType);
  const suffixOffset = following?.valueOffset ?? validEnd;
  const result = new Uint8Array(
    afterGrease + (followingDelta?.length ?? 0) + validEnd - suffixOffset,
  );
  if (insertAt > 0) {
    result.set(source.subarray(0, insertAt));
  }
  if (followingDelta !== undefined) {
    result.set(followingDelta, afterGrease);
    result.set(source.subarray(suffixOffset, validEnd), afterGrease + followingDelta.length);
  }
  result.set(greaseDelta, insertAt);
  return result;
}

/**
 * 単一の Property を delta encoding でエンコードする
 *
 * draft-ietf-moq-transport-23:
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
  assertPropertyValueLength(header.data.length);
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
 * draft-ietf-moq-transport-23:
 * delta encoding を使用するため、拡張ヘッダーは ID の昇順でソートしてからエンコードする。
 *
 * 生バイト経路 (Property[] をそのまま渡す経路) では、CODEC_STRING (0x11) の
 * 意味検証 (空文字列・孤立サロゲート) を行わない。空文字列の Value や、孤立サロゲートを
 * TextEncoder が U+FFFD に置換したバイト列もそのまま運ぶ。LOC の意味付きで
 * CODEC_STRING を送る場合は encodeVideoProperties / encodeAudioProperties
 * (または PublishOptions.locCodecString) を使うこと。
 * 奇数 ID の Value 長上限 (2^16-1) は encodePropertyWithDelta が検査する。
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
 * draft-ietf-moq-transport-23 Section 10.7 (Immutable Properties):
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
  // 内側の連結も 1 つの奇数 ID Property の Value になるため、§8.3 の上限を検査する
  assertPropertyValueLength(innerBytes.length);

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
 * draft-ietf-moq-transport-23:
 * delta encoding を使用して内部の拡張をデコードする。
 *
 * draft-ietf-moq-transport-23 §3.7:
 * 未知の Mandatory Track Property を含む Track は malformed であり、1 件目で
 * 打ち切らず構造全体を検証してから Type 一覧を持つ MalformedTrackError を投げる。
 *
 * @param data - ID を含む完全な Immutable Properties データ
 * @throws MalformedTrackError Immutable Properties 内の KVP が不完全な場合、または
 *   未知の Mandatory Track Property を含む場合 (unsupportedPropertyTypes に Type 一覧を載せる)
 * @throws ProtocolViolationError 既知 Type の Value / Length が serialization と
 *   一致しない場合 (MALFORMED_KEY_VALUE。CODEC_STRING (0x11) の UTF-8 と
 *   VIDEO_FRAME_MARKING (0x09) の Length 1-4 を含む)
 */
export function decodeImmutableProperties(data: Uint8Array): ImmutableProperties {
  const [_id, idLen] = decodeVarint(data);
  const [length, lengthLen] = decodeKnownPropertyVarint(
    MOQTPropertyId.IMMUTABLE_PROPERTIES,
    data,
    idLen,
  );
  if (isPropertyLengthOverLimit(length)) {
    throw new ProtocolViolationError(
      `immutable properties value length exceeds maximum: ${length} > 65535`,
      SessionErrorCode.FIELD_LENGTH_EXCEEDED,
    );
  }
  // Length 宣言が残りバイトを超える切り詰めは破損であり、
  // 短い subarray を返さず宣言時点で拒否する (外側でフレーミング済みのため)。
  if (!isLengthWithinData(length, idLen + lengthLen, data.length)) {
    throwLengthOverrunError(
      MOQTPropertyId.IMMUTABLE_PROPERTIES,
      length,
      data.length - (idLen + lengthLen),
      "immutable properties value",
    );
  }
  const innerData = data.subarray(idLen + lengthLen, idLen + lengthLen + Number(length));

  return { extensions: readImmutablePropertyList(innerData) };
}

/** Immutable Properties 内の KVP 列を読み、未知の Mandatory Track Property を拒否する。 */
function readImmutablePropertyList(data: Uint8Array): Property[] {
  const extensions: Property[] = [];
  const mandatoryPropertyTypes: bigint[] = [];
  try {
    decodeImmutablePropertyList(data, mandatoryPropertyTypes, extensions);
  } catch (error) {
    throwWithPropertyLimitPriority(data, error, true);
  }
  if (mandatoryPropertyTypes.length > 0) {
    throw unknownMandatoryTrackPropertiesError(mandatoryPropertyTypes);
  }
  return extensions;
}

/**
 * Immutable Properties 内の KVP を検証し、必要な場合だけデコード結果を保持する。
 *
 * draft-ietf-moq-transport-23 §10.7: 内側の KVP が解析できなければ Track を
 * malformed とする。§8.3 / §12.2 の既知 Type の不整合や上限超過はセッション
 * エラーとして伝える。仕様の節番号と要件は将来の版で変わり得る。
 */
function decodeImmutablePropertyList(
  data: Uint8Array,
  mandatoryPropertyTypes: bigint[],
  extensions?: Property[],
): void {
  let offset = 0;
  let previousId = 0n;
  try {
    while (offset < data.length) {
      const [deltaId, deltaIdLen] = decodeVarint(data, offset);
      const id = previousId + deltaId;
      // §8.3: delta 加算の上限は内側の KVP にも適用する。
      if (id > MAX_VARINT) {
        throw new ProtocolViolationError(
          `delta id addition exceeds maximum: ${id} > ${MAX_VARINT}`,
          SessionErrorCode.DELTA_ENCODING_OVERFLOW,
        );
      }
      previousId = id;
      offset += deltaIdLen;

      // §10.7: Immutable Properties は再帰的に含められない。
      if (id === MOQTPropertyId.IMMUTABLE_PROPERTIES) {
        throw new MalformedTrackError(
          "immutable properties must not recursively contain another immutable properties key",
        );
      }
      if (isMandatoryTrackPropertyId(id)) {
        mandatoryPropertyTypes.push(id);
      }

      const [value, valueLen] = decodeKnownPropertyVarint(id, data, offset);
      offset += valueLen;
      if (id % 2n === 0n) {
        validateTrackPropertyValue(id, value);
        assertKnownPropertyVarintValue(id, value);
        extensions?.push({ id, value });
        continue;
      }

      // 奇数 Type の varint は Length を表す。上限違反を残量不足より先に判定する。
      if (isPropertyLengthOverLimit(value) || !isLengthWithinData(value, offset, data.length)) {
        throwLengthOverrunError(id, value, data.length - offset, "immutable properties value");
      }
      const valueEnd = offset + Number(value);
      const valueData = data.subarray(offset, valueEnd);
      assertKnownPropertyDataValue(id, valueData);
      extensions?.push({ id, data: valueData.slice() });
      offset = valueEnd;
    }
  } catch (error) {
    if (
      error instanceof IncompleteDataError ||
      (error instanceof ProtocolViolationError && error.code === SessionErrorCode.MALFORMED_MESSAGE)
    ) {
      throw new MalformedTrackError("immutable properties contain an incomplete key-value pair");
    }
    throw error;
  }
}

/**
 * Track Properties に DYNAMIC_GROUPS=1 が含まれているかを判定する。
 *
 * draft-ietf-moq-transport-23 §10.7:
 * "When looking for the value of a property, processors MUST search both the
 * mutable properties and the contents of Immutable Properties."
 *
 * mutable list と Immutable Properties (Type 0x0B) 配下の両方を検索する。
 * DYNAMIC_GROUPS の値域は §10.6 により 0 / 1 のみで、受信時に
 * validateTrackPropertyValue が MALFORMED_KEY_VALUE として検証済みのため、複数値や
 * 範囲外は考慮不要。
 *
 * decodeProperties() の出力では Immutable Properties の property.data は
 * body のみ（ID + length は除去済み）のため、内側の KVP は decodeProperties()
 * でパースする。decodeImmutableProperties() は ID + length + body の完全な
 * ワイヤー形式を期待するため、property.data には使用できない。
 *
 * @param properties - Subscriber.trackProperties (decodeProperties の出力)
 * @throws ProtocolViolationError Immutable Properties の内側の既知 Type
 *   (CODEC_STRING (0x11) の UTF-8 / VIDEO_FRAME_MARKING (0x09) の Length 1-4) が
 *   serialization と一致しない場合 (MALFORMED_KEY_VALUE)
 */
export function supportsDynamicGroups(properties: ReadonlyArray<Property>): boolean {
  for (const property of properties) {
    if (property.id === TrackPropertyId.DYNAMIC_GROUPS && property.value === 1n) {
      return true;
    }
    if (property.id === MOQTPropertyId.IMMUTABLE_PROPERTIES && property.data) {
      const innerProperties = decodeProperties(property.data);
      for (const inner of innerProperties) {
        if (inner.id === TrackPropertyId.DYNAMIC_GROUPS && inner.value === 1n) {
          return true;
        }
      }
    }
  }
  return false;
}

/**
 * Track Properties から varint 値を持つ Property を解決する
 *
 * draft-ietf-moq-transport-23 §10.7 (Immutable Properties):
 * "Unless specified by a particular Property specification, Properties MAY appear
 *  either in the mutable property list or inside Immutable Properties. When
 *  looking for the value of a property, processors MUST search both the mutable
 *  properties and the contents of Immutable Properties."
 *
 * mutable property list を優先し、見つからなければ IMMUTABLE_PROPERTIES (0x0B)
 * 配下を検索する。同じ Type が両方に現れた場合は mutable を採る
 * (単一値の Track Property を解決する呼び出し側の規則を 1 か所に集約する)。
 *
 * decodeProperties() の出力では Immutable Properties の property.data は
 * body のみ (ID + length は除去済み) のため、内側の KVP は decodeProperties()
 * でパースする。decodeImmutableProperties() は ID + length + body の完全な
 * ワイヤー形式を期待するため、property.data には使用できない。
 *
 * @param properties - Subscriber.trackProperties (decodeProperties の出力)
 * @param propertyId - 解決する Track Property の Type
 * @returns 見つかった Property。不在・varint 値を持たない場合は undefined
 * @throws ProtocolViolationError Immutable Properties の内側の既知 Type
 *   (CODEC_STRING (0x11) の UTF-8 / VIDEO_FRAME_MARKING (0x09) の Length 1-4) が
 *   serialization と一致しない場合 (MALFORMED_KEY_VALUE)
 */
export function resolveTrackProperty(
  properties: ReadonlyArray<Property>,
  propertyId: bigint,
): Property | undefined {
  for (const property of properties) {
    if (property.id === propertyId && property.value !== undefined) {
      return property;
    }
  }
  // draft-ietf-moq-transport-23 §10.7: Immutable Properties の内容も検索する
  for (const property of properties) {
    if (property.id === MOQTPropertyId.IMMUTABLE_PROPERTIES && property.data) {
      for (const inner of decodeProperties(property.data)) {
        if (inner.id === propertyId && inner.value !== undefined) {
          return inner;
        }
      }
    }
  }
  return undefined;
}

/**
 * Track Properties から length + bytes 形式の Property の値を解決する
 *
 * draft-ietf-moq-transport-23 §8.3: 奇数 Type の Property は Length + Value 形式で運ぶ。
 * `decodeProperties` の出力では、その値を `data` に持つ (varint 値を持つ Property の
 * `value` は undefined)。
 *
 * §10.7 (Immutable Properties): "When looking for the value of a property, processors MUST
 * search both the mutable properties and the contents of Immutable Properties."
 * mutable property list を優先し、見つからなければ IMMUTABLE_PROPERTIES (0x0B) 配下を検索する。
 *
 * @param properties - Subscriber.trackProperties (decodeProperties の出力)
 * @param propertyId - 解決する Track Property の Type
 * @returns 見つかった Property の data。不在の場合は undefined
 */
export function resolveTrackPropertyData(
  properties: ReadonlyArray<Property>,
  propertyId: bigint,
): Uint8Array | undefined {
  for (const property of properties) {
    if (property.id === propertyId && property.data !== undefined) {
      return property.data;
    }
  }
  for (const property of properties) {
    if (property.id === MOQTPropertyId.IMMUTABLE_PROPERTIES && property.data) {
      for (const inner of decodeProperties(property.data)) {
        if (inner.id === propertyId && inner.data !== undefined) {
          return inner.data;
        }
      }
    }
  }
  return undefined;
}

/**
 * Track Properties から DEFAULT_PUBLISHER_PRIORITY (0x0E) を解決する
 *
 * draft-ietf-moq-transport-23 §10.4 (DEFAULT PUBLISHER PRIORITY):
 * "Subgroups and Datagrams for this subscription inherit this priority, unless
 *  they specifically override it." / "If omitted, the Default Publisher Priority
 *  is 128."
 * draft-ietf-moq-transport-23 §10.7 (Immutable Properties):
 * "When looking for the value of a property, processors MUST search both the
 *  mutable properties and the contents of Immutable Properties."
 *
 * mutable list を優先し、無ければ IMMUTABLE_PROPERTIES (0x0B) 配下を検索する
 * (検索規則は resolveTrackProperty に集約)。値域は decodeProperties の
 * validateTrackPropertyValue で検証済みのため、Number 変換は安全である。
 *
 * @param properties - Subscriber.trackProperties (decodeProperties の出力)
 * @returns 解決した Publisher Priority (0-255)。未指定は 128
 */
export function resolveDefaultPublisherPriority(properties: ReadonlyArray<Property>): number {
  const property = resolveTrackProperty(properties, TrackPropertyId.DEFAULT_PUBLISHER_PRIORITY);
  return property?.value === undefined ? 128 : Number(property.value);
}

/**
 * Properties をパースする
 *
 * 複数の Property が含まれるデータから、MOQT Core Properties を抽出する。
 * 未知の拡張はスキップされるが、unknownProperties に保持される。
 *
 * draft-ietf-moq-transport-23:
 * delta encoding を使用して ID をデコードする。
 *
 * draft-ietf-moq-transport-23 §3.7:
 * 未知の Mandatory Track Property を含む Track Properties は malformed であり、
 * 1 件目で打ち切らず構造全体を検証してから Type 一覧を持つ MalformedTrackError を
 * 投げる。構造破損や既知 KVP の不整合は、Type 収集より優先して従来どおり
 * ProtocolViolationError / SessionError として通知する。
 *
 * @param data - Properties データ（複数の Property を含む可能性あり）
 * @throws MalformedTrackError Immutable Properties 内の KVP が不完全な場合、または
 *   未知の Mandatory Track Property を含む場合 (unsupportedPropertyTypes に Type 一覧を載せる)
 */
export function parseProperties(data: Uint8Array): ParsedProperties {
  try {
    return parsePropertyList(data);
  } catch (error) {
    return throwWithPropertyLimitPriority(data, error);
  }
}

function parsePropertyList(data: Uint8Array): ParsedProperties {
  const result: ParsedProperties = {};
  const unknownProperties: Array<{ id: bigint; data: Uint8Array }> = [];
  // 未知の Mandatory Track Property は 1 件目で打ち切らず、
  // 構造全体の検証を終えてから Type 一覧を持つエラーで通知する。
  const mandatoryPropertyTypes: bigint[] = [];
  let offset = 0;
  let previousId = 0n;

  while (offset < data.length) {
    const [deltaId, deltaIdLen] = decodeVarint(data, offset);
    const id = previousId + deltaId;

    // draft-ietf-moq-transport-23 §8.3:
    // "The previous Type value plus the Delta Type MUST NOT be greater than
    //  2^64 - 1. If a Delta Type is received that would be too large, the
    //  Session MUST be closed with DELTA_ENCODING_OVERFLOW."
    if (id > MAX_VARINT) {
      throw new ProtocolViolationError(
        `delta id addition exceeds maximum: ${id} > ${MAX_VARINT}`,
        SessionErrorCode.DELTA_ENCODING_OVERFLOW,
      );
    }

    previousId = id;

    if (id === MOQTPropertyId.PRIOR_GROUP_ID_GAP) {
      // draft-ietf-moq-transport-23 §10.8:
      // "An Object MUST NOT contain more than one instance of this property."
      if (result.priorGroupIdGap !== undefined) {
        throw new MalformedTrackError(
          "Object contains more than one instance of PRIOR_GROUP_ID_GAP",
        );
      }
      const [gap, gapLen] = decodeKnownPropertyVarint(
        MOQTPropertyId.PRIOR_GROUP_ID_GAP,
        data,
        offset + deltaIdLen,
      );
      result.priorGroupIdGap = { gap };
      offset += deltaIdLen + gapLen;
    } else if (id === MOQTPropertyId.PRIOR_OBJECT_ID_GAP) {
      // draft-ietf-moq-transport-23 §10.9: 同上
      if (result.priorObjectIdGap !== undefined) {
        throw new MalformedTrackError(
          "Object contains more than one instance of PRIOR_OBJECT_ID_GAP",
        );
      }
      const [gap, gapLen] = decodeKnownPropertyVarint(
        MOQTPropertyId.PRIOR_OBJECT_ID_GAP,
        data,
        offset + deltaIdLen,
      );
      result.priorObjectIdGap = { gap };
      offset += deltaIdLen + gapLen;
    } else if (id === MOQTPropertyId.IMMUTABLE_PROPERTIES) {
      // draft-ietf-moq-transport-23 §10.7:
      // "An Object MUST NOT contain more than one instance of this property."
      if (result.immutableProperties !== undefined) {
        throw new MalformedTrackError(
          "Object contains more than one instance of IMMUTABLE_PROPERTIES",
        );
      }
      // Immutable Properties は奇数 ID なので length + bytes 形式
      const [length, lengthLen] = decodeKnownPropertyVarint(
        MOQTPropertyId.IMMUTABLE_PROPERTIES,
        data,
        offset + deltaIdLen,
      );
      if (isPropertyLengthOverLimit(length)) {
        throw new ProtocolViolationError(
          `properties value length exceeds maximum: ${length} > 65535`,
          SessionErrorCode.FIELD_LENGTH_EXCEEDED,
        );
      }
      // Length 宣言が残りバイトを超える切り詰めは破損であり、
      // 短い slice を返さず宣言時点で拒否する (外側でフレーミング済みのため)。
      if (!isLengthWithinData(length, offset + deltaIdLen + lengthLen, data.length)) {
        throwLengthOverrunError(
          MOQTPropertyId.IMMUTABLE_PROPERTIES,
          length,
          data.length - (offset + deltaIdLen + lengthLen),
          "immutable properties value",
        );
      }
      const innerData = data.subarray(
        offset + deltaIdLen + lengthLen,
        offset + deltaIdLen + lengthLen + Number(length),
      );

      const extensions: Property[] = [];
      decodeImmutablePropertyList(innerData, mandatoryPropertyTypes, extensions);
      result.immutableProperties = { extensions };
      offset += deltaIdLen + lengthLen + Number(length);
    } else {
      // 未知の拡張
      // draft-ietf-moq-transport-23 §3.7:
      // Mandatory Track Property (0x4000-0x7FFF) かつ未知の場合は
      // トラックを処理してはならない (MUST NOT process or forward)。
      // Type は後段で一覧として通知するため、ここでは記録して値の解析を続ける。
      if (isMandatoryTrackPropertyId(id)) {
        mandatoryPropertyTypes.push(id);
      }

      if (id % 2n === 1n) {
        // 奇数 ID: length + bytes 形式
        const [length, lengthLen] = decodeKnownPropertyVarint(id, data, offset + deltaIdLen);
        // Length 宣言が残りバイトを超える切り詰めは破損であり、
        // 短い slice を返さず宣言時点で拒否する (外側でフレーミング済みのため)。
        if (
          isPropertyLengthOverLimit(length) ||
          !isLengthWithinData(length, offset + deltaIdLen + lengthLen, data.length)
        ) {
          throwLengthOverrunError(
            id,
            length,
            data.length - (offset + deltaIdLen + lengthLen),
            "unknown property value",
          );
        }
        // 注意: unknownProperties にはデコード後の ID と生データを保持
        const extData = data.slice(
          offset + deltaIdLen + lengthLen,
          offset + deltaIdLen + lengthLen + Number(length),
        );
        assertKnownPropertyDataValue(id, extData);
        unknownProperties.push({ id, data: extData });
        offset += deltaIdLen + lengthLen + Number(length);
      } else {
        // 偶数 ID: varint value 形式
        const [value, valueLen] = decodeKnownPropertyVarint(id, data, offset + deltaIdLen);
        validateTrackPropertyValue(id, value);
        assertKnownPropertyVarintValue(id, value);
        const extData = encodeVarint(value);
        unknownProperties.push({ id, data: extData });
        offset += deltaIdLen + valueLen;
      }
    }
  }

  if (unknownProperties.length > 0) {
    result.unknownProperties = unknownProperties;
  }

  // draft-ietf-moq-transport-23 §3.7: 未知の Mandatory Track Property を含む Track は
  // malformed。1 件目で打ち切らず構造全体を検証した後、Type 一覧を構造情報として渡す。
  if (mandatoryPropertyTypes.length > 0) {
    throw unknownMandatoryTrackPropertiesError(mandatoryPropertyTypes);
  }

  return result;
}

/**
 * Properties をデコードする
 *
 * draft-ietf-moq-transport-23:
 * delta encoding を使用して ID をデコードする。
 *
 * draft-ietf-moq-transport-23 §3.7:
 * 未知の Mandatory Track Property を含む Track Properties は malformed であり、
 * 1 件目で打ち切らず構造全体を検証してから Type 一覧を持つ MalformedTrackError を
 * 投げる。構造破損や既知 KVP の不整合は、Type 収集より優先して従来どおり
 * ProtocolViolationError / SessionError として通知する。
 *
 * @param data - Properties データ（複数の Property を含む可能性あり）
 * @returns デコードされた Property の配列
 * @throws MalformedTrackError Immutable Properties 内の KVP が不完全な場合、または
 *   未知の Mandatory Track Property を含む場合 (unsupportedPropertyTypes に Type 一覧を載せる)
 * @throws ProtocolViolationError 既知 Type の Value / Length が serialization と
 *   一致しない場合 (MALFORMED_KEY_VALUE。CODEC_STRING (0x11) の UTF-8 と
 *   VIDEO_FRAME_MARKING (0x09) の Length 1-4 を含む。Immutable Properties の内側も含む)
 */
export function decodeProperties(data: Uint8Array, scope?: "track" | "object"): Property[] {
  try {
    return decodePropertyList(data, scope);
  } catch (error) {
    return throwWithPropertyLimitPriority(data, error);
  }
}

function decodePropertyList(data: Uint8Array, scope?: "track" | "object"): Property[] {
  const extensions: Property[] = [];
  let scopedProperties: Property[] | undefined;
  // 未知の Mandatory Track Property は 1 件目で打ち切らず、
  // 構造全体の検証を終えてから Type 一覧を持つエラーで通知する。
  const mandatoryPropertyTypes: bigint[] = [];
  let offset = 0;
  let previousId = 0n;

  while (offset < data.length) {
    const [deltaId, deltaIdLen] = decodeVarint(data, offset);
    const id = previousId + deltaId;

    // draft-ietf-moq-transport-23 §8.3:
    // "The previous Type value plus the Delta Type MUST NOT be greater than
    //  2^64 - 1. If a Delta Type is received that would be too large, the
    //  Session MUST be closed with DELTA_ENCODING_OVERFLOW."
    if (id > MAX_VARINT) {
      throw new ProtocolViolationError(
        `delta id addition exceeds maximum: ${id} > ${MAX_VARINT}`,
        SessionErrorCode.DELTA_ENCODING_OVERFLOW,
      );
    }

    previousId = id;

    // draft-ietf-moq-transport-23 §3.7:
    // 未知の Mandatory Track Property (0x4000-0x7FFF かつ GREASE でない) を含む Track は
    // 処理・転送してはならない (MUST NOT process or forward)。
    // Type は後段で一覧として通知するため、ここでは記録して値の解析を続ける。
    if (isMandatoryTrackPropertyId(id)) {
      mandatoryPropertyTypes.push(id);
    }

    if (id % 2n === 0n) {
      // 偶数 ID: varint value 形式
      const [value, valueLen] = decodeKnownPropertyVarint(id, data, offset + deltaIdLen);
      validateTrackPropertyValue(id, value);
      assertKnownPropertyVarintValue(id, value);
      const property = { id, value };
      extensions.push(property);
      scopedProperties?.push(property);
      offset += deltaIdLen + valueLen;
    } else {
      // 奇数 ID: length + bytes 形式
      const [length, lengthLen] = decodeKnownPropertyVarint(id, data, offset + deltaIdLen);
      if (isPropertyLengthOverLimit(length)) {
        throw new ProtocolViolationError(
          `properties value length exceeds maximum: ${length} > 65535`,
          SessionErrorCode.FIELD_LENGTH_EXCEEDED,
        );
      }
      // Length 宣言が残りバイトを超える切り詰めは破損であり、
      // 短い slice を返さず宣言時点で拒否する (外側でフレーミング済みのため)。
      if (!isLengthWithinData(length, offset + deltaIdLen + lengthLen, data.length)) {
        throwLengthOverrunError(
          id,
          length,
          data.length - (offset + deltaIdLen + lengthLen),
          "properties value",
        );
      }
      const extData = data.slice(
        offset + deltaIdLen + lengthLen,
        offset + deltaIdLen + lengthLen + Number(length),
      );
      if (id === MOQTPropertyId.IMMUTABLE_PROPERTIES) {
        if (scope !== undefined) {
          // 検証用の列は外側と内側を wire 順に並べる。外側の Immutable 自体も数える。
          scopedProperties ??= extensions.slice();
          scopedProperties.push({ id });
        }
        decodeImmutablePropertyList(extData, mandatoryPropertyTypes, scopedProperties);
      }
      // draft-ietf-moq-loc-05 §2.3.1.3: CODEC_STRING は UTF-8 文字列なので、
      // UTF-8 として解釈できないバイト列は §8.3 の serialization 不一致とする。
      assertKnownPropertyDataValue(id, extData);
      const property = { id, data: extData };
      extensions.push(property);
      if (id !== MOQTPropertyId.IMMUTABLE_PROPERTIES) scopedProperties?.push(property);
      offset += deltaIdLen + lengthLen + Number(length);
    }
  }

  // draft-ietf-moq-transport-23 §3.7: 未知の Mandatory Track Property を含む Track は
  // malformed。1 件目で打ち切らず構造全体を検証した後、Type 一覧を構造情報として渡す。
  if (mandatoryPropertyTypes.length > 0) {
    throw unknownMandatoryTrackPropertiesError(mandatoryPropertyTypes);
  }

  // draft-ietf-moq-transport-23 §8.4 / §12.1:
  // 受信文脈が分かる呼び出し元は、対応済み Property の scope 違反を
  // MalformedTrackError として検出できる (未指定なら従来どおり検証しない)。
  if (scope !== undefined) {
    const propertiesForValidation = scopedProperties ?? extensions;
    assertPropertyScopes(propertiesForValidation, scope);
    // draft-ietf-moq-transport-23 §8.4 / §12.1 条件 9:
    // Track Properties を許容する文脈では、対応済み Property の重複を malformed とする。
    // scope 未指定の呼び出し (空必須 OK / 応答種別判定前) は従来どおり検証しない。
    assertNoDuplicateSupportedProperties(propertiesForValidation, "track properties", true);
  }

  return extensions;
}

/** §12.2: 先行エラーがあっても境界を特定できる KVP の上限違反を優先する。 */
function throwWithPropertyLimitPriority(data: Uint8Array, error: unknown, nested = false): never {
  if (
    error instanceof MalformedTrackError ||
    error instanceof IncompleteDataError ||
    ((error instanceof ProtocolViolationError || error instanceof SessionError) &&
      error.code !== SessionErrorCode.DELTA_ENCODING_OVERFLOW &&
      error.code !== SessionErrorCode.FIELD_LENGTH_EXCEEDED)
  ) {
    new PropertyEncodingLimitReader(nested).check(data);
  }
  throw error;
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

// ============================================================================
// Object Property: Delivery Timeout ヘルパー
// draft-ietf-moq-transport-23 Section 5.2 / 10.1 / 10.2
// ============================================================================

/**
 * Object Properties バイト列を Key-Value-Pairs（Figure 4、delta encoding）で
 * 寛容にデコードする
 *
 * draft-ietf-moq-transport-23 §8.3:
 * Key-Value-Pairs encode a Type value as a delta from the previous Type value,
 * or from 0 if there is no previous Type value.
 *
 * 寛容なデコード: 不完全・不正なデータではそこで停止し、complete=false で
 * 途中まで読めた Property 列を返す。Delta Type オーバーフロー / Length 上限など
 * の §8.3 の MUST 検証は行わない（Track 向け decodeProperties の厳密検証は
 * 流用しない。Object バイト列に適用すると誤って MalformedTrackError になり得る）。
 *
 * OBJECT_PROPERTY_FILTER の評価 (draft-ietf-moq-transport-23 §3.3.2) でも
 * 同じ寛容経路を使用する (Object バイト列には Track 向けの検証を適用しない)。
 *
 * @returns complete=false のとき、properties は途中までデコードできた Property 列
 */
export function decodeObjectPropertiesTolerant(data: Uint8Array): {
  properties: Property[];
  complete: boolean;
} {
  const properties: Property[] = [];
  let offset = 0;
  let previousId = 0n;

  while (offset < data.length) {
    try {
      const [deltaId, deltaIdLen] = decodeVarint(data, offset);
      offset += deltaIdLen;
      const id = previousId + deltaId;
      previousId = id;

      if (id % 2n === 0n) {
        // 偶数 ID: varint value 形式
        const [value, valueLen] = decodeVarint(data, offset);
        offset += valueLen;
        properties.push({ id, value });
      } else {
        // 奇数 ID: length + bytes 形式
        const [length, lengthLen] = decodeVarint(data, offset);
        offset += lengthLen;
        if (!isLengthWithinData(length, offset, data.length)) {
          return { properties, complete: false };
        }
        properties.push({ id, data: data.slice(offset, offset + Number(length)) });
        offset += Number(length);
      }
    } catch {
      // 不完全データはそこで停止し、読めた分のみ返す
      return { properties, complete: false };
    }
  }

  return { properties, complete: true };
}

/**
 * Object Properties の既知 Type の Value / Length を検証する
 *
 * draft-ietf-moq-transport-23 §8.3:
 * "Key-Value-Pair is used in both the data plane and control plane" であり、
 * "If a receiver understands a Type, and the following Value or Length/Value
 *  does not match the serialization defined by that Type, the receiver MUST
 *  close the session with MALFORMED_KEY_VALUE."
 *
 * 検証する内容:
 * - 既知 Type (KNOWN_PROPERTY_TYPES) の Value / Length が varint として完結しない場合
 * - 既知 Type の Length 宣言が上限 (2^16-1) 内で残りバイトを超える場合
 * - LOC の AUDIO_LEVEL (0x0C) の Value が 0x00-0xFF の範囲外の場合
 *   (draft-ietf-moq-loc-05 §2.3.3.2)
 * - LOC の VIDEO_FRAME_MARKING (0x09) の Length が 1-4 の範囲外の場合
 *   (draft-ietf-moq-loc-05 §2.3.2.2)
 * - LOC の CODEC_STRING (0x11) の Value が UTF-8 として不正な場合
 *   (draft-ietf-moq-loc-05 §2.3.1.3)
 *
 * IMMUTABLE_PROPERTIES (0x0B) の内側の KVP 列にも同じ検証を 1 段だけ適用する
 * (draft-ietf-moq-transport-23 §10.7 の「双方を検索する」)。内側の KVP が不完全な
 * 場合は寛容契約どおりそこで打ち切る。入れ子の IMMUTABLE_PROPERTIES は
 * assertObjectPropertyList が malformed とするため、ここでは辿らない。
 *
 * 未知 Type は受信者が理解しないため対象外とし、不完全データでの打ち切りも
 * 寛容契約どおり維持する。
 *
 * §8.3 の MUST のうち Type に依存しない 2 つも本関数で検証する。delta の累積が
 * 2^64-1 を超える場合は DELTA_ENCODING_OVERFLOW、奇数 Type の Length が
 * 2^16-1 を超える場合は FIELD_LENGTH_EXCEEDED でセッションを閉じる (§12.2 の
 * 優先順位により、他のコードより優先する)。いずれも「不完全データ」ではないため
 * 寛容契約の対象外である。上限超過の判定は残量検査より先に行い、残りバイト内に
 * 収まる上限超過も拒否する。
 *
 * @throws ProtocolViolationError delta の累積が 2^64-1 を超える場合
 *   (DELTA_ENCODING_OVERFLOW)、奇数 Type の宣言 Length が 2^16-1 を
 *   超える場合 (FIELD_LENGTH_EXCEEDED)、VIDEO_FRAME_MARKING (0x09) の Length が
 *   1-4 の範囲外の場合、または CODEC_STRING (0x11) の Value が UTF-8 として
 *   不正な場合 (MALFORMED_KEY_VALUE)
 * @throws SessionError MALFORMED_KEY_VALUE 既知 Type の Value / Length が
 *   varint として完結しない場合、上限内の宣言 Length が残りバイトを超える場合、
 *   または LOC の AUDIO_LEVEL (0x0C) の Value が 0x00-0xFF の範囲外の場合
 */
export function assertKnownPropertyValueInObjectProperties(data: Uint8Array | undefined): void {
  if (data === undefined) return;
  try {
    assertPropertyListEncoding(data, false);
  } catch (error) {
    assertObjectPropertyLimitsOnValueError(data, error);
    throw error;
  }
}

/** §12.2: 別の違反を通知する前に、読める KVP の Delta と Length の上限違反を調べる。 */
export function assertObjectPropertyEncodingLimits(data: Uint8Array | undefined): void {
  if (data !== undefined) {
    new PropertyEncodingLimitReader().check(data);
  }
}

function assertObjectPropertyLimitsOnValueError(data: Uint8Array, error: unknown): void {
  if (
    (error instanceof SessionError || error instanceof ProtocolViolationError) &&
    error.code === SessionErrorCode.MALFORMED_KEY_VALUE
  ) {
    assertObjectPropertyEncodingLimits(data);
  }
}

/**
 * Object Properties の KVP 列 1 つ分の構造と、必要に応じて既知 Type の値を検証する。
 *
 * IMMUTABLE_PROPERTIES (0x0B) の内側は周囲の Object Properties と同じ規則で
 * 検証する (§10.7)。内側の KVP が不完全な場合は、外側の寛容契約と同じく
 * そこで打ち切って例外を送出しない。
 *
 * @param data - 検証する KVP 列
 * @param nested - IMMUTABLE_PROPERTIES の内側なら true
 * @param checkValues - 既知 Type の Value と Length/Value の対応も検証するなら true
 */
function assertPropertyListEncoding(data: Uint8Array, nested: boolean): void {
  let offset = 0;
  let previousId = 0n;
  while (offset < data.length) {
    let deltaId: bigint;
    let deltaIdLen: number;
    try {
      [deltaId, deltaIdLen] = decodeVarint(data, offset);
    } catch {
      // 不完全データは寛容契約どおりそこで打ち切る
      return;
    }
    const id = previousId + deltaId;
    // draft-ietf-moq-transport-23 §8.3: "The previous Type value plus the Delta
    // Type MUST NOT be greater than 2^64 - 1. If a Delta Type is received that
    // would be too large, the Session MUST be closed with DELTA_ENCODING_OVERFLOW."
    assertPropertyTypeWithinLimit(id);
    previousId = id;
    offset += deltaIdLen;

    if (id % 2n === 0n) {
      // 偶数 Type: Value (varint)
      let value: bigint;
      let valueLen: number;
      try {
        [value, valueLen] = decodeVarint(data, offset);
        offset += valueLen;
      } catch {
        if (KNOWN_PROPERTY_TYPES.has(id)) {
          throw new SessionError(
            `key-value-pair value does not match serialization for known type 0x${id.toString(16)}`,
            SessionErrorCode.MALFORMED_KEY_VALUE,
          );
        }
        return;
      }
      // draft-ietf-moq-loc-05 §2.3.3.2 の値域外 (0xFF 超) は §8.3 の serialization
      // 不一致として MALFORMED_KEY_VALUE でセッションを閉じる。既知 Type の varint
      // 完結性を見る KNOWN_PROPERTY_TYPES とは別に、値域をここで確認する。
      // この階層と Immutable Properties (0x0B) の内側の両方に適用する。
      assertKnownPropertyVarintValue(id, value);
      continue;
    }

    // 奇数 Type: Length (varint) + Value
    let length: bigint;
    let lengthLen: number;
    try {
      [length, lengthLen] = decodeVarint(data, offset);
    } catch {
      if (KNOWN_PROPERTY_TYPES.has(id)) {
        throw new SessionError(
          `key-value-pair length does not match serialization for known type 0x${id.toString(16)}`,
          SessionErrorCode.MALFORMED_KEY_VALUE,
        );
      }
      return;
    }
    offset += lengthLen;
    // draft-ietf-moq-transport-23 §8.3: "The maximum length of a value is
    // 2^16-1 bytes. If an endpoint receives a length larger than the maximum, it
    // MUST close the session with FIELD_LENGTH_EXCEEDED."
    // 上限超過は Type の既知 / 未知を問わず仕様違反であり、残量検査より先に判定する
    // (残りバイト内に収まる上限超過も拒否する)。
    assertPropertyLengthWithinLimit(length);
    if (!isLengthWithinData(length, offset, data.length)) {
      // draft-ietf-moq-transport-23 §8.3:
      // 既知 Type の Length 宣言が残りバイトを超える場合は serialization 不一致
      // として MALFORMED_KEY_VALUE。未知 Type は寛容契約どおり打ち切る
      // (上限超過は上で FIELD_LENGTH_EXCEEDED として弾いている)。
      if (isKnownPropertyWithinLengthLimit(id, length)) {
        throw knownPropertyLengthOverrunError(id, length, data.length - offset);
      }
      return;
    }
    const valueEnd = offset + Number(length);
    // draft-ietf-moq-loc-05 §2.3.1.3 / §2.3.2.2: 既知 length-prefixed Type の
    // Value / Length が serialization と一致しない場合は §8.3 の
    // MALFORMED_KEY_VALUE とする。
    assertKnownPropertyDataValue(id, data.subarray(offset, valueEnd));
    if (id === MOQTPropertyId.IMMUTABLE_PROPERTIES && !nested) {
      // draft-ietf-moq-transport-23 §10.7: Immutable Properties の内容も
      // Object Properties として扱い、同じ規則で検証する。
      // 入れ子の IMMUTABLE_PROPERTIES は assertObjectPropertyList が malformed と
      // するため、内側 1 段だけを対象にする (深いネストによるスタック枯渇も防ぐ)。
      assertPropertyListEncoding(data.subarray(offset, valueEnd), true);
    }
    offset = valueEnd;
  }
}

function assertPropertyTypeWithinLimit(id: bigint): void {
  if (id > MAX_VARINT) {
    throw new ProtocolViolationError(
      `delta id addition exceeds maximum: ${id} > ${MAX_VARINT}`,
      SessionErrorCode.DELTA_ENCODING_OVERFLOW,
    );
  }
}

function assertPropertyLengthWithinLimit(length: bigint): void {
  if (isPropertyLengthOverLimit(length)) {
    throw new ProtocolViolationError(
      `properties value length exceeds maximum: ${length} > ${MAX_PROPERTY_VALUE_LENGTH}`,
      SessionErrorCode.FIELD_LENGTH_EXCEEDED,
    );
  }
}

/**
 * §8.3 の Type Delta と Length の上限を、伸長する同じ KVP 列の先頭から検査する。
 * Value の終端が判明したら次の KVP の位置を保存する。Immutable Properties だけは
 * その宣言範囲の内側を別の Type 基準で並行して検査する (§10.7)。
 */
export class PropertyEncodingLimitReader {
  private offset = 0;
  private previousId = 0n;
  private inner: { start: number; reader: PropertyEncodingLimitReader } | undefined;

  constructor(private readonly nested = false) {}

  check(data: Uint8Array): void {
    if (this.inner !== undefined) {
      this.inner.reader.check(data.subarray(this.inner.start, this.offset));
      if (data.byteLength < this.offset) return;
      this.inner = undefined;
    }

    while (this.offset < data.byteLength) {
      try {
        const [delta, deltaLength] = decodeVarint(data, this.offset);
        const id = this.previousId + delta;
        assertPropertyTypeWithinLimit(id);
        const [field, fieldLength] = decodeVarint(data, this.offset + deltaLength);
        const valueStart = this.offset + deltaLength + fieldLength;
        if (id % 2n === 0n) {
          this.offset = valueStart;
        } else {
          assertPropertyLengthWithinLimit(field);
          this.offset = valueStart + Number(field);
          if (id === MOQTPropertyId.IMMUTABLE_PROPERTIES && !this.nested) {
            const reader = new PropertyEncodingLimitReader(true);
            reader.check(data.subarray(valueStart, this.offset));
            if (this.offset > data.byteLength) this.inner = { start: valueStart, reader };
          }
        }
        this.previousId = id;
      } catch (error) {
        // Delta または Value/Length の varint が未完成なら、次回はこの KVP から再開する。
        if (error instanceof IncompleteDataError) return;
        throw error;
      }
    }
  }
}

/**
 * Object Properties を検証する
 *
 * draft-ietf-moq-transport-23 §3.7:
 * "An Object received with a Mandatory Track Property as an Object Property is
 *  malformed (see Section 12.1)."
 * draft-ietf-moq-transport-23 §10.7 (Immutable Properties):
 * "An Object MUST NOT contain more than one instance of this property."
 * "An Object contains an Immutable Properties property that contains another
 *  Immutable Properties key." → malformed
 * draft-ietf-moq-transport-23 §10.8 (Prior Group ID Gap) / §10.9 (Prior Object ID Gap):
 * "An Object MUST NOT contain more than one instance of this property."
 * "An Object contains more than one instance of Prior Group ID Gap." /
 * "An Object contains more than one instance of Prior Object ID Gap." → malformed
 *
 * decodeObjectPropertiesTolerant でデコードできた Property の ID を確認する。
 * 不完全・不正な delta / Length では検出を打ち切り、ProtocolViolationError は送出しない
 * (寛容契約を維持する)。
 *
 * @throws MalformedTrackError 以下のいずれかを検出した場合
 *   - 0x4000-0x7FFF の Mandatory Track Property
 *   - IMMUTABLE_PROPERTIES の複数出現
 *   - IMMUTABLE_PROPERTIES の再帰ネスト
 *   - PRIOR_GROUP_ID_GAP の複数出現 (mutable list と IMMUTABLE_PROPERTIES 配下の合算)
 *   - PRIOR_OBJECT_ID_GAP の複数出現 (mutable list と IMMUTABLE_PROPERTIES 配下の合算)
 */
export function assertNoMandatoryTrackPropertyInObjectProperties(data: Uint8Array): void {
  assertObjectPropertyList(decodeObjectPropertiesTolerant(data).properties, false, false);
}

/** 受信した Property 列を検証し、受信履歴と Subgroup の配送タイムアウトに使う値を返す。 */
export function assertReceivedObjectProperties(
  data: Uint8Array,
  readDeliveryTimeouts = false,
): ValidatedObjectProperties {
  // Mandatory、scope、重複の検査で、途中まで読めた KVP 列を共有する。
  const { properties } = decodeObjectPropertiesTolerant(data);
  let validated: ValidatedObjectProperties;
  try {
    validated = assertObjectPropertyList(properties, false, readDeliveryTimeouts);
    assertPropertyScopes(properties, "object");
    assertNoDuplicateSupportedProperties(properties, "object properties");
  } catch (error) {
    if (error instanceof MalformedTrackError) {
      // §8.3: セッションを閉じるべき形式違反は Track 単位の失敗でも確認する。
      assertKnownPropertyValueInObjectProperties(data);
    } else {
      assertObjectPropertyLimitsOnValueError(data, error);
    }
    throw error;
  }
  assertKnownPropertyValueInObjectProperties(data);
  return validated;
}

/**
 * Object Properties の KVP 列を検証する
 *
 * IMMUTABLE_PROPERTIES の再帰ネストは §10.7 で malformed とされるため、
 * 内側は 1 段だけ検査し、内側に現れる IMMUTABLE_PROPERTIES は検出時点で
 * MalformedTrackError とする (深いネストによるスタック枯渇も同時に防ぐ)。
 *
 * §10.8 / §10.9 の Prior Gap の出現回数は mutable list と
 * IMMUTABLE_PROPERTIES 配下を合算して数える (§10.7 の「双方を検索する」) ため、
 * 検証結果を再帰呼び出しで共有する。
 *
 * @param properties - 復号できた KVP 列
 * @param nested - IMMUTABLE_PROPERTIES の内側なら true
 * @param readDeliveryTimeouts - Subgroup で最初に publish された Object なら true
 * @param validated - 再帰呼び出しで持ち回る検証結果
 */
function assertObjectPropertyList(
  properties: readonly Property[],
  nested: boolean,
  readDeliveryTimeouts: boolean,
  validated: ValidatedObjectProperties = {},
): ValidatedObjectProperties {
  for (const property of properties) {
    if (isMandatoryTrackPropertyId(property.id)) {
      throw new MalformedTrackError(
        `mandatory track property as object property: type 0x${property.id.toString(16)}`,
      );
    }
    // draft-ietf-moq-transport-23 §10.8 / §10.9:
    // "An Object MUST NOT contain more than one instance of this property."
    // mutable list と IMMUTABLE_PROPERTIES 配下を合わせて数える。
    if (property.id === MOQTPropertyId.PRIOR_GROUP_ID_GAP && property.value !== undefined) {
      if (validated.priorGroupIdGap !== undefined) {
        throw new MalformedTrackError(
          "Object contains more than one instance of PRIOR_GROUP_ID_GAP",
        );
      }
      validated.priorGroupIdGap = property.value;
      validated.firstGap ??= "group";
    } else if (property.id === MOQTPropertyId.PRIOR_OBJECT_ID_GAP && property.value !== undefined) {
      if (validated.priorObjectIdGap !== undefined) {
        throw new MalformedTrackError(
          "Object contains more than one instance of PRIOR_OBJECT_ID_GAP",
        );
      }
      validated.priorObjectIdGap = property.value;
      validated.firstGap ??= "object";
    } else if (readDeliveryTimeouts && property.value !== undefined) {
      // §5.2 / §10.7: 可変・不変の両方を調べる。同じ Type が両方にあれば後続の重複検査で拒否する。
      if (property.id === TrackPropertyId.OBJECT_DELIVERY_TIMEOUT) {
        validated.objectDeliveryTimeout = property.value;
      } else if (property.id === TrackPropertyId.SUBGROUP_DELIVERY_TIMEOUT) {
        validated.subgroupDeliveryTimeout = property.value;
      }
    }
    if (property.id !== MOQTPropertyId.IMMUTABLE_PROPERTIES) {
      continue;
    }
    // draft-ietf-moq-transport-23 §10.7:
    // IMMUTABLE_PROPERTIES は再帰的に IMMUTABLE_PROPERTIES を含んではならない
    if (nested) {
      throw new MalformedTrackError(
        "immutable properties must not recursively contain another immutable properties key",
      );
    }
    // draft-ietf-moq-transport-23 §10.7:
    // "An Object MUST NOT contain more than one instance of this property."
    if (validated.immutableProperties !== undefined) {
      throw new MalformedTrackError(
        "Object contains more than one instance of IMMUTABLE_PROPERTIES",
      );
    }
    // draft-ietf-moq-transport-23 §10.7:
    // IMMUTABLE_PROPERTIES の内容も Object Property として扱う
    if (property.data !== undefined) {
      validated.immutableProperties = property.data;
      assertObjectPropertyList(
        decodeObjectPropertiesTolerant(property.data).properties,
        true,
        readDeliveryTimeouts,
        validated,
      );
    }
  }
  return validated;
}

export interface ObjectTrackingProperties {
  priorGroupIdGap?: bigint;
  priorObjectIdGap?: bigint;
  immutableProperties?: Uint8Array;
}

export interface DeliveryTimeoutProperties {
  objectDeliveryTimeout?: bigint;
  subgroupDeliveryTimeout?: bigint;
}

export interface ValidatedObjectProperties
  extends ObjectTrackingProperties, DeliveryTimeoutProperties {
  /** 両方の gap が上限を超えた場合、従来の走査順で先に現れた違反を報告する。 */
  firstGap?: "group" | "object";
}

/** §10.8 / §10.9: 復号済みの Prior ID Gap と Object 自身の ID を比較する。 */
export function assertPriorIdGapBounds(
  groupId: bigint,
  objectId: bigint,
  tracking: ValidatedObjectProperties | undefined,
): void {
  if (tracking === undefined) return;
  const { priorGroupIdGap, priorObjectIdGap, firstGap } = tracking;
  const invalidObjectGap = priorObjectIdGap !== undefined && priorObjectIdGap > objectId;
  if (
    priorGroupIdGap !== undefined &&
    priorGroupIdGap > groupId &&
    (!invalidObjectGap || firstGap !== "object")
  ) {
    throw new MalformedTrackError(
      `prior group id gap exceeds group id: gap=${priorGroupIdGap}, group=${groupId}`,
    );
  }
  if (invalidObjectGap) {
    throw new MalformedTrackError(
      `prior object id gap exceeds object id: gap=${priorObjectIdGap}, object=${objectId}`,
    );
  }
}

/**
 * 受信履歴の照合に使う Gap と Immutable Properties を取り出す
 *
 * draft-ietf-moq-transport-23 §10.7 (Immutable Properties):
 * "When looking for the value of a property, processors MUST search both the
 *  mutable properties and the contents of Immutable Properties."
 * mutable list と IMMUTABLE_PROPERTIES 配下の双方を探索する。同一 Object 内の
 * 複数出現は受信時に assertReceivedObjectProperties が malformed とする
 * ため、ここでは最初に見つけた値を保持する。
 *
 * 仕様の節番号と要件は将来の版で変わり得る。
 * 不完全・不正な KVP は decodeObjectPropertiesTolerant の契約どおり読み飛ばす。
 */
export function readObjectTrackingProperties(
  properties: Uint8Array | undefined,
): ObjectTrackingProperties {
  const collected: ObjectTrackingProperties = {};
  if (properties === undefined || properties.length === 0) {
    return collected;
  }
  collectObjectTrackingProperties(
    decodeObjectPropertiesTolerant(properties).properties,
    collected,
    false,
  );
  return collected;
}

/** Property 列と Immutable Properties の 1 階層を調べる。 */
function collectObjectTrackingProperties(
  properties: ReadonlyArray<Property>,
  collected: ObjectTrackingProperties,
  nested: boolean,
): void {
  for (const property of properties) {
    if (property.id === MOQTPropertyId.PRIOR_GROUP_ID_GAP && property.value !== undefined) {
      collected.priorGroupIdGap ??= property.value;
    } else if (property.id === MOQTPropertyId.PRIOR_OBJECT_ID_GAP && property.value !== undefined) {
      collected.priorObjectIdGap ??= property.value;
    } else if (
      !nested &&
      property.id === MOQTPropertyId.IMMUTABLE_PROPERTIES &&
      property.data !== undefined
    ) {
      // draft-ietf-moq-transport-23 §10.7 の「双方を検索する」に従い、
      // IMMUTABLE_PROPERTIES (0x0B) の内側も探索する。内側の 0x0B は
      // 再帰ネストとして先に malformed になるため、深さは 1 段で足りる。
      collected.immutableProperties ??= property.data;
      collectObjectTrackingProperties(
        decodeObjectPropertiesTolerant(property.data).properties,
        collected,
        true,
      );
    }
  }
}

/**
 * Object Properties バイト列から delivery timeout 値を寛容に抽出する
 *
 * draft-ietf-moq-transport-23 Section 5.2:
 * subgroup 先頭オブジェクトの Object Property で Track 値を上書きできる。
 * Track 向け decodeProperties とは異なり、Mandatory Track Property 検証や
 * validateTrackPropertyValue は行わない（Object バイト列に載せると誤るため）。
 *
 * §8.3 の Key-Value-Pairs（delta encoding）でデコードする。delta 形式は Type が
 * 前 Property との差分で連鎖するため、途中で壊れた場合は後続 Property の抽出が
 * 全滅し、抽出済みの先行値のみが保持される（absolute 形式より寛容性が低下する
 * 既知の制約）。
 *
 * draft-ietf-moq-transport-23 §10.7 (Immutable Properties):
 * "Unless specified by a particular Property specification, Properties MAY appear
 *  either in the mutable property list or inside Immutable Properties. When looking
 *  for the value of a property, processors MUST search both the mutable properties
 *  and the contents of Immutable Properties."
 * mutable list を先に走査し、そこで見つからなかった型だけ Immutable Properties
 * (0x0B) の内側を 1 段だけ走査する (§10.7 は 0x0B の内側に 0x0B が現れる Object を
 * malformed とするため、内側の 0x0B は辿らない)。内側も
 * decodeObjectPropertiesTolerant の寛容契約どおり、不完全・不正な KVP ではそこで
 * 打ち切る。
 *
 * @returns 抽出できた値。不明・不完全なら undefined
 */
export function readDeliveryTimeoutObjectProperties(
  properties: Uint8Array | undefined,
): DeliveryTimeoutProperties {
  if (properties === undefined || properties.length === 0) {
    return {};
  }

  let objectDeliveryTimeout: bigint | undefined;
  let subgroupDeliveryTimeout: bigint | undefined;

  // 寛容にデコードし、読めた分の先行値のみを保持する
  const decoded = decodeObjectPropertiesTolerant(properties);
  // mutable list を先に走査する (同じ型が mutable 側にあればそちらの値を使う)
  for (const property of decoded.properties) {
    if (property.id === TrackPropertyId.OBJECT_DELIVERY_TIMEOUT) {
      objectDeliveryTimeout = property.value;
    } else if (property.id === TrackPropertyId.SUBGROUP_DELIVERY_TIMEOUT) {
      subgroupDeliveryTimeout = property.value;
    }
  }

  // mutable list で見つからなかった型だけ Immutable Properties の内側を走査する
  for (const property of decoded.properties) {
    if (property.id !== MOQTPropertyId.IMMUTABLE_PROPERTIES || property.data === undefined) {
      continue;
    }
    for (const inner of decodeObjectPropertiesTolerant(property.data).properties) {
      if (inner.id === TrackPropertyId.OBJECT_DELIVERY_TIMEOUT) {
        objectDeliveryTimeout ??= inner.value;
      } else if (inner.id === TrackPropertyId.SUBGROUP_DELIVERY_TIMEOUT) {
        subgroupDeliveryTimeout ??= inner.value;
      }
    }
  }

  // exactOptionalPropertyTypes では optional なフィールドに undefined を渡せないため、
  // 読み取れた値がある場合だけ載せる
  return {
    ...(objectDeliveryTimeout !== undefined ? { objectDeliveryTimeout } : {}),
    ...(subgroupDeliveryTimeout !== undefined ? { subgroupDeliveryTimeout } : {}),
  };
}

/**
 * 既存の Object Properties バイト列に型付き delivery timeout 値を合成する
 *
 * draft-ietf-moq-transport-23 Section 5.2:
 * 同一 ID が mutable list にある場合、型付き値を優先する。
 * Immutable Properties 内に同じ ID がある場合は重複になるため拒否する (§8.4 / §10.7)。
 *
 * §8.3 の Key-Value-Pairs（delta encoding）に従い、既存バイト列をデコードして
 * Property[] に分解し、上書き ID（0x02 / 0x06）の全出現を除外して型付き値を 1 つ
 * 追加し、ID 昇順で再エンコードする（再構成方式）。delta は前 Property との差分で
 * Type をエンコードするため、既存バイト列のスライスコピーや末尾追記はできない。
 * 既存バイト列が不完全・不正でデコードできない場合は破棄し、型付き値のみで
 * 再構成する（不完全バイト列の保持は delta 連鎖を壊した不正ワイヤを送信し得る）。
 *
 * @param existing - 既存の properties バイト列（undefined 可）
 * @param deliveryTimeout - OBJECT_DELIVERY_TIMEOUT 値（undefined は未指定）
 * @param subgroupDeliveryTimeout - SUBGROUP_DELIVERY_TIMEOUT 値（undefined は未指定）
 * @returns 合成後の properties バイト列。全て undefined なら existing をそのまま返す
 */
export function mergeDeliveryTimeoutObjectProperties(
  existing: Uint8Array | undefined,
  deliveryTimeout: bigint | undefined,
  subgroupDeliveryTimeout: bigint | undefined,
): Uint8Array | undefined {
  if (deliveryTimeout === undefined && subgroupDeliveryTimeout === undefined) {
    return existing;
  }

  // delta encoding のため再構成方式で合成する
  const headers: Property[] = [];
  if (existing !== undefined && existing.length > 0) {
    const decoded = decodeObjectPropertiesTolerant(existing);
    if (decoded.complete) {
      headers.push(...decoded.properties);
    }
  }

  // 型付き値で上書きする ID は既存の全出現を除外する
  const filtered = headers.filter((property) => {
    if (property.id === TrackPropertyId.OBJECT_DELIVERY_TIMEOUT && deliveryTimeout !== undefined) {
      return false;
    }
    if (
      property.id === TrackPropertyId.SUBGROUP_DELIVERY_TIMEOUT &&
      subgroupDeliveryTimeout !== undefined
    ) {
      return false;
    }
    return true;
  });

  // 型付き値を追加
  if (deliveryTimeout !== undefined) {
    filtered.push({ id: TrackPropertyId.OBJECT_DELIVERY_TIMEOUT, value: deliveryTimeout });
  }
  if (subgroupDeliveryTimeout !== undefined) {
    filtered.push({
      id: TrackPropertyId.SUBGROUP_DELIVERY_TIMEOUT,
      value: subgroupDeliveryTimeout,
    });
  }

  assertNoDuplicatePropertiesForSend(filtered);
  return encodeProperties(filtered);
}
