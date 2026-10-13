import { test, assert, beforeEach } from "vite-plus/test";
import type { DebugMessage } from "moqt-js";
import { getMessageTypeName } from "../../../src/message/debug.ts";
import { MessageType } from "../../../src/message/types.ts";
import { handleDebugMessage as handleSubscriberDebugMessage } from "./useSubscriber";
import { handleDebugMessage as handlePublisherDebugMessage } from "./usePublisher";
import { __resetLogStateForTest, getLogBuffer } from "../signals/debugLog";

beforeEach(() => {
  __resetLogStateForTest();
});

// payload を残す型 (GOAWAY) を使う。型と表示名は moqt-js の対応から取る
function makeMessage(payload: Uint8Array): DebugMessage {
  return {
    direction: "recv",
    type: MessageType.GOAWAY,
    typeName: getMessageTypeName(MessageType.GOAWAY),
    payload,
    timestamp: 0,
  };
}

/** ログ 1 件の行を取り出す */
function firstLogMessage(): string {
  const [entry] = getLogBuffer();
  if (entry === undefined) {
    throw new Error("expected exactly one log entry");
  }
  return entry.message;
}

// useSubscriber / usePublisher の handleDebugMessage は logDebugMessage への 1 行委譲である。
// payload の扱い (独立コピー、認可トークンを載せうる型では残さないこと、上限) は委譲先の
// debugMessageLog.test.ts が固定するため、ここでは接続ごとの prefix (ログの行頭に出る
// `[subscriber-1]` / `[publisher]`) を付けてログへ 1 件積むことだけを確かめる
test("handleDebugMessage: 接続ごとの prefix を付けてログへ 1 件積む", () => {
  handleSubscriberDebugMessage("subscriber-1", makeMessage(new Uint8Array([1, 2, 3, 4])));
  assert.equal(firstLogMessage(), "[subscriber-1] [RECV] GOAWAY");

  // 別の接続のログと混ざらないよう、prefix ごとに分けて積む
  __resetLogStateForTest();
  handlePublisherDebugMessage(makeMessage(new Uint8Array([0xaa, 0xbb])));
  assert.equal(firstLogMessage(), "[publisher] [RECV] GOAWAY");
});
