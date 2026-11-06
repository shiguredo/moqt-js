import { test, assert, beforeEach } from "vite-plus/test";
import { ControlStreamReader, ControlStreamWriter } from "./controlStream";
import { MessageType } from "./message/types";
import { SessionError, SessionErrorCode } from "./error";
import { captureThrownError, concatUint8Arrays } from "./testSupport/helpers";

/**
 * draft-ietf-moq-transport-23 §9 (Control Messages) のフレーミングのテスト
 *
 * Control Message は Type (vi64) + Message Length (vi64) + Message Body で構成し、
 * Message Length は Message Body のバイト長である。旧 draft の 16 bit 固定長ではない。
 */

let reader: ControlStreamReader;
let writer: ControlStreamWriter;

beforeEach(() => {
  reader = new ControlStreamReader();
  writer = new ControlStreamWriter();
});

/**
 * reader.feed が SessionError を投げることを検証し、投げたエラーを返す
 *
 * Chai の assert.throws はエラーを返さないため、コードまで確認できるよう
 * 既存の captureThrownError で受け取る。
 */
function feedExpectingSessionError(target: ControlStreamReader, data: Uint8Array): SessionError {
  const error = captureThrownError(() => {
    target.feed(data);
  });
  assert.instanceOf(error, SessionError, "SessionError が投げられること");
  return error as SessionError;
}

test("ControlStreamReader で空データを供給", () => {
  const messages = reader.feed(new Uint8Array(0));
  assert.equal(messages.length, 0);
});

test("ControlStreamReader でバッファをクリア", () => {
  // メッセージの途中まで供給してからクリアすると、残りを供給しても復元されない
  reader.feed(new Uint8Array([0x01, 0x02]));
  reader.clear();
  const messages = reader.feed(new Uint8Array([0x03]));

  assert.equal(messages.length, 0);
});

test("ControlStreamReader で単一メッセージを解析", () => {
  // SETUP (0x2f00) の varint エンコードは [0xaf, 0x00]。
  // Message Length 2 の vi64 は [0x02] であり、その後に 2 バイトの本文が続く。
  const data = new Uint8Array([0xaf, 0x00, 0x02, 0xab, 0xcd]);
  const messages = reader.feed(data);

  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.type, MessageType.SETUP);
  assert.deepEqual(messages[0]?.payload, new Uint8Array([0xab, 0xcd]));
});

test("ControlStreamReader でペイロードなしのメッセージを解析", () => {
  // GOAWAY (0x10) の本文長 0 は Length 1 バイトの [0x00] だけで表現する
  const data = new Uint8Array([0x10, 0x00]);
  const messages = reader.feed(data);

  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.type, MessageType.GOAWAY);
  assert.equal(messages[0]?.payload.length, 0);
});

test("ControlStreamReader で複数メッセージを一度に解析", () => {
  // SUBSCRIBE (0x03, 本文 1 バイト) と SUBSCRIBE_OK (0x04, 本文 2 バイト) を連結する
  const data = new Uint8Array([0x03, 0x01, 0x11, 0x04, 0x02, 0x22, 0x33]);
  const messages = reader.feed(data);

  assert.equal(messages.length, 2);
  assert.equal(messages[0]?.type, MessageType.SUBSCRIBE);
  assert.deepEqual(messages[0]?.payload, new Uint8Array([0x11]));
  assert.equal(messages[1]?.type, MessageType.SUBSCRIBE_OK);
  assert.deepEqual(messages[1]?.payload, new Uint8Array([0x22, 0x33]));
});

test("ControlStreamReader で分割されたメッセージ (Type の途中) を解析", () => {
  // SETUP (0x2f00) の varint エンコードは [0xaf, 0x00]。
  // Type が揃うまではメッセージを取り出さず、半端なバイトを保持する。
  let messages = reader.feed(new Uint8Array([0xaf]));
  assert.equal(messages.length, 0);
  assert.isTrue(reader.hasBufferedBytes);
  assert.equal(reader.bufferedBytes, 1);

  messages = reader.feed(new Uint8Array([0x00, 0x02, 0xab, 0xcd]));
  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.type, MessageType.SETUP);
  assert.deepEqual(messages[0]?.payload, new Uint8Array([0xab, 0xcd]));
});

test("ControlStreamReader で分割されたメッセージ (Length の途中) を解析", () => {
  // 本文長 130 は vi64 2 バイトの [0x80, 0x82]。
  // Length の 1 バイト目だけを先に供給し、まだメッセージが揃わないことを確認する。
  const payload = new Uint8Array(130).fill(0x5a);
  const frame = concatUint8Arrays([
    new Uint8Array([0x10]),
    new Uint8Array([0x80]),
    new Uint8Array([0x82]),
    payload,
  ]);

  let messages = reader.feed(frame.slice(0, 2));
  assert.equal(messages.length, 0);
  assert.isTrue(reader.hasBufferedBytes);

  messages = reader.feed(frame.slice(2));
  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.type, MessageType.GOAWAY);
  assert.deepEqual(messages[0]?.payload, payload);
});

test("ControlStreamReader で分割されたメッセージ (Payload の途中) を解析", () => {
  // SETUP (0x2f00) の本文 3 バイトを 1 バイトずつ供給する
  let messages = reader.feed(new Uint8Array([0xaf, 0x00, 0x03, 0xab]));
  assert.equal(messages.length, 0);

  messages = reader.feed(new Uint8Array([0xcd, 0xef]));
  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0]?.payload, new Uint8Array([0xab, 0xcd, 0xef]));
});

test("ControlStreamReader で 2 バイト varint Type のメッセージを解析", () => {
  // 0x1dd = 477 → vi64: [0x81, 0xdd]
  const data = new Uint8Array([0x81, 0xdd, 0x01, 0xff]);
  const messages = reader.feed(data);

  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.type, 0x1dd);
  assert.deepEqual(messages[0]?.payload, new Uint8Array([0xff]));
});

test("ControlStreamReader で 1 バイト Length の上限 (127) を解析", () => {
  // Length 127 は vi64 1 バイトの上限
  const payload = new Uint8Array(127).fill(0x11);
  const messages = reader.feed(concatUint8Arrays([new Uint8Array([0x10, 0x7f]), payload]));

  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.payload.length, 127);
});

test("ControlStreamReader で 2 バイト Length (128) を解析", () => {
  // Length 128 は vi64 2 バイトの最小値 [0x80, 0x80]
  const payload = new Uint8Array(128).fill(0x22);
  const messages = reader.feed(concatUint8Arrays([new Uint8Array([0x10, 0x80, 0x80]), payload]));

  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.payload.length, 128);
});

test("ControlStreamReader で 3 バイト Length (16384) を解析", () => {
  // Length 16384 は vi64 3 バイトの最小値 [0xc0, 0x40, 0x00]
  const payload = new Uint8Array(16384).fill(0x33);
  const messages = reader.feed(
    concatUint8Arrays([new Uint8Array([0x10, 0xc0, 0x40, 0x00]), payload]),
  );

  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.payload.length, 16384);
});

test("ControlStreamReader で 4 バイト Length (2097152) を解析", () => {
  // Length 2097152 (2 MiB) は vi64 4 バイトの最小値 [0xe0, 0x20, 0x00, 0x00]。
  // 既定上限 65535 を超えるため、上限を本文長と同じ 2 MiB にした reader で解析する。
  const payload = new Uint8Array(2097152).fill(0x44);
  const largeReader = new ControlStreamReader(2097152);
  const messages = largeReader.feed(
    concatUint8Arrays([new Uint8Array([0x10, 0xe0, 0x20, 0x00, 0x00]), payload]),
  );

  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.payload.length, 2097152);
});

test("ControlStreamReader で 5 バイト Length をデコードし本文待ちになる", () => {
  // Length 268435456 (2^28) は vi64 5 バイトの最小値 [0xf0, 0x10, 0x00, 0x00, 0x00]。
  // 本文を用意できないため上限を最大にしてヘッダだけを供給し、Length を読み進めて
  // 本文待ちになることを確認する (デコード幅の検証)。
  const largeReader = new ControlStreamReader(Number.MAX_SAFE_INTEGER);
  const messages = largeReader.feed(new Uint8Array([0x10, 0xf0, 0x10, 0x00, 0x00, 0x00]));

  assert.equal(messages.length, 0);
  assert.isTrue(largeReader.hasBufferedBytes);
  assert.equal(largeReader.bufferedBytes, 6);
});

test("ControlStreamReader で 9 バイトの非最小表現の Length を解析", () => {
  // draft-ietf-moq-transport-23 §8.1: varint は最小バイト数である必要はなく、
  // 値を表現できる任意の長さを使える。9 バイト varint で値 1 を表す
  // [0xff, 0x00 x 7, 0x01] も受理しなければならない。
  // Type 0x10 + 9 バイト Length = 1 + 本文 1 バイトを供給して解析する。
  const messages = reader.feed(
    new Uint8Array([0x10, 0xff, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0xab]),
  );

  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.type, 0x10);
  assert.deepEqual(messages[0]?.payload, new Uint8Array([0xab]));
});

test("ControlStreamReader で 5 バイト Length の上限超過を FIELD_LENGTH_EXCEEDED にする", () => {
  // 既定上限 65535 に対して Length 268435456 (vi64 5 バイト) を宣言する。
  // 本文が揃う前でも宣言時点でセッションを閉じるコードを返す。
  const error = feedExpectingSessionError(
    reader,
    new Uint8Array([0x10, 0xf0, 0x10, 0x00, 0x00, 0x00]),
  );

  assert.equal(error.code, SessionErrorCode.FIELD_LENGTH_EXCEEDED);
  assert.isTrue(error.message.includes("268435456"));
  assert.isTrue(error.message.includes("65535"));
});

test("ControlStreamReader で 9 バイト Length の上限超過を FIELD_LENGTH_EXCEEDED にする", () => {
  // Length 72057594037927936 (2^56) は 9 バイト varint の最小表現であり、
  // Number の整数精度を超えるが、bigint のまま比較して上限超過を判定する
  const error = feedExpectingSessionError(
    reader,
    new Uint8Array([0x10, 0xff, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
  );

  assert.equal(error.code, SessionErrorCode.FIELD_LENGTH_EXCEEDED);
  assert.isTrue(error.message.includes("72057594037927936"));
});

test("ControlStreamReader でローカル上限ちょうどの Length を受理", () => {
  // 上限を 4 にした reader に本文長 4 のメッセージを供給する (境界値)
  const boundedReader = new ControlStreamReader(4);
  const messages = boundedReader.feed(new Uint8Array([0x10, 0x04, 0xaa, 0xbb, 0xcc, 0xdd]));

  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0]?.payload, new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd]));
});

test("ControlStreamReader でローカル上限を 1 バイト超える Length を拒否", () => {
  // 境界値 + 1 は FIELD_LENGTH_EXCEEDED。本文は供給しない (宣言時点で閉じる)
  const boundedReader = new ControlStreamReader(4);
  const error = feedExpectingSessionError(boundedReader, new Uint8Array([0x10, 0x05]));

  assert.equal(error.code, SessionErrorCode.FIELD_LENGTH_EXCEEDED);
});

test("ControlStreamWriter で基本的なメッセージをエンコード", () => {
  const payload = new Uint8Array([0xab, 0xcd]);
  // SETUP (0x2f00) の varint は [0xaf, 0x00]、Length 2 の vi64 は [0x02]
  const encoded = writer.encode(MessageType.SETUP, payload);

  assert.deepEqual(encoded, new Uint8Array([0xaf, 0x00, 0x02, 0xab, 0xcd]));
});

test("ControlStreamWriter で空ペイロードをエンコード", () => {
  const encoded = writer.encode(MessageType.GOAWAY, new Uint8Array(0));

  assert.deepEqual(encoded, new Uint8Array([0x10, 0x00]));
});

test("ControlStreamWriter で 1 バイト Length の上限 (127) をエンコード", () => {
  const payload = new Uint8Array(127).fill(0x11);
  const encoded = writer.encode(0x10, payload);

  assert.equal(encoded[0], 0x10);
  assert.equal(encoded[1], 0x7f);
  assert.equal(encoded.length, 2 + 127);
});

test("ControlStreamWriter で 2 バイト Length (128) をエンコード", () => {
  const payload = new Uint8Array(128).fill(0x22);
  const encoded = writer.encode(0x10, payload);

  assert.deepEqual(encoded.slice(0, 3), new Uint8Array([0x10, 0x80, 0x80]));
  assert.equal(encoded.length, 3 + 128);
});

test("ControlStreamWriter で 3 バイト Length (16384) をエンコード", () => {
  const payload = new Uint8Array(16384).fill(0x33);
  const encoded = writer.encode(0x10, payload);

  assert.deepEqual(encoded.slice(0, 4), new Uint8Array([0x10, 0xc0, 0x40, 0x00]));
  assert.equal(encoded.length, 4 + 16384);
});

test("ControlStreamWriter で 2 バイト varint Type をエンコード", () => {
  // 0x1dd = 477 → vi64: [0x81, 0xdd]
  const payload = new Uint8Array([0x11, 0x22]);
  const encoded = writer.encode(0x1dd, payload);

  assert.deepEqual(encoded, new Uint8Array([0x81, 0xdd, 0x02, 0x11, 0x22]));
});

test("ControlStreamWriter で既定上限 (65535) ちょうどのペイロードをエンコード", () => {
  const payload = new Uint8Array(65535).fill(0x55);
  const encoded = writer.encode(0x10, payload);

  // Length 65535 は vi64 3 バイトの [0xc0, 0xff, 0xff]
  assert.equal(encoded[0], 0x10);
  assert.equal(encoded[1], 0xc0);
  assert.equal(encoded[2], 0xff);
  assert.equal(encoded[3], 0xff);
  assert.equal(encoded.length, 1 + 3 + 65535);
});

test("ControlStreamWriter で既定上限を超えるペイロードはエラー", () => {
  const payload = new Uint8Array(65536);
  assert.throws(() => writer.encode(0x10, payload), "exceeds peer maximum 65535");
});

test("ControlStreamWriter で maxMessageSize を変更すると上限を超えるペイロードはエラー", () => {
  // ピアの SETUP 受信後に上限が更新される経路を想定する。値を小さくすれば
  // 小さなペイロードでも送信前に拒否する。
  writer.setMaxMessageSize(8);
  assert.deepEqual(
    writer.encode(0x10, new Uint8Array(8)).slice(0, 2),
    new Uint8Array([0x10, 0x08]),
  );
  assert.throws(() => writer.encode(0x10, new Uint8Array(9)), "exceeds peer maximum 8");
});

test("ControlStreamWriter の setMaxMessageSize は不正値を拒否する", () => {
  // 上限は 0 以上の安全な整数でなければならない (本文長は number で比較するため)
  assert.throws(() => writer.setMaxMessageSize(Number.NaN), "non-negative safe integer");
  assert.throws(() => writer.setMaxMessageSize(-1), "non-negative safe integer");
  assert.throws(() => writer.setMaxMessageSize(1.5), "non-negative safe integer");
  assert.throws(
    () => writer.setMaxMessageSize(Number.MAX_SAFE_INTEGER + 1),
    "non-negative safe integer",
  );
});

test("ControlStreamReader のコンストラクタは不正値を拒否する", () => {
  // writer と同じく 0 以上の安全な整数だけを受け付ける
  assert.throws(() => new ControlStreamReader(Number.NaN), "non-negative safe integer");
  assert.throws(() => new ControlStreamReader(-1), "non-negative safe integer");
  assert.throws(() => new ControlStreamReader(1.5), "non-negative safe integer");
  assert.throws(
    () => new ControlStreamReader(Number.MAX_SAFE_INTEGER + 1),
    "non-negative safe integer",
  );
});

test("ControlStreamWriter のコンストラクタは不正値を拒否する", () => {
  // コンストラクタも setter と同じ検証を通す (NaN を渡すと上限が無効化されるため)
  assert.throws(() => new ControlStreamWriter(Number.NaN), "non-negative safe integer");
  assert.throws(() => new ControlStreamWriter(-1), "non-negative safe integer");
  assert.throws(() => new ControlStreamWriter(1.5), "non-negative safe integer");
  assert.throws(
    () => new ControlStreamWriter(Number.MAX_SAFE_INTEGER + 1),
    "non-negative safe integer",
  );
});

test("ControlStreamWriter で 2 バイト varint Type と 2 バイト Length を併用してエンコード", () => {
  const payload = new Uint8Array(130).fill(0x66);
  const encoded = writer.encode(0x1dd, payload);

  assert.deepEqual(encoded.slice(0, 4), new Uint8Array([0x81, 0xdd, 0x80, 0x82]));
  assert.equal(encoded.length, 4 + 130);
});

test("ストリーミング roundtrip (1 バイトずつ)", () => {
  const original = {
    type: MessageType.SUBSCRIBE_OK,
    payload: new Uint8Array([0x55, 0x66, 0x77]),
  };
  const encoded = writer.encode(original.type, original.payload);

  const allDecoded: { type: number; payload: Uint8Array }[] = [];

  for (const byte of encoded) {
    const messages = reader.feed(new Uint8Array([byte]));
    allDecoded.push(...messages);
  }

  assert.equal(allDecoded.length, 1);
  assert.equal(allDecoded[0]?.type, original.type);
  assert.deepEqual(allDecoded[0]?.payload, original.payload);
});

test("メッセージ全体を各バイト位置で分割しても復元できる", () => {
  // 2 バイト varint Type (0x1dd) と 2 バイト Length (130) を含むメッセージを、
  // すべてのバイト境界で 2 チャンクに分割して供給する。どの位置で切っても
  // メッセージが 1 回だけ復元されることを確認する。
  const payload = new Uint8Array(130).fill(0x77);
  const frame = writer.encode(0x1dd, payload);

  for (let splitPosition = 1; splitPosition < frame.length; splitPosition++) {
    const splitReader = new ControlStreamReader();
    const firstMessages = splitReader.feed(frame.slice(0, splitPosition));
    // 分割位置が本文の途中であれば、まだメッセージは揃わない
    assert.equal(firstMessages.length, 0);
    const secondMessages = splitReader.feed(frame.slice(splitPosition));
    assert.equal(secondMessages.length, 1);
    assert.equal(secondMessages[0]?.type, 0x1dd);
    assert.deepEqual(secondMessages[0]?.payload, payload);
  }
});

test("ControlStreamReader で連結されたメッセージを順序通り解析", () => {
  // initialize() は SETUP に相乗りした後続メッセージを同一チャンクで受け取るため、
  // SETUP (本文なし) と後続の GOAWAY (本文 1 バイト) を 1 チャンクで供給する
  const data = new Uint8Array([0xaf, 0x00, 0x00, 0x10, 0x01, 0xab]);
  const messages = reader.feed(data);

  assert.equal(messages.length, 2);
  assert.equal(messages[0]?.type, MessageType.SETUP);
  assert.deepEqual(messages[0]?.payload, new Uint8Array([]));
  assert.equal(messages[1]?.type, 0x10);
  assert.deepEqual(messages[1]?.payload, new Uint8Array([0xab]));
});

test("ControlStreamReader で 2 バイト Length の上限 (16383) を解析", () => {
  // Length 16383 は vi64 2 バイトの上限 [0xbf, 0xff]
  const payload = new Uint8Array(16383).fill(0x77);
  const messages = reader.feed(concatUint8Arrays([new Uint8Array([0x10, 0xbf, 0xff]), payload]));

  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.payload.length, 16383);
});

test("ControlStreamReader で既定上限 (65535) ちょうどの Length を受理", () => {
  // Length 65535 は vi64 3 バイトの [0xc0, 0xff, 0xff]。既定上限ちょうどの境界値
  const payload = new Uint8Array(65535).fill(0x88);
  const messages = reader.feed(
    concatUint8Arrays([new Uint8Array([0x10, 0xc0, 0xff, 0xff]), payload]),
  );

  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.payload.length, 65535);
});

test("ControlStreamReader で既定上限を 1 バイト超える宣言を拒否", () => {
  // Length 65536 は vi64 3 バイトの [0xc1, 0x00, 0x00]。本文は供給しない
  const error = feedExpectingSessionError(reader, new Uint8Array([0x10, 0xc1, 0x00, 0x00]));

  assert.equal(error.code, SessionErrorCode.FIELD_LENGTH_EXCEEDED);
});
