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
import { ObjectStatus } from "../message/types";
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
 * Promise が reject し、その message が正規表現に一致することを検証する
 */
export async function assertRejectsWithMessage(
  factory: () => Promise<unknown>,
  messagePattern: RegExp,
): Promise<void> {
  try {
    await factory();
    assert.fail("expected promise to reject");
  } catch (error) {
    assert.match((error as Error).message, messagePattern);
  }
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
