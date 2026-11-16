/**
 * MSF_COMPRESSION (0x78) の圧縮 / 展開 (draft-ietf-moq-msf-02 §12.1)
 *
 * §12.1: 圧縮のシグナリングは Track Property と Object Property の 2 方式があり、
 * 同じ track で併用してはならない (MUST NOT)。アルゴリズムは 0 = 無圧縮、1 = GZIP で、
 * すべての実装は両方を MUST サポートする。
 *
 * 参照: draft-ietf-moq-msf-02
 */

import { MSFPropertyId, decodeProperties, MOQTPropertyId } from "../properties";
import type { Property } from "../properties";

/** 圧縮アルゴリズム (§12.1 Table 14) */
export type MsfCompression = "none" | "gzip";

/**
 * MSF_COMPRESSION の値 (varint) を取り出す
 *
 * 0x78 は偶数 ID のため、値は property の `value` (varint) として運ばれる。
 * 同じ track に複数ある場合は最初の値を使う。
 */
function compressionValue(properties: ReadonlyArray<Property>): bigint | undefined {
  for (const property of properties) {
    if (property.id === MSFPropertyId.MSF_COMPRESSION) {
      return property.value;
    }
  }
  for (const property of properties) {
    if (property.id === MOQTPropertyId.IMMUTABLE_PROPERTIES && property.data) {
      for (const inner of decodeProperties(property.data)) {
        if (inner.id === MSFPropertyId.MSF_COMPRESSION) {
          return inner.value;
        }
      }
    }
  }
  return undefined;
}

/**
 * property の値から圧縮アルゴリズムを解決する (§12.1 Table 14)
 *
 * 0 は無圧縮、1 は GZIP。未知の値は undefined (未対応) を返す。
 */
function decodeAlgorithm(properties: ReadonlyArray<Property>): MsfCompression | undefined {
  const value = compressionValue(properties);
  if (value === undefined) {
    return "none";
  }
  if (value === 0n) {
    return "none";
  }
  if (value === 1n) {
    return "gzip";
  }
  return undefined;
}

/**
 * Track Properties から圧縮アルゴリズムを解決する (§12.1.1)
 *
 * property が無ければ `"none"` (無圧縮) を返す。未対応の値なら `undefined` を返し、
 * 呼び出し側は payload を処理してはならない (§12.1.1 MUST NOT)。
 */
export function resolveTrackCompression(
  properties: ReadonlyArray<Property>,
): MsfCompression | undefined {
  return decodeAlgorithm(properties);
}

/**
 * Object Properties から圧縮アルゴリズムを解決する (§12.1.2)
 *
 * property が無ければ `"none"` (無圧縮) を返す。
 */
export function resolveObjectCompression(
  properties: ReadonlyArray<Property>,
): MsfCompression | undefined {
  return decodeAlgorithm(properties);
}

/**
 * Track と Object の両方に MSF_COMPRESSION が付いていないことを検証する (§12.1)
 *
 * §12.1: A publisher MUST NOT use both mechanisms on the same track.
 *
 * @throws Error 両方に付いているとき
 */
export function assertCompressionScope(
  trackProperties: ReadonlyArray<Property>,
  objectProperties: ReadonlyArray<Property>,
): void {
  const onTrack = compressionValue(trackProperties);
  const onObject = compressionValue(objectProperties);
  if (onTrack !== undefined && onObject !== undefined) {
    throw new Error(
      "invalid compression signaling: MSF_COMPRESSION must not be present on both Track and Object properties per §12.1",
    );
  }
}

/**
 * GZIP で圧縮する
 *
 * Web 標準の `CompressionStream("gzip")` を使う。
 */
export async function compressGzip(data: Uint8Array): Promise<Uint8Array> {
  const stream = new CompressionStream("gzip");
  const writer = stream.writable.getWriter();
  // BufferSource の型に合わせて ArrayBuffer の view を渡す
  void writer.write(data as Uint8Array<ArrayBuffer>);
  void writer.close();
  return new Uint8Array(await new Response(stream.readable).arrayBuffer());
}

/**
 * GZIP で展開する
 *
 * Web 標準の `DecompressionStream("gzip")` を使う。
 *
 * @throws Error 圧縮データが壊れているとき
 */
export async function decompressGzip(data: Uint8Array): Promise<Uint8Array> {
  const stream = new DecompressionStream("gzip");
  const writer = stream.writable.getWriter();
  void writer.write(data as Uint8Array<ArrayBuffer>);
  void writer.close();
  try {
    return new Uint8Array(await new Response(stream.readable).arrayBuffer());
  } catch (cause) {
    throw new Error("invalid gzip payload: failed to decompress per §12.1", { cause });
  }
}

/**
 * payload を圧縮アルゴリズムに従って展開して返す (§12.1)
 *
 * @param payload - 受信した payload
 * @param compression - 解決済みの圧縮アルゴリズム
 * @returns 展開後の payload。無圧縮ならそのまま
 * @throws Error 未対応のアルゴリズムのとき、または展開に失敗したとき
 */
export async function decompressPayload(
  payload: Uint8Array,
  compression: MsfCompression | undefined,
): Promise<Uint8Array> {
  if (compression === "none") {
    return payload;
  }
  if (compression === undefined) {
    throw new Error(
      "unsupported MSF_COMPRESSION algorithm: must not process the payload per §12.1",
    );
  }
  return decompressGzip(payload);
}

/**
 * 受信した Object の payload を展開して返す (draft-02 §12.1)
 *
 * Track Properties と Object Properties の両方を見て、片方だけに付いていることを
 * 確かめてから展開する。Track に付いていれば全 Object が圧縮されており、Object に
 * 付いていればその Object だけが圧縮されている。
 *
 * @param payload - 受信した payload
 * @param trackProperties - 購読ハンドルが持つ Track Properties
 * @param objectProperties - Object の Properties
 * @returns 展開後の payload
 * @throws Error 両方に付いているとき、未対応のアルゴリズムのとき、展開に失敗したとき
 */
export async function decompressObjectPayload(
  payload: Uint8Array,
  trackProperties: ReadonlyArray<Property>,
  objectProperties: ReadonlyArray<Property>,
): Promise<Uint8Array> {
  assertCompressionScope(trackProperties, objectProperties);
  const onObject = resolveObjectCompression(objectProperties);
  const compression = onObject === "none" ? resolveTrackCompression(trackProperties) : onObject;
  return decompressPayload(payload, compression);
}
