import { assert, test } from "vite-plus/test";
import { describeShakaVersion } from "./version";

test("git describe 形式から表示用のタグだけを取り出す", () => {
  const info = describeShakaVersion("v5.3.6-main-13-gef7e1bf63");
  assert.equal(info.displayVersion, "v5.3.6");
  assert.equal(
    info.releaseUrl,
    "https://github.com/shaka-project/shaka-player/releases/tag/v5.3.6",
  );
  assert.equal(info.packageUrl, "https://www.npmjs.com/package/shaka-player");
});

test("タグだけのバージョンもそのまま扱う", () => {
  const info = describeShakaVersion("v5.3.6");
  assert.equal(info.displayVersion, "v5.3.6");
});

test("解析できないバージョンはリポジトリへリンクする", () => {
  const info = describeShakaVersion("unknown");
  assert.equal(info.displayVersion, "unknown");
  assert.equal(info.releaseUrl, "https://github.com/shaka-project/shaka-player");
});
