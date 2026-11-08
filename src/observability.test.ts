/**
 * MOQLOG / MOQMETRICS の共通命名 helper の単体テスト
 *
 * 通常の公開 API からは固定 prefix しか渡らないが、JavaScript からは任意の値が
 * 渡り得るため、prefix と resourceId の実行時検証をここで固定する。
 */

import { test, assert } from "vite-plus/test";
import { observabilityNamespaceTemplate, observabilityTrackNamespace } from "./observability";

const RESOURCE_ID = "8f2c4a1b0e9d7c63";
const PREFIX = ["logs.moq.arpa", "v1"] as const;

test("observabilityTrackNamespace: prefix は 2 つの非空 field を要求する", () => {
  assert.throws(() => observabilityTrackNamespace(["", "v1"], RESOURCE_ID, "test"), /prefix/);
  assert.throws(
    () => observabilityTrackNamespace(["logs.moq.arpa", ""], RESOURCE_ID, "test"),
    /prefix/,
  );
  assert.throws(
    () =>
      observabilityTrackNamespace([] as unknown as readonly [string, string], RESOURCE_ID, "test"),
    /prefix/,
  );
  assert.throws(
    () =>
      observabilityTrackNamespace(
        ["logs.moq.arpa"] as unknown as readonly [string, string],
        RESOURCE_ID,
        "test",
      ),
    /prefix/,
  );
  assert.throws(
    () =>
      observabilityTrackNamespace(
        ["logs.moq.arpa", "v1", "extra"] as unknown as readonly [string, string],
        RESOURCE_ID,
        "test",
      ),
    /prefix/,
  );
});

test("observabilityTrackNamespace: resourceId は string かつ 16 桁小文字 hex", () => {
  assert.throws(
    () => observabilityTrackNamespace(PREFIX, 123 as unknown as string, "test"),
    /must be a string/,
  );
  assert.throws(
    () =>
      observabilityTrackNamespace(
        PREFIX,
        { toString: () => RESOURCE_ID } as unknown as string,
        "test",
      ),
    /must be a string/,
  );
  assert.throws(
    () => observabilityTrackNamespace(PREFIX, "8F2C4A1B0E9D7C63", "test"),
    /16 lowercase hexadecimal/,
  );
  assert.deepEqual(observabilityTrackNamespace(PREFIX, RESOURCE_ID, "test"), [
    "logs.moq.arpa",
    "v1",
    RESOURCE_ID,
  ]);
});

test("observabilityNamespaceTemplate: prefix は 2 つの非空 field を要求する", () => {
  assert.throws(() => observabilityNamespaceTemplate(["", "v1"]), /prefix/);
  assert.throws(
    () => observabilityNamespaceTemplate([] as unknown as readonly [string, string]),
    /prefix/,
  );
  assert.equal(observabilityNamespaceTemplate(PREFIX), "logs.2emoq.2earpa-v1-%resourceId%");
});
