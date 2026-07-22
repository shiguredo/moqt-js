/**
 * MOQT Authorization Token
 * draft-ietf-moq-transport-18 Section 10.2.2 (AUTHORIZATION TOKEN Parameter)
 * https://datatracker.ietf.org/doc/html/draft-ietf-moq-transport-18#section-10.2.2
 *
 * Token {
 *   Alias Type (vi64),
 *   [Token Alias (vi64),]
 *   [Token Type (vi64),]
 *   [Token Value (..)]
 * }
 */

import { SessionError, SessionErrorCode } from "../error";
import { decodeVarint, encodeVarint } from "../varint";

/**
 * Authorization Token Alias Type
 * draft-ietf-moq-transport-18 Section 10.2.2 (Figure 5 / Section 15.5)
 *
 * - DELETE: There is an Alias but no Type or Value.
 * - REGISTER: There is an Alias, a Type and a Value.
 * - USE_ALIAS: There is an Alias but no Type or Value.
 * - USE_VALUE: There is no Alias and there is a Type and Value.
 */
export const AuthorizationTokenAliasType = {
  DELETE: 0,
  REGISTER: 1,
  USE_ALIAS: 2,
  USE_VALUE: 3,
} as const;

export type AuthorizationTokenAliasType =
  (typeof AuthorizationTokenAliasType)[keyof typeof AuthorizationTokenAliasType];

/**
 * DELETE 形式の Authorization Token
 * Alias だけを持ち Token Type / Value を持たない。
 */
export interface AuthorizationTokenDelete {
  aliasType: typeof AuthorizationTokenAliasType.DELETE;
  tokenAlias: bigint;
}

/**
 * REGISTER 形式の Authorization Token
 * Alias と Token Type、Token Value をすべて持つ。
 */
export interface AuthorizationTokenRegister {
  aliasType: typeof AuthorizationTokenAliasType.REGISTER;
  tokenAlias: bigint;
  tokenType: bigint;
  tokenValue: Uint8Array;
}

/**
 * USE_ALIAS 形式の Authorization Token
 * Alias のみを持ち、登録済みの Token Type / Value を参照する。
 */
export interface AuthorizationTokenUseAlias {
  aliasType: typeof AuthorizationTokenAliasType.USE_ALIAS;
  tokenAlias: bigint;
}

/**
 * USE_VALUE 形式の Authorization Token
 * Alias を持たず、Token Type と Token Value を直接指定する。
 */
export interface AuthorizationTokenUseValue {
  aliasType: typeof AuthorizationTokenAliasType.USE_VALUE;
  tokenType: bigint;
  tokenValue: Uint8Array;
}

/**
 * Authorization Token の discriminated union
 * draft-ietf-moq-transport-18 Section 10.2.2
 */
export type AuthorizationToken =
  | AuthorizationTokenDelete
  | AuthorizationTokenRegister
  | AuthorizationTokenUseAlias
  | AuthorizationTokenUseValue;

/**
 * Authorization Token をエンコードする
 * draft-ietf-moq-transport-18 Section 10.2.2
 */
export function encodeAuthorizationToken(token: AuthorizationToken): Uint8Array {
  const parts: Uint8Array[] = [];

  switch (token.aliasType) {
    case AuthorizationTokenAliasType.DELETE: {
      parts.push(encodeVarint(AuthorizationTokenAliasType.DELETE));
      parts.push(encodeVarint(token.tokenAlias));
      break;
    }
    case AuthorizationTokenAliasType.REGISTER: {
      parts.push(encodeVarint(AuthorizationTokenAliasType.REGISTER));
      parts.push(encodeVarint(token.tokenAlias));
      parts.push(encodeVarint(token.tokenType));
      parts.push(token.tokenValue);
      break;
    }
    case AuthorizationTokenAliasType.USE_ALIAS: {
      parts.push(encodeVarint(AuthorizationTokenAliasType.USE_ALIAS));
      parts.push(encodeVarint(token.tokenAlias));
      break;
    }
    case AuthorizationTokenAliasType.USE_VALUE: {
      parts.push(encodeVarint(AuthorizationTokenAliasType.USE_VALUE));
      parts.push(encodeVarint(token.tokenType));
      parts.push(token.tokenValue);
      break;
    }
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
 * Authorization Token をデコードする
 * draft-ietf-moq-transport-18 Section 10.2.2
 *
 * Token 構造がデコードできない場合は
 * KEY_VALUE_FORMATTING_ERROR の SessionError を throw する。
 */
export function decodeAuthorizationToken(data: Uint8Array): AuthorizationToken {
  try {
    const [aliasTypeRaw, aliasTypeConsumed] = decodeVarint(data, 0);
    const aliasType = Number(aliasTypeRaw);
    let offset = aliasTypeConsumed;

    switch (aliasType) {
      case AuthorizationTokenAliasType.DELETE: {
        const [tokenAlias, consumed] = decodeVarint(data, offset);
        offset += consumed;
        if (offset !== data.length) {
          throw new Error(
            `authorization token DELETE has trailing bytes: expected ${offset}, got ${data.length}`,
          );
        }
        return {
          aliasType: AuthorizationTokenAliasType.DELETE,
          tokenAlias,
        };
      }
      case AuthorizationTokenAliasType.REGISTER: {
        const [tokenAlias, aliasConsumed] = decodeVarint(data, offset);
        offset += aliasConsumed;
        const [tokenType, typeConsumed] = decodeVarint(data, offset);
        offset += typeConsumed;
        const tokenValue = data.slice(offset);
        return {
          aliasType: AuthorizationTokenAliasType.REGISTER,
          tokenAlias,
          tokenType,
          tokenValue,
        };
      }
      case AuthorizationTokenAliasType.USE_ALIAS: {
        const [tokenAlias, consumed] = decodeVarint(data, offset);
        offset += consumed;
        if (offset !== data.length) {
          throw new Error(
            `authorization token USE_ALIAS has trailing bytes: expected ${offset}, got ${data.length}`,
          );
        }
        return {
          aliasType: AuthorizationTokenAliasType.USE_ALIAS,
          tokenAlias,
        };
      }
      case AuthorizationTokenAliasType.USE_VALUE: {
        const [tokenType, consumed] = decodeVarint(data, offset);
        offset += consumed;
        const tokenValue = data.slice(offset);
        return {
          aliasType: AuthorizationTokenAliasType.USE_VALUE,
          tokenType,
          tokenValue,
        };
      }
      default:
        throw new Error(`unknown authorization token alias type: ${aliasType}`);
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new SessionError(
      `failed to decode authorization token: ${reason}`,
      SessionErrorCode.KEY_VALUE_FORMATTING_ERROR,
    );
  }
}

/**
 * SETUP メッセージ用の Authorization Token Alias Type を検証する
 * draft-ietf-moq-transport-18 Section 10.2.2:
 * "If a server receives Alias Type DELETE (0x0) or USE_ALIAS (0x2)
 *  in a SETUP message, it MUST close the session with a PROTOCOL_VIOLATION."
 *
 * 送信側でも DELETE / USE_ALIAS を SETUP に載せてはならないため、
 * createSetup 時にこの関数で検証する。
 */
export function assertAuthorizationTokenForSetup(token: AuthorizationToken): void {
  if (
    token.aliasType === AuthorizationTokenAliasType.DELETE ||
    token.aliasType === AuthorizationTokenAliasType.USE_ALIAS
  ) {
    throw new Error(
      `authorization token alias type ${token.aliasType} is not allowed in SETUP, expected REGISTER (1) or USE_VALUE (3)`,
    );
  }
}

/**
 * Authorization Token のサイズを計算する
 * draft-ietf-moq-transport-18 §10.3.1.3:
 * "The token size is calculated as 16 bytes + the size of the Token Value field"
 *
 * REGISTER / USE_VALUE のみ Token Value を持つ。
 * DELETE / USE_ALIAS は Token Value を持たないため 0 を返す。
 */
export function calculateAuthTokenSize(token: AuthorizationToken): number {
  if (
    token.aliasType === AuthorizationTokenAliasType.REGISTER ||
    token.aliasType === AuthorizationTokenAliasType.USE_VALUE
  ) {
    return 16 + token.tokenValue.length;
  }
  return 0;
}

/**
 * REGISTER を USE_VALUE にフォールバックする
 * draft-ietf-moq-transport-18 §10.3.1.4:
 * "If an endpoint receives an AUTHORIZATION TOKEN option in SETUP with
 *  Alias Type REGISTER that exceeds its MAX_AUTH_TOKEN_CACHE_SIZE,
 *  it MUST treat the option as Alias Type USE_VALUE."
 */
export function fallbackRegisterToUseValue(
  token: AuthorizationTokenRegister,
): AuthorizationTokenUseValue {
  return {
    aliasType: AuthorizationTokenAliasType.USE_VALUE,
    tokenType: token.tokenType,
    tokenValue: token.tokenValue,
  };
}
