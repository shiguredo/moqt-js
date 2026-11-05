/**
 * C4M DevTools のアクション表示のテスト
 *
 * draft-ietf-moq-transport-23 §A.7 の draft-17 の項目で CLIENT_SETUP と
 * SERVER_SETUP が 1 つの SETUP に統合され、draft-ietf-moq-c4m-02 Table 1 の
 * アクションも SETUP (1) だけを持つ。表示名はすべて異なるため、表示名の一覧と
 * 認可判定が Table 1 に従うことを固定する。
 */

import { test, assert } from "vite-plus/test";
import { C4M } from "moqt-js";
import {
  NAMED_ACTIONS,
  actionDisplayName,
  actionDisplayNames,
  isActionAllowedByName,
} from "./actions";

const TEXT_ENCODER = new TextEncoder();

test("NAMED_ACTIONS: MOQT_ACTIONS の順に表示名を持つ", () => {
  // 並びは MOQT_ACTIONS の順で、各アクションに表示名が 1 つ付く
  assert.deepEqual(
    NAMED_ACTIONS.map(({ name }) => name),
    [
      "SETUP",
      "PUBLISH_NAMESPACE",
      "SUBSCRIBE_NAMESPACE",
      "SUBSCRIBE",
      "REQUEST_UPDATE",
      "PUBLISH",
      "FETCH",
      "TRACK_STATUS",
      "SUBSCRIBE_TRACKS",
    ],
  );
  // 表示名 "SETUP" は claim アクション "Setup" に 1 対 1 で対応する
  assert.deepEqual(NAMED_ACTIONS.find(({ name }) => name === "SETUP")?.action, "Setup");
});

test("actionDisplayNames: 同じ表示名は 1 つにまとめ、表に無い値は数値のままにする", () => {
  // C4M 02 の SETUP は 1。0 は旧 ClientSetup で表示名を持たず数値のまま
  assert.deepEqual(actionDisplayNames([1]), ["SETUP"]);
  assert.deepEqual(actionDisplayNames([0]), ["0"]);
  assert.deepEqual(actionDisplayNames([4, 6, 7]), ["SUBSCRIBE", "PUBLISH", "FETCH"]);
  assert.equal(actionDisplayName(99), "99");
});

test("isActionAllowedByName: SETUP は単一の claim アクションで認可する", () => {
  const namespace = [TEXT_ENCODER.encode("15551")];
  const track = TEXT_ENCODER.encode("catalog");
  const claims = C4M.createCatClaims();
  // SETUP (1) を許可するスコープ
  claims.moqt = { scopes: [C4M.createMoqtScope(["Setup"])] };

  assert.isTrue(isActionAllowedByName(claims, "SETUP", namespace, track));
  assert.isFalse(isActionAllowedByName(claims, "SUBSCRIBE", namespace, track));
  // 表に無い表示名は許可しない
  assert.isFalse(isActionAllowedByName(claims, "UNKNOWN", namespace, track));
});
