import { test, assert } from "vite-plus/test";
import { shouldSendOnEnter } from "./messageInput";

// 日本語入力の変換確定の Enter では送信しない。IME の変換中は isComposing が true に
// なるため、その Enter は変換の確定に使う
test("shouldSendOnEnter: 変換中の Enter では送信しない", () => {
  assert.isTrue(shouldSendOnEnter({ key: "Enter", isComposing: false }));
  assert.isFalse(shouldSendOnEnter({ key: "Enter", isComposing: true }));
});

// Enter 以外のキーでは送信しない
test("shouldSendOnEnter: Enter 以外では送信しない", () => {
  assert.isFalse(shouldSendOnEnter({ key: "a", isComposing: false }));
  assert.isFalse(shouldSendOnEnter({ key: "Process", isComposing: true }));
});
