/**
 * C4M DevTools のアクション表示のテスト
 *
 * draft-ietf-moq-transport-21 で CLIENT_SETUP と SERVER_SETUP が 1 つの SETUP に統合された
 * ため、画面の表示名と認可判定がその規則に従うことを固定する。
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

test("ACTION_GROUPS: ClientSetup と ServerSetup を 1 つの SETUP にまとめる", () => {
  const setup = ACTION_GROUPS.find((group) => group.name === "SETUP");
  assert.deepEqual(setup?.actions, ["ClientSetup", "ServerSetup"]);
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
    ],
  );
});

test("actionDisplayNames: 同じ表示名は 1 つにまとめ、表に無い値は数値のままにする", () => {
  // claim の 0 (ClientSetup) と 1 (ServerSetup) はどちらも SETUP になる
  assert.deepEqual(actionDisplayNames([0, 1]), ["SETUP"]);
  assert.deepEqual(actionDisplayNames([4, 6, 7]), ["SUBSCRIBE", "PUBLISH", "FETCH"]);
  assert.equal(actionDisplayName(99), "99");
});

test("isActionAllowedByName: SETUP はどちらかの claim アクションで許可されていれば許可する", () => {
  const namespace = [TEXT_ENCODER.encode("15551")];
  const track = TEXT_ENCODER.encode("catalog");
  const claims = C4M.createCatClaims();
  // ClientSetup (0) だけを許可するスコープ
  claims.moqt = { scopes: [C4M.createMoqtScope(["ClientSetup"])] };

  assert.isTrue(isActionAllowedByName(claims, "SETUP", namespace, track));
  assert.isFalse(isActionAllowedByName(claims, "SUBSCRIBE", namespace, track));
});
