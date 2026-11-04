/**
 * C4M DevTools のアクション表示のテスト
 *
 * draft-ietf-moq-transport-23 §A.7 (draft-17 以降の変更履歴) で CLIENT_SETUP と
 * SERVER_SETUP が 1 つの SETUP に統合され、draft-ietf-moq-c4m-02 Table 1 の
 * アクションも SETUP (1) だけを持つ。表示名はすべて異なるためグループ化は
 * no-op であり、表示名と認可判定が Table 1 に従うことを固定する。
 */

import { test, assert } from "vite-plus/test";
import { C4M } from "moqt-js";
import {
  ACTION_GROUPS,
  actionDisplayName,
  actionDisplayNames,
  isActionAllowedByName,
} from "./actions";

const TEXT_ENCODER = new TextEncoder();

test("ACTION_GROUPS: 同じ表示名のアクションを 1 つにまとめる", () => {
  const setup = ACTION_GROUPS.find((group) => group.name === "SETUP");
  assert.deepEqual(setup?.actions, ["Setup"]);
  // 並びは MOQT_ACTIONS の順で、同名の表示は 1 つにまとめる
  assert.deepEqual(
    ACTION_GROUPS.map((group) => group.name),
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
});

test("actionDisplayNames: 同じ表示名は 1 つにまとめ、表に無い値は数値のままにする", () => {
  // C4M 02 の SETUP は 1。0 は旧 ClientSetup で表示名を持たず数値のまま
  assert.deepEqual(actionDisplayNames([1]), ["SETUP"]);
  assert.deepEqual(actionDisplayNames([0]), ["0"]);
  assert.deepEqual(actionDisplayNames([4, 6, 7]), ["SUBSCRIBE", "PUBLISH", "FETCH"]);
  assert.equal(actionDisplayName(99), "99");
});

test("isActionAllowedByName: SETUP は claim アクションで許可されていれば許可する", () => {
  const namespace = [TEXT_ENCODER.encode("15551")];
  const track = TEXT_ENCODER.encode("catalog");
  const claims = C4M.createCatClaims();
  // SETUP (1) を許可するスコープ
  claims.moqt = { scopes: [C4M.createMoqtScope(["Setup"])] };

  assert.isTrue(isActionAllowedByName(claims, "SETUP", namespace, track));
  assert.isFalse(isActionAllowedByName(claims, "SUBSCRIBE", namespace, track));
});
