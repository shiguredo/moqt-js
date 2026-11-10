// 診断用 (一時的): テスト自身の負荷 (映像の供給と画素の読み戻し) を外した変種を交互に並べる
import { test } from "@playwright/test";
import {
  defineElementPlaybackTests,
  elementPlaybackLaunchOptions,
} from "../elementPlaybackDiagnostics";

test.use({ ...elementPlaybackLaunchOptions, trace: "off" });
test.skip(({ browserName }) => browserName !== "webkit", "WebKit の CI の乱れの診断だけに使う");
defineElementPlaybackTests("trace=off", 5, ["full", "noReadback", "noVideo"], [10]);
