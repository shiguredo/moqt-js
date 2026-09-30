/**
 * catalog の track に載せる Authorization Info (draft-ietf-moq-msf-01 §5.2.42)
 *
 * 参照: draft-ietf-moq-msf-01, draft-ietf-moq-c4m-01
 */
import { MOQT_AUTH_TOKEN_TYPE_CAT } from "../c4m/cat";
import {
  type AuthorizationToken,
  AuthorizationTokenAliasType,
} from "../message/authorizationToken";
import type { AuthInfo } from "./types";

/** draft-ietf-moq-msf-01 §5.2.42 Table 7 の CAT のスキーム名 */
const CAT_AUTH_SCHEME = "cat";

/**
 * draft-ietf-moq-msf-01 §11.1.1 の予約パラメータ `c4m` を指す変数参照 (§5.4 / §5.2.43)
 *
 * 視聴側は、catalog を得た URI の fragment の `c4m` の値でこの変数を置換できる。
 * `c4m` の値がパディング無しの base64url なら、§5.4.1 の変数の値の制限
 * (英数字 / ハイフン / アンダースコア / `@`) を満たす。
 */
const C4M_VARIABLE_REFERENCE = "%c4m%";

/**
 * SETUP の Authorization Token から、catalog の track に載せる authInfo を決める
 *
 * draft-ietf-moq-msf-01 §5.2.42: authInfo は track の認可が必要なことを視聴側に示す
 * ("The presence of this field signals to subscribers that they must obtain and present
 * valid authorization tokens when subscribing to this track")。§11.4.1 も、視聴側は
 * catalog の authInfo を見て認可の要否を知るとする。C4M のトークン (CAT) で接続した
 * 配信の track は、同じトークンでの認可を前提にするため、視聴側にトークンの提示を求める。
 *
 * - Token Type が CAT (0x01) のときだけ `{"cat": "%c4m%"}` を返す
 * - 値は fragment の `c4m` を指す変数参照にし、トークンそのものは書かない。catalog は
 *   すべての視聴者に届き、配信者のトークンは PUBLISH の権限を含むため
 * - Token Type を持たない DELETE / USE_ALIAS と、CAT 以外の Token Type、トークンが無い
 *   ときは undefined を返す (authInfo を載せない)
 *
 * @param token - SETUP Option (0x03) として送る Authorization Token
 * @returns track に載せる authInfo。載せないときは undefined
 */
export function catalogAuthInfoForSetupToken(
  token: AuthorizationToken | undefined,
): AuthInfo | undefined {
  if (token === undefined) {
    return undefined;
  }
  if (
    token.aliasType !== AuthorizationTokenAliasType.USE_VALUE &&
    token.aliasType !== AuthorizationTokenAliasType.REGISTER
  ) {
    return undefined;
  }
  if (token.tokenType !== MOQT_AUTH_TOKEN_TYPE_CAT) {
    return undefined;
  }
  return { [CAT_AUTH_SCHEME]: C4M_VARIABLE_REFERENCE };
}
