import { test, expect } from "@playwright/test";
import { C4M } from "moqt-js";
import { DEVTOOLS_URL } from "./urls";

// devtools の Authorization Token の UI テスト
// 実リレーは起動しない。c4m の取り込みと Token Type 入力による解除を UI で観測する。
// dev サーバーは playwright.config.ts の webServer で起動される (port 5173)

// c4m の Base64 トークン (draft-ietf-moq-msf-01 §11.1.1 / draft-ietf-moq-c4m-02 §2)
const C4M_BASE64 = "QUFB";

const TEXT_ENCODER = new TextEncoder();
// C4M 02 付録 A の検証用 preset (Private Use の -65537 / -65538) を明示して使う
const CLAIM_LABELS = C4M.C4M_DRAFT_02_EXAMPLE_CLAIM_LABELS;

// moqt クレームに exact な track name のスコープを持つ CAT を発行し、URL に載る base64url
// (パディング省略) で返す。トークンの発行にはライブラリの実装 (Web Crypto API) を使う
async function buildCatWithTrackNames(
  trackNames: readonly string[],
  claimLabels: C4M.C4mClaimLabels = CLAIM_LABELS,
): Promise<string> {
  const scopes = trackNames.map((trackName) => {
    const scope = C4M.createMoqtScope(["Subscribe", "Publish"]);
    scope.namespace.push(C4M.namespaceMatchValue(C4M.exactMatch(TEXT_ENCODER.encode("15551"))));
    scope.namespace.push(C4M.namespaceMatchValue(C4M.exactMatch(TEXT_ENCODER.encode("spam"))));
    scope.namespace.push(C4M.namespaceMatchEnd());
    scope.track = C4M.exactMatch(TEXT_ENCODER.encode(trackName));
    return scope;
  });
  const claims = C4M.createCatClaims();
  claims.moqt = { scopes };
  const key = C4M.symmetricKey(new Uint8Array(32).fill(0x0b));
  const tokenBytes = await new C4M.CatTokenBuilder({
    claims,
    claimLabels,
  }).buildCose(new C4M.WebCrypto(), key);
  return C4M.encodeBase64Url(tokenBytes);
}

test("c4m の取り込みで表示が出て Token Type が 1 (CAT) になり、Token Type の編集で解除される", async ({
  page,
}) => {
  // MSF URL の c4m は fragment に含まれるため、URLSearchParams で組み立てる
  // (素の文字列連結では # 以降が落ちて c4m が取り込まれない)
  const params = new URLSearchParams();
  params.set("url", `moqt://example.com/moqt#msf:room-123--catalog&c4m=${C4M_BASE64}`);

  await page.goto(`${DEVTOOLS_URL}?${params.toString()}`);

  // c4m から読み込んだトークンの表示が 1 つだけ出る
  await expect(page.getByTestId("authorization-token-c4m")).toHaveCount(1);
  // draft-ietf-moq-c4m-02 §8.2 Table 4: Token Type 0x01 は CAT
  await expect(page.getByTestId("authorization-token-type")).toHaveValue("1");
  // c4m の取り込みでは Token Value をクリアする
  await expect(page.getByTestId("authorization-token-value")).toHaveValue("");

  // Token Type を手入力すると c4m の取り込みが解除される (入力した値はそのまま使う)。
  // moqt-js の connect() は URL の c4m を SETUP に載せるため、URL からも c4m が消える
  await page.getByTestId("authorization-token-type").fill("0");
  await expect(page.getByTestId("authorization-token-c4m")).toHaveCount(0);
  await expect(page.getByTestId("authorization-token-type")).toHaveValue("0");
  await expect(page.getByTestId("moqt-uri")).toHaveValue(
    "moqt://example.com/moqt#msf:room-123--catalog",
  );
});

// Clear は取り込みの解除と Token Type のリセットに加え、MOQT URI からも c4m を取り除く。
// moqt-js の connect() が URI の c4m を SETUP の Authorization Token として送るため、
// URL に値が残っていると解除したつもりでも送信され続ける
// (draft-ietf-moq-msf-01 §11.1.1 / §11.4.3)。
test("c4m の Clear で取り込みが解除され MOQT URI からも c4m が消える", async ({ page }) => {
  const params = new URLSearchParams();
  params.set(
    "url",
    `moqt://example.com/moqt#msf:room-123--catalog&connection=wt&c4m=${C4M_BASE64}`,
  );

  await page.goto(`${DEVTOOLS_URL}?${params.toString()}`);
  await expect(page.getByTestId("authorization-token-c4m")).toHaveCount(1);

  await page.getByTestId("authorization-token-c4m-clear").click();

  await expect(page.getByTestId("authorization-token-c4m")).toHaveCount(0);
  await expect(page.getByTestId("authorization-token-type")).toHaveValue("0");
  // c4m 以外の parameter と track-identifier は残す
  await expect(page.getByTestId("moqt-uri")).toHaveValue(
    "moqt://example.com/moqt#msf:room-123--catalog&connection=wt",
  );
  await expect(page.getByTestId("uri-fragment")).toHaveValue("msf:room-123--catalog&connection=wt");
});

test("Token Value の編集で c4m が解除され Token Type が 0 に戻る", async ({ page }) => {
  const params = new URLSearchParams();
  params.set("url", `moqt://example.com/moqt#msf:room-123--catalog&c4m=${C4M_BASE64}`);

  await page.goto(`${DEVTOOLS_URL}?${params.toString()}`);
  await expect(page.getByTestId("authorization-token-c4m")).toHaveCount(1);

  // 手入力の UTF-8 トークンは CAT ではないため、c4m 由来の Token Type 1 を残さない
  await page.getByTestId("authorization-token-value").fill("manual-token");
  await expect(page.getByTestId("authorization-token-c4m")).toHaveCount(0);
  await expect(page.getByTestId("authorization-token-type")).toHaveValue("0");
  await expect(page.getByTestId("authorization-token-value")).toHaveValue("manual-token");
  // 手入力のトークンへ置き換えたため、URL の c4m も取り除く
  await expect(page.getByTestId("moqt-uri")).toHaveValue(
    "moqt://example.com/moqt#msf:room-123--catalog",
  );
});

test("c4m が無い URL では既定の Token Type 0 のままで c4m の表示も出ない", async ({ page }) => {
  await page.goto(DEVTOOLS_URL);

  await expect(page.getByTestId("authorization-token-c4m")).toHaveCount(0);
  await expect(page.getByTestId("authorization-token-type")).toHaveValue("0");

  // c4m を取り込んでいないため、Token Value を編集しても手入力した Token Type は保持される
  await page.getByTestId("authorization-token-type").fill("2");
  await page.getByTestId("authorization-token-value").fill("manual-token");
  await expect(page.getByTestId("authorization-token-type")).toHaveValue("2");
});

// Sora の MSF URL を想定し、msf fragment の namespace が Namespace 欄へ反映されて
// 編集できなくなることを確かめる。msf fragment が接続先の namespace を決めるため、
// ユーザーの編集で認可された namespace から外れないようにする
test("msf fragment の namespace を固定し、c4m の track name を反映する", async ({ page }) => {
  const c4m = await buildCatWithTrackNames(["catalog", "audio", "video", "events"]);
  const msfFragment = `msf:15551-spam--catalog&c4m=${c4m}`;
  const params = new URLSearchParams();
  params.set("url", `moqt://sora-moq.example/#${msfFragment}`);
  // 既定と違うトラック名を指定しておき、c4m の track name で上書きされることを確かめる
  params.set("videoTrackName", "cam");
  params.set("audioTrackName", "mic");

  await page.goto(`${DEVTOOLS_URL}?${params.toString()}`);

  // MOQT URI は貼り付けた URL のまま (fragment が消えない)。
  // fragment は URI Fragment 欄へ映し、読み取り専用にする
  await expect(page.getByTestId("moqt-uri")).toHaveValue(`moqt://sora-moq.example/#${msfFragment}`);
  const fragmentInput = page.getByTestId("uri-fragment");
  await expect(fragmentInput).toHaveValue(msfFragment);
  await expect(fragmentInput).toHaveAttribute("readonly", "");

  // Namespace は msf fragment の値 (§8.8 の namespace-name 文字列) になり、読み取り専用になる
  const namespaceInput = page.getByTestId("namespace");
  await expect(namespaceInput).toHaveValue("15551-spam");
  await expect(namespaceInput).toHaveAttribute("readonly", "");

  // c4m の取り込みは従来どおり (Token Type は CAT を表す 1)
  await expect(page.getByTestId("authorization-token-c4m")).toHaveCount(1);
  await expect(page.getByTestId("authorization-token-type")).toHaveValue("1");
  // 取り込んだトークンが許可する track name を画面に出す
  await expect(page.getByTestId("authorization-token-c4m-tracks")).toHaveText(
    "Tracks: catalog, audio, video, events",
  );

  // moqt クレームの exact な track name が audio / video の欄へ反映され、読み取り専用になる
  // (URL の videoTrackName / audioTrackName より c4m を優先する)
  const audioTrackNameInput = page.getByTestId("audio-track-name");
  const videoTrackNameInput = page.getByTestId("video-track-name");
  await expect(audioTrackNameInput).toHaveValue("audio");
  await expect(videoTrackNameInput).toHaveValue("video");
  await expect(audioTrackNameInput).toHaveAttribute("readonly", "");
  await expect(videoTrackNameInput).toHaveAttribute("readonly", "");

  // デコード結果 (形式 / alg / スコープ) は常に表示する
  await expect(page.getByTestId("authorization-token-c4m-details")).toBeVisible();
  await expect(page.getByTestId("c4m-token-format")).toHaveText("coseMac0 / HmacSha256");
  await expect(page.getByTestId("c4m-token-scope")).toHaveCount(4);
  // スコープは Actions / Namespace / Track の 3 列で 1 スコープ 1 行にする
  const firstScope = page.getByTestId("c4m-token-scope").first();
  await expect(firstScope.locator("td").nth(0)).toHaveText("SUBSCRIBE, PUBLISH");
  await expect(firstScope.locator("td").nth(1)).toHaveText("15551, spam, end");
  await expect(firstScope.locator("td").nth(2)).toHaveText("catalog");
});

// MOQT URI 欄に貼り付けた値からも c4m を取り込む。欄への入力は 1 回だけ接続先を指定する
// 最短の経路であり、貼り付けた時点で Authorization Token と namespace が揃う必要がある
test("MOQT URI 欄に貼り付けた c4m 付きの URI を取り込む", async ({ page }) => {
  const c4m = await buildCatWithTrackNames(["catalog", "video"]);
  const msfFragment = `msf:15551-spam--catalog&c4m=${c4m}`;
  await page.goto(DEVTOOLS_URL);

  // 貼り付ける前は c4m の表示が無く、Token Type は既定の 0
  await expect(page.getByTestId("authorization-token-c4m")).toHaveCount(0);
  await expect(page.getByTestId("authorization-token-type")).toHaveValue("0");

  // MOQT URI 欄へ貼り付けると、その場で c4m を取り込む
  await page.getByTestId("moqt-uri").fill(`moqt://sora-moq.example/#${msfFragment}`);

  await expect(page.getByTestId("authorization-token-c4m")).toHaveCount(1);
  // draft-ietf-moq-c4m-02 §8.2 Table 4: Token Type 0x01 は CAT
  await expect(page.getByTestId("authorization-token-type")).toHaveValue("1");
  // 取り込んだトークンが許可する track name を画面に出す
  await expect(page.getByTestId("authorization-token-c4m-tracks")).toHaveText(
    "Tracks: catalog, video",
  );
  // fragment は URI Fragment 欄へ映し、msf fragment の namespace を固定する
  await expect(page.getByTestId("uri-fragment")).toHaveValue(msfFragment);
  await expect(page.getByTestId("namespace")).toHaveValue("15551-spam");
  await expect(page.getByTestId("namespace")).toHaveAttribute("readonly", "");

  // 欄から c4m を消すと、取り込んだトークンも解除する (URL に無い値を送らない)
  await page.getByTestId("moqt-uri").fill("moqt://sora-moq.example/#msf:15551-spam--catalog");
  await expect(page.getByTestId("authorization-token-c4m")).toHaveCount(0);
  await expect(page.getByTestId("authorization-token-type")).toHaveValue("0");
  await expect(page.getByTestId("uri-fragment")).toHaveValue("msf:15551-spam--catalog");
});

// c4m の `moqt` クレームの claim key は IANA 未割当で、peer ごとに異なる値を合意する。
// 付録 A の preset (-65537) と違う key のトークンでも、raw の claim から `moqt` クレームを
// 見つけて Actions / Namespace / Track Name を表示する
test("付録 A と異なる moqt claim key のトークンでもスコープを表示する", async ({ page }) => {
  const c4m = await buildCatWithTrackNames(["video"], { moqt: 999, moqtReval: 1000 });
  const params = new URLSearchParams();
  params.set("url", `moqt://example.com/moqt#msf:room-123--catalog&c4m=${c4m}`);

  await page.goto(`${DEVTOOLS_URL}?${params.toString()}`);

  await expect(page.getByTestId("c4m-token-scope")).toHaveCount(1);
  await expect(page.getByTestId("c4m-token-scope")).toContainText("SUBSCRIBE, PUBLISH");
  await expect(page.getByTestId("c4m-token-scope")).toContainText("15551, spam, end");
  await expect(page.getByTestId("c4m-token-scope")).toContainText("video");
  // 付録 A の preset ではなく raw の claim から見つけた key を出す
  await expect(page.getByTestId("c4m-token-claim-label")).toHaveText("(claim key 999)");
});

// moqt クレームが無いトークンでは、スコープの表を出さずに理由を出す
test("moqt クレームが無いトークンでは理由を表示する", async ({ page }) => {
  const claims = C4M.createCatClaims();
  claims.issuer = "https://auth.example.com";
  const key = C4M.symmetricKey(new Uint8Array(32).fill(0x0b));
  const tokenBytes = await new C4M.CatTokenBuilder({
    claims,
    claimLabels: CLAIM_LABELS,
  }).buildCose(new C4M.WebCrypto(), key);
  const c4m = C4M.encodeBase64Url(tokenBytes);
  const params = new URLSearchParams();
  params.set("url", `moqt://example.com/moqt#msf:room-123--catalog&c4m=${c4m}`);

  await page.goto(`${DEVTOOLS_URL}?${params.toString()}`);

  await expect(page.getByTestId("c4m-token-scope")).toHaveCount(0);
  await expect(page.getByTestId("c4m-token-no-moqt-claim")).toContainText("no moqt claim");
});
