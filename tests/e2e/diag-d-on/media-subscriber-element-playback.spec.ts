// 診断用 (一時的): trace=retain-on-failure で video 要素の再生テストを繰り返す
import { test } from "@playwright/test";
import {
  defineElementPlaybackTests,
  elementPlaybackLaunchOptions,
} from "../elementPlaybackDiagnostics";

test.use({ ...elementPlaybackLaunchOptions, trace: "retain-on-failure" });
test.skip(({ browserName }) => browserName !== "webkit", "WebKit の CI の乱れの診断だけに使う");
defineElementPlaybackTests("trace=retain-on-failure", 2);
