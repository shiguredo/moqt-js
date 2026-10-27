import { expect, test, type Locator, type Page } from "@playwright/test";
import { DEVTOOLS_URL } from "./urls";

// MOQT URI の候補 (接続先) を、実際のブラウザと実際の OPFS で確かめる。
//
// - MOQT URI 欄は候補の表示欄であり、手入力はできない。値をクリックする (または Enter /
//   Space を押す) と候補の管理モーダルが開く
// - 候補の追加・削除・有効 / 無効・全消去は、その場で接続設定と OPFS へ反映する
//   (Save / Cancel のような確定操作は無く、閉じても変更は取り消されない)
// - 表示値: 有効 1 件はその URI、有効 2 件以上は "Random from N candidates"、候補はあるが
//   有効 0 件は "No candidate enabled"、候補なしは空。共有リンクの page は url の値
// - 起動時は候補を接続設定 (URL signal) へ適用しない
// - 以前の版は 1 行の MOQT URI を server-url.txt に保存しており、読み込み時に候補 1 件へ
//   移行する
// - ページ内で navigator.storage.getDirectory() を直接読み書きし、モックやスタブは使わない
// - 実リレーへは接続しない。接続先が無いときのエラーと、パネルの候補表示は、接続の前に
//   拒否される条件 (接続先なし / 解析できない Namespace) で確かめる
//
// dev サーバーは playwright.config.ts の webServer が空きポートで起動する。

/** 候補一覧の保存先 (OPFS) のファイル名 */
const SERVER_URLS_FILE = "server-urls.json";

/** 以前の版が 1 行の MOQT URI を保存していたファイル名 (読み込み時の移行元) */
const LEGACY_SERVER_URL_FILE = "server-url.txt";

/** 登録した接続先の候補 (server-urls.json の要素) */
interface StoredServerUrlEntry {
  url: string;
  enabled: boolean;
}

/** server-urls.json の全体 */
interface StoredServerUrlFile {
  urlEntries: StoredServerUrlEntry[];
}

/** OPFS のファイルを読む。ファイルが無い、または読めないときは null */
async function readOpfsFile(page: Page, fileName: string): Promise<string | null> {
  return page.evaluate(async (name) => {
    const root = await navigator.storage.getDirectory();
    try {
      const handle = await root.getFileHandle(name);
      const file = await handle.getFile();
      return await file.text();
    } catch {
      return null;
    }
  }, fileName);
}

/** OPFS にファイルを書く (旧形式の server-url.txt をテストの前提として置くときに使う) */
async function writeOpfsFile(page: Page, fileName: string, contents: string): Promise<void> {
  await page.evaluate(
    async ({ name, text }) => {
      const root = await navigator.storage.getDirectory();
      const handle = await root.getFileHandle(name, { create: true });
      const writable = await handle.createWritable();
      await writable.write(text);
      await writable.close();
    },
    { name: fileName, text: contents },
  );
}

/** このオリジンの OPFS から候補のファイル (旧形式を含む) を消す */
async function clearOpfsServerUrlFiles(page: Page): Promise<void> {
  await page.evaluate(
    async ({ names }) => {
      const root = await navigator.storage.getDirectory();
      for (const name of names) {
        try {
          await root.removeEntry(name);
        } catch {
          // まだ保存していない (ファイルが無い) だけなので何もしない
        }
      }
    },
    { names: [SERVER_URLS_FILE, LEGACY_SERVER_URL_FILE] },
  );
}

/**
 * OPFS に保存された候補一覧を読む
 *
 * 操作の直後は保存の途中で読めることがあるため、JSON として読めないときは null を返し、
 * 呼び出し側の `expect.poll` で保存の完了を待つ。
 */
async function readStoredServerUrlFile(page: Page): Promise<StoredServerUrlFile | null> {
  const text = await readOpfsFile(page, SERVER_URLS_FILE);
  if (text === null) {
    return null;
  }
  try {
    return JSON.parse(text) as StoredServerUrlFile;
  } catch {
    return null;
  }
}

/** OPFS に保存された候補一覧が期待どおりになるまで待つ */
async function expectStoredEntries(
  page: Page,
  entries: readonly StoredServerUrlEntry[],
): Promise<void> {
  await expect.poll(() => readStoredServerUrlFile(page)).toEqual({ urlEntries: entries });
}

/**
 * OPFS を空にした状態で devtools を開き直す
 *
 * 前のテストや前の操作が残した候補を持ち越さないよう、テストの前提を毎回そろえる。
 * 起動時の OPFS 読み込み (旧形式の移行を含む) が終わってから消し、その後に読み込み直す。
 */
async function openDevtoolsWithCleanOpfs(page: Page): Promise<void> {
  await page.goto(DEVTOOLS_URL);
  await expect(page.getByTestId("moqt-uri")).toBeVisible();
  await clearOpfsServerUrlFiles(page);
  await page.reload();
}

/** MOQT URI 欄 (候補の表示欄) をクリックして候補の管理モーダルを開く */
async function openCandidatesModal(page: Page): Promise<void> {
  await page.getByTestId("moqt-uri").click();
  await expect(page.getByTestId("server-url-candidates-modal")).toBeVisible();
  // モーダルを開くときに走る effect (入力欄への焦点と Escape の listener) を待つ
  await expect(page.getByTestId("server-url-candidates-input")).toBeFocused();
}

/** 候補モーダルの入力欄へ MOQT URI を入れて Add を押す */
async function addCandidateInModal(page: Page, url: string): Promise<void> {
  await page.getByTestId("server-url-candidates-input").fill(url);
  await page.getByTestId("server-url-candidates-add").click();
}

/** OPFS に保存された候補の件数が期待どおりになるまで待つ (その場で保存されるため) */
async function expectStoredEntryCount(page: Page, count: number): Promise<void> {
  await expect
    .poll(async () => {
      const stored = await readStoredServerUrlFile(page);
      return stored?.urlEntries.length ?? 0;
    })
    .toBe(count);
}

/** MOQT URI 欄をクリックしてモーダルで複数の候補を登録し、Close で閉じる */
async function registerCandidates(page: Page, urls: readonly string[]): Promise<void> {
  await openCandidatesModal(page);
  for (const [index, url] of urls.entries()) {
    await addCandidateInModal(page, url);
    // 次の追加と OPFS への書き込みが重ならないよう、保存の完了を待つ
    await expectStoredEntryCount(page, index + 1);
  }
  await page.getByTestId("server-url-candidates-close-footer").click();
  await expect(page.getByTestId("server-url-candidates-modal")).toHaveCount(0);
}

/**
 * 要素の文書内での位置と大きさを読む
 *
 * `boundingBox()` はビューポート基準のため、要素をクリックするときの自動スクロールで
 * 値が変わることがある。スクロールしても値が変わらないよう、スクロール量を足した
 * 文書内の座標で比べる。
 */
async function documentLayout(locator: Locator): Promise<{
  x: number;
  y: number;
  width: number;
  height: number;
}> {
  return locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      x: rect.x + window.scrollX,
      y: rect.y + window.scrollY,
      width: rect.width,
      height: rect.height,
    };
  });
}

/** パネルに出ている "Candidate: <MOQT URI>" の MOQT URI 部分を取り出す */
async function selectedCandidateUrl(locator: Locator): Promise<string> {
  const text = (await locator.textContent()) ?? "";
  const prefix = "Candidate:";
  if (!text.startsWith(prefix)) {
    throw new Error(`選んだ候補の行が "Candidate:" で始まっていません: ${text}`);
  }
  return text.slice(prefix.length).trim();
}

/** パネルの行に出た候補が、登録した候補のどれかであることを確かめ、その URI を返す */
async function expectSelectedCandidateRow(
  locator: Locator,
  urls: readonly string[],
): Promise<string> {
  await expect(locator).toBeVisible();
  await expect(locator).toContainText("Candidate:");
  const selected = await selectedCandidateUrl(locator);
  expect(urls).toContain(selected);
  return selected;
}

test("MOQT URI 欄は候補の表示欄で、クリックとキーボードで管理モーダルを開ける", async ({
  page,
}) => {
  await openDevtoolsWithCleanOpfs(page);

  const uriField = page.getByTestId("moqt-uri");
  const modal = page.getByTestId("server-url-candidates-modal");

  // 候補が無いときは空で、placeholder で登録方法を案内する
  await expect(uriField).toHaveValue("");
  await expect(uriField).toHaveAttribute("placeholder", "No MOQT URI candidate registered");
  // 手入力できない読み取り専用の表示欄
  await expect(uriField).toHaveAttribute("readonly", "");
  await expect(uriField).not.toBeEditable();
  // Add / Manage candidates ボタンと、候補を使っている間の注記は廃止されている
  await expect(page.getByTestId("moqt-uri-add-candidate")).toHaveCount(0);
  await expect(page.getByTestId("moqt-uri-candidates")).toHaveCount(0);
  await expect(page.getByTestId("moqt-uri-candidates-note")).toHaveCount(0);

  // クリックでモーダルを開き、Escape で閉じる
  await uriField.click();
  await expect(modal).toBeVisible();
  // モーダルを開くときに走る effect (Escape の listener) を待つ
  await expect(page.getByTestId("server-url-candidates-input")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(modal).toHaveCount(0);

  // Enter でも開き、× で閉じる
  await uriField.focus();
  await page.keyboard.press("Enter");
  await expect(modal).toBeVisible();
  await page.getByTestId("server-url-candidates-close").click();
  await expect(modal).toHaveCount(0);

  // Space でも開き、Close で閉じる
  await uriField.focus();
  await page.keyboard.press("Space");
  await expect(modal).toBeVisible();
  await page.getByTestId("server-url-candidates-close-footer").click();
  await expect(modal).toHaveCount(0);

  // オーバーレイ (モーダルの外側) のクリックでも閉じる
  await uriField.click();
  await expect(modal).toBeVisible();
  await page.mouse.click(8, 8);
  await expect(modal).toHaveCount(0);
});

test("MOQT URI 欄は有効な候補の数に応じた値を表示する", async ({ page }) => {
  await openDevtoolsWithCleanOpfs(page);

  const relayA = "moqt://relay-a.example:4443/";
  const relayB = "moqt://relay-b.example:4443/";
  const uriField = page.getByTestId("moqt-uri");

  // 有効な候補が 1 件のときは、その URI を表示する
  await registerCandidates(page, [relayA]);
  await expect(uriField).toHaveValue(relayA);

  // 有効な候補が 2 件以上のときは、候補から選ぶことを表示する
  await openCandidatesModal(page);
  await addCandidateInModal(page, relayB);
  await expectStoredEntryCount(page, 2);
  await page.getByTestId("server-url-candidates-close-footer").click();
  await expect(uriField).toHaveValue("Random from 2 candidates");

  // 候補はあるが有効が 0 件のときは、その旨を表示する
  await openCandidatesModal(page);
  await page.getByTestId("server-url-candidates-enabled-0").click();
  await page.getByTestId("server-url-candidates-enabled-1").click();
  await expectStoredEntries(page, [
    { url: relayA, enabled: false },
    { url: relayB, enabled: false },
  ]);
  await page.getByTestId("server-url-candidates-close-footer").click();
  await expect(uriField).toHaveValue("No candidate enabled");

  // 候補をすべて消すと空に戻り、placeholder を出す
  await openCandidatesModal(page);
  const removeAll = page.getByTestId("server-url-candidates-remove-all");
  await removeAll.click();
  await removeAll.click();
  await expect.poll(() => readOpfsFile(page, SERVER_URLS_FILE)).toBeNull();
  await page.getByTestId("server-url-candidates-close-footer").click();
  await expect(uriField).toHaveValue("");
  await expect(uriField).toHaveAttribute("placeholder", "No MOQT URI candidate registered");
});

test("候補モーダルでは追加・有効無効・削除が即座に反映される", async ({ page }) => {
  await openDevtoolsWithCleanOpfs(page);

  const uriField = page.getByTestId("moqt-uri");
  const modal = page.getByTestId("server-url-candidates-modal");
  const error = page.getByTestId("server-url-candidates-error");
  const input = page.getByTestId("server-url-candidates-input");

  // モーダルには Save / Cancel / Purge が無い (操作はその場で反映される)
  await openCandidatesModal(page);
  await expect(page.getByTestId("server-url-candidates-empty")).toBeVisible();
  await expect(page.getByTestId("server-url-candidates-save")).toHaveCount(0);
  await expect(page.getByTestId("server-url-candidates-cancel")).toHaveCount(0);
  await expect(page.getByTestId("server-url-candidates-purge")).toHaveCount(0);
  await expect(page.getByTestId("server-url-candidates-enabled-count")).toHaveCount(0);
  // 追加エラーの行は常に描画される (エラーが無いときは空で、一覧とフッターの位置が動かない)
  await expect(error).toHaveCount(1);
  await expect(error).toHaveText("");

  // 空のまま Add すると英語のエラーを出す
  await page.getByTestId("server-url-candidates-add").click();
  await expect(error).toHaveText("MOQT URI must not be empty");

  // moqt:// 以外の URL は MOQT URI として登録できない
  await input.fill("https://relay.example:4443/");
  await page.getByTestId("server-url-candidates-add").click();
  await expect(error).toHaveText("url must start with moqt://, got: https://relay.example:4443/");

  // 接続に使えない MOQT URI は登録できない。候補は接続のたびにランダムに選ばれるため、
  // 接続で必ず失敗する候補を登録させない。エラーは接続時と同じライブラリの理由を出す
  const unconnectableCandidates = [
    {
      // msf fragment の値が空
      url: "moqt://example.test/#msf:",
      error: "invalid msf fragment value: empty",
    },
    {
      // namespace と track name の区切り (--) が無い
      url: "moqt://example.test/#msf:room",
      error:
        "invalid msf fragment value: missing '--' delimiter between namespace and track name per §11.1.2",
    },
    {
      // Native QUIC が必要な connection=q は未実装
      url: "moqt://example.test/#msf:room-123--catalog&connection=q",
      error:
        "msf fragment connection='q' requires Native QUIC, which is not implemented (only 'wt' WebTransport is supported)",
    },
  ];
  for (const { url, error: expectedError } of unconnectableCandidates) {
    await input.fill(url);
    await page.getByTestId("server-url-candidates-add").click();
    await expect(error).toHaveText(expectedError);
    // 登録できない候補は一覧へ追加されない
    await expect(page.getByTestId("server-url-candidates-entry-0")).toHaveCount(0);
  }

  // 正しい MOQT URI は Enter でも追加でき、その場で接続設定と OPFS に反映される
  const relayA = "moqt://relay-a.example:4443/";
  const relayB = "moqt://relay-b.example:4443/";
  await input.fill(relayA);
  await input.press("Enter");
  await expect(page.getByTestId("server-url-candidates-entry-0")).toContainText(relayA);
  await expect(input).toHaveValue("");
  // 追加するとエラーは消えるが、エラー行自体は残る (高さが変わらない)
  await expect(error).toHaveCount(1);
  await expect(error).toHaveText("");
  // モーダルは開いたまま (確定操作が無い)。MOQT URI 欄はその URI を表示する
  await expect(modal).toBeVisible();
  await expect(uriField).toHaveValue(relayA);
  await expectStoredEntries(page, [{ url: relayA, enabled: true }]);
  // 通常は保存に成功するため、保存に失敗したときの表示は出ない。設定欄側の表示は
  // 廃止され、モーダル側にだけ出す
  await expect(page.getByTestId("server-url-candidates-save-error")).toHaveCount(0);
  await expect(page.getByTestId("moqt-uri-candidates-save-error")).toHaveCount(0);

  // 登録済みと同じ MOQT URI は重複として拒否する (どの URI が重複したかも出す)
  await addCandidateInModal(page, relayA);
  await expect(error).toHaveText(`this MOQT URI is already registered: ${relayA}`);

  // 2 件目を追加すると、有効数と MOQT URI 欄の表示がその場で変わる
  await addCandidateInModal(page, relayB);
  await expect(page.getByTestId("server-url-candidates-entry-1")).toContainText(relayB);
  await expect(page.getByTestId("server-url-candidates-enabled-count")).toHaveText("(2 enabled)");
  await expect(uriField).toHaveValue("Random from 2 candidates");
  await expectStoredEntries(page, [
    { url: relayA, enabled: true },
    { url: relayB, enabled: true },
  ]);

  // チェックを外すと即座に無効になり、MOQT URI 欄の表示と OPFS も変わる
  await page.getByTestId("server-url-candidates-enabled-1").click();
  await expect(page.getByTestId("server-url-candidates-enabled-count")).toHaveText("(1 enabled)");
  await expect(uriField).toHaveValue(relayA);
  await expectStoredEntries(page, [
    { url: relayA, enabled: true },
    { url: relayB, enabled: false },
  ]);

  // 削除すると即座に一覧から消え、後ろの候補が前へ詰まる
  await page.getByTestId("server-url-candidates-delete-0").click();
  await expect(page.getByTestId("server-url-candidates-entry-0")).toContainText(relayB);
  await expect(page.getByTestId("server-url-candidates-entry-1")).toHaveCount(0);
  await expect(uriField).toHaveValue("No candidate enabled");
  await expectStoredEntries(page, [{ url: relayB, enabled: false }]);
});

test("候補モーダルの大きさは候補とエラーの有無で変わらない", async ({ page }) => {
  await openDevtoolsWithCleanOpfs(page);

  const relayA = "moqt://relay-a.example:4443/";
  const modal = page.getByTestId("server-url-candidates-modal");
  const error = page.getByTestId("server-url-candidates-error");

  // 候補 0 件のときの大きさを覚える。空の案内は高さ固定の一覧の中に出す
  await openCandidatesModal(page);
  await expect(page.getByTestId("server-url-candidates-empty")).toBeVisible();
  await expect(error).toHaveText("");
  const emptyBox = await modal.boundingBox();
  if (emptyBox === null) {
    throw new Error("候補モーダルの大きさを取得できませんでした");
  }

  // 候補を 1 件追加しても、モーダルの大きさは変わらない (一覧の高さが固定されている)
  await addCandidateInModal(page, relayA);
  await expectStoredEntryCount(page, 1);
  await expect(page.getByTestId("server-url-candidates-empty")).toHaveCount(0);
  const oneBox = await modal.boundingBox();
  expect(oneBox?.height).toBe(emptyBox.height);
  expect(oneBox?.width).toBe(emptyBox.width);

  // エラーを出しても、モーダルの大きさは変わらない (エラー行の高さも固定されている)
  await page.getByTestId("server-url-candidates-add").click();
  await expect(error).toHaveText("MOQT URI must not be empty");
  const errorBox = await modal.boundingBox();
  expect(errorBox?.height).toBe(emptyBox.height);
  expect(errorBox?.width).toBe(emptyBox.width);
});

test("モーダルを閉じても候補の変更は取り消されない", async ({ page }) => {
  await openDevtoolsWithCleanOpfs(page);

  const relayA = "moqt://relay-a.example:4443/";
  const uriField = page.getByTestId("moqt-uri");
  const modal = page.getByTestId("server-url-candidates-modal");

  // × で閉じても、追加した候補は残る
  await openCandidatesModal(page);
  await addCandidateInModal(page, relayA);
  await expectStoredEntryCount(page, 1);
  await page.getByTestId("server-url-candidates-close").click();
  await expect(modal).toHaveCount(0);
  await expect(uriField).toHaveValue(relayA);
  await expectStoredEntries(page, [{ url: relayA, enabled: true }]);

  // Close で閉じても、有効 / 無効の変更は残る
  await openCandidatesModal(page);
  await page.getByTestId("server-url-candidates-enabled-0").click();
  await expectStoredEntries(page, [{ url: relayA, enabled: false }]);
  await page.getByTestId("server-url-candidates-close-footer").click();
  await expect(modal).toHaveCount(0);
  await expect(uriField).toHaveValue("No candidate enabled");
  await expectStoredEntries(page, [{ url: relayA, enabled: false }]);

  // Escape で閉じても、削除は残る
  await openCandidatesModal(page);
  await page.getByTestId("server-url-candidates-delete-0").click();
  await expect(page.getByTestId("server-url-candidates-empty")).toBeVisible();
  await expect.poll(() => readOpfsFile(page, SERVER_URLS_FILE)).toBeNull();
  await page.keyboard.press("Escape");
  await expect(modal).toHaveCount(0);
  await expect(uriField).toHaveValue("");
  await expect.poll(() => readOpfsFile(page, SERVER_URLS_FILE)).toBeNull();

  // オーバーレイ (モーダルの外側) のクリックで閉じても、追加した候補は残る
  await openCandidatesModal(page);
  await addCandidateInModal(page, relayA);
  await expectStoredEntryCount(page, 1);
  await page.mouse.click(8, 8);
  await expect(modal).toHaveCount(0);
  await expect(uriField).toHaveValue(relayA);
  await expectStoredEntries(page, [{ url: relayA, enabled: true }]);
});

test("Remove all は 2 回目のクリックで候補と OPFS のファイルを消す", async ({ page }) => {
  await openDevtoolsWithCleanOpfs(page);

  const relayA = "moqt://relay-a.example:4443/";
  const relayB = "moqt://relay-b.example:4443/";
  const uriField = page.getByTestId("moqt-uri");
  const removeAll = page.getByTestId("server-url-candidates-remove-all");

  // 候補を 2 件登録してから、モーダルの Remove all を 2 回押して全消去する
  await registerCandidates(page, [relayA, relayB]);
  await expect(uriField).toHaveValue("Random from 2 candidates");
  await expectStoredEntries(page, [
    { url: relayA, enabled: true },
    { url: relayB, enabled: true },
  ]);
  await openCandidatesModal(page);
  const storedBefore = await readOpfsFile(page, SERVER_URLS_FILE);
  expect(storedBefore).not.toBeNull();

  // 1 回目のクリックは確認待ちになるだけ。候補は消えず、OPFS も変わらない
  await removeAll.click();
  await expect(removeAll).toHaveText("Remove all?");
  await expect(page.getByTestId("server-url-candidates-entry-0")).toContainText(relayA);
  await expect(page.getByTestId("server-url-candidates-entry-1")).toContainText(relayB);
  await expect(uriField).toHaveValue("Random from 2 candidates");
  expect(await readOpfsFile(page, SERVER_URLS_FILE)).toBe(storedBefore);

  // 2 回目のクリックで全消去し、OPFS の候補のファイルも消える (旧形式も残さない)
  await removeAll.click();
  await expect(page.getByTestId("server-url-candidates-empty")).toBeVisible();
  await expect(page.getByTestId("server-url-candidates-entry-0")).toHaveCount(0);
  // 全消去すると確認待ちも解除される (ボタンは候補が無いため押せない)
  await expect(removeAll).toHaveText("Remove all");
  await expect(removeAll).toBeDisabled();
  await expect.poll(() => readOpfsFile(page, SERVER_URLS_FILE)).toBeNull();
  await expect.poll(() => readOpfsFile(page, LEGACY_SERVER_URL_FILE)).toBeNull();
  // モーダルは開いたまま。MOQT URI 欄は空に戻る
  await expect(uriField).toHaveValue("");

  // 他の操作 (チェック・追加・削除) をすると確認待ちは解除される (全消去されない)
  await addCandidateInModal(page, relayA);
  await expectStoredEntryCount(page, 1);

  // チェックの切り替えで解除される
  await removeAll.click();
  await expect(removeAll).toHaveText("Remove all?");
  await page.getByTestId("server-url-candidates-enabled-0").click();
  await expect(removeAll).toHaveText("Remove all");
  await expect(page.getByTestId("server-url-candidates-entry-0")).toHaveCount(1);
  await expect(uriField).toHaveValue("No candidate enabled");

  // 追加で解除される
  await removeAll.click();
  await expect(removeAll).toHaveText("Remove all?");
  await addCandidateInModal(page, relayB);
  await expect(removeAll).toHaveText("Remove all");
  await expect(page.getByTestId("server-url-candidates-entry-1")).toHaveCount(1);
  await expectStoredEntryCount(page, 2);
  await expect(uriField).toHaveValue(relayB);

  // 削除で解除される
  await removeAll.click();
  await expect(removeAll).toHaveText("Remove all?");
  await page.getByTestId("server-url-candidates-delete-0").click();
  await expect(removeAll).toHaveText("Remove all");
  await expect(page.getByTestId("server-url-candidates-entry-0")).toContainText(relayB);
  await expectStoredEntryCount(page, 1);

  // 最後に 2 回クリックすると全消去する
  await removeAll.click();
  await expect(removeAll).toHaveText("Remove all?");
  await removeAll.click();
  await expect(page.getByTestId("server-url-candidates-empty")).toBeVisible();
  await expect.poll(() => readOpfsFile(page, SERVER_URLS_FILE)).toBeNull();

  // 閉じて開き直しても空のまま (全消去は取り消されない)
  await page.getByTestId("server-url-candidates-close-footer").click();
  await openCandidatesModal(page);
  await expect(page.getByTestId("server-url-candidates-empty")).toBeVisible();
});

test("保存した候補は再読み込みで MOQT URI 欄に表示される", async ({ page }) => {
  await openDevtoolsWithCleanOpfs(page);

  const relayA = "moqt://relay-a.example:4443/";
  const relayB = "moqt://relay-b.example:4443/";
  const uriField = page.getByTestId("moqt-uri");

  // 有効な候補が 2 件のときは、再読み込み後も候補から選ぶことを表示する
  await registerCandidates(page, [relayA, relayB]);
  await expectStoredEntries(page, [
    { url: relayA, enabled: true },
    { url: relayB, enabled: true },
  ]);
  await page.reload();
  await expect(uriField).toHaveValue("Random from 2 candidates");

  // 1 件だけ有効にすると、再読み込み後もその URI を表示する
  await openCandidatesModal(page);
  await page.getByTestId("server-url-candidates-enabled-1").click();
  await expectStoredEntries(page, [
    { url: relayA, enabled: true },
    { url: relayB, enabled: false },
  ]);
  await page.getByTestId("server-url-candidates-close-footer").click();
  await expect(uriField).toHaveValue(relayA);
  await page.reload();
  await expect(uriField).toHaveValue(relayA);

  // 有効な候補が 0 件のときは、再読み込み後もその旨を表示する
  await openCandidatesModal(page);
  await page.getByTestId("server-url-candidates-enabled-0").click();
  await expectStoredEntries(page, [
    { url: relayA, enabled: false },
    { url: relayB, enabled: false },
  ]);
  await page.getByTestId("server-url-candidates-close-footer").click();
  await expect(uriField).toHaveValue("No candidate enabled");
  await page.reload();
  await expect(uriField).toHaveValue("No candidate enabled");
});

test("fragment 付きの候補は起動時に URI Fragment と namespace と c4m を取り込まない", async ({
  page,
}) => {
  await openDevtoolsWithCleanOpfs(page);

  const candidate = "moqt://relay.example:4443/#msf:15551-spam--catalog&c4m=QUFB";
  // fragment を含む MOQT URI を候補として登録する
  await registerCandidates(page, [candidate]);
  await expectStoredEntries(page, [{ url: candidate, enabled: true }]);
  await page.reload();

  // 候補は MOQT URI 欄に表示されるが、起動時に URI Fragment 欄へは映さない
  await expect(page.getByTestId("moqt-uri")).toHaveValue(candidate);
  await expect(page.getByTestId("uri-fragment")).toHaveValue("");
  // 起動時は msf fragment による namespace の固定も c4m の取り込みもしない
  await expect(page.getByTestId("namespace")).toBeEditable();
  await expect(page.getByTestId("authorization-token-type")).toHaveValue("0");
  await expect(page.getByTestId("authorization-token-c4m")).toHaveCount(0);
});

test("旧形式の server-url.txt は読み込み時に候補 1 件へ移行し、MOQT URI 欄に表示する", async ({
  page,
}) => {
  await openDevtoolsWithCleanOpfs(page);

  const legacyUrl = "moqt://legacy.example:4443/";
  // 以前の版が残した 1 行の MOQT URI を OPFS に置いてから開き直す
  await expect(page.getByTestId("moqt-uri")).toHaveValue("");
  await writeOpfsFile(page, LEGACY_SERVER_URL_FILE, legacyUrl);
  await page.reload();

  // 旧形式は有効な候補 1 件として復元され、MOQT URI 欄に表示される
  await expect(page.getByTestId("moqt-uri")).toHaveValue(legacyUrl);
  // 新しい形式のファイルが作られ、旧形式のファイルは消える
  await expect
    .poll(() => readStoredServerUrlFile(page))
    .toEqual({
      urlEntries: [{ url: legacyUrl, enabled: true }],
    });
  await expect.poll(() => readOpfsFile(page, LEGACY_SERVER_URL_FILE)).toBeNull();

  // 移行した候補はモーダルの一覧にも並ぶ
  await openCandidatesModal(page);
  await expect(page.getByTestId("server-url-candidates-entry-0")).toContainText(legacyUrl);
  await expect(page.getByTestId("server-url-candidates-enabled-0")).toBeChecked();
});

test("Copy URL は有効な候補を urlCandidates に載せ、url が空でも候補を復元できる", async ({
  page,
}) => {
  await openDevtoolsWithCleanOpfs(page);

  const relayA = "moqt://relay-a.example:4443/";
  const relayB = "moqt://relay-b.example:4443/";

  // 2 件登録して 2 件目を無効にする (urlCandidates には有効な 1 件目だけを載せる)
  await registerCandidates(page, [relayA, relayB]);
  await openCandidatesModal(page);
  await page.getByTestId("server-url-candidates-enabled-1").click();
  await expectStoredEntries(page, [
    { url: relayA, enabled: true },
    { url: relayB, enabled: false },
  ]);
  await page.getByTestId("server-url-candidates-close-footer").click();
  // 起動時の読み込みを通す (接続設定の URL signal へは適用されない)
  await page.reload();
  await expect(page.getByTestId("moqt-uri")).toHaveValue(relayA);

  // Copy URL: 接続設定の URL は空のままなので url は空、urlCandidates には有効な候補
  await page.getByTestId("copy-url").click();
  await expect(page).toHaveURL(/urlCandidates=/);
  const copiedUrl = new URL(page.url());
  expect(copiedUrl.searchParams.get("url")).toBe("");
  const candidatesParam = copiedUrl.searchParams.get("urlCandidates");
  if (candidatesParam === null) {
    throw new Error("共有 URL に urlCandidates が含まれていません");
  }
  expect(JSON.parse(candidatesParam)).toEqual([relayA]);

  // OPFS を空にした page で開いても、urlCandidates から候補を復元できる
  await clearOpfsServerUrlFiles(page);
  await expect.poll(() => readOpfsFile(page, SERVER_URLS_FILE)).toBeNull();
  await page.goto(copiedUrl.toString());
  await expect(page.getByTestId("moqt-uri")).toHaveValue(relayA);
  // 共有リンクを開いただけでは OPFS に候補を書き出さない
  await expect.poll(() => readOpfsFile(page, SERVER_URLS_FILE)).toBeNull();
  await expect.poll(() => readOpfsFile(page, LEGACY_SERVER_URL_FILE)).toBeNull();
});

test("url だけの共有リンクは候補を止め、候補を編集すると即座に解除される", async ({ page }) => {
  await openDevtoolsWithCleanOpfs(page);

  const relayA = "moqt://relay-a.example:4443/";
  const relayB = "moqt://relay-b.example:4443/";
  const uriField = page.getByTestId("moqt-uri");

  // 2 件の候補を登録し、url クエリの無い再読み込みで OPFS から読み込ませる
  await registerCandidates(page, [relayA, relayB]);
  await expectStoredEntries(page, [
    { url: relayA, enabled: true },
    { url: relayB, enabled: true },
  ]);
  await page.reload();
  await expect(uriField).toHaveValue("Random from 2 candidates");
  const storedBefore = await readOpfsFile(page, SERVER_URLS_FILE);
  expect(storedBefore).not.toBeNull();

  // url だけを載せた共有リンクを開くと、読み込み済みの候補は残すが、この page の接続には
  // 使わない (MOQT URI 欄は url の接続先を表示し、候補の表示には切り替わらない)
  const sharedUrl = "moqt://shared.example:4443/";
  await page.goto(`${DEVTOOLS_URL}?url=${encodeURIComponent(sharedUrl)}`);
  await expect(uriField).toHaveValue(sharedUrl);
  await expect(uriField).toBeEnabled();
  // 候補の件数は残したまま (モーダルで見える一覧をそのまま編集できる)。設定の MOQT URI の
  // 見出しには、共有リンクの接続先を使っていることを短いタグで添える
  const suspendedTag = page.getByTestId("moqt-uri-candidates-suspended-note");
  await expect(suspendedTag).toHaveText("(shared link)");
  await expect(suspendedTag).toHaveAttribute(
    "title",
    "This page uses the shared MOQT URI. Editing the candidates enables them here.",
  );
  // モーダルを開いていない間は、モーダル側の説明は出ない
  await expect(page.getByTestId("server-url-candidates-suspended-note")).toHaveCount(0);

  // この page では候補を使っていないため、Copy URL に urlCandidates を載せない
  await page.getByTestId("copy-url").click();
  expect(new URL(page.url()).searchParams.has("urlCandidates")).toBe(false);

  // 共有リンクを開いただけでは OPFS の候補を変更しない
  expect(await readOpfsFile(page, SERVER_URLS_FILE)).toBe(storedBefore);

  // モーダルで候補を編集すると、その場で停止が解除される (Save は無い)
  await openCandidatesModal(page);
  // モーダル内には、共有リンクの接続先を使っている説明を出す
  await expect(page.getByTestId("server-url-candidates-suspended-note")).toHaveText(
    "This page uses the shared MOQT URI. Editing the candidates enables them here.",
  );
  await expect(page.getByTestId("server-url-candidates-entry-0")).toContainText(relayA);
  await expect(page.getByTestId("server-url-candidates-entry-1")).toContainText(relayB);
  await page.getByTestId("server-url-candidates-enabled-1").click();
  // 編集すると停止が解除され、設定のタグとモーダル内の説明が消える
  await expect(suspendedTag).toHaveCount(0);
  await expect(page.getByTestId("server-url-candidates-suspended-note")).toHaveCount(0);
  // 停止が解除され、有効な 1 件の URI を表示する
  await expect(uriField).toHaveValue(relayA);
  // 編集はその場で OPFS にも保存される
  await expectStoredEntries(page, [
    { url: relayA, enabled: true },
    { url: relayB, enabled: false },
  ]);

  // 閉じても解除されたまま。Copy URL に urlCandidates が載る
  await page.getByTestId("server-url-candidates-close-footer").click();
  await page.getByTestId("copy-url").click();
  await expect(page).toHaveURL(/urlCandidates=/);
  const candidatesParam = new URL(page.url()).searchParams.get("urlCandidates");
  if (candidatesParam === null) {
    throw new Error("共有 URL に urlCandidates が含まれていません");
  }
  expect(JSON.parse(candidatesParam)).toEqual([relayA]);
});

test("壊れた urlCandidates の共有リンクは url の接続先を使い、保存済みの候補は残す", async ({
  page,
}) => {
  await openDevtoolsWithCleanOpfs(page);

  const relayA = "moqt://relay-a.example:4443/";
  const sharedUrl = "moqt://shared.example:4443/";

  // 候補を 1 件登録し、url クエリの無い再読み込みで OPFS から読み込ませる
  await registerCandidates(page, [relayA]);
  await expectStoredEntries(page, [{ url: relayA, enabled: true }]);
  await page.reload();
  await expect(page.getByTestId("moqt-uri")).toHaveValue(relayA);
  const storedBefore = await readOpfsFile(page, SERVER_URLS_FILE);
  expect(storedBefore).not.toBeNull();

  // urlCandidates が JSON として読めない共有リンクは、url の接続先を使って候補を止める
  await page.goto(
    `${DEVTOOLS_URL}?url=${encodeURIComponent(sharedUrl)}&urlCandidates=${encodeURIComponent("not-json")}`,
  );
  await expect(page.getByTestId("moqt-uri")).toHaveValue(sharedUrl);
  await expect(page.getByTestId("moqt-uri")).toBeEnabled();
  // 設定の見出しのタグで、共有リンクの接続先を使っていることを示す
  await expect(page.getByTestId("moqt-uri-candidates-suspended-note")).toHaveText("(shared link)");

  // 壊れた urlCandidates はコピーしても載せない (相手にも url の接続先を使わせる)
  await page.getByTestId("copy-url").click();
  expect(new URL(page.url()).searchParams.has("urlCandidates")).toBe(false);

  // 開いただけでは OPFS の候補を変更しない
  expect(await readOpfsFile(page, SERVER_URLS_FILE)).toBe(storedBefore);
});

test("Publisher と Subscriber パネルは接続を試みたときに選んだ候補を表示する", async ({ page }) => {
  await openDevtoolsWithCleanOpfs(page);

  const relayA = "moqt://relay-a.example:4443/";
  const relayB = "moqt://relay-b.example:4443/";
  const candidates = [relayA, relayB];
  const uriField = page.getByTestId("moqt-uri");

  // fragment を持たない候補を 2 件登録する (接続試行時に namespace を固定しない)
  await registerCandidates(page, candidates);
  await expectStoredEntries(page, [
    { url: relayA, enabled: true },
    { url: relayB, enabled: true },
  ]);
  await page.reload();
  await expect(uriField).toHaveValue("Random from 2 candidates");

  // 候補の行は接続前から描画され、未選択の間は "-" を出す (接続の開始で映像が動かない)
  const publisherCandidateRow = page.getByTestId("publisher-selected-candidate");
  const subscriberCandidateRows = page.getByTestId("subscriber-selected-candidate");
  await expect(publisherCandidateRow).toHaveCount(1);
  await expect(publisherCandidateRow).toHaveText(/Candidate:\s*-/);
  await expect(subscriberCandidateRows).toHaveCount(1);
  await expect(subscriberCandidateRows.nth(0)).toHaveText(/Candidate:\s*-/);

  // Namespace を解析できない値にすると、接続の前に拒否される (実リレーには接続しない)
  await page.getByTestId("namespace").fill("invalid/namespace");
  await expect(page.getByTestId("namespace-warning")).toBeVisible();

  // 接続を試みても映像の位置と大きさが変わらないことを比べるため、カードの位置を覚える。
  // 上の設定欄はこの時点で既に Namespace の警告が出た状態であり、これ以降に増えるのは
  // 候補の行の値と接続の状態だけ
  const publisherVideoCard = page.getByTestId("publisher-video-card");
  const subscriberVideoCard = page.getByTestId("subscriber-video-card").nth(0);
  const publisherVideoLayout = await documentLayout(publisherVideoCard);
  const subscriberVideoLayout = await documentLayout(subscriberVideoCard);

  // Publisher: Publish を押すと候補が選ばれて行の値が変わる (接続は拒否されるが行は残る)
  await page.getByTestId("publisher-publish-button").click();
  await expectSelectedCandidateRow(publisherCandidateRow, candidates);
  await expect(page.getByTestId("publisher-status-message")).toContainText("Failed:");

  // Subscriber 1 つ目: Start Subscribing を押すと行の値が変わる
  const subscribeButtons = page.getByTestId("subscriber-subscribe-button");
  await expect(subscribeButtons).toHaveCount(1);
  await subscribeButtons.nth(0).click();
  await expect(subscriberCandidateRows).toHaveCount(1);
  const firstSelected = await expectSelectedCandidateRow(
    subscriberCandidateRows.nth(0),
    candidates,
  );
  await expect(page.getByTestId("subscriber-status-message").nth(0)).toContainText("Failed:");

  // Subscriber を追加すると、パネルごとに独立した行が出る
  await page.getByRole("button", { name: "Add Subscriber" }).click();
  await expect(subscribeButtons).toHaveCount(2);
  // 追加した Subscriber の行も描画され、まだ接続を試みていないため "-" のまま
  await expect(subscriberCandidateRows).toHaveCount(2);
  await expect(subscriberCandidateRows.nth(1)).toHaveText(/Candidate:\s*-/);
  await subscribeButtons.nth(1).click();
  await expect(subscriberCandidateRows).toHaveCount(2);
  await expectSelectedCandidateRow(subscriberCandidateRows.nth(1), candidates);
  // 1 つ目の Subscriber が選んだ候補は、2 つ目の試行で上書きされない
  const firstSelectedAfter = await selectedCandidateUrl(subscriberCandidateRows.nth(0));
  expect(firstSelectedAfter).toBe(firstSelected);

  // 行の値が増えても、映像カードの位置と大きさは接続試行の前後で変わらない
  expect(await documentLayout(publisherVideoCard)).toEqual(publisherVideoLayout);
  expect(await documentLayout(subscriberVideoCard)).toEqual(subscriberVideoLayout);

  // 候補は接続に使うだけで、接続設定の signal (MOQT URI 欄 / URI Fragment / Namespace) は
  // 変えない。接続を試みた後も、MOQT URI 欄は "Random from 2 candidates" のまま
  await expect(uriField).toHaveValue("Random from 2 candidates");
  await expect(page.getByTestId("uri-fragment")).toHaveValue("");
  await expect(page.getByTestId("namespace")).toHaveValue("invalid/namespace");

  // Copy URL: 候補の URI は url クエリへ書き戻らず空のまま、有効な候補は urlCandidates に載る
  await page.getByTestId("copy-url").click();
  await expect(page).toHaveURL(/urlCandidates=/);
  const copiedUrl = new URL(page.url());
  expect(copiedUrl.searchParams.get("url")).toBe("");
  const candidatesParam = copiedUrl.searchParams.get("urlCandidates");
  if (candidatesParam === null) {
    throw new Error("共有 URL に urlCandidates が含まれていません");
  }
  expect(JSON.parse(candidatesParam)).toEqual(candidates);
});

test("接続先が無いまま Start すると MOQT URI の登録を促すエラーになる", async ({ page }) => {
  await openDevtoolsWithCleanOpfs(page);

  const uriField = page.getByTestId("moqt-uri");
  // 候補も共有リンクの接続先も無いため、表示欄は空
  await expect(uriField).toHaveValue("");

  // Publisher: Publish を押すと接続の前に理由を出す (実リレーには接続しない)
  await page.getByTestId("publisher-publish-button").click();
  await expect(page.getByTestId("publisher-status-message")).toHaveText(
    "Failed: no MOQT URI is set: register a MOQT URI candidate",
  );

  // Subscriber: Start Subscribing でも同じ理由を出す
  await page.getByTestId("subscriber-subscribe-button").click();
  await expect(page.getByTestId("subscriber-status-message")).toHaveText(
    "Failed: no MOQT URI is set: register a MOQT URI candidate",
  );

  // 表示欄は空のままで、候補は登録されていない
  await expect(uriField).toHaveValue("");
  await expect.poll(() => readOpfsFile(page, SERVER_URLS_FILE)).toBeNull();
});
