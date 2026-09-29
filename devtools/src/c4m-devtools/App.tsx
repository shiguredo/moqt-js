/**
 * C4M DevTools
 *
 * C4M (draft-ietf-moq-c4m-01) の CAT トークンをブラウザ内でデコード / 検証 /
 * 発行するための開発ツール。鍵は Web Crypto API で生成し、メモリ上だけで扱う。
 */

import { signal } from "@preact/signals";
import { C4M } from "moqt-js";
import {
  type GeneratedKey,
  type KeyGenerationAlgorithm,
  type KeyInputInspection,
  type SecretInputFormat,
  bytesToHex,
  describeJwk,
  generateKey,
  inspectKeyInput,
  publicJwkOf,
} from "./utils/keys";
import {
  formatBytes,
  formatMatch,
  formatNamespaceMatches,
  parseList,
  parseNamespaceMatches,
  parseOptionalNumber,
  parseTrackMatch,
} from "./utils/claims";

const TEXT_ENCODER = new TextEncoder();
const cryptoImpl = new C4M.WebCrypto();

const CARD_CLASS = "bg-white rounded-xl shadow p-6 space-y-4";
const INPUT_CLASS =
  "w-full border border-slate-300 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-400";
const LABEL_CLASS = "block text-sm font-medium text-slate-700 mb-1";
const BUTTON_CLASS =
  "px-4 py-2 rounded-lg bg-blue-500 hover:bg-blue-600 disabled:bg-slate-300 text-white text-sm font-medium";

/** スコープ編集の 1 行 */
interface ScopeForm {
  id: number;
  actions: C4M.MoqtAction[];
  namespaceText: string;
  trackText: string;
}

let scopeIdCounter = 0;

function createScopeForm(): ScopeForm {
  return {
    id: scopeIdCounter++,
    actions: ["Publish"],
    namespaceText: "",
    trackText: "",
  };
}

// =============================================================================
// シグナル
// =============================================================================

const tokenInput = signal("");
const decodeError = signal<string | undefined>(undefined);
const decoded = signal<C4M.CatToken | undefined>(undefined);

const verifyKeyText = signal("");
/** 検証鍵の secret の入力形式 (`detect` は hex → base64url → text の順で解釈) */
const verifySecretFormat = signal<SecretInputFormat>("detect");
const verifyAlgorithm = signal<"any" | C4M.Algorithm>("any");
const verifyType = signal("");
const verifyResult = signal<string | undefined>(undefined);
const verifyOk = signal<boolean | undefined>(undefined);
const verifyBusy = signal(false);

const keyAlgorithm = signal<KeyGenerationAlgorithm>("Es256");
const generatedKey = signal<GeneratedKey | undefined>(undefined);
const keyError = signal<string | undefined>(undefined);
const keyBusy = signal(false);

const signingKeyText = signal("");
/** 署名鍵の secret の入力形式 (`detect` は hex → base64url → text の順で解釈) */
const signingSecretFormat = signal<SecretInputFormat>("detect");

const issuer = signal("");
const subject = signal("");
const audience = signal("");
const expiration = signal("");
const notBefore = signal("");
const issuedAt = signal("");
const cwtId = signal("");
const moqtReval = signal("");
const catdpopWindow = signal("");
const catdpopHonorJti = signal(false);
const includeJkt = signal(false);
const kid = signal("");
const outputFormat = signal<"compact" | "cose">("compact");
const scopeForms = signal<ScopeForm[]>([createScopeForm()]);
const buildError = signal<string | undefined>(undefined);
const buildBusy = signal(false);
const buildMessage = signal<string | undefined>(undefined);
const output = signal("");

const authorizeAction = signal<C4M.MoqtAction>("Publish");
const authorizeNamespace = signal("");
const authorizeTrack = signal("");

const copiedField = signal<string | undefined>(undefined);

// =============================================================================
// 共通
// =============================================================================

/**
 * エラーを画面表示用の 1 行へ整形する
 */
function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/**
 * フィールドの内容をクリップボードへコピーする
 */
function copyField(name: string, text: string): void {
  void navigator.clipboard.writeText(text).then(() => {
    copiedField.value = name;
    setTimeout(() => {
      if (copiedField.value === name) {
        copiedField.value = undefined;
      }
    }, 1500);
  });
}

function CopyButton({ name, text }: { name: string; text: string }) {
  return (
    <button
      type="button"
      data-testid={`c4m-copy-${name}`}
      class="px-3 py-1 rounded bg-slate-200 hover:bg-slate-300 text-xs font-medium"
      onClick={() => {
        copyField(name, text);
      }}
    >
      {copiedField.value === name ? "Copied" : "Copy"}
    </button>
  );
}

/**
 * 鍵入力の解釈結果を表示する
 *
 * `inspectKeyInput` の結果をそのまま出すことで、`Detect` が何を選んだのかと、
 * JWK が署名に使えるかを入力のたびに確認できるようにする。
 */
function KeyStatus({
  inspection,
  testId,
  role,
}: {
  inspection: KeyInputInspection;
  testId: string;
  role: "sign" | "verify";
}) {
  let text: string;
  let className: string;
  if (inspection.type === "error") {
    text = `Invalid key: ${inspection.message}`;
    className = "text-red-600";
  } else if (inspection.type === "jwk") {
    const cannotSign = role === "sign" && !inspection.hasPrivateKey;
    text = `JWK: ${describeJwk(inspection.jwk)}${cannotSign ? " (no private key, cannot sign)" : ""}`;
    className = cannotSign ? "text-amber-700" : "text-emerald-700";
  } else if (inspection.type === "secret") {
    text = `Secret: ${inspection.format}, ${inspection.secret.length} bytes`;
    className = "text-emerald-700";
  } else {
    text =
      role === "sign"
        ? "Empty: uses the generated key if there is one"
        : "Paste a JWK or a secret to verify";
    className = "text-slate-400";
  }
  return (
    <p data-testid={testId} class={`text-xs ${className}`}>
      {text}
    </p>
  );
}

// =============================================================================
// トークンのデコード
// =============================================================================

function decodeToken(): void {
  decodeError.value = undefined;
  decoded.value = undefined;
  const input = tokenInput.value.trim();
  if (input.length === 0) {
    decodeError.value = "Enter a token";
    return;
  }
  try {
    decoded.value = C4M.CatToken.decode(TEXT_ENCODER.encode(input));
  } catch (error) {
    decodeError.value = formatError(error);
  }
}

/**
 * 現在時刻でのクレーム検証結果を返す
 */
function validityText(token: C4M.CatToken): string {
  try {
    C4M.validateCatClaims(token.claims(), { referenceTimeSeconds: Date.now() / 1000 });
    return "valid at the current time";
  } catch (error) {
    if (error instanceof C4M.ClaimValidationError) {
      return `invalid: ${error.code}`;
    }
    return `invalid: ${formatError(error)}`;
  }
}

/**
 * UNIX 秒を ISO 8601 へ整形する (範囲外の値は "invalid date" にする)
 */
function formatTime(seconds: number): string {
  try {
    return new Date(seconds * 1000).toISOString();
  } catch {
    return "invalid date";
  }
}

/**
 * クレームの表示行を作る
 */
function claimRows(claims: C4M.CatClaims): Array<[string, string]> {
  const rows: Array<[string, string]> = [];
  if (claims.issuer !== undefined) {
    rows.push(["iss", claims.issuer]);
  }
  if (claims.subject !== undefined) {
    rows.push(["sub", claims.subject]);
  }
  if (claims.audience.length > 0) {
    rows.push(["aud", claims.audience.join(", ")]);
  }
  if (claims.expiration !== undefined) {
    rows.push(["exp", `${claims.expiration} (${formatTime(claims.expiration)})`]);
  }
  if (claims.notBefore !== undefined) {
    rows.push(["nbf", `${claims.notBefore} (${formatTime(claims.notBefore)})`]);
  }
  if (claims.issuedAt !== undefined) {
    rows.push(["iat", `${claims.issuedAt} (${formatTime(claims.issuedAt)})`]);
  }
  if (claims.cwtId !== undefined) {
    rows.push(["cti", formatBytes(claims.cwtId)]);
  }
  if (claims.moqtReval !== undefined) {
    rows.push(["moqt-reval", `${claims.moqtReval} (seconds)`]);
  }
  if (claims.confirmation !== undefined) {
    const jkt = C4M.confirmationJkt(claims.confirmation);
    rows.push(["cnf.jkt", jkt !== undefined ? formatBytes(jkt) : "(empty)"]);
  }
  if (claims.catdpop !== undefined) {
    rows.push([
      "catdpop",
      `window=${String(claims.catdpop.windowSeconds ?? "-")} honor-jti=${String(claims.catdpop.honorJti ?? "-")}`,
    ]);
  }
  if (claims.raw.length > 0) {
    rows.push(["raw", `${claims.raw.length} unparsed claims`]);
  }
  return rows;
}

function TokenPanel() {
  const token = decoded.value;
  const keyId = token?.header().keyId;
  const typ = token?.header().typ;
  const namespace = parseList(authorizeNamespace.value).map((field) => TEXT_ENCODER.encode(field));
  const authorizeResult =
    token === undefined
      ? "no token"
      : token.claims().moqt === undefined
        ? "no moqt claim"
        : C4M.authorizeCatClaims(
              token.claims(),
              authorizeAction.value,
              namespace,
              TEXT_ENCODER.encode(authorizeTrack.value),
            )
          ? "Allowed"
          : "Denied";

  return (
    <section class={CARD_CLASS} data-testid="c4m-token-panel">
      <h2 class="text-lg font-bold text-slate-800">Token</h2>
      <div>
        <label class={LABEL_CLASS} for="c4m-token-input">
          Compact token, COSE token (base64url), or JWS-style text
        </label>
        <textarea
          id="c4m-token-input"
          data-testid="c4m-token-input"
          class={`${INPUT_CLASS} h-24`}
          value={tokenInput.value}
          placeholder="eyJ... or base64url of the COSE bytes"
          onInput={(event) => {
            tokenInput.value = (event.target as HTMLTextAreaElement).value;
          }}
        />
      </div>
      <button
        type="button"
        data-testid="c4m-decode-button"
        class={BUTTON_CLASS}
        onClick={decodeToken}
      >
        Decode
      </button>
      {decodeError.value !== undefined && (
        <p data-testid="c4m-decode-error" class="text-sm text-red-600">
          {decodeError.value}
        </p>
      )}
      {token !== undefined && (
        <div class="space-y-3 text-sm">
          <dl class="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-1">
            <dt class="text-slate-500">format</dt>
            <dd data-testid="c4m-format">{token.format()}</dd>
            <dt class="text-slate-500">alg</dt>
            <dd data-testid="c4m-alg">
              {String(token.header().algorithm)} ({String(token.header().algorithmIdentifier)})
            </dd>
            <dt class="text-slate-500">kid</dt>
            <dd>{keyId !== undefined ? formatBytes(C4M.coseKeyIdAsBytes(keyId)) : "-"}</dd>
            <dt class="text-slate-500">typ</dt>
            <dd>{typ?.type === "textString" ? typ.value : "-"}</dd>
            <dt class="text-slate-500">validity</dt>
            <dd data-testid="c4m-validity">{validityText(token)}</dd>
          </dl>
          <div>
            <h3 class="font-semibold text-slate-700 mb-1">Claims</h3>
            <dl class="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-1">
              {claimRows(token.claims()).map(([name, value]) => (
                <div key={name} class="contents">
                  <dt class="text-slate-500">{name}</dt>
                  <dd data-testid={`c4m-claim-${name}`}>{value}</dd>
                </div>
              ))}
            </dl>
          </div>
          {token.claims().moqt !== undefined && (
            <div>
              <h3 class="font-semibold text-slate-700 mb-1">moqt scopes</h3>
              <ul class="space-y-1">
                {token.claims().moqt?.scopes.map((scope, index) => (
                  <li key={index} data-testid={`c4m-scope-${index}`} class="font-mono text-xs">
                    actions=[
                    {scope.actions
                      .map((action) => C4M.moqtActionFromKey(action) ?? action)
                      .join(", ")}
                    ] namespace=[{formatNamespaceMatches(scope.namespace)}] track=[
                    {scope.track !== undefined ? formatMatch(scope.track) : "any"}]
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div class="border-t border-slate-200 pt-3 space-y-2">
            <h3 class="font-semibold text-slate-700">Authorize check</h3>
            <div class="flex flex-wrap gap-2 items-end">
              <div>
                <label class={LABEL_CLASS} for="c4m-authorize-action">
                  Action
                </label>
                <select
                  id="c4m-authorize-action"
                  data-testid="c4m-authorize-action"
                  class="border border-slate-300 rounded-lg px-3 py-2 text-sm"
                  value={authorizeAction.value}
                  onChange={(event) => {
                    authorizeAction.value = (event.target as HTMLSelectElement)
                      .value as C4M.MoqtAction;
                  }}
                >
                  {C4M.MOQT_ACTIONS.map((action) => (
                    <option key={action} value={action}>
                      {action}
                    </option>
                  ))}
                </select>
              </div>
              <div class="flex-1">
                <label class={LABEL_CLASS} for="c4m-authorize-namespace">
                  Namespace (comma separated)
                </label>
                <input
                  id="c4m-authorize-namespace"
                  data-testid="c4m-authorize-namespace"
                  class={INPUT_CLASS}
                  value={authorizeNamespace.value}
                  onInput={(event) => {
                    authorizeNamespace.value = (event.target as HTMLInputElement).value;
                  }}
                />
              </div>
              <div class="flex-1">
                <label class={LABEL_CLASS} for="c4m-authorize-track">
                  Track
                </label>
                <input
                  id="c4m-authorize-track"
                  data-testid="c4m-authorize-track"
                  class={INPUT_CLASS}
                  value={authorizeTrack.value}
                  onInput={(event) => {
                    authorizeTrack.value = (event.target as HTMLInputElement).value;
                  }}
                />
              </div>
              <span
                data-testid="c4m-authorize-result"
                class={`px-3 py-2 rounded-lg text-sm font-medium ${authorizeResult === "Allowed" ? "bg-emerald-100 text-emerald-700" : "bg-slate-200 text-slate-700"}`}
              >
                {authorizeResult}
              </span>
            </div>
          </div>
          <div class="border-t border-slate-200 pt-3 space-y-2">
            <h3 class="font-semibold text-slate-700">Verify signature</h3>
            <div>
              <div class="flex items-center justify-between mb-1">
                <label class={LABEL_CLASS} for="c4m-verify-key">
                  Verification key (JWK, or secret for HMAC)
                </label>
                <select
                  data-testid="c4m-verify-secret-format"
                  class="border border-slate-300 rounded px-2 py-1 text-xs"
                  value={verifySecretFormat.value}
                  onChange={(event) => {
                    verifySecretFormat.value = (event.target as HTMLSelectElement)
                      .value as SecretInputFormat;
                  }}
                >
                  <option value="detect">Detect (hex, then base64url, then text)</option>
                  <option value="hex">hex</option>
                  <option value="base64url">base64url</option>
                  <option value="text">text</option>
                </select>
              </div>
              <textarea
                id="c4m-verify-key"
                data-testid="c4m-verify-key"
                class={`${INPUT_CLASS} h-20`}
                value={verifyKeyText.value}
                onInput={(event) => {
                  verifyKeyText.value = (event.target as HTMLTextAreaElement).value;
                }}
              />
              <KeyStatus
                inspection={inspectKeyInput(verifyKeyText.value, verifySecretFormat.value)}
                testId="c4m-verify-key-status"
                role="verify"
              />
            </div>
            <div class="flex flex-wrap gap-2 items-end">
              <div>
                <label class={LABEL_CLASS} for="c4m-verify-algorithm">
                  Expected alg
                </label>
                <select
                  id="c4m-verify-algorithm"
                  data-testid="c4m-verify-algorithm"
                  class="border border-slate-300 rounded-lg px-3 py-2 text-sm"
                  value={verifyAlgorithm.value}
                  onChange={(event) => {
                    verifyAlgorithm.value = (event.target as HTMLSelectElement).value as
                      | "any"
                      | C4M.Algorithm;
                  }}
                >
                  <option value="any">any</option>
                  {(
                    [
                      "HmacSha256",
                      "HmacSha384",
                      "HmacSha512",
                      "Es256",
                      "Es384",
                      "Es512",
                      "EdDsa",
                    ] as const
                  ).map((algorithm) => (
                    <option key={algorithm} value={algorithm}>
                      {algorithm}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label class={LABEL_CLASS} for="c4m-verify-typ">
                  Expected typ
                </label>
                <input
                  id="c4m-verify-typ"
                  data-testid="c4m-verify-typ"
                  class={INPUT_CLASS}
                  value={verifyType.value}
                  onInput={(event) => {
                    verifyType.value = (event.target as HTMLInputElement).value;
                  }}
                />
              </div>
              <button
                type="button"
                data-testid="c4m-verify-button"
                class={BUTTON_CLASS}
                disabled={verifyBusy.value}
                onClick={() => {
                  void verifyToken();
                }}
              >
                Verify
              </button>
              {verifyResult.value !== undefined && (
                <span
                  data-testid="c4m-verify-result"
                  class={`px-3 py-2 rounded-lg text-sm ${verifyOk.value === true ? "bg-emerald-100 text-emerald-700" : "bg-red-100 text-red-700"}`}
                >
                  {verifyResult.value}
                </span>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

/**
 * 検証鍵を入力から解決する
 */
function resolveVerifyKey(): C4M.CoseKey {
  const inspection = inspectKeyInput(verifyKeyText.value, verifySecretFormat.value);
  if (inspection.type === "error") {
    throw new Error(inspection.message);
  }
  if (inspection.type === "jwk") {
    return inspection.coseKey;
  }
  if (inspection.type === "secret") {
    return C4M.symmetricKey(inspection.secret);
  }
  throw new Error("enter a verification key");
}

async function verifyToken(): Promise<void> {
  const token = decoded.value;
  if (token === undefined) {
    return;
  }
  verifyBusy.value = true;
  verifyResult.value = undefined;
  verifyOk.value = undefined;
  try {
    const options: C4M.CatVerifyOptions = {};
    if (verifyAlgorithm.value !== "any") {
      options.expectedAlgorithm = verifyAlgorithm.value;
    }
    if (verifyType.value.trim().length > 0) {
      options.expectedType = verifyType.value.trim();
    }
    await token.verify(cryptoImpl, resolveVerifyKey(), options);
    verifyOk.value = true;
    verifyResult.value = "Signature verified";
  } catch (error) {
    verifyOk.value = false;
    verifyResult.value = formatError(error);
  } finally {
    verifyBusy.value = false;
  }
}

// =============================================================================
// 鍵生成
// =============================================================================

function KeyPanel() {
  const generated = generatedKey.value;
  return (
    <section class={CARD_CLASS} data-testid="c4m-key-panel">
      <h2 class="text-lg font-bold text-slate-800">Keys</h2>
      <p class="text-xs text-slate-500">
        Generated in your browser with Web Crypto and kept in memory only. Use test keys here; do
        not paste production secrets into a shared machine.
      </p>
      <div class="flex flex-wrap gap-2 items-end">
        <div>
          <label class={LABEL_CLASS} for="c4m-key-algorithm">
            Algorithm
          </label>
          <select
            id="c4m-key-algorithm"
            data-testid="c4m-key-algorithm"
            class="border border-slate-300 rounded-lg px-3 py-2 text-sm"
            value={keyAlgorithm.value}
            onChange={(event) => {
              keyAlgorithm.value = (event.target as HTMLSelectElement)
                .value as KeyGenerationAlgorithm;
            }}
          >
            <option value="Es256">ES256 (P-256)</option>
            <option value="Es384">ES384 (P-384)</option>
            <option value="Es512">ES512 (P-521)</option>
            <option value="EdDsa">EdDSA (Ed25519)</option>
            <option value="HmacSha256">HMAC-SHA256 (secret)</option>
          </select>
        </div>
        <button
          type="button"
          data-testid="c4m-generate-key-button"
          class={BUTTON_CLASS}
          disabled={keyBusy.value}
          onClick={() => {
            void generateKeyPair();
          }}
        >
          Generate
        </button>
      </div>
      {keyError.value !== undefined && (
        <p data-testid="c4m-key-error" class="text-sm text-red-600">
          {keyError.value}
        </p>
      )}
      {generated !== undefined && generated.kind === "asymmetric" && (
        <div class="space-y-3">
          <div>
            <div class="flex items-center justify-between mb-1">
              <label class={LABEL_CLASS} for="c4m-key-public">
                Public JWK
              </label>
              <CopyButton name="public-jwk" text={C4M.encodeJwk(generated.publicJwk)} />
            </div>
            <textarea
              id="c4m-key-public"
              data-testid="c4m-key-public"
              class={`${INPUT_CLASS} h-20`}
              readonly
              value={C4M.encodeJwk(generated.publicJwk)}
            />
          </div>
          <div>
            <div class="flex items-center justify-between mb-1">
              <label class={LABEL_CLASS} for="c4m-key-private">
                Private JWK
              </label>
              <CopyButton name="private-jwk" text={C4M.encodeJwk(generated.privateJwk)} />
            </div>
            <textarea
              id="c4m-key-private"
              data-testid="c4m-key-private"
              class={`${INPUT_CLASS} h-20`}
              readonly
              value={C4M.encodeJwk(generated.privateJwk)}
            />
          </div>
          <div class="flex gap-2">
            <button
              type="button"
              data-testid="c4m-use-for-verify"
              class="px-3 py-1 rounded bg-slate-200 hover:bg-slate-300 text-xs font-medium"
              onClick={() => {
                verifyKeyText.value = C4M.encodeJwk(generated.publicJwk);
                verifyAlgorithm.value = generated.algorithm;
              }}
            >
              Use as verification key
            </button>
            <button
              type="button"
              data-testid="c4m-use-for-sign"
              class="px-3 py-1 rounded bg-slate-200 hover:bg-slate-300 text-xs font-medium"
              onClick={() => {
                signingKeyText.value = C4M.encodeJwk(generated.privateJwk);
              }}
            >
              Use as signing key
            </button>
          </div>
        </div>
      )}
      {generated !== undefined && generated.kind === "symmetric" && (
        <div class="space-y-3">
          <div>
            <div class="flex items-center justify-between mb-1">
              <label class={LABEL_CLASS} for="c4m-key-secret">
                Secret (hex)
              </label>
              <CopyButton name="secret" text={bytesToHex(generated.secret)} />
            </div>
            <textarea
              id="c4m-key-secret"
              data-testid="c4m-key-secret"
              class={`${INPUT_CLASS} h-16`}
              readonly
              value={bytesToHex(generated.secret)}
            />
          </div>
          <div class="flex gap-2">
            <button
              type="button"
              data-testid="c4m-use-for-verify"
              class="px-3 py-1 rounded bg-slate-200 hover:bg-slate-300 text-xs font-medium"
              onClick={() => {
                verifyKeyText.value = bytesToHex(generated.secret);
                verifyAlgorithm.value = "HmacSha256";
              }}
            >
              Use as verification key
            </button>
            <button
              type="button"
              data-testid="c4m-use-for-sign"
              class="px-3 py-1 rounded bg-slate-200 hover:bg-slate-300 text-xs font-medium"
              onClick={() => {
                signingKeyText.value = bytesToHex(generated.secret);
                signingSecretFormat.value = "hex";
              }}
            >
              Use as signing key
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

async function generateKeyPair(): Promise<void> {
  keyBusy.value = true;
  keyError.value = undefined;
  try {
    generatedKey.value = await generateKey(keyAlgorithm.value);
  } catch (error) {
    keyError.value = formatError(error);
  } finally {
    keyBusy.value = false;
  }
}

// =============================================================================
// トークン発行
// =============================================================================

/**
 * 署名鍵を入力から解決する
 */
function resolveSigningKey(): { coseKey: C4M.CoseKey; publicJwk: C4M.Jwk | undefined } {
  const inspection = inspectKeyInput(signingKeyText.value, signingSecretFormat.value);
  if (inspection.type === "error") {
    throw new Error(inspection.message);
  }
  if (inspection.type === "jwk") {
    if (!inspection.hasPrivateKey) {
      throw new Error("the signing JWK has no private key");
    }
    return { coseKey: inspection.coseKey, publicJwk: publicJwkOf(inspection.jwk) };
  }
  if (inspection.type === "secret") {
    return { coseKey: C4M.symmetricKey(inspection.secret), publicJwk: undefined };
  }
  const generated = generatedKey.value;
  if (generated === undefined) {
    throw new Error("generate a key or paste a signing key");
  }
  if (generated.kind === "asymmetric") {
    return { coseKey: generated.privateCoseKey, publicJwk: generated.publicJwk };
  }
  return { coseKey: C4M.symmetricKey(generated.secret), publicJwk: undefined };
}

/**
 * フォームからクレームセットを組み立てる
 */
function buildClaims(): C4M.CatClaims {
  const claims = C4M.createCatClaims();
  if (issuer.value.trim().length > 0) {
    claims.issuer = issuer.value.trim();
  }
  if (subject.value.trim().length > 0) {
    claims.subject = subject.value.trim();
  }
  claims.audience = parseList(audience.value);
  const expirationValue = parseOptionalNumber(expiration.value, "exp");
  if (expirationValue !== undefined) {
    claims.expiration = expirationValue;
  }
  const notBeforeValue = parseOptionalNumber(notBefore.value, "nbf");
  if (notBeforeValue !== undefined) {
    claims.notBefore = notBeforeValue;
  }
  const issuedAtValue = parseOptionalNumber(issuedAt.value, "iat");
  if (issuedAtValue !== undefined) {
    claims.issuedAt = issuedAtValue;
  }
  if (cwtId.value.trim().length > 0) {
    claims.cwtId = TEXT_ENCODER.encode(cwtId.value.trim());
  }
  const moqtRevalValue = parseOptionalNumber(moqtReval.value, "moqt-reval");
  if (moqtRevalValue !== undefined) {
    claims.moqtReval = moqtRevalValue;
  }
  const catdpopWindowValue = parseOptionalNumber(catdpopWindow.value, "catdpop window");
  if (catdpopWindowValue !== undefined) {
    claims.catdpop = C4M.createCatDpop(catdpopWindowValue, catdpopHonorJti.value);
  }
  const scopes: C4M.MoqtScope[] = [];
  for (const form of scopeForms.value) {
    if (form.actions.length === 0) {
      throw new Error("each scope needs at least one action");
    }
    const scope = C4M.createMoqtScope(form.actions);
    scope.namespace = parseNamespaceMatches(form.namespaceText);
    scope.track = parseTrackMatch(form.trackText);
    scopes.push(scope);
  }
  if (scopes.length > 0) {
    claims.moqt = { scopes };
  }
  return claims;
}

async function buildToken(): Promise<void> {
  buildBusy.value = true;
  buildError.value = undefined;
  buildMessage.value = undefined;
  try {
    const signing = resolveSigningKey();
    const claims = buildClaims();
    if (includeJkt.value) {
      if (signing.publicJwk === undefined) {
        throw new Error("cnf jkt requires an asymmetric signing key");
      }
      const thumbprint = await C4M.jwkThumbprintSha256(cryptoImpl, signing.publicJwk);
      claims.confirmation = C4M.createConfirmation();
      claims.confirmation.jwkThumbprint = thumbprint;
    }
    const builder = new C4M.CatTokenBuilder({ claims });
    if (kid.value.trim().length > 0) {
      builder.keyId(C4M.coseKeyIdText(kid.value.trim()));
    }
    if (outputFormat.value === "compact") {
      output.value = await builder.buildCompact(cryptoImpl, signing.coseKey);
    } else {
      output.value = C4M.encodeBase64Url(await builder.buildCose(cryptoImpl, signing.coseKey));
    }
    buildMessage.value = "Token issued";
  } catch (error) {
    buildError.value = formatError(error);
  } finally {
    buildBusy.value = false;
  }
}

function ScopeEditor({ form, index }: { form: ScopeForm; index: number }) {
  return (
    <div
      class="border border-slate-200 rounded-lg p-3 space-y-2"
      data-testid={`c4m-scope-form-${index}`}
    >
      <div class="flex flex-wrap gap-x-4 gap-y-1">
        {C4M.MOQT_ACTIONS.map((action) => (
          <label key={action} class="flex items-center gap-1 text-xs text-slate-700">
            <input
              type="checkbox"
              data-testid={`c4m-scope-${index}-action-${action}`}
              checked={form.actions.includes(action)}
              onChange={(event) => {
                const checked = (event.target as HTMLInputElement).checked;
                scopeForms.value = scopeForms.value.map((scope) =>
                  scope.id === form.id
                    ? {
                        ...scope,
                        actions: checked
                          ? [...scope.actions, action]
                          : scope.actions.filter((entry) => entry !== action),
                      }
                    : scope,
                );
              }}
            />
            {action}
          </label>
        ))}
      </div>
      <div class="flex gap-2">
        <div class="flex-1">
          <label class={LABEL_CLASS} for={`c4m-scope-${index}-namespace`}>
            Namespace (comma separated, e.g. &quot;example.com, prefix:live, end&quot;)
          </label>
          <input
            id={`c4m-scope-${index}-namespace`}
            data-testid={`c4m-scope-${index}-namespace`}
            class={INPUT_CLASS}
            value={form.namespaceText}
            onInput={(event) => {
              const value = (event.target as HTMLInputElement).value;
              scopeForms.value = scopeForms.value.map((scope) =>
                scope.id === form.id ? { ...scope, namespaceText: value } : scope,
              );
            }}
          />
        </div>
        <div class="flex-1">
          <label class={LABEL_CLASS} for={`c4m-scope-${index}-track`}>
            Track (empty = any, e.g. &quot;prefix:video-&quot;)
          </label>
          <input
            id={`c4m-scope-${index}-track`}
            data-testid={`c4m-scope-${index}-track`}
            class={INPUT_CLASS}
            value={form.trackText}
            onInput={(event) => {
              const value = (event.target as HTMLInputElement).value;
              scopeForms.value = scopeForms.value.map((scope) =>
                scope.id === form.id ? { ...scope, trackText: value } : scope,
              );
            }}
          />
        </div>
      </div>
      <button
        type="button"
        data-testid={`c4m-scope-${index}-remove`}
        class="px-3 py-1 rounded bg-red-100 hover:bg-red-200 text-red-700 text-xs font-medium"
        onClick={() => {
          scopeForms.value = scopeForms.value.filter((scope) => scope.id !== form.id);
        }}
      >
        Remove scope
      </button>
    </div>
  );
}

function IssuePanel() {
  return (
    <section class={CARD_CLASS} data-testid="c4m-issue-panel">
      <h2 class="text-lg font-bold text-slate-800">Issue token</h2>
      <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
        {(
          [
            ["issuer", "iss", issuer],
            ["subject", "sub", subject],
            ["audience", "aud (comma separated)", audience],
            ["expiration", "exp (unix seconds)", expiration],
            ["not-before", "nbf (unix seconds)", notBefore],
            ["issued-at", "iat (unix seconds)", issuedAt],
            ["cwt-id", "cti (text)", cwtId],
            ["moqt-reval", "moqt-reval (seconds)", moqtReval],
            ["kid", "kid", kid],
            ["catdpop-window", "catdpop window (seconds)", catdpopWindow],
          ] as const
        ).map(([testId, label, field]) => (
          <div key={testId}>
            <label class={LABEL_CLASS} for={`c4m-${testId}`}>
              {label}
            </label>
            <input
              id={`c4m-${testId}`}
              data-testid={`c4m-${testId}`}
              class={INPUT_CLASS}
              value={field.value}
              onInput={(event) => {
                field.value = (event.target as HTMLInputElement).value;
              }}
            />
          </div>
        ))}
      </div>
      <div class="flex flex-wrap gap-4 items-center text-sm text-slate-700">
        <label class="flex items-center gap-1">
          <input
            type="checkbox"
            data-testid="c4m-catdpop-honor-jti"
            checked={catdpopHonorJti.value}
            onChange={(event) => {
              catdpopHonorJti.value = (event.target as HTMLInputElement).checked;
            }}
          />
          catdpop honor jti
        </label>
        <label class="flex items-center gap-1">
          <input
            type="checkbox"
            data-testid="c4m-include-jkt"
            checked={includeJkt.value}
            onChange={(event) => {
              includeJkt.value = (event.target as HTMLInputElement).checked;
            }}
          />
          cnf jkt from the signing key
        </label>
        <div class="flex items-center gap-2">
          <label class="text-sm" for="c4m-output-format">
            Format
          </label>
          <select
            id="c4m-output-format"
            data-testid="c4m-output-format"
            class="border border-slate-300 rounded-lg px-3 py-2 text-sm"
            value={outputFormat.value}
            onChange={(event) => {
              outputFormat.value = (event.target as HTMLSelectElement).value as "compact" | "cose";
            }}
          >
            <option value="compact">compact</option>
            <option value="cose">COSE (base64url)</option>
          </select>
        </div>
      </div>
      <div>
        <div class="flex items-center justify-between mb-1">
          <label class={LABEL_CLASS} for="c4m-signing-key">
            Signing key (JWK with a private key, or secret for HMAC). Empty uses the generated key.
          </label>
          <div class="flex items-center gap-2">
            <select
              data-testid="c4m-signing-secret-format"
              class="border border-slate-300 rounded px-2 py-1 text-xs"
              value={signingSecretFormat.value}
              onChange={(event) => {
                signingSecretFormat.value = (event.target as HTMLSelectElement)
                  .value as SecretInputFormat;
              }}
            >
              <option value="detect">Detect (hex, then base64url, then text)</option>
              <option value="hex">hex</option>
              <option value="base64url">base64url</option>
              <option value="text">text</option>
            </select>
          </div>
        </div>
        <textarea
          id="c4m-signing-key"
          data-testid="c4m-signing-key"
          class={`${INPUT_CLASS} h-20`}
          value={signingKeyText.value}
          onInput={(event) => {
            signingKeyText.value = (event.target as HTMLTextAreaElement).value;
          }}
        />
        <KeyStatus
          inspection={inspectKeyInput(signingKeyText.value, signingSecretFormat.value)}
          testId="c4m-signing-key-status"
          role="sign"
        />
      </div>
      <div class="space-y-2">
        <h3 class="font-semibold text-slate-700">moqt scopes</h3>
        {scopeForms.value.map((form, index) => (
          <ScopeEditor key={form.id} form={form} index={index} />
        ))}
        <button
          type="button"
          data-testid="c4m-scope-add"
          class="px-3 py-1 rounded bg-slate-200 hover:bg-slate-300 text-xs font-medium"
          onClick={() => {
            scopeForms.value = [...scopeForms.value, createScopeForm()];
          }}
        >
          Add scope
        </button>
      </div>
      <div class="flex items-center gap-3">
        <button
          type="button"
          data-testid="c4m-build-button"
          class={BUTTON_CLASS}
          disabled={buildBusy.value}
          onClick={() => {
            void buildToken();
          }}
        >
          Build
        </button>
        {buildMessage.value !== undefined && (
          <span class="text-sm text-emerald-700">{buildMessage.value}</span>
        )}
        {buildError.value !== undefined && (
          <span data-testid="c4m-build-error" class="text-sm text-red-600">
            {buildError.value}
          </span>
        )}
      </div>
      {output.value.length > 0 && (
        <div>
          <div class="flex items-center justify-between mb-1">
            <label class={LABEL_CLASS} for="c4m-output">
              Output
            </label>
            <div class="flex gap-2">
              <CopyButton name="output" text={output.value} />
              <button
                type="button"
                data-testid="c4m-output-load"
                class="px-3 py-1 rounded bg-slate-200 hover:bg-slate-300 text-xs font-medium"
                onClick={() => {
                  tokenInput.value = output.value;
                  decodeToken();
                  window.scrollTo({ top: 0, behavior: "smooth" });
                }}
              >
                Load into decoder
              </button>
            </div>
          </div>
          <textarea
            id="c4m-output"
            data-testid="c4m-output"
            class={`${INPUT_CLASS} h-24`}
            readonly
            value={output.value}
          />
        </div>
      )}
    </section>
  );
}

// =============================================================================
// ページ
// =============================================================================

export function App() {
  return (
    <div class="min-h-screen bg-slate-100">
      <div class="container mx-auto px-4 py-8 max-w-6xl space-y-6">
        <header>
          <h1 class="text-2xl font-bold text-slate-800" data-testid="c4m-title">
            C4M DevTools
          </h1>
          <p class="text-sm text-slate-500 mt-1">
            Decode, verify, and issue CAT tokens for draft-ietf-moq-c4m-01. Keys are used in this
            browser tab only and are never stored or uploaded.
          </p>
          <p class="text-sm mt-2">
            <a href="/index.html" class="text-blue-500 hover:text-blue-600 underline">
              MOQT DevTools
            </a>
            {" / "}
            <a
              href="/webtransport-devtools.html"
              class="text-blue-500 hover:text-blue-600 underline"
            >
              WebTransport DevTools
            </a>
            {" / "}
            <a href="/webcodecs-devtools.html" class="text-blue-500 hover:text-blue-600 underline">
              WebCodecs DevTools
            </a>
          </p>
        </header>
        <TokenPanel />
        <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <KeyPanel />
          <IssuePanel />
        </div>
      </div>
    </div>
  );
}
