/**
 * 受信 Authorization Token キャッシュ
 *
 * draft-ietf-moq-transport-23 §8.9 (Authorization Token Compression) /
 * §9.1.3 (MAX_AUTH_TOKEN_CACHE_SIZE) / §9.1.4 (AUTHORIZATION TOKEN) /
 * §9.19.2 (AUTHORIZATION TOKEN Parameter)
 *
 * ピアが REGISTER した Token Alias を保持し、USE_ALIAS を解決し、
 * DELETE で退役させる。Alias 空間は送信元ごとに独立するため、
 * 本キャッシュは「ピアが登録した Alias」だけを保持する。
 */

import { SessionError, SessionErrorCode } from "../error";
import {
  AuthorizationTokenAliasType,
  type AuthorizationToken,
  type AuthorizationTokenRegister,
  decodeAuthorizationToken,
} from "../message/authorizationToken";
import { MessageParameterType, SetupOptionType } from "../message/types";

/**
 * キャッシュエントリ 1 件あたりの固定オーバーヘッド
 *
 * draft-ietf-moq-transport-23 §9.1.3:
 * "The token size is calculated as 16 bytes + the size of the Token Value field"
 */
const AUTH_TOKEN_CACHE_ENTRY_OVERHEAD = 16;

/**
 * Token Value 長からキャッシュエントリ 1 件のサイズを求める
 *
 * draft-ietf-moq-transport-23 §9.1.3: 1 件のサイズは
 * "16 bytes + the size of the Token Value field" である。
 * 送信側がピアの MAX_AUTH_TOKEN_CACHE_SIZE と比較するときにも使う。
 */
function authTokenRegisterEntrySize(tokenValue: Uint8Array): bigint {
  return BigInt(AUTH_TOKEN_CACHE_ENTRY_OVERHEAD + tokenValue.length);
}

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
 * - duplicate-token: Alias 解決後の Type と Value の組が重複した
 * - unknown-alias: 未登録 Alias を参照する USE_ALIAS があり、呼び出し元が
 *   セッションを閉じるべきである。tokenAlias は該当する Alias 値
 */
type AuthTokenProcessResult =
  | { status: "ok" }
  | { status: "duplicate-token" }
  | { status: "unknown-alias"; tokenAlias: bigint };

export const DUPLICATE_AUTH_TOKEN_REASON =
  "duplicate AUTHORIZATION_TOKEN Type and Value in the same message";

interface OutgoingAuthTokenEntry extends AuthTokenCacheEntry {
  size: bigint;
}

type OutgoingAliasOperation =
  | { kind: "register"; alias: bigint; entry: OutgoingAuthTokenEntry }
  | { kind: "use" | "delete"; alias: bigint };

interface PendingAuthTokenRequest {
  streamId: bigint;
  submitted: boolean;
  reservedBytes: bigint;
  operations: OutgoingAliasOperation[];
}

/** §8.9: Alias 解決後の Type と Value の組はメッセージ内で一意とする。 */
function addAuthTokenIdentity(
  seenTokens: Map<bigint, Set<string>>,
  { tokenType, tokenValue }: AuthTokenCacheEntry,
): boolean {
  // 各バイトを 1 コード単位に対応させる。長い値は引数の個数を制限するために分割する。
  const chunkSize = 8192;
  let key = "";
  for (let offset = 0; offset < tokenValue.length; offset += chunkSize) {
    key += String.fromCharCode(...tokenValue.subarray(offset, offset + chunkSize));
  }
  const values = seenTokens.get(tokenType);
  if (values === undefined) {
    seenTokens.set(tokenType, new Set([key]));
    return true;
  }
  const previousSize = values.size;
  values.add(key);
  return values.size !== previousSize;
}

function recordOutgoingAuthToken(
  seenTokens: Map<bigint, Set<string>> | undefined,
  entry: AuthTokenCacheEntry,
): void {
  if (seenTokens !== undefined && !addAuthTokenIdentity(seenTokens, entry)) {
    throw new Error(DUPLICATE_AUTH_TOKEN_REASON);
  }
}

/**
 * draft-ietf-moq-transport-23 §8.9 / §9.1.3: 送信側の Alias とキャッシュ容量を保持する。
 * 要求単位のエラーでも REGISTER は有効なので、応答が確認できれば OK / ERROR ともに確定する。
 */
export class PendingAuthTokenRequests {
  private readonly requests = new Map<bigint, PendingAuthTokenRequest>();
  private readonly registeredTokens = new Map<bigint, OutgoingAuthTokenEntry>();
  private readonly registrations = new Map<
    bigint,
    { request: PendingAuthTokenRequest; entry: OutgoingAuthTokenEntry }
  >();
  private readonly retirements = new Map<bigint, PendingAuthTokenRequest>();
  private readonly uses = new Map<bigint, number>();
  private readonly openingRegistrations = new Map<bigint, number>();
  private accountedBytes = 0n;
  private setupAlias: bigint | undefined;
  private setupRetired = false;

  get size(): bigint {
    return this.accountedBytes;
  }

  get setupRegistrationRetired(): boolean {
    return this.setupRetired;
  }

  hasAlias(alias: bigint): boolean {
    return this.registeredTokens.has(alias) || this.registrations.has(alias);
  }

  rememberSetup({ tokenAlias, tokenType, tokenValue }: AuthorizationTokenRegister): void {
    const size = authTokenRegisterEntrySize(tokenValue);
    this.setupAlias = tokenAlias;
    this.registeredTokens.set(tokenAlias, { size, tokenType, tokenValue: tokenValue.slice() });
    this.accountedBytes += size;
  }

  /** 別のストリームが先に開いても、送信予定の REGISTER を追い越させない。 */
  openingRegistration(alias: bigint): () => void {
    const opening = this.openingRegistrations;
    opening.set(alias, (opening.get(alias) ?? 0) + 1);
    return () => {
      const count = opening.get(alias) ?? 0;
      if (count <= 1) opening.delete(alias);
      else opening.set(alias, count - 1);
    };
  }

  reserve(
    tokens: readonly AuthorizationToken[],
    requestId: bigint,
    streamId: bigint,
    limit: bigint,
  ): boolean {
    if (
      tokens.length === 0 ||
      (tokens[0]?.aliasType === AuthorizationTokenAliasType.USE_VALUE && tokens.length === 1)
    ) {
      return false;
    }
    const request: PendingAuthTokenRequest = {
      streamId,
      submitted: false,
      reservedBytes: 0n,
      operations: [],
    };
    // 同じメッセージ内ではワイヤ順に適用する。応答前に他のストリームへ解放を
    // 見せず、そのメッセージ内で増え得る最大量だけを全体の予約に加える。
    const projectedTokens = new Map<bigint, OutgoingAuthTokenEntry | undefined>();
    const seenTokens = tokens.length > 1 ? new Map<bigint, Set<string>>() : undefined;
    let change = 0n;
    let peak = 0n;
    try {
      for (const token of tokens) {
        if (token.aliasType === AuthorizationTokenAliasType.USE_VALUE) {
          recordOutgoingAuthToken(seenTokens, token);
          continue;
        }
        const alias = token.tokenAlias;
        const registration = this.registrations.get(alias);
        const retirement = this.retirements.get(alias);
        if (retirement !== undefined && retirement !== request) {
          throw new Error(`AUTHORIZATION_TOKEN alias ${alias} is awaiting a DELETE response`);
        }
        const projected = projectedTokens.has(alias)
          ? projectedTokens.get(alias)
          : this.registeredTokens.get(alias);
        switch (token.aliasType) {
          case AuthorizationTokenAliasType.REGISTER: {
            if (
              projected !== undefined ||
              (registration !== undefined && registration.request !== request)
            ) {
              throw new Error(
                `AUTHORIZATION_TOKEN alias ${alias} is already registered in this session`,
              );
            }
            recordOutgoingAuthToken(seenTokens, token);
            const size = authTokenRegisterEntrySize(token.tokenValue);
            change += size;
            if (change > peak) peak = change;
            if (this.accountedBytes + peak > limit) {
              throw new Error(
                `AUTHORIZATION_TOKEN registration total size ${this.accountedBytes + peak} exceeds peer MAX_AUTH_TOKEN_CACHE_SIZE ${limit}`,
              );
            }
            // raw パラメータのバイト列は呼び出し元が変更できる。登録時の値を保持する。
            const entry = {
              size,
              tokenType: token.tokenType,
              tokenValue: token.tokenValue.slice(),
            };
            projectedTokens.set(alias, entry);
            this.registrations.set(alias, { request, entry });
            request.operations.push({ kind: "register", alias, entry });
            break;
          }
          case AuthorizationTokenAliasType.USE_ALIAS: {
            // writer.write を呼んで送信順が決まった後だけ、同じストリームで先行 REGISTER を参照できる。
            const orderedRegistration =
              registration?.request.streamId === streamId && registration.request.submitted
                ? registration.entry
                : undefined;
            if (
              this.openingRegistrations.has(alias) ||
              (registration !== undefined &&
                registration.request !== request &&
                orderedRegistration === undefined)
            ) {
              throw new Error(`AUTHORIZATION_TOKEN alias ${alias} is awaiting a REGISTER response`);
            }
            const entry = orderedRegistration ?? projected;
            if (entry === undefined) {
              throw new Error(
                `AUTHORIZATION_TOKEN alias ${alias} is not registered in this session`,
              );
            }
            recordOutgoingAuthToken(seenTokens, entry);
            this.uses.set(alias, (this.uses.get(alias) ?? 0) + 1);
            request.operations.push({ kind: "use", alias });
            break;
          }
          case AuthorizationTokenAliasType.DELETE:
            if (
              this.openingRegistrations.has(alias) ||
              (registration !== undefined && registration.request !== request)
            ) {
              throw new Error(`AUTHORIZATION_TOKEN alias ${alias} is awaiting a REGISTER response`);
            }
            if (this.uses.has(alias)) {
              throw new Error(
                `AUTHORIZATION_TOKEN alias ${alias} is awaiting a USE_ALIAS response`,
              );
            }
            change -= projected?.size ?? 0n;
            projectedTokens.set(alias, undefined);
            this.retirements.set(alias, request);
            request.operations.push({ kind: "delete", alias });
            break;
        }
      }
    } catch (error) {
      this.releaseOperations(request);
      throw error;
    }

    if (request.operations.length === 0) return false;
    request.reservedBytes = peak;
    this.accountedBytes += peak;
    this.requests.set(requestId, request);
    return true;
  }

  markSubmitted(requestId: bigint): void {
    const request = this.requests.get(requestId);
    if (request !== undefined) request.submitted = true;
  }

  finish(requestId: bigint): void {
    const request = this.take(requestId);
    if (request === undefined) return;
    for (const operation of request.operations) {
      if (operation.kind === "register") {
        this.registeredTokens.set(operation.alias, operation.entry);
        this.accountedBytes += operation.entry.size;
      } else if (operation.kind === "delete") {
        this.accountedBytes -= this.registeredTokens.get(operation.alias)?.size ?? 0n;
        this.registeredTokens.delete(operation.alias);
        if (operation.alias === this.setupAlias) this.setupRetired = true;
      }
    }
  }

  cancel(requestId: bigint): void {
    this.take(requestId);
  }

  private take(requestId: bigint): PendingAuthTokenRequest | undefined {
    const request = this.requests.get(requestId);
    if (request === undefined) return undefined;
    this.requests.delete(requestId);
    this.accountedBytes -= request.reservedBytes;
    this.releaseOperations(request);
    return request;
  }

  private releaseOperations(request: PendingAuthTokenRequest): void {
    for (const operation of request.operations) {
      if (operation.kind === "register") {
        this.registrations.delete(operation.alias);
      } else if (operation.kind === "delete") {
        this.retirements.delete(operation.alias);
      } else {
        const count = this.uses.get(operation.alias) ?? 0;
        if (count <= 1) this.uses.delete(operation.alias);
        else this.uses.set(operation.alias, count - 1);
      }
    }
  }

  clear(): void {
    this.requests.clear();
    this.registeredTokens.clear();
    this.registrations.clear();
    this.retirements.clear();
    this.uses.clear();
    this.openingRegistrations.clear();
    this.accountedBytes = 0n;
    this.setupAlias = undefined;
    this.setupRetired = false;
  }
}

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
   * draft-ietf-moq-transport-23 §8.9:
   * "Once a Token Alias has been registered, it cannot be re-registered by the
   *  same endpoint in the Session without first being deleted."
   * §9.1.3 の上限判定は「REGISTER のトークンサイズの総和 − DELETE の総和」で行う。
   */
  register(tokenAlias: bigint, tokenType: bigint, tokenValue: Uint8Array): AuthTokenRegisterResult {
    if (this.entries.has(tokenAlias)) {
      return { status: "duplicate-alias" };
    }

    const entrySize = Number(authTokenRegisterEntrySize(tokenValue));
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
   * draft-ietf-moq-transport-23 §8.9:
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
   * draft-ietf-moq-transport-23 §8.9 (DELETE):
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
 * draft-ietf-moq-transport-23 §9.1.4:
 * "If a server receives Alias Type DELETE (0x0) or USE_ALIAS (0x2) in a SETUP
 *  message, it MUST close the session with ROLE_VIOLATION."
 * "If an endpoint receives an AUTHORIZATION TOKEN option in SETUP with Alias
 *  Type REGISTER that exceeds its MAX_AUTH_TOKEN_CACHE_SIZE, it MUST NOT fail
 *  the session with AUTH_TOKEN_CACHE_OVERFLOW.  Instead, it MUST treat the
 *  option as Alias Type USE_VALUE."
 *
 * §9.1.4 の DELETE / USE_ALIAS 検査は server 宛の MUST であり、client である
 * moqt-js には直接適用されない。SETUP 時点で解決できない Alias は適合 peer が
 * 送らないため、防御的検査としてセッションを閉じる。ROLE_VIOLATION は「役割上
 * 送信できないメッセージやフィールド」に対するコードであり、この防御的検査の
 * 意味に合うため、同じコードを使う。
 *
 * @throws SessionError ROLE_VIOLATION (DELETE / USE_ALIAS) または
 *   DUPLICATE_AUTH_TOKEN_ALIAS (登録済み Alias の再 REGISTER)
 */
function processSetupAuthorizationToken(cache: AuthTokenCache, token: AuthorizationToken): void {
  switch (token.aliasType) {
    case AuthorizationTokenAliasType.DELETE:
    case AuthorizationTokenAliasType.USE_ALIAS:
      throw new SessionError(
        `authorization token alias type ${token.aliasType} is not allowed in SETUP`,
        SessionErrorCode.ROLE_VIOLATION,
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
 * draft-ietf-moq-transport-23 §9.1.4: オプション値は §8.9 の Token 構造。
 *
 * @throws SessionError Token 構造がデコード不能 (MALFORMED_AUTH_TOKEN)、
 *   DELETE / USE_ALIAS (ROLE_VIOLATION)、登録済み Alias の再 REGISTER
 *   (DUPLICATE_AUTH_TOKEN_ALIAS)
 */
export function processSetupAuthorizationTokens(
  cache: AuthTokenCache,
  parameters: Array<{ type: number; value: Uint8Array }>,
): void {
  for (const parameter of parameters) {
    // Setup Options と Message Parameters は別のレジストリ (§9.1 / §9.19) であり、
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
 * draft-ietf-moq-transport-23 §8.9:
 * "The receiver of a message attempting to register an Alias which is already
 *  registered MUST close the Session with DUPLICATE_AUTH_TOKEN_ALIAS."
 * "If a registration outside of SETUP is attempted that would cause this limit
 *  to be exceeded, the receiver MUST terminate the Session with an
 *  AUTH_TOKEN_CACHE_OVERFLOW error.  Registrations in SETUP are handled as
 *  described in Section 9.1.4."
 *
 * 未登録 Alias の参照は Session Termination になる。セッションを閉じるのは
 * 呼び出し元であり、本関数はセッションを閉じずに戻り値で unknown-alias を伝える。
 *
 * @throws SessionError Token 構造がデコード不能 (MALFORMED_AUTH_TOKEN)、
 *   登録済み Alias の再 REGISTER (DUPLICATE_AUTH_TOKEN_ALIAS)、
 *   キャッシュ上限超過 (AUTH_TOKEN_CACHE_OVERFLOW)
 */
function processMessageAuthorizationToken(
  cache: AuthTokenCache,
  token: AuthorizationToken,
): AuthTokenCacheEntry | { unknownAlias: bigint } | undefined {
  switch (token.aliasType) {
    case AuthorizationTokenAliasType.REGISTER: {
      const result = cache.register(token.tokenAlias, token.tokenType, token.tokenValue.slice());
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
      return token;
    }
    case AuthorizationTokenAliasType.USE_ALIAS: {
      const result = cache.resolve(token.tokenAlias);
      if (result.status === "unknown-alias") {
        return { unknownAlias: token.tokenAlias };
      }
      return result;
    }
    case AuthorizationTokenAliasType.DELETE:
      cache.delete(token.tokenAlias);
      return undefined;
    case AuthorizationTokenAliasType.USE_VALUE:
      // 値を直接用いるためキャッシュへは登録しない (§8.9)。
      return token;
    default:
      // AuthorizationToken は判別 union であり、上の case が全 Alias Type を網羅する。
      // 到達しないが、未知の Alias Type は Token 構造として不正であるため
      // §8.9 の「デコード不能」と同じ扱いでセッションを閉じる。
      throw new SessionError(
        `unknown authorization token alias type: ${String((token as { aliasType: number }).aliasType)}`,
        SessionErrorCode.MALFORMED_AUTH_TOKEN,
      );
  }
}

/**
 * 受信メッセージの AUTHORIZATION TOKEN パラメータをすべて処理する
 *
 * draft-ietf-moq-transport-23 §8.9:
 * "An Authorization Token MAY be repeated within a message as long as the
 *  combination of Token Type and Token Value are unique after resolving any
 *  aliases." ワイヤ順で解決し、組の重複を検出しても後続の REGISTER を処理する。
 *
 * 要求単位の重複よりセッションエラーを優先する。未登録 Alias の参照は
 * セッションを終了させるため、最初のセッションエラーを検出した時点で打ち切る。
 *
 * @throws SessionError Token 構造がデコード不能 (MALFORMED_AUTH_TOKEN)、
 *   登録済み Alias の再 REGISTER (DUPLICATE_AUTH_TOKEN_ALIAS)、
 *   キャッシュ上限超過 (AUTH_TOKEN_CACHE_OVERFLOW)
 */
export function processMessageAuthorizationTokens(
  cache: AuthTokenCache,
  parameters: readonly { type: number; value: Uint8Array }[],
): AuthTokenProcessResult {
  let firstToken: AuthTokenCacheEntry | undefined;
  let seenTokens: Map<bigint, Set<string>> | undefined;
  let duplicate = false;
  for (const parameter of parameters) {
    if (parameter.type !== MessageParameterType.AUTHORIZATION_TOKEN) {
      continue;
    }
    // 比較にだけ使う Value をコピーせず、キャッシュに保持する REGISTER だけコピーする。
    const token = decodeAuthorizationToken(parameter.value, { copyTokenValue: false });
    const identity = processMessageAuthorizationToken(cache, token);
    if (identity === undefined) continue;
    if ("unknownAlias" in identity) {
      return { status: "unknown-alias", tokenAlias: identity.unknownAlias };
    }
    if (duplicate) continue;
    if (firstToken === undefined) {
      firstToken = identity;
      continue;
    }
    if (seenTokens === undefined) {
      seenTokens = new Map();
      addAuthTokenIdentity(seenTokens, firstToken);
    }
    duplicate = !addAuthTokenIdentity(seenTokens, identity);
  }
  return duplicate ? { status: "duplicate-token" } : { status: "ok" };
}

/** §8.9 / §12.2 / §12.3: セッションエラーを処理し、要求単位の重複は呼び出し元へ返す。 */
export function processIncomingAuthorizationTokens(
  session: { receivedAuthTokens: AuthTokenCache; closeWithError(error: SessionError): void },
  requestId: bigint,
  parameters: readonly { type: number; value: Uint8Array }[],
): "ok" | "duplicate-token" | "closed" {
  try {
    const result = processMessageAuthorizationTokens(session.receivedAuthTokens, parameters);
    if (result.status !== "unknown-alias") return result.status;
    // UNKNOWN_AUTH_TOKEN_ALIAS は §12.2 の Session Termination Code として定義される。
    throw new SessionError(
      `unknown authorization token alias: requestId=${requestId} alias=${result.tokenAlias}`,
      SessionErrorCode.UNKNOWN_AUTH_TOKEN_ALIAS,
    );
  } catch (error) {
    if (!(error instanceof SessionError)) throw error;
    session.closeWithError(error);
    return "closed";
  }
}

/**
 * SETUP の REGISTER がピアの上限に収まるかを判定する
 *
 * draft-ietf-moq-transport-23 §9.1.3 (MAX_AUTH_TOKEN_CACHE_SIZE):
 * "16 bytes + the size of the Token Value field" が 1 エントリのサイズである。
 * §8.9 (Authorization Token Compression) は「SETUP 以外での登録が上限を超えると
 * AUTH_TOKEN_CACHE_OVERFLOW でセッションを終了する」と定めるが、SETUP の登録は
 * §9.1.4 のとおり失敗させず USE_VALUE として扱う。
 *
 * 送信側は、ピアの SETUP を受信して上限が判明した時点で、自 SETUP の REGISTER が
 * 登録に成功したか (registered) を確定する。後続メッセージへ同じトークンを付与
 * するときの正規化 (normalizeAuthorizationTokenForSend) に使う。
 *
 * @param token - SETUP に載せた Authorization Token (REGISTER 以外は対象外)
 * @param peerMaxAuthTokenCacheSize - ピアの MAX_AUTH_TOKEN_CACHE_SIZE (未受信時は 0)
 * @returns 登録成否。SETUP トークンが REGISTER でなければ undefined
 */
export function setupTokenRegistration(
  token: AuthorizationToken | undefined,
  peerMaxAuthTokenCacheSize: bigint,
): { tokenAlias: bigint; registered: boolean } | undefined {
  if (token === undefined || token.aliasType !== AuthorizationTokenAliasType.REGISTER) {
    return undefined;
  }
  const entrySize = AUTH_TOKEN_CACHE_ENTRY_OVERHEAD + token.tokenValue.length;
  return {
    tokenAlias: token.tokenAlias,
    registered: BigInt(entrySize) <= peerMaxAuthTokenCacheSize,
  };
}

/**
 * 後続メッセージへ付与する Authorization Token を正規化する
 *
 * draft-ietf-moq-transport-23 §8.9 / §9.1.4:
 * - 自 SETUP の REGISTER で登録に成功した Alias を REGISTER のまま再送すると、
 *   ピアは登録済み Alias の再 REGISTER として DUPLICATE_AUTH_TOKEN_ALIAS で
 *   セッションを閉じる (§8.9)。同じ Alias を参照する USE_ALIAS に変換する
 * - 登録に失敗した (ピアに登録されていない) Alias を REGISTER / USE_ALIAS で
 *   参照すると、ピアは未知の Alias として扱う。値が手元にあるため USE_VALUE に
 *   変換する (§9.1.4 の purge)
 * - 上記以外 (USE_VALUE、ユーザーが明示的に指定した別 Alias の REGISTER /
 *   USE_ALIAS) はそのまま送る
 *
 * 値を持たない Alias を参照する場合は呼び出し側でローカルエラーにする。ここでは
 * 自 SETUP の REGISTER の値を使える場合だけ変換し、使えない場合は入力をそのまま
 * 返す (判断は呼び出し側の責務)。
 */
export function normalizeAuthorizationTokenForSend(
  token: AuthorizationToken,
  registration: { tokenAlias: bigint; registered: boolean } | undefined,
  setupToken: AuthorizationToken | undefined,
): AuthorizationToken {
  if (
    registration === undefined ||
    setupToken === undefined ||
    setupToken.aliasType !== AuthorizationTokenAliasType.REGISTER
  ) {
    return token;
  }
  if (token.aliasType === AuthorizationTokenAliasType.USE_VALUE) {
    return token;
  }
  // REGISTER は Alias だけでなく Token Type / Value も SETUP と一致する場合だけ
  // 正規化する。同じ Alias で別の値を指定するのはアプリの誤用であり、黙って
  // SETUP の値に置き換えると呼び出し側が指定した値が送られないままになる。
  const refersToSetupAlias =
    token.aliasType === AuthorizationTokenAliasType.REGISTER
      ? token.tokenAlias === registration.tokenAlias &&
        token.tokenType === setupToken.tokenType &&
        token.tokenValue.length === setupToken.tokenValue.length &&
        token.tokenValue.every((byte, index) => byte === setupToken.tokenValue[index])
      : token.aliasType === AuthorizationTokenAliasType.USE_ALIAS
        ? token.tokenAlias === registration.tokenAlias
        : false;
  if (!refersToSetupAlias) {
    return token;
  }
  if (registration.registered) {
    // 登録済み Alias の再 REGISTER は禁止のため USE_ALIAS に変換する
    return {
      aliasType: AuthorizationTokenAliasType.USE_ALIAS,
      tokenAlias: registration.tokenAlias,
    };
  }
  // 登録に失敗した Alias は USE_VALUE に変換する (値は自 SETUP のトークンにある)
  return {
    aliasType: AuthorizationTokenAliasType.USE_VALUE,
    tokenType: setupToken.tokenType,
    tokenValue: setupToken.tokenValue,
  };
}
