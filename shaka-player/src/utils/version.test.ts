import { assert, test } from "vite-plus/test";
import { describeShakaVersion } from "./version";

test("git describe 形式からタグと commit を分ける", () => {
  const info = describeShakaVersion("v5.3.6-main-13-gef7e1bf63");
  assert.equal(info.displayVersion, "v5.3.6");
  assert.equal(info.detail, "main-13-gef7e1bf63");
  assert.equal(
    info.releaseUrl,
    "https://github.com/shaka-project/shaka-player/releases/tag/v5.3.6",
  );
  assert.equal(info.commitUrl, "https://github.com/shaka-project/shaka-player/commit/ef7e1bf63");
});

test("タグだけのバージョンは接尾辞を持たない", () => {
  const info = describeShakaVersion("v5.3.6");
  assert.equal(info.displayVersion, "v5.3.6");
  assert.isNull(info.detail);
  assert.isNull(info.commitUrl);
});

test("解析できないバージョンはリポジトリへリンクする", () => {
  const info = describeShakaVersion("unknown");
  assert.equal(info.displayVersion, "unknown");
  assert.isNull(info.detail);
  assert.equal(info.releaseUrl, "https://github.com/shaka-project/shaka-player");
  assert.isNull(info.commitUrl);
});
