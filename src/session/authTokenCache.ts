/**
 * 受信 Authorization Token キャッシュ
 *
 * draft-ietf-moq-transport-21 §8.9 (Authorization Token Compression) /
 * §9.1.3 (MAX_AUTH_TOKEN_CACHE_SIZE) / §9.1.4 (AUTHORIZATION TOKEN) /
 * §9.20.3 (AUTHORIZATION TOKEN Parameter)
 *
 * ピアが REGISTER した Token Alias を保持し、USE_ALIAS を解決し、
 * DELETE で退役させる。Alias 空間は送信元ごとに独立するため、
 * 本キャッシュは「ピアが登録した Alias」だけを保持する。
 */

import { SessionError, SessionErrorCode } from "../error";
import {
  AuthorizationTokenAliasType,
  type AuthorizationToken,
  decodeAuthorizationToken,
} from "../message/authorizationToken";
import { MessageParameterType, SetupOptionType } from "../message/types";

/**
 * キャッシュエントリ 1 件あたりの固定オーバーヘッド
 *
 * draft-ietf-moq-transport-21 §9.1.3:
 * "The token size is calculated as 16 bytes + the size of the Token Value field"
 */
const AUTH_TOKEN_CACHE_ENTRY_OVERHEAD = 16;

/**
 * キャッシュに登録済みの Token Type / Token Value
 */
interface AuthTokenCacheEntry {
  tokenType: bigint;
  tokenValue: Uint8Array;
}

/**
 * REGISTER の結果
 *
 * - registered: 登録できた
 * - duplicate-alias: 同一 Alias が登録済み (§8.9 の DUPLICATE_AUTH_TOKEN_ALIAS)
 * - cache-overflow: キャッシュ上限を超える (§9.1.3 の上限超過)。
 *   attemptedSize は登録した場合の合計サイズであり、エラーメッセージに使う。
 */
type AuthTokenRegisterResult =
  | { status: "registered" }
  | { status: "duplicate-alias" }
  | { status: "cache-overflow"; attemptedSize: number };

/**
 * USE_ALIAS の解決結果
 */
type AuthTokenResolveResult =
  | { status: "resolved"; tokenType: bigint; tokenValue: Uint8Array }
  | { status: "unknown-alias" };

/**
 * メッセージ 1 通分の AUTHORIZATION TOKEN パラメータ処理結果
 *
 * - ok: すべての Token を処理できた
 * - unknown-alias: 未登録 Alias を参照する USE_ALIAS があり、呼び出し元が
 *   セッションを閉じるべきである。tokenAlias は該当する Alias 値
 */
export type AuthTokenProcessResult =
  | { status: "ok" }
  | { status: "unknown-alias"; tokenAlias: bigint };

/**
 * 受信 Authorization Token キャッシュ
 *
 * 保持するのは自分が広告した MAX_AUTH_TOKEN_CACHE_SIZE (§9.1.3) に基づく上限である。
 * 未広告時の既定は 0 であり、Alias の使用を一切受け付けない。
 */
export class AuthTokenCache {
  private readonly entries = new Map<bigint, AuthTokenCacheEntry>();
  private registeredSize = 0;
  private readonly maxSize: number;

  constructor(maxSize: number) {
    this.maxSize = maxSize;
  }

  /**
   * 現在の登録済みサイズ (§9.1.3 の計算式に基づく)
   */
  get size(): number {
    return this.registeredSize;
  }

  /**
   * 上限サイズ (§9.1.3)
   */
  get limit(): number {
    return this.maxSize;
  }

  /**
   * Token Alias を登録する
   *
   * draft-ietf-moq-transport-21 §8.9:
   * "Once a Token Alias has been registered, it cannot be re-registered by the
   *  same endpoint in the Session without first being deleted."
   * §9.1.3 の上限判定は「REGISTER のトークンサイズの総和 − DELETE の総和」で行う。
   */
  register(tokenAlias: bigint, tokenType: bigint, tokenValue: Uint8Array): AuthTokenRegisterResult {
    if (this.entries.has(tokenAlias)) {
      return { status: "duplicate-alias" };
    }

    const entrySize = AUTH_TOKEN_CACHE_ENTRY_OVERHEAD + tokenValue.length;
    const attemptedSize = this.registeredSize + entrySize;
    if (attemptedSize > this.maxSize) {
      return { status: "cache-overflow", attemptedSize };
    }

    this.entries.set(tokenAlias, { tokenType, tokenValue });
    this.registeredSize = attemptedSize;
    return { status: "registered" };
  }

  /**
   * Token Alias を解決する
   *
   * draft-ietf-moq-transport-21 §8.9:
   * "The receiver of a message referencing an Alias that is not currently
   *  registered MUST reject the message with UNKNOWN_AUTH_TOKEN_ALIAS."
   *
   * 未登録 Alias は unknown-alias として返す。セッションを閉じるかどうかは
   * 呼び出し元が決める。
   */
  resolve(tokenAlias: bigint): AuthTokenResolveResult {
    const entry = this.entries.get(tokenAlias);
    if (entry === undefined) {
      return { status: "unknown-alias" };
    }
    return { status: "resolved", tokenType: entry.tokenType, tokenValue: entry.tokenValue };
  }

  /**
   * Token Alias を退役させる
   *
   * draft-ietf-moq-transport-21 §8.9 (DELETE):
   * "This Alias and the Token Value it was previously associated with MUST be
   *  retired." 未登録 Alias への DELETE は減算対象が無いため何もしない。
   */
  delete(tokenAlias: bigint): void {
    const entry = this.entries.get(tokenAlias);
    if (entry === undefined) {
      return;
    }
    this.entries.delete(tokenAlias);
    this.registeredSize -= AUTH_TOKEN_CACHE_ENTRY_OVERHEAD + entry.tokenValue.length;
  }

  /**
   * 登録内容を破棄する
   *
   * Session 終了時に呼ぶ。上限値は自 endpoint が SETUP で広告した値であり
   * Session の構成を表すため維持し、登録済みエントリとサイズだけを破棄する。
   */
  clear(): void {
    this.entries.clear();
    this.registeredSize = 0;
  }
}

/**
 * 受信 SETUP オプションの Authorization Token を 1 件処理する
 *
 * draft-ietf-moq-transport-21 §9.1.4:
 * "If a server receives Alias Type DELETE (0x0) or USE_ALIAS (0x2) in a SETUP
 *  message, it MUST close the session with a PROTOCOL_VIOLATION."
 * "If an endpoint receives an AUTHORIZATION TOKEN option in SETUP with Alias
 *  Type REGISTER that exceeds its MAX_AUTH_TOKEN_CACHE_SIZE, it MUST NOT fail
 *  the session with AUTH_TOKEN_CACHE_OVERFLOW.  Instead, it MUST treat the
 *  option as Alias Type USE_VALUE."
 *
 * moqt-js は client であり §9.1.4 の DELETE / USE_ALIAS 検査は server 宛の MUST だが、
 * SETUP 時点で解決できない Alias は適合 peer が送らないため、防御的検査として同じく
 * PROTOCOL_VIOLATION でセッションを閉じる。
 *
 * @throws SessionError PROTOCOL_VIOLATION (DELETE / USE_ALIAS) または
 *   DUPLICATE_AUTH_TOKEN_ALIAS (登録済み Alias の再 REGISTER)
 */
function processSetupAuthorizationToken(cache: AuthTokenCache, token: AuthorizationToken): void {
  switch (token.aliasType) {
    case AuthorizationTokenAliasType.DELETE:
    case AuthorizationTokenAliasType.USE_ALIAS:
      throw new SessionError(
        `authorization token alias type ${token.aliasType} is not allowed in SETUP`,
        SessionErrorCode.PROTOCOL_VIOLATION,
      );
    case AuthorizationTokenAliasType.REGISTER: {
      const result = cache.register(token.tokenAlias, token.tokenType, token.tokenValue);
      if (result.status === "duplicate-alias") {
        throw new SessionError(
          `authorization token alias ${token.tokenAlias} is already registered`,
          SessionErrorCode.DUPLICATE_AUTH_TOKEN_ALIAS,
        );
      }
      // cache-overflow は §9.1.4 の MUST により USE_VALUE として扱い、
      // セッションを閉じず登録もしない。
      break;
    }
    case AuthorizationTokenAliasType.USE_VALUE:
      // 値を直接用いるためキャッシュへは登録しない (§8.9)。
      break;
  }
}

/**
 * 受信 SETUP の AUTHORIZATION TOKEN オプションをすべて処理する
 *
 * draft-ietf-moq-transport-21 §9.1.4: オプション値は §8.9 の Token 構造。
 *
 * @throws SessionError Token 構造がデコード不能 (KEY_VALUE_FORMATTING_ERROR)、
 *   DELETE / USE_ALIAS (PROTOCOL_VIOLATION)、登録済み Alias の再 REGISTER
 *   (DUPLICATE_AUTH_TOKEN_ALIAS)
 */
export function processSetupAuthorizationTokens(
  cache: AuthTokenCache,
  parameters: Array<{ type: number; value: Uint8Array }>,
): void {
  for (const parameter of parameters) {
    // Setup Options と Message Parameters は別のレジストリ (§9.1 / §9.20) であり、
    // SETUP 経路では SetupOptionType で判定する。
    if (parameter.type !== SetupOptionType.AUTHORIZATION_TOKEN) {
      continue;
    }
    const token = decodeAuthorizationToken(parameter.value);
    processSetupAuthorizationToken(cache, token);
  }
}

/**
 * 受信メッセージパラメータの Authorization Token を 1 件処理する
 *
 * draft-ietf-moq-transport-21 §8.9:
 * "The receiver of a message attempting to register an Alias which is already
 *  registered MUST close the Session with DUPLICATE_AUTH_TOKEN_ALIAS."
 * "If a registration is attempted which would cause this limit to be exceeded,
 *  the receiver MUST terminate the Session with a AUTH_TOKEN_CACHE_OVERFLOW error."
 *
 * 未登録 Alias の参照は Session Termination になる。セッションを閉じるのは
 * 呼び出し元であり、本関数はセッションを閉じずに戻り値で unknown-alias を伝える。
 *
 * @throws SessionError Token 構造がデコード不能 (KEY_VALUE_FORMATTING_ERROR)、
 *   登録済み Alias の再 REGISTER (DUPLICATE_AUTH_TOKEN_ALIAS)、
 *   キャッシュ上限超過 (AUTH_TOKEN_CACHE_OVERFLOW)
 */
function processMessageAuthorizationToken(
  cache: AuthTokenCache,
  token: AuthorizationToken,
): AuthTokenProcessResult {
  switch (token.aliasType) {
    case AuthorizationTokenAliasType.REGISTER: {
      const result = cache.register(token.tokenAlias, token.tokenType, token.tokenValue);
      if (result.status === "duplicate-alias") {
        throw new SessionError(
          `authorization token alias ${token.tokenAlias} is already registered`,
          SessionErrorCode.DUPLICATE_AUTH_TOKEN_ALIAS,
        );
      }
      if (result.status === "cache-overflow") {
        throw new SessionError(
          `authorization token cache size limit exceeded: ${result.attemptedSize} > ${cache.limit}`,
          SessionErrorCode.AUTH_TOKEN_CACHE_OVERFLOW,
        );
      }
      return { status: "ok" };
    }
    case AuthorizationTokenAliasType.USE_ALIAS: {
      const result = cache.resolve(token.tokenAlias);
      if (result.status === "unknown-alias") {
        return { status: "unknown-alias", tokenAlias: token.tokenAlias };
      }
      return { status: "ok" };
    }
    case AuthorizationTokenAliasType.DELETE:
      cache.delete(token.tokenAlias);
      return { status: "ok" };
    case AuthorizationTokenAliasType.USE_VALUE:
      // 値を直接用いるためキャッシュへは登録しない (§8.9)。
      return { status: "ok" };
    default:
      // AuthorizationToken は判別 union であり、上の case が全 Alias Type を網羅する。
      // 到達しないが、未知の Alias Type は Token 構造として不正であるため
      // §8.9 の「デコード不能」と同じ扱いでセッションを閉じる。
      throw new SessionError(
        `unknown authorization token alias type: ${String((token as { aliasType: number }).aliasType)}`,
        SessionErrorCode.KEY_VALUE_FORMATTING_ERROR,
      );
  }
}

/**
 * 受信メッセージの AUTHORIZATION TOKEN パラメータをすべて処理する
 *
 * draft-ietf-moq-transport-21 §8.9:
 * "An Authorization Token MAY be repeated within a message as long as the
 *  combination of Token Type and Token Value are unique after resolving any
 *  aliases." 複数出現し得るため、順に処理する。
 *
 * 未登録 Alias の参照を検出した時点で打ち切り、その結果を返す。同じメッセージに
 * 複数の違反 (未登録 Alias の参照と、登録済み Alias の再 REGISTER など) が含まれる
 * 場合、処理を続けると後続の SessionError が送出されて診断コードがパラメータ順に
 * 依存する。最初の違反を報告するため打ち切る。この結果、§9.1.3 の上限超過
 * (AUTH_TOKEN_CACHE_OVERFLOW) を伴う REGISTER が未登録 Alias の参照より後ろにある
 * 場合、報告されるコードは未登録 Alias 側の UNKNOWN_AUTH_TOKEN_ALIAS になる。
 * どちらもセッションを終了させる §12.2 の relevant code であり、REGISTER は
 * 「試行」の段階に達しないため §9.1.3 の MUST に反しない。
 *
 * §8.9 の REGISTER 登録 MUST
 * ("The receiver of a message carrying an Authorization Token with Alias Type
 *  REGISTER that does not result in a Session error MUST register the Token
 *  Alias in the token cache, even if the message fails for other reasons.")
 * はセッションエラーにならないメッセージを対象とする。未登録 Alias の参照は
 * Session Termination を起こすため同 MUST の対象外であり、打ち切っても
 * 同 MUST に反しない。
 *
 * @throws SessionError Token 構造がデコード不能 (KEY_VALUE_FORMATTING_ERROR)、
 *   登録済み Alias の再 REGISTER (DUPLICATE_AUTH_TOKEN_ALIAS)、
 *   キャッシュ上限超過 (AUTH_TOKEN_CACHE_OVERFLOW)
 */
export function processMessageAuthorizationTokens(
  cache: AuthTokenCache,
  parameters: Array<{ type: number; value: Uint8Array }>,
): AuthTokenProcessResult {
  for (const parameter of parameters) {
    if (parameter.type !== MessageParameterType.AUTHORIZATION_TOKEN) {
      continue;
    }
    const token = decodeAuthorizationToken(parameter.value);
    const processed = processMessageAuthorizationToken(cache, token);
    if (processed.status !== "ok") {
      return processed;
    }
  }
  return { status: "ok" };
}
