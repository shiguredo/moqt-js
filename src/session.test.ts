/**
 * SessionImpl の単体テスト
 *
 * WebTransport のモックを渡して SessionImpl を構築し、送信前検証をテストする。
 */

import { test, assert } from "vite-plus/test";
import { SessionImpl } from "./session";

/**
 * SessionImpl を構築するための WebTransport モック
 *
 * 検証が throw する経路のテストでは、それより後 (createBidirectionalStream 等) に
 * 到達しないため、transport は最小限のプロパティのみでよい。
 */
function createSessionImpl(): SessionImpl {
  const transport = {
    closed: new Promise<WebTransportCloseInfo>(() => {}),
  } as unknown as WebTransport;
  return new SessionImpl(transport, {});
}

/**
 * draft-ietf-moq-transport-19 §10.12.3 (Fetch Handling):
 * "End Location MUST specify the same or a larger Location than Start
 *  Location for Standalone and Absolute Joining Fetches."
 * 不正な範囲をワイヤに載せないよう送信前に throw することを検証する。
 */
test("fetch: End Location の Group が Start Location より小さい場合は throw する", async () => {
  const session = createSessionImpl();

  let thrown: Error | undefined;
  try {
    await session.fetch(
      ["live"],
      "video",
      {
        startLocation: { group: 2n, object: 0n },
        endLocation: { group: 1n, object: 0n },
      },
      { object: () => {} },
    );
  } catch (error) {
    thrown = error instanceof Error ? error : new Error(String(error));
  }

  assert.isDefined(thrown);
  assert.isTrue(thrown!.message.includes("is smaller than start location"));
});

test("fetch: 同一 Group 内で End Location の Object が小さい場合は throw する", async () => {
  const session = createSessionImpl();

  let thrown: Error | undefined;
  try {
    await session.fetch(
      ["live"],
      "video",
      {
        startLocation: { group: 1n, object: 5n },
        endLocation: { group: 1n, object: 4n },
      },
      { object: () => {} },
    );
  } catch (error) {
    thrown = error instanceof Error ? error : new Error(String(error));
  }

  assert.isDefined(thrown);
  assert.isTrue(thrown!.message.includes("is smaller than start location"));
});

test("fetch: End Location が Start Location と等しい場合は Location 検証で throw しない", async () => {
  const session = createSessionImpl();

  let thrown: Error | undefined;
  try {
    await session.fetch(
      ["live"],
      "video",
      {
        startLocation: { group: 1n, object: 0n },
        endLocation: { group: 1n, object: 0n },
      },
      { object: () => {} },
    );
  } catch (error) {
    thrown = error instanceof Error ? error : new Error(String(error));
  }

  // Location 検証は通過する。後続の送信経路 (controlWriter 未初期化等) のエラーは対象外
  assert.isNull(thrown?.message.match(/is smaller than start location/) ?? null);
});
