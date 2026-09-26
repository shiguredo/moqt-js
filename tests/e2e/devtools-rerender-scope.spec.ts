import { expect, test } from "@playwright/test";

// 設定を 1 文字変えたときに再描画されるコンポーネントを数える。コンポーネントテストの
// 基盤 (Vitest Browser Mode) が無いため、実ブラウザで Preact の描画フックを包んで数える。
// 副題のリンクは今の接続設定を載せた URL を出すため設定の signal を読むが、その購読は
// 副題の中だけに閉じている (App が読むと App と子パネルが再描画される)。
const DEVTOOLS_URL = "http://localhost:5173/";

test("接続設定を変えても App と子パネルは再描画されず、副題だけが再描画される", async ({
  page,
}) => {
  await page.goto(DEVTOOLS_URL);
  await expect(page.getByTestId("moqt-draft-link")).toBeVisible();

  // Preact の描画フック (options.__r) を包み、コンポーネントごとの描画回数を数える。
  // アプリが読み込んだものと同じモジュール実体を使う必要があるため、URL は
  // Resource Timing から取る (HMR のタイムスタンプ付きでも同じ実体になる)。
  // @preact/signals も同じフックを使うため、元のハンドラは必ず呼ぶ。
  await page.evaluate(async () => {
    const depUrl = (pattern: RegExp): string => {
      const url = performance
        .getEntriesByType("resource")
        .map((entry) => entry.name)
        .find((name) => pattern.test(name));
      if (!url) {
        throw new Error(`no loaded module: ${String(pattern)}`);
      }
      return url;
    };

    type RenderHook = (vnode: { type: unknown }, ...rest: unknown[]) => void;
    interface RenderCounters {
      counts: Map<string, number>;
    }

    const preact = (await import(depUrl(/\/deps\/preact\.js\?v=/))) as {
      options: { __r?: RenderHook };
    };
    const app = (await import(depUrl(/\/src\/App\.tsx/))) as { App: unknown };
    const modeSubtitle = (await import(depUrl(/\/src\/components\/ModeSubtitle\.tsx/))) as {
      ModeSubtitle: unknown;
    };
    const subscriberPanel = (await import(depUrl(/\/src\/components\/SubscriberPanel\.tsx/))) as {
      SubscriberPanel: unknown;
    };

    const names = new Map<unknown, string>([
      [app.App, "App"],
      [modeSubtitle.ModeSubtitle, "ModeSubtitle"],
      [subscriberPanel.SubscriberPanel, "SubscriberPanel"],
    ]);

    const counters: RenderCounters = { counts: new Map<string, number>() };
    const previous = preact.options.__r;
    preact.options.__r = function __r(vnode, ...rest) {
      const name = names.get(vnode.type);
      if (name !== undefined) {
        counters.counts.set(name, (counters.counts.get(name) ?? 0) + 1);
      }
      if (previous !== undefined) {
        previous.call(this, vnode, ...rest);
      }
    };

    const host = window as unknown as { __renderCounters?: RenderCounters };
    host.__renderCounters = counters;
  });

  const relayUri = page.getByTestId("relay-uri");
  await expect(relayUri).toBeVisible();
  await relayUri.click();
  await page.evaluate(() => {
    const host = window as unknown as { __renderCounters?: { counts: Map<string, number> } };
    host.__renderCounters?.counts.clear();
  });

  // URL の入力欄へ 10 文字入れる (1 文字ごとに url signal が変わる)
  await relayUri.press("End");
  for (const character of "abcdefghij") {
    await relayUri.press(character);
  }

  // @preact/signals は描画を requestAnimationFrame でまとめるため、2 フレーム待つ
  const counts = await page.evaluate(
    () =>
      new Promise<Record<string, number>>((resolve) => {
        const host = window as unknown as { __renderCounters?: { counts: Map<string, number> } };
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            resolve(Object.fromEntries(host.__renderCounters?.counts ?? []));
          });
        });
      }),
  );

  // 副題は今の設定を読むため再描画される。href も今の設定へ追従する
  expect(counts.ModeSubtitle ?? 0).toBeGreaterThan(0);
  // App は接続設定の signal を読まないため再描画されない。子パネルも巻き込まれない
  expect(counts.App ?? 0).toBe(0);
  expect(counts.SubscriberPanel ?? 0).toBe(0);

  await expect(page.getByTestId("mode-link-publisher")).toHaveAttribute(
    "href",
    /url=moqt%3A%2F%2F127\.0\.0\.1%3A4443%2Fabcdefghij/,
  );
});
