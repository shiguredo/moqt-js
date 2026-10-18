import { test, expect } from "@playwright/test";
import { DEVTOOLS_ROOT_URL as DEVTOOLS_URL } from "./urls";

// 映像のライトボックス (通常表示の 2 倍の幅) と全画面の UI テスト
//
// 実リレーは使わない。映像のカードは接続前から描かれるため、カードの位置と大きさ、
// ボタンの状態だけを見る。実際のフレームの描画は relay のテストで確かめる。

/** ライトボックスのカードと画面の端の余白 (VideoCard の実装と同じ値) */
const LIGHTBOX_VIEWPORT_MARGIN_PX = 32;
/** ライトボックスでカードの縦に確保する余白 (VideoCard の実装と同じ値) */
const LIGHTBOX_VERTICAL_RESERVED_PX = 96;
/** 映像の縦横比 (幅 / 高さ。VideoCard の実装と同じ値) */
const VIDEO_ASPECT_RATIO = 16 / 9;

test("Publisher の映像はライトボックスで通常の 2 倍の幅になり、Esc で元に戻る", async ({
  page,
}) => {
  await page.goto(DEVTOOLS_URL);

  const card = page.getByTestId("publisher-video-card");
  await expect(card).toBeVisible();
  const normalBox = await card.boundingBox();
  expect(normalBox).not.toBeNull();
  // 画面の幅と高さは、実装が幅を決めるときと同じ値を使う (スクロールバーの有無で
  // viewportSize と clientWidth がずれる環境でも同じ期待値になる)
  const viewport = await page.evaluate(() => ({
    width: document.documentElement.clientWidth,
    height: document.documentElement.clientHeight,
  }));

  await page.getByTestId("publisher-video-lightbox-button").click();

  // 背景が重なり、カードが通常表示の 2 倍の幅 (画面に収まる範囲) になる
  await expect(page.getByTestId("publisher-video-lightbox-backdrop")).toBeVisible();
  const expectedWidth = Math.floor(
    Math.min(
      (normalBox?.width ?? 0) * 2,
      viewport.width - LIGHTBOX_VIEWPORT_MARGIN_PX,
      (viewport.height - LIGHTBOX_VERTICAL_RESERVED_PX) * VIDEO_ASPECT_RATIO,
    ),
  );
  const lightboxBox = await card.boundingBox();
  expect(lightboxBox).not.toBeNull();
  // 端数の丸めだけを許す
  expect(Math.abs((lightboxBox?.width ?? 0) - expectedWidth)).toBeLessThanOrEqual(1);
  // 画面の中央に置かれる (左右の余白が同じ)
  const leftMargin = lightboxBox?.x ?? 0;
  const rightMargin = viewport.width - ((lightboxBox?.x ?? 0) + (lightboxBox?.width ?? 0));
  expect(Math.abs(leftMargin - rightMargin)).toBeLessThanOrEqual(1);

  // Esc で閉じ、通常表示の大きさに戻る
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("publisher-video-lightbox-backdrop")).toBeHidden();
  const restoredBox = await card.boundingBox();
  expect(restoredBox).not.toBeNull();
  expect(Math.abs((restoredBox?.width ?? 0) - (normalBox?.width ?? 0))).toBeLessThanOrEqual(1);
});

test("Subscriber の映像もライトボックスで広がり、背景を押すと元に戻る", async ({ page }) => {
  await page.goto(DEVTOOLS_URL);

  const card = page.getByTestId("subscriber-video-card");
  await expect(card).toBeVisible();
  const normalBox = await card.boundingBox();
  expect(normalBox).not.toBeNull();

  await page.getByTestId("subscriber-video-lightbox-button").click();
  await expect(page.getByTestId("subscriber-video-lightbox-backdrop")).toBeVisible();
  const lightboxBox = await card.boundingBox();
  expect(lightboxBox).not.toBeNull();
  // ライトボックスでは通常表示より確実に広い (画面の高さで頭打ちになる環境でも 1.5 倍以上)
  expect(lightboxBox?.width ?? 0).toBeGreaterThan((normalBox?.width ?? 0) * 1.5);

  // 映像の外側 (背景) を押すと閉じる
  await page.mouse.click(8, 8);
  await expect(page.getByTestId("subscriber-video-lightbox-backdrop")).toBeHidden();
  await expect(card).toBeVisible();
});

test("Publisher の映像を全画面にでき、全画面を終えると元に戻る", async ({ page }) => {
  await page.goto(DEVTOOLS_URL);

  const card = page.getByTestId("publisher-video-card");
  await expect(card).toBeVisible();
  const viewport = page.viewportSize();
  expect(viewport).not.toBeNull();

  await page.getByTestId("publisher-video-fullscreen-button").click();

  // 全画面に入るとカードが全画面の要素になる
  await expect
    .poll(() =>
      page.evaluate(
        () => document.fullscreenElement?.matches('[data-testid="publisher-video-card"]') ?? false,
      ),
    )
    .toBe(true);
  // 全画面中はカードが画面全体に広がる
  const fullscreenBox = await card.boundingBox();
  expect(fullscreenBox).not.toBeNull();
  expect(Math.abs((fullscreenBox?.width ?? 0) - (viewport?.width ?? 0))).toBeLessThanOrEqual(1);
  expect(Math.abs((fullscreenBox?.height ?? 0) - (viewport?.height ?? 0))).toBeLessThanOrEqual(1);
  // ボタンの文言が全画面を終える側へ変わる
  await expect(page.getByTestId("publisher-video-fullscreen-button")).toHaveAttribute(
    "aria-label",
    "Exit fullscreen",
  );

  // ボタンでも全画面を終えられる
  await page.getByTestId("publisher-video-fullscreen-button").click();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true);
  await expect(page.getByTestId("publisher-video-fullscreen-button")).toHaveAttribute(
    "aria-label",
    "Enter fullscreen",
  );
});
