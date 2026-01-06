import { test, assert, beforeEach } from "vitest";
import { ControlStreamReader, ControlStreamWriter } from "./controlStream";
import { MessageType } from "./message/types";

let reader: ControlStreamReader;
let writer: ControlStreamWriter;

beforeEach(() => {
  reader = new ControlStreamReader();
  writer = new ControlStreamWriter();
});

test("ControlStreamReader の初期状態", () => {
  assert.equal(reader.bufferSize, 0);
  assert.equal(reader.isFinReceived, false);
});

test("ControlStreamReader で空データを供給", () => {
  const messages = reader.feed(new Uint8Array(0));
  assert.equal(messages.length, 0);
  assert.equal(reader.bufferSize, 0);
});

test("ControlStreamReader で FIN フラグを設定", () => {
  reader.feed(new Uint8Array(0), true);
  assert.equal(reader.isFinReceived, true);
});

test("ControlStreamReader でバッファをクリア", () => {
  reader.feed(new Uint8Array([0x01, 0x02, 0x03]));
  assert.equal(reader.bufferSize, 3);
  reader.clear();
  assert.equal(reader.bufferSize, 0);
});

test("ControlStreamReader で単一メッセージを解析", () => {
  const data = new Uint8Array([0x20, 0x00, 0x02, 0xab, 0xcd]);
  const messages = reader.feed(data);

  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, MessageType.CLIENT_SETUP);
  assert.deepEqual(messages[0].payload, new Uint8Array([0xab, 0xcd]));
  assert.equal(reader.bufferSize, 0);
});

test("ControlStreamReader でペイロードなしのメッセージを解析", () => {
  const data = new Uint8Array([0x10, 0x00, 0x00]);
  const messages = reader.feed(data);

  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, MessageType.GOAWAY);
  assert.equal(messages[0].payload.length, 0);
});

test("ControlStreamReader で複数メッセージを一度に解析", () => {
  const data = new Uint8Array([0x03, 0x00, 0x01, 0x11, 0x04, 0x00, 0x02, 0x22, 0x33]);
  const messages = reader.feed(data);

  assert.equal(messages.length, 2);
  assert.equal(messages[0].type, MessageType.SUBSCRIBE);
  assert.deepEqual(messages[0].payload, new Uint8Array([0x11]));
  assert.equal(messages[1].type, MessageType.SUBSCRIBE_OK);
  assert.deepEqual(messages[1].payload, new Uint8Array([0x22, 0x33]));
});

test("ControlStreamReader で分割されたメッセージ (ヘッダ途中) を解析", () => {
  let messages = reader.feed(new Uint8Array([0x20]));
  assert.equal(messages.length, 0);
  assert.equal(reader.bufferSize, 1);

  messages = reader.feed(new Uint8Array([0x00, 0x02, 0xab, 0xcd]));
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, MessageType.CLIENT_SETUP);
  assert.deepEqual(messages[0].payload, new Uint8Array([0xab, 0xcd]));
});

test("ControlStreamReader で分割されたメッセージ (Payload 途中) を解析", () => {
  let messages = reader.feed(new Uint8Array([0x20, 0x00, 0x03, 0xab]));
  assert.equal(messages.length, 0);
  assert.equal(reader.bufferSize, 4);

  messages = reader.feed(new Uint8Array([0xcd, 0xef]));
  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0].payload, new Uint8Array([0xab, 0xcd, 0xef]));
});

test("ControlStreamReader で複数回に分けて供給", () => {
  const fullMessage = new Uint8Array([0x03, 0x00, 0x02, 0x11, 0x22]);

  for (let i = 0; i < fullMessage.length - 1; i++) {
    const messages = reader.feed(new Uint8Array([fullMessage[i]]));
    assert.equal(messages.length, 0);
  }

  const messages = reader.feed(new Uint8Array([fullMessage[fullMessage.length - 1]]));
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, MessageType.SUBSCRIBE);
});

test("ControlStreamReader で 2バイト varint Type のメッセージを解析", () => {
  const data = new Uint8Array([0x41, 0xdd, 0x00, 0x01, 0xff]);
  const messages = reader.feed(data);

  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, 0x1dd);
  assert.deepEqual(messages[0].payload, new Uint8Array([0xff]));
});

test("ControlStreamWriter で基本的なメッセージをエンコード", () => {
  const payload = new Uint8Array([0xab, 0xcd]);
  const encoded = writer.encode(MessageType.CLIENT_SETUP, payload);

  assert.deepEqual(encoded, new Uint8Array([0x20, 0x00, 0x02, 0xab, 0xcd]));
});

test("ControlStreamWriter で空ペイロードをエンコード", () => {
  const encoded = writer.encode(MessageType.GOAWAY, new Uint8Array(0));

  assert.deepEqual(encoded, new Uint8Array([0x10, 0x00, 0x00]));
});

test("ControlStreamWriter で大きなペイロードをエンコード", () => {
  const payload = new Uint8Array(256).fill(0xaa);
  const encoded = writer.encode(0x05, payload);

  assert.equal(encoded[0], 0x05);
  assert.equal(encoded[1], 0x01);
  assert.equal(encoded[2], 0x00);
  assert.deepEqual(encoded.slice(3), payload);
});

test("ControlStreamWriter で最大サイズペイロード (65535 bytes) をエンコード", () => {
  const payload = new Uint8Array(65535).fill(0x55);
  const encoded = writer.encode(0x01, payload);

  assert.equal(encoded[1], 0xff);
  assert.equal(encoded[2], 0xff);
  assert.equal(encoded.length, 1 + 2 + 65535);
});

test("ControlStreamWriter でペイロードが大きすぎるとエラー", () => {
  const payload = new Uint8Array(65536);
  assert.throws(() => writer.encode(0x01, payload), "Payload too large");
});

test("ControlStreamWriter で 2バイト varint Type をエンコード", () => {
  const payload = new Uint8Array([0x11, 0x22]);
  const encoded = writer.encode(0x1dd, payload);

  assert.deepEqual(encoded.slice(0, 2), new Uint8Array([0x41, 0xdd]));
  assert.equal(encoded[2], 0x00);
  assert.equal(encoded[3], 0x02);
  assert.deepEqual(encoded.slice(4), payload);
});

test("ControlStreamWriter で encodeMessage を使用", () => {
  const msg = { type: MessageType.SUBSCRIBE, payload: new Uint8Array([0x01]) };
  const encoded = writer.encodeMessage(msg);

  assert.deepEqual(encoded, new Uint8Array([0x03, 0x00, 0x01, 0x01]));
});

test("encode → decode roundtrip", () => {
  const messages = [
    { type: MessageType.CLIENT_SETUP, payload: new Uint8Array([0x01, 0x02, 0x03]) },
    { type: MessageType.SUBSCRIBE, payload: new Uint8Array([0x10, 0x20]) },
    { type: MessageType.PUBLISH, payload: new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd]) },
  ];

  const encoded: Uint8Array[] = messages.map((m) => writer.encodeMessage(m));
  const totalLen = encoded.reduce((sum, e) => sum + e.length, 0);
  const combined = new Uint8Array(totalLen);
  let offset = 0;
  for (const e of encoded) {
    combined.set(e, offset);
    offset += e.length;
  }

  const decoded = reader.feed(combined);

  assert.equal(decoded.length, messages.length);
  for (let i = 0; i < messages.length; i++) {
    assert.equal(decoded[i].type, messages[i].type);
    assert.deepEqual(decoded[i].payload, messages[i].payload);
  }
});

test("ストリーミング roundtrip (1バイトずつ)", () => {
  const original = {
    type: MessageType.SUBSCRIBE_OK,
    payload: new Uint8Array([0x55, 0x66, 0x77]),
  };
  const encoded = writer.encodeMessage(original);

  const allDecoded: { type: number; payload: Uint8Array }[] = [];

  for (const byte of encoded) {
    const messages = reader.feed(new Uint8Array([byte]));
    allDecoded.push(...messages);
  }

  assert.equal(allDecoded.length, 1);
  assert.equal(allDecoded[0].type, original.type);
  assert.deepEqual(allDecoded[0].payload, original.payload);
});
