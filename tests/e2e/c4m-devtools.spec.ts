import { test, expect } from "@playwright/test";
import { C4M } from "moqt-js";

// C4M DevTools の UI テスト
// dev サーバーは playwright.config.ts の webServer で起動される (port 5173)。
// 鍵の生成は Web Crypto API で行い、トークンの発行から検証までをブラウザ内で確認する。
const C4M_DEVTOOLS_URL = "/c4m-devtools.html";

const TEXT_ENCODER = new TextEncoder();

/**
 * 付録 A と異なる `moqt` claim key で CAT を発行する
 *
 * C4M 02 の `moqt` claim key は IANA 未割当で、peer ごとに異なる値を合意する。
 * devtools が付録 A の preset で解釈できないトークンでも表示できることを確かめる。
 */
async function buildCatWithCustomMoqtLabel(): Promise<string> {
  const scope = C4M.createMoqtScope(["Publish"]);
  scope.namespace.push(C4M.namespaceMatchValue(C4M.exactMatch(TEXT_ENCODER.encode("example.com"))));
  scope.namespace.push(C4M.namespaceMatchEnd());
  scope.track = C4M.exactMatch(TEXT_ENCODER.encode("video-hd"));
  const claims = C4M.createCatClaims();
  claims.moqt = { scopes: [scope] };
  const key = C4M.symmetricKey(new Uint8Array(32).fill(0x0b));
  const tokenBytes = await new C4M.CatTokenBuilder({
    claims,
    claimLabels: { moqt: 999, moqtReval: 1000 },
  }).buildCose(new C4M.WebCrypto(), key);
  return C4M.encodeBase64Url(tokenBytes);
}

test("生成した Ed25519 の鍵で COSE 形式のトークンを発行して検証できる", async ({ page }) => {
  await page.goto(C4M_DEVTOOLS_URL);
  await expect(page.getByTestId("c4m-title")).toHaveText("C4M DevTools");

  // EdDSA の鍵ペアを生成する
  await page.getByTestId("c4m-key-algorithm").selectOption("EdDsa");
  await page.getByTestId("c4m-generate-key-button").click();
  await expect(page.getByTestId("c4m-key-public")).not.toHaveValue("");
  await expect(page.getByTestId("c4m-key-private")).not.toHaveValue("");

  // 生成した鍵を署名と検証に使う
  await page.getByTestId("c4m-use-for-sign").click();
  await page.getByTestId("c4m-use-for-verify").click();
  // 署名鍵の解釈結果はすぐに表示される
  await expect(page.getByTestId("c4m-signing-key-status")).toContainText("private key");

  // Publish を example.com にだけ許可するスコープを設定する
  await page.getByTestId("c4m-scope-0-namespace").fill("example.com");

  // クレームを設定して発行する (出力は常に COSE 形式)
  await page.getByTestId("c4m-issuer").fill("https://auth.example.com");
  await page.getByTestId("c4m-expiration").fill("1700086400");
  await page.getByTestId("c4m-build-button").click();
  await expect(page.getByTestId("c4m-build-error")).toHaveCount(0);
  await expect(page.getByTestId("c4m-output")).toHaveValue(/.+/);

  // 出力は base64url で包んだ COSE であり、ピリオドを含まない
  const tokenText = await page.getByTestId("c4m-output").inputValue();
  expect(tokenText).not.toContain(".");

  // 発行したトークンをデコードして検証する
  await page.getByTestId("c4m-output-load").click();
  await expect(page.getByTestId("c4m-decode-error")).toHaveCount(0);
  await expect(page.getByTestId("c4m-format")).toHaveText("coseSign1");
  await expect(page.getByTestId("c4m-alg")).toContainText("EdDsa");
  await expect(page.getByTestId("c4m-claim-iss")).toHaveText("https://auth.example.com");
  // 検証鍵の解釈結果はトークンの検証欄に表示される
  await expect(page.getByTestId("c4m-verify-key-status")).toContainText("public key");
  await page.getByTestId("c4m-verify-button").click();
  await expect(page.getByTestId("c4m-verify-result")).toHaveText("Signature verified");

  // 認可判定: PUBLISH は example.com にだけ許可される
  await page.getByTestId("c4m-authorize-action").selectOption("PUBLISH");
  await page.getByTestId("c4m-authorize-namespace").fill("example.com");
  await page.getByTestId("c4m-authorize-track").fill("video-hd");
  await expect(page.getByTestId("c4m-authorize-result")).toHaveText("Allowed");
  await page.getByTestId("c4m-authorize-namespace").fill("other.example.com");
  await expect(page.getByTestId("c4m-authorize-result")).toHaveText("Denied");
  await page.getByTestId("c4m-authorize-action").selectOption("SUBSCRIBE");
  await page.getByTestId("c4m-authorize-namespace").fill("example.com");
  await expect(page.getByTestId("c4m-authorize-result")).toHaveText("Denied");
});

test("moqt-reval を持つトークンは再検証が必要である旨を表示する", async ({ page }) => {
  await page.goto(C4M_DEVTOOLS_URL);

  // 鍵を生成して署名 / 検証に使う
  await page.getByTestId("c4m-key-algorithm").selectOption("HmacSha256");
  await page.getByTestId("c4m-generate-key-button").click();
  await page.getByTestId("c4m-use-for-sign").click();
  await page.getByTestId("c4m-use-for-verify").click();

  // 再検証の間隔を 300 秒にしてトークンを発行する
  await page.getByTestId("c4m-issuer").fill("https://auth.example.com");
  await page.getByTestId("c4m-moqt-reval").fill("300");
  await page.getByTestId("c4m-build-button").click();
  await expect(page.getByTestId("c4m-build-error")).toHaveCount(0);

  // デコードすると、invalid ではなく再検証が必要である旨が表示される
  await page.getByTestId("c4m-output-load").click();
  await expect(page.getByTestId("c4m-decode-error")).toHaveCount(0);
  await expect(page.getByTestId("c4m-validity")).toHaveText(
    "valid, requires revalidation every 300 seconds (this tool does not revalidate)",
  );
});

test("生成した HMAC の対称鍵で COSE 形式のトークンを発行して検証できる", async ({ page }) => {
  await page.goto(C4M_DEVTOOLS_URL);

  // HMAC-SHA256 の対称鍵を生成する
  await page.getByTestId("c4m-key-algorithm").selectOption("HmacSha256");
  await page.getByTestId("c4m-generate-key-button").click();
  await expect(page.getByTestId("c4m-key-secret")).not.toHaveValue("");
  await page.getByTestId("c4m-use-for-sign").click();
  await page.getByTestId("c4m-use-for-verify").click();
  // 生成した secret は hex として解釈される
  await expect(page.getByTestId("c4m-signing-key-status")).toContainText("hex, 32 bytes");

  // COSE 形式で発行する
  await page.getByTestId("c4m-issuer").fill("https://auth.example.com");
  await page.getByTestId("c4m-build-button").click();
  await expect(page.getByTestId("c4m-output")).toHaveValue(/.+/);

  // デコードすると COSE_Mac0 として判別される
  await page.getByTestId("c4m-output-load").click();
  await expect(page.getByTestId("c4m-format")).toHaveText("coseMac0");
  await expect(page.getByTestId("c4m-alg")).toContainText("HmacSha256");
  await expect(page.getByTestId("c4m-verify-key-status")).toContainText("hex, 32 bytes");
  await page.getByTestId("c4m-verify-button").click();
  await expect(page.getByTestId("c4m-verify-result")).toHaveText("Signature verified");
});

test("不正なトークンはデコードエラーになる", async ({ page }) => {
  await page.goto(C4M_DEVTOOLS_URL);

  await page.getByTestId("c4m-token-input").fill("not a token");
  await page.getByTestId("c4m-decode-button").click();
  await expect(page.getByTestId("c4m-decode-error")).not.toHaveText("");

  // 署名の検証鍵を入れずに検証するとエラーになる
  await page.getByTestId("c4m-decode-error").waitFor();
  await expect(page.getByTestId("c4m-token-panel")).toContainText("Token");
});

test("cnf 付きトークンの認可は DPoP proof 未検証のため Denied になる", async ({ page }) => {
  await page.goto(C4M_DEVTOOLS_URL);

  // 署名用の EdDSA 鍵を生成し、cnf jkt の算出と署名に使う
  await page.getByTestId("c4m-key-algorithm").selectOption("EdDsa");
  await page.getByTestId("c4m-generate-key-button").click();
  await expect(page.getByTestId("c4m-key-public")).not.toHaveValue("");
  await page.getByTestId("c4m-use-for-sign").click();

  // PUBLISH を example.com に許可する moqt scope と cnf.jkt を持つトークンを発行する
  await page.getByTestId("c4m-scope-0-namespace").fill("example.com");
  await page.getByTestId("c4m-issuer").fill("https://auth.example.com");
  await page.getByTestId("c4m-expiration").fill("1700086400");
  await page.getByTestId("c4m-include-jkt").check();
  await page.getByTestId("c4m-build-button").click();
  await expect(page.getByTestId("c4m-build-error")).toHaveCount(0);
  await page.getByTestId("c4m-output-load").click();
  await expect(page.getByTestId("c4m-decode-error")).toHaveCount(0);

  // moqt scope は PUBLISH を許可しているが、DevTools は DPoP proof を検証しないため
  // cnf 付きトークンの認可は Denied になる。理由も画面に表示する
  await page.getByTestId("c4m-authorize-action").selectOption("PUBLISH");
  await page.getByTestId("c4m-authorize-namespace").fill("example.com");
  await page.getByTestId("c4m-authorize-track").fill("video-hd");
  await expect(page.getByTestId("c4m-authorize-result")).toHaveText("Denied");
  await expect(page.getByTestId("c4m-authorize-cnf-note")).toBeVisible();
});

// `moqt` claim key が付録 A の preset と違っても、raw の claim から `moqt` クレームを
// 見つけてスコープと認可判定に使う
test("付録 A と異なる moqt claim key のトークンでもスコープと認可判定を表示する", async ({
  page,
}) => {
  const c4m = await buildCatWithCustomMoqtLabel();
  await page.goto(C4M_DEVTOOLS_URL);

  await page.getByTestId("c4m-token-input").fill(c4m);
  await page.getByTestId("c4m-decode-button").click();

  await expect(page.getByTestId("c4m-scope-0")).toContainText("actions=[PUBLISH]");
  await expect(page.getByTestId("c4m-scope-0")).toContainText("namespace=[example.com, end]");
  await expect(page.getByTestId("c4m-scope-0")).toContainText("track=[video-hd]");
  // 付録 A の preset ではなく raw の claim から見つけた key を出す
  await expect(page.getByTestId("c4m-scope-claim-label")).toHaveText("(claim key 999)");
  // 解釈しなかった claim の key も Claims の raw 行に出す
  await expect(page.getByTestId("c4m-claim-raw")).toContainText("keys: 999");

  // 認可判定も検出した moqt クレームを使う
  await page.getByTestId("c4m-authorize-action").selectOption("PUBLISH");
  await page.getByTestId("c4m-authorize-namespace").fill("example.com");
  await page.getByTestId("c4m-authorize-track").fill("video-hd");
  await expect(page.getByTestId("c4m-authorize-result")).toHaveText("Allowed");
});
