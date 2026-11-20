import { test, assert } from "vite-plus/test";
import * as fc from "fast-check";
import { buildMessageEventEntry, selectRecentMessageEventEntries } from "./eventTimeline";

// 履歴が 1 件ずつ増えても、最新 5 件だけを新しい順で残す。
// 送信側から届いた全履歴は変更せず、古い項目が再表示されないことも確かめる。
test("受信メッセージは履歴の長さによらず最新 5 件だけを新しい順で残す", () => {
  fc.assert(
    fc.property(fc.array(fc.string(), { maxLength: 30 }), (messages) => {
      const history = messages.map((text, index) => buildMessageEventEntry(text, index));
      for (let length = 0; length <= history.length; length++) {
        const received = history.slice(0, length);
        const original = [...received];
        const recent = selectRecentMessageEventEntries(received);

        assert.lengthOf(recent, Math.min(5, length));
        // 入力の末尾が最新であり、表示位置を 1 つ下げるごとに 1 件前へ戻る。
        for (let index = 0; index < recent.length; index++) {
          assert.strictEqual(recent[index], history[length - index - 1]);
        }
        assert.deepEqual(received, original);
      }
    }),
  );
});
