/**
 * Length 宣言境界の共通ガード
 *
 * MOQT のメッセージと Properties は Length 付きフィールドを多用する。
 * 宣言 Length が残りバイト数を超える切り詰めはフレーミング破損であり、
 * 短い slice / subarray を返さず宣言時点で拒否する
 * (切り詰めを黙って通すと、後続フィールドの解釈がずれて誤った値を受け入れる)。
 *
 * draft-ietf-moq-transport-21 §8.3:
 * "If a receiver understands a Type, and the following Value or Length/Value
 *  does not match the serialization defined by that Type, the receiver MUST
 *  close the session with error code KEY_VALUE_FORMATTING_ERROR."
 *
 * 呼び出し側は「Value の先頭位置 (start)」と「対象データの長さ (dataLength)」を
 * 渡す。宣言 Length の数値化と残量の差分計算は本モジュールに集約する。
 */

import { ProtocolViolationError } from "./error";

/**
 * Length 宣言の Value が残りバイト数に収まるかを判定する
 *
 * 収まらない場合の扱いが経路ごとに異なる箇所 (寛容に打ち切る経路や、
 * 既知 Type だけエラーにする経路) は本述語を使い、throw は呼び出し側が行う。
 *
 * @param declared - 宣言された Length
 * @param start - Value の先頭位置
 * @param dataLength - 対象データの長さ
 */
export function isLengthWithinData(declared: bigint, start: number, dataLength: number): boolean {
  return start + Number(declared) <= dataLength;
}

/**
 * Length 宣言の Value が残りバイト数に収まることを検証する
 *
 * 収まらない場合は ProtocolViolationError を throw する。メッセージは
 * `${label} length exceeds remaining data: ${宣言値} > ${残りバイト数}` で統一する。
 *
 * @param label - エラーメッセージに使うフィールド名 (例: "publish track name")
 * @param declared - 宣言された Length
 * @param start - Value の先頭位置
 * @param dataLength - 対象データの長さ
 */
export function assertLengthWithinData(
  label: string,
  declared: bigint,
  start: number,
  dataLength: number,
): void {
  if (!isLengthWithinData(declared, start, dataLength)) {
    throw new ProtocolViolationError(
      `${label} length exceeds remaining data: ${declared} > ${dataLength - start}`,
    );
  }
}
