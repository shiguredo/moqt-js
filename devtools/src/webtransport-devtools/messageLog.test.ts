import { test, assert } from "vite-plus/test";
import {
  MAX_STREAM_MESSAGES,
  appendMessage,
  clearMessageLog,
  createMessageLogFields,
  formatTimestamp,
} from "./messageLog";

test("appendMessage は連番 ID と整形済みの日時を持つメッセージを末尾へ追加する", () => {
  const log = createMessageLogFields();
  appendMessage(log, "recv", "hello");
  appendMessage(log, "send", "world");

  assert.equal(log.messages.length, 2);
  const [first, second] = log.messages;
  assert.ok(first !== undefined);
  assert.ok(second !== undefined);

  // 表示の key に使う連番は、追加した順に増える
  assert.ok(first.id < second.id);
  assert.equal(first.direction, "recv");
  assert.equal(first.data, "hello");
  assert.equal(second.direction, "send");
  assert.equal(second.data, "world");

  // 日時は追加時に 1 回だけ整形して持つ (描画では整形し直さない)
  assert.equal(typeof first.formattedTimestamp, "string");
  assert.ok(first.formattedTimestamp.length > 0);
  assert.equal(first.formattedTimestamp, formatTimestamp(first.timestamp));
});

test("appendMessage の連番は一覧をまたいで重複しない", () => {
  const first = createMessageLogFields();
  const second = createMessageLogFields();
  for (let i = 0; i < 5; i++) {
    appendMessage(first, "recv", `a-${i}`);
    appendMessage(second, "recv", `b-${i}`);
  }

  const ids = [...first.messages, ...second.messages].map((message) => message.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("appendMessage は上限を超えたら最古を捨て、件数を上限に保つ", () => {
  const log = createMessageLogFields();
  const appendCount = MAX_STREAM_MESSAGES + 5;
  for (let i = 0; i < appendCount; i++) {
    appendMessage(log, "recv", `m-${i}`);
  }

  assert.equal(log.messages.length, MAX_STREAM_MESSAGES);
  // 先頭は最も古い 5 件が落ちたものになる
  assert.equal(log.messages[0]?.data, "m-5");
  assert.equal(log.messages.at(-1)?.data, `m-${appendCount - 1}`);
});

test("appendMessage は配列を作り直さず、追加を連番で伝える", () => {
  const log = createMessageLogFields();
  // 呼び出し側は同じ配列を読み続けられる (再描画のトリガは messagesVersion)
  const messages = log.messages;
  const initialVersion = log.messagesVersion.value;

  appendMessage(log, "recv", "a");
  assert.equal(log.messages, messages);
  assert.equal(log.messagesVersion.value, initialVersion + 1);

  // 上限に達した後も配列は作り直さない
  for (let i = 0; i < MAX_STREAM_MESSAGES + 1; i++) {
    appendMessage(log, "recv", `m-${i}`);
  }
  assert.equal(log.messages, messages);
  assert.equal(log.messagesVersion.value, initialVersion + MAX_STREAM_MESSAGES + 2);
});

test("clearMessageLog は一覧を空にして連番を増やす", () => {
  const log = createMessageLogFields();
  appendMessage(log, "recv", "a");
  const messages = log.messages;
  const version = log.messagesVersion.value;

  clearMessageLog(log);

  assert.equal(log.messages.length, 0);
  // 空にする変更も連番で伝える (追加と同じ経路で再描画できるようにする)
  assert.equal(log.messagesVersion.value, version + 1);
  assert.equal(log.messages, messages);
});
