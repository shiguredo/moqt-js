import { assert, test } from "vitest";
import { formatError, formatShakaError } from "./error";

test("Error は message をそのまま出す", () => {
  assert.equal(formatError(new Error("load failed")), "load failed");
});

test("shaka の error は category と code と既知の名前を出す", () => {
  assert.equal(
    formatShakaError({ category: 4, code: 4032, message: "unsupported" }),
    "shaka error category=4 code=4032 (CONTENT_UNSUPPORTED_BY_BROWSER): unsupported",
  );
});

test("error.data の理由を出す", () => {
  assert.equal(
    formatShakaError({ category: 4, code: 4065, data: ["no publisher for track"] }),
    "shaka error category=4 code=4065 (MSF_CONNECTION_CLOSED): no publisher for track",
  );
});

test("category だけ、code だけでも出す", () => {
  assert.equal(formatShakaError({ category: 4 }), "shaka error category=4");
  assert.equal(
    formatShakaError({ code: 4032 }),
    "shaka error code=4032 (CONTENT_UNSUPPORTED_BY_BROWSER)",
  );
});

test("message だけの error は message を出す", () => {
  assert.equal(formatShakaError({ message: "only message" }), "only message");
});

test("オブジェクトでない値は文字列にする", () => {
  assert.equal(formatShakaError("boom"), "boom");
  assert.equal(formatError(42), "42");
});
