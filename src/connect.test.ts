/**
 * connect() の SETUP 配線のテスト
 *
 * draft-ietf-moq-msf-01 §11.1.1 (c4m) / §11.4.2 / §11.4.3 (Presenting Authorization):
 * MOQT URI の msf fragment が持つ c4m は Base64 でエンコードされた C4M トークンであり、
 * クライアントが取り出して SETUP の AUTHORIZATION TOKEN として送る。
 * fragment はサーバーへ送信されない (draft-ietf-moq-transport-21 §6.1.1)。
 *
 * connect() は WebTransport の実体を必要とするため、connect() と initialize() が使う
 * API だけを持つ WebTransport の代役を globalThis に差し替えて最後まで駆動する
 * (モックライブラリは使わない)。
 */

import { test, assert } from "vite-plus/test";
import { connect } from "./connect";
import { ControlStreamReader, ControlStreamWriter } from "./controlStream";
import { concatUint8Arrays } from "./testSupport/helpers";
import { decodeVarint, encodeVarint } from "./varint";
import {
  type AuthorizationToken,
  type AuthorizationTokenUseValue,
  AuthorizationTokenAliasType,
  MessageType,
  getSetupAuthorizationTokens,
} from "./message";
import { createSetup, decodeSetupPayload, encodeSetupPayload } from "./message/setup";

/**
 * クライアントの SETUP 送信まで connect() を駆動する WebTransport の代役を差し込む
 *
 * - `ready` は解決済みで、`new WebTransport` の後も止まらない
 * - `createUnidirectionalStream()` が返すストリームでクライアントの送信バイト列を記録する
 * - `incomingUnidirectionalStreams` はサーバーの制御ストリーム
 *   (ストリームタイプ + SETUP) を 1 通だけ返す
 * - `closed` はテストの間ずっと解決しない
 *
 * @returns 差し替えを戻す `restore`、`new WebTransport` に渡された URL、送信バイト列
 */
function installSetupHandshakeTransport(): {
  restore(): void;
  createdUrls: string[];
  sentChunks: Uint8Array[];
} {
  const createdUrls: string[] = [];
  const sentChunks: Uint8Array[] = [];
  const clientControlStream = new WritableStream<Uint8Array>({
    write(chunk) {
      sentChunks.push(chunk);
    },
  });

  // サーバーの SETUP はクライアント側の検証を通る最小の内容にする
  const serverSetup = encodeSetupPayload(createSetup({ moqtImplementation: false }));
  const serverControlWriter = new ControlStreamWriter();
  const serverControlStream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        new Uint8Array([
          ...encodeVarint(MessageType.SETUP),
          ...serverControlWriter.encode(MessageType.SETUP, serverSetup),
        ]),
      );
    },
  });

  const transport = {
    closed: new Promise<WebTransportCloseInfo>(() => {}),
    ready: Promise.resolve(),
    createUnidirectionalStream: async () => clientControlStream,
    incomingUnidirectionalStreams: new ReadableStream<ReadableStream<Uint8Array>>({
      start(controller) {
        controller.enqueue(serverControlStream);
      },
    }),
    incomingBidirectionalStreams: new ReadableStream<WebTransportBidirectionalStream>({
      start() {},
    }),
    datagrams: {
      readable: new ReadableStream<Uint8Array>({ start() {} }),
      writable: new WritableStream<Uint8Array>(),
    },
  } as unknown as WebTransport;

  const originalWebTransport = (globalThis as { WebTransport?: unknown }).WebTransport;
  // connect() は new WebTransport(url, options) を呼ぶため、関数を差し替えて URL を記録する
  (globalThis as { WebTransport?: unknown }).WebTransport = function WebTransport(
    this: unknown,
    url: string,
  ): WebTransport {
    createdUrls.push(url);
    return transport;
  } as unknown as typeof WebTransport;

  return {
    restore: () => {
      (globalThis as { WebTransport?: unknown }).WebTransport = originalWebTransport;
    },
    createdUrls,
    sentChunks,
  };
}

/**
 * クライアントが送った制御ストリームのバイト列から SETUP の Authorization Token を取り出す
 *
 * ストリームタイプ (0x2F00 = SETUP) とフレーミングを外し、Setup Options の
 * AUTHORIZATION TOKEN (0x03) をデコードする (draft-ietf-moq-transport-21 §9.1.4 / §8.9)。
 */
function decodeSentAuthorizationTokens(sentChunks: Uint8Array[]): AuthorizationToken[] {
  const sent = concatUint8Arrays(sentChunks);
  const [streamType, streamTypeConsumed] = decodeVarint(sent, 0);
  assert.strictEqual(Number(streamType), MessageType.SETUP);

  const messages = new ControlStreamReader().feed(sent.slice(streamTypeConsumed));
  assert.strictEqual(messages.length, 1);
  const [message] = messages;
  assert.isDefined(message);
  assert.strictEqual(message.type, MessageType.SETUP);

  return getSetupAuthorizationTokens(decodeSetupPayload(message.payload));
}

/**
 * USE_VALUE 形式の Authorization Token であることを確かめて中身を取り出す
 *
 * draft-ietf-moq-transport-21 §9.1.4: SETUP で送れるのは REGISTER (0x1) と USE_VALUE (0x3)。
 */
function requireUseValueToken(token: AuthorizationToken | undefined): AuthorizationTokenUseValue {
  assert.isDefined(token);
  if (token.aliasType !== AuthorizationTokenAliasType.USE_VALUE) {
    throw new Error(`expected USE_VALUE (0x3), got alias type ${token.aliasType}`);
  }
  return token;
}

test("connect: msf fragment の c4m を SETUP の AUTHORIZATION TOKEN として送る", async () => {
  const fake = installSetupHandshakeTransport();
  try {
    // "3q2-7w" は [0xde, 0xad, 0xbe, 0xef] の base64url (パディング無し)
    await connect("moqt://example.com/moqt#msf:room-123--catalog&c4m=3q2-7w");
  } finally {
    fake.restore();
  }

  const tokens = decodeSentAuthorizationTokens(fake.sentChunks);
  assert.strictEqual(tokens.length, 1);
  const token = requireUseValueToken(tokens[0]);
  // draft-ietf-moq-c4m-01 §7.1 Table 4: Token Type 0x01 は CAT
  assert.strictEqual(token.tokenType, 1n);
  // c4m の Base64 を復号した生バイト列をそのまま Token Value にする
  assert.deepEqual(token.tokenValue, new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
});

test("connect: c4m を持つ URI でも WebTransport へ fragment を渡さない", async () => {
  const fake = installSetupHandshakeTransport();
  try {
    await connect("moqt://example.com/moqt#msf:room-123--catalog&c4m=AQID");
  } finally {
    fake.restore();
  }

  // draft-ietf-moq-transport-21 §6.1.1: fragment はサーバーへ送信せず、クライアントが
  // ローカルで処理する。認可トークンが fragment のままサーバーへ漏れないこと
  assert.strictEqual(fake.createdUrls.length, 1);
  const [createdUrl] = fake.createdUrls;
  assert.strictEqual(createdUrl, "https://example.com/moqt");
});

test("connect: c4m が無い URI では AUTHORIZATION TOKEN を送らない", async () => {
  const fake = installSetupHandshakeTransport();
  try {
    await connect("moqt://example.com/moqt#msf:room-123--catalog&connection=wt");
  } finally {
    fake.restore();
  }

  assert.deepEqual(decodeSentAuthorizationTokens(fake.sentChunks), []);
});

test("connect: options.authorizationToken を指定した場合は URI の c4m より優先する", async () => {
  const fake = installSetupHandshakeTransport();
  try {
    await connect(
      "moqt://example.com/moqt#msf:room-123--catalog&c4m=AQID",
      {},
      {
        authorizationToken: {
          aliasType: AuthorizationTokenAliasType.USE_VALUE,
          tokenType: 0n,
          tokenValue: new Uint8Array([0x09]),
        },
      },
    );
  } finally {
    fake.restore();
  }

  const tokens = decodeSentAuthorizationTokens(fake.sentChunks);
  assert.strictEqual(tokens.length, 1);
  const token = requireUseValueToken(tokens[0]);
  // 明示したトークンがそのまま送られ、URI の c4m は使われない
  assert.strictEqual(token.tokenType, 0n);
  assert.deepEqual(token.tokenValue, new Uint8Array([0x09]));
});

test("connect: 復号できない c4m は WebTransport を作る前に throw する", async () => {
  const fake = installSetupHandshakeTransport();
  let thrown: Error | undefined;
  try {
    await connect("moqt://example.com/moqt#msf:room-123--catalog&c4m=not base64!!");
  } catch (error) {
    thrown = error instanceof Error ? error : new Error(String(error));
  } finally {
    fake.restore();
  }

  assert.isDefined(thrown);
  assert.strictEqual(
    thrown?.message,
    "msf fragment c4m must be a Base64 encoded C4M token (draft-ietf-moq-msf-01 Section 11.1.1)",
  );
  // 接続を始めない (WebTransport を作らない)
  assert.deepEqual(fake.createdUrls, []);
  assert.deepEqual(fake.sentChunks, []);
});
