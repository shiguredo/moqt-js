/**
 * MSF URI fragment の c4m を SETUP の Authorization Token にする
 *
 * 参照:
 * - draft-ietf-moq-msf-01 §11.1.1 (Reserved fragment parameters): c4m は
 *   "a base64 encoded token, as defined by [C4M]"
 * - draft-ietf-moq-msf-01 §11.4.2 / §11.4.3 (Presenting Authorization): 接続 URI の
 *   トークンをクライアントが取り出し、SETUP の AUTHORIZATION TOKEN setup parameter
 *   (MAY) または制御メッセージの AUTHORIZATION TOKEN message parameter で提示する
 * - draft-ietf-moq-c4m-01 §2 (Token format): URL に載せるときは Base64 (RFC 4648)
 * - draft-ietf-moq-c4m-01 §7.1 Table 4 / §7.1.1: Token Type 0x01 は CAT で、Token Payload
 *   は CBOR エンコードされた CWT として直列化した CAT
 * - draft-ietf-moq-transport-22 §9.1.4 (AUTHORIZATION TOKEN Setup Option)
 * - draft-ietf-moq-transport-22 §8.9 (Authorization Token Compression): Token 構造
 *
 * draft 版を追従しているため、将来変更される可能性がある。
 */

import { tryDecodeBase64OrUrl } from "../c4m/base64url";
import {
  AuthorizationTokenAliasType,
  type AuthorizationTokenUseValue,
} from "../message/authorizationToken";
import type { MoqtFragment } from "../moqtUri";
import { getC4mParameter } from "./c4m";
import { parseMsfFragmentValue } from "./fragment";

/**
 * c4m が運ぶ C4M のトークンタイプ
 *
 * draft-ietf-moq-c4m-01 §7.1 Table 4: MOQT Auth Token Type の 0x01 が CAT。
 * draft-ietf-moq-transport-22 §8.9: Type 0 は表に定義が無く out-of-band で交渉する
 * 予約値のため、CAT には 0 ではなく 0x01 を送る。
 */
const C4M_TOKEN_TYPE = 1n;

/**
 * c4m パラメータの値 (Base64) を SETUP 用の Authorization Token にする
 *
 * draft-ietf-moq-msf-01 §11.1.1 / draft-ietf-moq-c4m-01 §2:
 * c4m の値は Base64 でエンコードされた C4M トークン。msf は base64 としか規定せず、
 * c4m の付録 A のテストベクタはパディング無しの base64url のため、標準 Base64
 * (RFC 4648 Section 4) と base64url (Section 5)、パディングの有無の両方を受ける。
 *
 * draft-ietf-moq-transport-22 §9.1.4: SETUP で Alias Type DELETE (0x0) / USE_ALIAS (0x2) を
 * 受信したサーバーは PROTOCOL_VIOLATION でセッションを閉じる MUST。Alias を持たず
 * トークン値をそのまま使う USE_VALUE (0x3) で返す。
 *
 * @param c4mValue c4m パラメータの値
 * @returns SETUP に載せる Authorization Token。値が空、または Base64 として復号できない
 *   場合は undefined
 */
export function createC4mAuthorizationToken(
  c4mValue: string,
): AuthorizationTokenUseValue | undefined {
  // `c4m=` (値が空) はトークンを運んでいない。空のバイト列を Token Value にすると
  // relay が MALFORMED_AUTH_TOKEN で拒否するため、値なしとして扱う
  if (c4mValue.length === 0) {
    return undefined;
  }

  const tokenValue = tryDecodeBase64OrUrl(c4mValue);
  if (tokenValue === undefined) {
    return undefined;
  }

  return {
    aliasType: AuthorizationTokenAliasType.USE_VALUE,
    tokenType: C4M_TOKEN_TYPE,
    tokenValue,
  };
}

/**
 * MOQT URI の msf fragment が持つ c4m から SETUP 用の Authorization Token を解決する
 *
 * draft-ietf-moq-msf-01 §11.1: fragment はサーバーへ送信されず、クライアントが
 * ローカルで解釈する。§11.4.2: 接続 URI にトークンのパラメータがある場合、クライアントが
 * その値を取り出して適切な MOQT メッセージに含める。
 *
 * - fragment type が msf でない場合、c4m が無い場合は undefined (トークンを載せない)
 * - c4m が Base64 として復号できない場合は Error を throw する。msf はこの場合の
 *   クライアント挙動を規定していないが、黙って無視すると relay の認可エラーとして
 *   現れて原因が分からなくなるため、接続前にエラーにする
 *
 * @param fragment MOQT URI の fragment (指定なしは null)
 * @throws Error c4m の値が Base64 として復号できない場合
 */
export function resolveMsfAuthorizationToken(
  fragment: MoqtFragment | null,
): AuthorizationTokenUseValue | undefined {
  if (fragment?.type !== "msf") {
    return undefined;
  }

  const c4mValue = getC4mParameter(parseMsfFragmentValue(fragment.value).parameters);
  if (c4mValue === undefined) {
    return undefined;
  }

  const token = createC4mAuthorizationToken(c4mValue);
  if (token === undefined) {
    // c4m の値は認可トークンのため、エラーメッセージに値を含めない
    throw new Error(
      "msf fragment c4m must be a Base64 encoded C4M token (draft-ietf-moq-msf-01 Section 11.1.1)",
    );
  }
  return token;
}
