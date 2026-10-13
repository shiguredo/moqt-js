/**
 * メッセージ型の判定の単体テスト: isPublishDoneErrorStatus
 *
 * PUBLISH_DONE の Status Code の分類 (エラーか正常な終わりか) を全数固定する。
 * draft-ietf-moq-transport-22 §9.9 / §12.4 (Publish Done Codes) を参照する。
 * モックやスタブは使わない。
 */

import { test, assert } from "vite-plus/test";
import { PublishDoneStatusCode, isPublishDoneErrorStatus } from "./types";

// エラーとみなす code (§12.4 がエラーを示すとするもの)
const ERROR_STATUS_CODES: readonly PublishDoneStatusCode[] = [
  PublishDoneStatusCode.INTERNAL_ERROR,
  PublishDoneStatusCode.UNAUTHORIZED,
  PublishDoneStatusCode.TOO_FAR_BEHIND,
  PublishDoneStatusCode.UPDATE_FAILED,
  PublishDoneStatusCode.EXCESSIVE_LOAD,
  PublishDoneStatusCode.MALFORMED_TRACK,
];

// 購読の正常な終わりとみなす code
const NON_ERROR_STATUS_CODES: readonly PublishDoneStatusCode[] = [
  PublishDoneStatusCode.TRACK_ENDED,
  PublishDoneStatusCode.GOING_AWAY,
  PublishDoneStatusCode.EXPIRED,
];

test("isPublishDoneErrorStatus: エラーを示す Status Code をエラーとみなす", () => {
  for (const statusCode of ERROR_STATUS_CODES) {
    assert.isTrue(
      isPublishDoneErrorStatus(statusCode),
      `0x${statusCode.toString(16)} はエラーとみなすべき`,
    );
  }
});

test("isPublishDoneErrorStatus: 正常な終わりの Status Code をエラーとみなさない", () => {
  for (const statusCode of NON_ERROR_STATUS_CODES) {
    assert.isFalse(
      isPublishDoneErrorStatus(statusCode),
      `0x${statusCode.toString(16)} はエラーとみなすべきでない`,
    );
  }
});

// draft-ietf-moq-transport-22 §13 (Grease):
// "Receipt of an unknown error code in any error context (… PUBLISH_DONE …) MUST be treated as
// equivalent to INTERNAL_ERROR for that context." に従い、列挙に無い値はエラーとみなす
test("isPublishDoneErrorStatus: 列挙に無い値はエラーとみなす", () => {
  // 削除された 0x3 (SUBSCRIPTION_ENDED) と、列挙に無い値
  assert.isTrue(isPublishDoneErrorStatus(0x3 as PublishDoneStatusCode));
  assert.isTrue(isPublishDoneErrorStatus(0x7f as PublishDoneStatusCode));
});
