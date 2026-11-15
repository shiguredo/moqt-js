import { expect, test, type Browser, type Page } from "@playwright/test";
import { RELAY_PAGE_URL } from "../urls";

/**
 * 実リレーへ接続する e2e テストの共通部分
 *
 * 接続先は環境変数 `TEST_MOQT_URI` で渡す。CI では GitHub Actions の secret から
 * 環境変数として注入し、未設定の環境 (fork からの PR、secret を持たないローカル) では
 * テストを skip として記録する。暗黙の成功扱いにはしない。
 */
export const TEST_MOQT_URI = process.env.TEST_MOQT_URI;

/**
 * 複数の実リレーへ接続する e2e テストの接続先
 *
 * カンマ区切りの MOQT URI 列である。接続先をまたぐ SUBSCRIBE_TRACKS の
 * 経路を検証するテストが使う。単一リレーのテストは `TEST_MOQT_URI` だけを使う
 */
export const TEST_MOQT_URIS = process.env.TEST_MOQT_URIS;

/** 接続先が無い環境での skip 理由 (日本語のテストログとして出す) */
export const RELAY_REQUIRED_SKIP_REASON =
  "TEST_MOQT_URI が設定されていないため実リレーへ接続するテストを実行しない";

/**
 * 実リレーとの往復はローカルより CI の runner で遅い
 *
 * 接続、エンコーダーの初期化、カタログの往復、フレームの到達までを 1 本のテストで
 * 待つため、既定の 30 秒では足りない。
 */
export const RELAY_TEST_TIMEOUT_MS = 90_000;

/**
 * 実リレー接続用のテストページ
 *
 * playwright.config.ts の 2 本目の webServer が配信する。ポートは空きポートを取って
 * 渡されるため、spec 側はこの値を使う (直書きしない)。
 */
export { RELAY_PAGE_URL };

/**
 * 実リレーの MOQT URI を取り出す
 *
 * `TEST_MOQT_URI` を優先し、未設定なら `TEST_MOQT_URIS` の先頭を使う。秘密情報の
 * 設定方法によっては複数 URI の secret だけが設定されるため、単一リレーのテストを
 * 不必要に skip しない。どちらも無ければテストを skip として記録し、null を返す。
 * 呼び出し側は null なら直ちに return する (skip したテストの本体を走らせない)。
 */
export function requireRelayUri(): string | null {
  if (TEST_MOQT_URI !== undefined && TEST_MOQT_URI.length > 0) {
    return TEST_MOQT_URI;
  }
  const first = relayUrisFromEnvironment()[0];
  if (first !== undefined) {
    return first;
  }
  test.skip(true, RELAY_REQUIRED_SKIP_REASON);
  return null;
}

/**
 * `TEST_MOQT_URIS` を MOQT URI の配列にする
 *
 * 区切りはカンマを正とする。GitHub Actions の secret はカンマ区切りで設定する。
 * ローカルの .env で空白区切りにしていても動くよう、空白も受け付ける。空の要素は
 * 無視する。接続先は公開ログへ出さないため、呼び出し側も値をログへ書かない。
 */
function relayUrisFromEnvironment(): string[] {
  return (TEST_MOQT_URIS ?? "")
    .split(/[\s,]+/)
    .map((uri) => uri.trim())
    .filter((uri) => uri.length > 0);
}

/**
 * 複数リレーの e2e テスト用に MOQT URI を `minimum` 本以上取り出す
 *
 * `TEST_MOQT_URIS` はカンマ区切り (ローカルでは空白区切りも可) であり、空の要素は無視する。未設定・不足の環境では
 * テストを skip として記録し、null を返す。呼び出し側は null なら直ちに return する。
 * 接続先は公開ログへ出さないため、skip の理由には本数だけを書く。
 */
export function requireRelayUris(minimum: number): string[] | null {
  const uris = relayUrisFromEnvironment();
  if (uris.length >= minimum) {
    return uris;
  }
  test.skip(
    true,
    `TEST_MOQT_URIS に ${minimum} 本以上のリレー URI が設定されていない (設定済み ${uris.length} 本) ため複数リレーのテストを実行しない`,
  );
  return null;
}

/**
 * テストごとに一意な Track Namespace を作る
 *
 * 実リレーは共有のため、テストを並行実行しても namespace が衝突しないようにする。
 * `crypto.randomUUID()` はブラウザと Node の両方にある標準 API。
 */
export function createTestNamespace(): string[] {
  return ["moqt-js-e2e", crypto.randomUUID()];
}

/**
 * 接続先の MOQT URI を設定する
 *
 * 接続設定の MOQT URI 欄へそのまま入力する。入力した URI がそのまま接続先になり、候補への
 * 登録や候補プールの切り替えは要らない (1 回だけ使う経路を最短にする)。
 */
export async function setMoqtUri(page: Page, moqtUri: string): Promise<void> {
  const uriField = page.getByTestId("moqt-uri");
  await expect(uriField).toBeEditable();
  await uriField.fill(moqtUri);
  await expect(uriField).toHaveValue(moqtUri);
}

/**
 * 実リレー接続用のテストページを開き、テスト API が公開されるまで待つ
 *
 * `page.goto` の load 完了と module script の評価完了は別タイミングなので、
 * `window.__moqtE2E` の定義を明示的に待つ。
 */
export async function openRelayPage(browser: Browser): Promise<Page> {
  const page = await browser.newPage();
  await page.goto(RELAY_PAGE_URL);
  await page.waitForFunction(() => Boolean(window.__moqtE2E));
  return page;
}

/**
 * テストページを閉じる
 *
 * `browser.newPage()` は暗黙に context を作るため、context ごと閉じる。
 */
export async function closeRelayPage(page: Page): Promise<void> {
  await page.context().close();
}
