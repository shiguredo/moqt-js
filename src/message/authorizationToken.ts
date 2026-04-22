/**
 * MOQT AUTHORIZATION_TOKEN Token 構造
 * draft-ietf-moq-transport-17 Section 9.3.2 AUTHORIZATION TOKEN Parameter
 * https://www.ietf.org/archive/id/draft-ietf-moq-transport-17.html#section-9.3.2
 *
 *   Token {
 *     Alias Type (vi64),
 *     [Token Alias (vi64),]
 *     [Token Type (vi64),]
 *     [Token Value (..)]
 *   }
 *
 * Token Value の終端は AUTHORIZATION_TOKEN パラメータ本体の length-prefix に従う。
 * パラメータ length の範囲内で「残ったバイト全て」が Token Value となる。
 */

import { SessionError, SessionErrorCode } from "../error";
import { decodeVarint, encodeVarint } from "../varint";

/**
 * Token の Alias Type (Section 9.3.2)
 *
 * - DELETE    (0x0): Alias のみ。対象 Alias を retire する
 * - REGISTER  (0x1): Alias + Type + Value。新規登録
 * - USE_ALIAS (0x2): Alias のみ。登録済み Type/Value を参照
 * - USE_VALUE (0x3): Type + Value。Alias を使わず直接指定
 */
export const AuthorizationTokenAliasType = {
  DELETE: 0x0,
  REGISTER: 0x1,
  USE_ALIAS: 0x2,
  USE_VALUE: 0x3,
} as const;

export type AuthorizationTokenAliasType =
  (typeof AuthorizationTokenAliasType)[keyof typeof AuthorizationTokenAliasType];

/**
 * DELETE (0x0): Alias を retire する
 */
export interface AuthorizationTokenDelete {
  kind: "delete";
  alias: bigint;
}

/**
 * REGISTER (0x1): Alias に Token Type / Value を紐付ける
 */
export interface AuthorizationTokenRegister {
  kind: "register";
  alias: bigint;
  tokenType: bigint;
  tokenValue: Uint8Array;
}

/**
 * USE_ALIAS (0x2): 登録済み Alias を参照する
 */
export interface AuthorizationTokenUseAlias {
  kind: "useAlias";
  alias: bigint;
}

/**
 * USE_VALUE (0x3): Alias を使わず Token Type / Value を直接指定する
 */
export interface AuthorizationTokenUseValue {
  kind: "useValue";
  tokenType: bigint;
  tokenValue: Uint8Array;
}

export type AuthorizationToken =
  | AuthorizationTokenDelete
  | AuthorizationTokenRegister
  | AuthorizationTokenUseAlias
  | AuthorizationTokenUseValue;

/**
 * AuthorizationToken を AUTHORIZATION_TOKEN パラメータ Value にエンコードする
 */
export function encodeAuthorizationToken(token: AuthorizationToken): Uint8Array {
  switch (token.kind) {
    case "delete":
      return concat(encodeVarint(AuthorizationTokenAliasType.DELETE), encodeVarint(token.alias));
    case "register":
      return concat(
        encodeVarint(AuthorizationTokenAliasType.REGISTER),
        encodeVarint(token.alias),
        encodeVarint(token.tokenType),
        token.tokenValue,
      );
    case "useAlias":
      return concat(encodeVarint(AuthorizationTokenAliasType.USE_ALIAS), encodeVarint(token.alias));
    case "useValue":
      return concat(
        encodeVarint(AuthorizationTokenAliasType.USE_VALUE),
        encodeVarint(token.tokenType),
        token.tokenValue,
      );
  }
}

/**
 * AUTHORIZATION_TOKEN パラメータ Value を Token 構造にデコードする
 *
 * draft-ietf-moq-transport-17 Section 9.3.2:
 * "If the Token structure cannot be decoded, the receiver MUST close the
 *  Session with KEY_VALUE_FORMATTING_ERROR."
 */
export function decodeAuthorizationToken(data: Uint8Array): AuthorizationToken {
  let offset = 0;
  let aliasTypeRaw: bigint;
  try {
    const [value, consumed] = decodeVarint(data, offset);
    aliasTypeRaw = value;
    offset += consumed;
  } catch {
    throw malformed("failed to decode alias type");
  }

  switch (Number(aliasTypeRaw)) {
    case AuthorizationTokenAliasType.DELETE: {
      const [alias, aliasConsumed] = decodeAliasOrThrow(data, offset);
      offset += aliasConsumed;
      requireEnd(data, offset, "DELETE");
      return { kind: "delete", alias };
    }
    case AuthorizationTokenAliasType.REGISTER: {
      const [alias, aliasConsumed] = decodeAliasOrThrow(data, offset);
      offset += aliasConsumed;
      const [tokenType, typeConsumed] = decodeTokenTypeOrThrow(data, offset);
      offset += typeConsumed;
      const tokenValue = data.subarray(offset);
      return { kind: "register", alias, tokenType, tokenValue: copyBytes(tokenValue) };
    }
    case AuthorizationTokenAliasType.USE_ALIAS: {
      const [alias, aliasConsumed] = decodeAliasOrThrow(data, offset);
      offset += aliasConsumed;
      requireEnd(data, offset, "USE_ALIAS");
      return { kind: "useAlias", alias };
    }
    case AuthorizationTokenAliasType.USE_VALUE: {
      const [tokenType, typeConsumed] = decodeTokenTypeOrThrow(data, offset);
      offset += typeConsumed;
      const tokenValue = data.subarray(offset);
      return { kind: "useValue", tokenType, tokenValue: copyBytes(tokenValue) };
    }
    default:
      throw malformed(`unknown alias type ${aliasTypeRaw}`);
  }
}

function decodeAliasOrThrow(data: Uint8Array, offset: number): [bigint, number] {
  try {
    return decodeVarint(data, offset);
  } catch {
    throw malformed("failed to decode token alias");
  }
}

function decodeTokenTypeOrThrow(data: Uint8Array, offset: number): [bigint, number] {
  try {
    return decodeVarint(data, offset);
  } catch {
    throw malformed("failed to decode token type");
  }
}

function requireEnd(data: Uint8Array, offset: number, label: string): void {
  if (offset !== data.length) {
    throw malformed(`trailing bytes after ${label} alias type`);
  }
}

function malformed(reason: string): SessionError {
  return new SessionError(
    `malformed AUTHORIZATION_TOKEN: ${reason}`,
    SessionErrorCode.KEY_VALUE_FORMATTING_ERROR,
  );
}

function copyBytes(src: Uint8Array): Uint8Array {
  const out = new Uint8Array(src.length);
  out.set(src);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}
