import { test, expect } from "@playwright/test";

// devtools の Keyframe Interval の選択肢と、URL からの復元の UI テスト
// 実リレーは起動しない。dev サーバーは playwright.config.ts の webServer で起動される
// (port 5173)
const DEVTOOLS_URL = "http://localhost:5173/index.html";

// 選択肢は値もラベルも秒で固定する。値がフレーム数だと、framerate を変えたときに
// 実際の間隔が変わり (30 fps の 300 フレームは 10 秒だが 60 fps では 5 秒)、
// 画面の表示と実際の間隔が食い違う。選択肢の欠落は URL が復元した値に対応する option が
// 無い状態を生み、select が空表示になって表示と実際の設定が食い違う
test("Keyframe Interval の選択肢は値と表示の組で固定される", async ({ page }) => {
  await page.goto(DEVTOOLS_URL);

  const select = page.getByTestId("keyframe-interval");
  // 既定は 10 秒
  await expect(select).toHaveValue("10");

  const expectedOptions = [
    { value: "1", label: "1 sec" },
    { value: "2", label: "2 sec" },
    { value: "4", label: "4 sec" },
    { value: "8", label: "8 sec" },
    { value: "10", label: "10 sec" },
    { value: "30", label: "30 sec" },
    { value: "60", label: "60 sec" },
    { value: "90", label: "90 sec" },
    { value: "120", label: "120 sec" },
    { value: "240", label: "240 sec" },
  ];

  // 選択肢の件数を先に待ってから、値と表示の組をまとめて比べる
  const options = select.locator("option");
  await expect(options).toHaveCount(expectedOptions.length);
  expect(
    await options.evaluateAll((elements) =>
      elements.map((element) => ({
        value: element.getAttribute("value"),
        label: element.textContent,
      })),
    ),
  ).toEqual(expectedOptions);
});

// 選択肢に無い値は URL から復元しない。0 を受理すると経過時間の比較が成立せず、
// 先頭フレームを含めてキーフレームの要求が意図した周期で出なくなる
test("Keyframe Interval は URL の有効な値だけを復元し、select を空表示にしない", async ({
  page,
}) => {
  await page.goto(`${DEVTOOLS_URL}?keyframeInterval=0`);
  await expect(page.getByTestId("keyframe-interval")).toHaveValue("10");

  // 選択肢にある値は復元する。signal に入った値に対応する option が無いと select は
  // 空表示になるため、値そのものを固定する
  await page.goto(`${DEVTOOLS_URL}?keyframeInterval=240`);
  await expect(page.getByTestId("keyframe-interval")).toHaveValue("240");
});
