/**
 * テスト専用の共有ヘルパー
 *
 * テストファイルと PBT ファイルの間で重複していた定義をここに集約する。
 * このファイルは vitest の `test.include` (`src/**\/*.{test,prop}.ts`) に
 * 一致しない名前にして、テストを含まないファイルがテストファイルとして
 * 収集されるのを避ける。ライブラリのビルド entry (`src/index.ts`) からも
 * 到達しないため、配布物には含まれない。
 */

import { assert } from "vite-plus/test";
import { decodeVarint } from "../varint";
import type { MoqtObject } from "../dataStream";
import { SessionError, SessionErrorCode } from "../error";
import { ObjectStatus } from "../message/types";
import { MOQTPropertyId, encodeProperties } from "../properties";
import {
  AuthorizationTokenAliasType,
  type AuthorizationToken,
} from "../message/authorizationToken";

/**
 * Uint8Array の配列を 1 つに連結する
 *
 * ライブラリ本体の `src/bytes.ts` に同じ実装があるため、そちらを再公開する
 * (テスト専用の重複実装を残さない)。
 */
export { concatUint8Arrays } from "../bytes";

/**
 * Node.js の process を型付きで取り出す
 *
 * unhandled rejection の検証で使う。ブラウザ環境では undefined になる。
 */
export const nodeProcess = (
  globalThis as unknown as {
    process: {
      on(event: string, listener: (reason: unknown) => void): void;
      off(event: string, listener: (reason: unknown) => void): void;
    };
  }
).process;

/**
 * テスト用の MoqtObject を生成する
 *
 * ペイロードは固定値で、group / object の位置だけをテストから指定する。
 */
export function createObject(groupId: bigint, objectId: bigint): MoqtObject {
  return {
    groupId,
    objectId,
    status: ObjectStatus.NORMAL,
    payload: new Uint8Array([1, 2, 3]),
  };
}

/**
 * ペイロード末尾に malformed な Track Properties を付加する
 *
 * draft-ietf-moq-transport-21 §8.3:
 * `[0x02, 0x80]` は偶数 Type の Value を varint として読めない系列であり、
 * KEY_VALUE_FORMATTING_ERROR を誘発する。
 */
export function appendMalformedTrackProperties(payload: Uint8Array): Uint8Array {
  const malformed = new Uint8Array([0x02, 0x80]);
  const result = new Uint8Array(payload.length + malformed.length);
  result.set(payload, 0);
  result.set(malformed, payload.length);
  return result;
}

/**
 * Object Properties の Key-Value-Pair 列から Type の並びを取り出す
 *
 * delta encoding を戻しながら、偶数 ID は varint value 形式・奇数 ID は
 * length prefixed 形式として読み飛ばす。
 */
export function parseObjectPropertyIds(bytes: Uint8Array): bigint[] {
  const ids: bigint[] = [];
  let offset = 0;
  let previousId = 0n;
  while (offset < bytes.length) {
    const [deltaType, typeLen] = decodeVarint(bytes, offset);
    offset += typeLen;
    const id = previousId + deltaType;
    previousId = id;
    ids.push(id);
    if (id % 2n === 0n) {
      // 偶数 ID: varint value 形式
      const [, valueLen] = decodeVarint(bytes, offset);
      offset += valueLen;
    } else {
      // 奇数 ID: length prefixed 形式
      const [valueLength, lengthLen] = decodeVarint(bytes, offset);
      offset += lengthLen + Number(valueLength);
    }
  }
  return ids;
}

/**
 * JSON を UTF-8 バイト列に変換する
 */
export function encodeJson(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

/**
 * USE_VALUE 形式の AuthorizationToken を生成する
 */
export function useValueToken(tokenValue = "scheme-token"): AuthorizationToken {
  return {
    aliasType: AuthorizationTokenAliasType.USE_VALUE,
    tokenType: 0n,
    tokenValue: new TextEncoder().encode(tokenValue),
  };
}

/**
 * Prior Group ID Gap を持つ Object Properties を組み立てる
 *
 * draft-ietf-moq-transport-21 §10.8:
 * Prior Group ID Gap (Property Type 0x3C) は現在の Group より前の、存在しない
 * Group の数を示す。§10.8 / §10.9 の Track 横断条件のテストで使う。
 */
export function priorGroupIdGapProperties(gap: bigint): Uint8Array {
  return encodeProperties([{ id: MOQTPropertyId.PRIOR_GROUP_ID_GAP, value: gap }]);
}

/**
 * Prior Object ID Gap を持つ Object Properties を組み立てる
 *
 * draft-ietf-moq-transport-21 §10.9:
 * Prior Object ID Gap (Property Type 0x3E) は現在の Object より前の、同じ Group に
 * 存在しない Object の数を示す。
 */
export function priorObjectIdGapProperties(gap: bigint): Uint8Array {
  return encodeProperties([{ id: MOQTPropertyId.PRIOR_OBJECT_ID_GAP, value: gap }]);
}

/**
 * 例外を捕捉して返す (assert.throws では SessionError のコードまで検証できないため)
 */
export function captureThrownError(run: () => void): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

/**
 * KEY_VALUE_FORMATTING_ERROR の SessionError が送出されることを検証する
 *
 * @param run - 例外を送出する処理
 * @param messagePattern - エラーメッセージの期待値 (省略時は検証しない)
 */
export function assertKeyValueFormattingError(run: () => void, messagePattern?: RegExp): void {
  const thrown = captureThrownError(run);
  if (!(thrown instanceof SessionError)) {
    assert.fail(`SessionError を期待したが ${String(thrown)} が送出された`);
  }
  assert.equal(thrown.code, SessionErrorCode.KEY_VALUE_FORMATTING_ERROR);
  if (messagePattern !== undefined) {
    assert.match(thrown.message, messagePattern);
  }
}
