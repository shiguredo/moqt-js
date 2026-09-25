import { test, assert } from "vite-plus/test";
import { hasActivePublisher, isStarting, pubSession } from "./publisher";

// Publisher が接続設定を使っているかは、session があるか、配信を始めている途中かで決まる。
// startPublishing は connect の後に session を設定するため、connect を待つ間は session が
// null のまま接続設定を使っている。この間に Subscriber を止めても、接続設定の入力を
// 有効に戻してはならない
test("hasActivePublisher: session が無くても配信を始めている途中なら接続設定を使っている", () => {
  pubSession.value = null;
  isStarting.value = false;
  try {
    // 配信していない
    assert.isFalse(hasActivePublisher.value);

    // connect を待っている (session はまだ無い)
    isStarting.value = true;
    assert.isTrue(hasActivePublisher.value);

    // 開始が失敗して後始末を終えた
    isStarting.value = false;
    assert.isFalse(hasActivePublisher.value);
  } finally {
    isStarting.value = false;
  }
});
