/**
 * テストが使う URL
 *
 * ポートは `playwright.config.ts` が起動時に空きポートを取って環境変数で渡す。固定ポートに
 * すると、同じポートで別のアプリが動いているときに `reuseExistingServer` がそれを黙って
 * 使い、**別のアプリを相手にテストしてしまう** (実際に起きた)。空きポートを取れば、その
 * 取り違えもポートの衝突も起きない。
 *
 * spec を単体で走らせるときのために、環境変数が無ければ既定のポートを使う (devtools は
 * 5173、実リレー接続用のテストページは 5180。それぞれの vite.config.ts の値と同じ)。
 */

/** devtools の起点 (末尾に `/` は付けない) */
export const DEVTOOLS_ORIGIN = process.env.MOQT_DEVTOOLS_ORIGIN ?? "http://localhost:5173";

/** devtools の起点 (末尾に `/` を付けた形。パスを繋ぐときに使う) */
export const DEVTOOLS_ROOT_URL = `${DEVTOOLS_ORIGIN}/`;

/** devtools の index.html */
export const DEVTOOLS_URL = `${DEVTOOLS_ORIGIN}/index.html`;

/** devtools の WebTransport のページ */
export const WEBTRANSPORT_DEVTOOLS_URL = `${DEVTOOLS_ORIGIN}/webtransport-devtools.html`;

/** devtools の WebCodecs のページ */
export const WEBCODECS_DEVTOOLS_URL = `${DEVTOOLS_ORIGIN}/webcodecs-devtools.html`;

/** devtools の codec のページ */
export const CODEC_TEST_URL = `${DEVTOOLS_ORIGIN}/codec-test.html`;

/** 実リレー接続用のテストページ */
export const RELAY_PAGE_URL = process.env.MOQT_E2E_PAGE_URL ?? "http://localhost:5180/index.html";
