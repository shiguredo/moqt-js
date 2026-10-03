import { expect, test } from "@playwright/test";
import { RELAY_TEST_TIMEOUT_MS, closeRelayPage, openRelayPage, requireRelayUri } from "./support";

// 実リレーとのセッション確立 (SETUP の交換) と正常な切断を検証する
//
// draft-ietf-moq-transport-22 §6.2 (Session establishment)
// draft-ietf-moq-transport-22 §9.1 (SETUP)
//
// ここが通らないと他の実リレーのテストはすべて意味を持たないため、最初に確認する
// 最小のシナリオにする。接続先は環境変数 TEST_MOQT_URI で渡す。
test("実リレーへ接続し、SETUP の交換が完了してから正常に切断できる", async ({ browser }) => {
  test.setTimeout(RELAY_TEST_TIMEOUT_MS);
  const moqtUri = requireRelayUri();
  if (moqtUri === null) {
    return;
  }

  const page = await openRelayPage(browser);
  try {
    const result = await page.evaluate(
      (uri) => window.__moqtE2E.connectRelay({ url: uri }),
      moqtUri,
    );

    // SETUP の交換が完了していれば state は "connected" になる
    expect(result.state).toBe("connected");
    // 接続そのものが失敗した場合は close が通知される前に error が積まれる
    expect(result.errors).toEqual([]);
    // 正常な切断では close が通知され、closeCode は NO_ERROR (0) になる
    expect(result.closeNotified).toBe(true);
    expect(result.closeCode).toBe(0);
  } finally {
    await closeRelayPage(page);
  }
});
