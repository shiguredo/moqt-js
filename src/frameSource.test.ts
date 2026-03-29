import { test, assert } from "vitest";
import { isMediaStreamTrackProcessorAvailable } from "./frameSource";

// Node.js 環境では MediaStreamTrackProcessor が存在しないため false を返す
test("isMediaStreamTrackProcessorAvailable は MediaStreamTrackProcessor が未定義の場合 false を返す", () => {
  assert.strictEqual(isMediaStreamTrackProcessorAvailable(), false);
});
