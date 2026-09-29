import { test, assert } from "vite-plus/test";
import { decodeEventTimeline, encodeEventTimeline } from "moqt-js";
import {
  appendMessageEventEntry,
  buildMessageEventEntry,
  MESSAGES_EVENT_TYPE,
  EVENT_HISTORY_LIMIT,
  EVENT_TRACK_NAME,
  formatEventEntryData,
} from "./eventTimeline";

// ============================================================================
// 定数
// ============================================================================

// catalog の検証 (src/msf/catalogTrackValidation.ts) は eventtimeline のトラックに
// eventType / depends / mimeType を MUST で要求する。eventType は逆ドメイン名の
// 形式で、MSF に登録された型ではないことを固定する
test("EVENT_TRACK_NAME と MESSAGES_EVENT_TYPE は devtools の取り決めの値になる", () => {
  assert.equal(EVENT_TRACK_NAME, "events");
  assert.equal(MESSAGES_EVENT_TYPE, "app.shiguredo.moqt-devtools.messages");
});

// ============================================================================
// entry の組み立て
// ============================================================================

// draft-ietf-moq-msf-01 §8.1: entry は index 参照を 1 つ持ち、data の構造は
// catalog の eventType が定義する。メッセージは壁時計 (`t`) で並べる
test("buildMessageEventEntry: 壁時計と text を持つ entry を作る", () => {
  const entry = buildMessageEventEntry("hello", 1_790_263_445_102);

  assert.equal(entry.t, 1_790_263_445_102);
  // Media PTS (`m`) と Location (`l`) は使わない
  assert.isUndefined(entry.m);
  assert.isUndefined(entry.l);
  assert.deepEqual(entry.data, { text: "hello" });
});

// ============================================================================
// 履歴の追記
// ============================================================================

test("appendMessageEventEntry: 履歴の末尾に 1 件足す", () => {
  const first = buildMessageEventEntry("one", 1000);
  const second = buildMessageEventEntry("two", 2000);

  const original = [first];
  const history = appendMessageEventEntry(original, second);

  assert.deepEqual(history, [first, second]);
  // 引数の配列は書き換えない
  assert.deepEqual(original, [first]);
});

// draft-ietf-moq-msf-01 §8.3: Group の先頭 Object には、それまでに蓄積されアクセス
// 可能な全レコードを載せる。上限を超えたら古い方から落とし、payload の増加を抑える
test("appendMessageEventEntry: 上限を超えたら古い entry から落とす", () => {
  const entries = Array.from({ length: EVENT_HISTORY_LIMIT }, (_, index) =>
    buildMessageEventEntry(`message ${index}`, index),
  );

  const history = appendMessageEventEntry(
    entries,
    buildMessageEventEntry("newest", EVENT_HISTORY_LIMIT),
  );

  assert.equal(history.length, EVENT_HISTORY_LIMIT);
  // 先頭の 1 件が落ち、2 件目が新しい先頭になる
  assert.deepEqual(history[0], entries[1]);
  // 末尾は追加した entry になる
  assert.deepEqual(
    history[history.length - 1],
    buildMessageEventEntry("newest", EVENT_HISTORY_LIMIT),
  );
});

// ============================================================================
// 表示用の文字列
// ============================================================================

// devtools の eventType では { text: string } を送る。text があればそのまま表示する
test("formatEventEntryData: text を持つ data は text を表示する", () => {
  assert.equal(formatEventEntryData({ text: "hello" }), "hello");
});

// 他の publisher の event timeline を購読したときは data の構造が違う。
// その場合は JSON として表示し、表示のたびに例外を出さない
test("formatEventEntryData: text を持たない data は JSON として表示する", () => {
  assert.equal(formatEventEntryData({ score: 2 }), '{"score":2}');
  assert.equal(formatEventEntryData([1, 2]), "[1,2]");
  assert.equal(formatEventEntryData("plain"), '"plain"');
  // JSON.stringify が undefined を返す値は String に落とす
  assert.equal(formatEventEntryData(undefined), "undefined");
  // 循環参照は JSON にできないため String に落とす
  const cyclic: Record<string, unknown> = {};
  cyclic["self"] = cyclic;
  assert.equal(formatEventEntryData(cyclic), "[object Object]");
});

// ============================================================================
// wire format との往復
// ============================================================================

// 送信側が encodeEventTimeline に渡す entry の配列を、購読側が decodeEventTimeline で
// 読み戻せることを固定する (devtools の publisher と subscriber はこの経路だけを使う)
test("buildMessageEventEntry: encodeEventTimeline と decodeEventTimeline で往復できる", () => {
  const history = [buildMessageEventEntry("one", 1000), buildMessageEventEntry("two", 2000)];

  const decoded = decodeEventTimeline(encodeEventTimeline(history));

  assert.deepEqual(decoded, history);
});
