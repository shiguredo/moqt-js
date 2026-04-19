/**
 * SessionMachine AUTHORIZATION_TOKEN Wiring Property-Based Tests
 * draft-ietf-moq-transport-17 Section 9.3.2
 */

import { assert, test } from "vite-plus/test";
import { SessionError, SessionErrorCode } from "../error";
import {
  type AuthToken,
  encodeAuthToken,
  MessageParameterType,
  MessageType,
  type Parameter,
  type Subscribe,
  createSetup,
  createTrackNamespace,
  encodeTrackName,
  encodeParameter,
  SetupOptionType,
} from "../message";
import { encodeVarint } from "../varint";
import { SessionMachine } from "./machine";

function authTokenParameter(token: AuthToken): Parameter {
  return {
    type: MessageParameterType.AUTHORIZATION_TOKEN,
    value: encodeAuthToken(token),
  };
}

function setupWithCacheSize(size: bigint) {
  const setup = createSetup();
  // MAX_AUTH_TOKEN_CACHE_SIZE (Setup Option Type 0x04) を Key-Value-Pair として埋め込む
  setup.parameters = [
    {
      type: SetupOptionType.MAX_AUTH_TOKEN_CACHE_SIZE,
      value: encodeVarint(size),
    },
  ];
  return setup;
}

function establishedWithCacheSize(cacheSize = 1024n): SessionMachine {
  const local = setupWithCacheSize(cacheSize);
  const peer = setupWithCacheSize(cacheSize);
  const p = SessionMachine.createClient("webTransport", local);
  p.nextEvent();
  p.handleControl(peer);
  p.nextEvent();
  return p;
}

function buildSubscribe(
  requestId: bigint,
  parameters: Parameter[],
  name = `t${requestId}`,
): Subscribe {
  return {
    type: MessageType.SUBSCRIBE,
    requestId,
    requiredRequestIdDelta: 0n,
    trackNamespace: createTrackNamespace(["a"]),
    trackName: encodeTrackName(name),
    parameters,
  };
}

test("sendSubscribe の REGISTER が _localAuthTokenCache に登録される", () => {
  const p = establishedWithCacheSize();
  const requestId = p.nextLocalRequestId();
  p.sendSubscribe(
    buildSubscribe(requestId, [
      authTokenParameter({
        kind: "register",
        alias: 1n,
        tokenType: 7n,
        tokenValue: new Uint8Array([0x01, 0x02]),
      }),
    ]),
  );
  const resolved = p.localAuthTokenCache.resolve(1n);
  assert.ok(resolved);
  assert.equal(resolved.tokenType, 7n);
});

test("sendSubscribe の DELETE で _localAuthTokenCache から除去される", () => {
  const p = establishedWithCacheSize();
  const register = p.nextLocalRequestId();
  p.sendSubscribe(
    buildSubscribe(register, [
      authTokenParameter({
        kind: "register",
        alias: 2n,
        tokenType: 1n,
        tokenValue: new Uint8Array(),
      }),
    ]),
  );
  assert.ok(p.localAuthTokenCache.resolve(2n));

  const remove = p.nextLocalRequestId();
  p.sendSubscribe(buildSubscribe(remove, [authTokenParameter({ kind: "delete", alias: 2n })]));
  assert.equal(p.localAuthTokenCache.resolve(2n), undefined);
});

test("sendSubscribe の重複 REGISTER は DUPLICATE_AUTH_TOKEN_ALIAS で throw", () => {
  const p = establishedWithCacheSize();
  const r1 = p.nextLocalRequestId();
  p.sendSubscribe(
    buildSubscribe(r1, [
      authTokenParameter({
        kind: "register",
        alias: 5n,
        tokenType: 0n,
        tokenValue: new Uint8Array(),
      }),
    ]),
  );

  const r2 = p.nextLocalRequestId();
  let caught: unknown;
  try {
    p.sendSubscribe(
      buildSubscribe(r2, [
        authTokenParameter({
          kind: "register",
          alias: 5n,
          tokenType: 0n,
          tokenValue: new Uint8Array(),
        }),
      ]),
    );
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof SessionError);
  assert.equal((caught as SessionError).code, SessionErrorCode.DUPLICATE_AUTH_TOKEN_ALIAS);
});

test("sendSubscribe のキャッシュ超過は AUTH_TOKEN_CACHE_OVERFLOW で throw", () => {
  // maxSize=16 にすると Token Value 1 バイトで溢れる (16 + 1 > 16)
  const p = establishedWithCacheSize(16n);
  const r = p.nextLocalRequestId();
  let caught: unknown;
  try {
    p.sendSubscribe(
      buildSubscribe(r, [
        authTokenParameter({
          kind: "register",
          alias: 1n,
          tokenType: 0n,
          tokenValue: new Uint8Array([0xff]),
        }),
      ]),
    );
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof SessionError);
  assert.equal((caught as SessionError).code, SessionErrorCode.AUTH_TOKEN_CACHE_OVERFLOW);
});

test("sendSubscribe の malformed Token は KEY_VALUE_FORMATTING_ERROR で throw", () => {
  const p = establishedWithCacheSize();
  const r = p.nextLocalRequestId();
  let caught: unknown;
  try {
    // alias type 0x42 は未定義
    p.sendSubscribe(
      buildSubscribe(r, [
        {
          type: MessageParameterType.AUTHORIZATION_TOKEN,
          value: new Uint8Array(encodeVarint(0x42)),
        },
      ]),
    );
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof SessionError);
  assert.equal((caught as SessionError).code, SessionErrorCode.KEY_VALUE_FORMATTING_ERROR);
});

test("processIncomingAuthTokens の REGISTER で _peerAuthTokenCache に登録される", () => {
  const p = establishedWithCacheSize();
  p.processIncomingAuthTokens([
    authTokenParameter({
      kind: "register",
      alias: 10n,
      tokenType: 3n,
      tokenValue: new Uint8Array([0xab]),
    }),
  ]);
  const resolved = p.peerAuthTokenCache.resolve(10n);
  assert.ok(resolved);
  assert.equal(resolved.tokenType, 3n);
});

test("processIncomingAuthTokens の malformed Token で closeSession を積む", () => {
  const p = establishedWithCacheSize();
  p.processIncomingAuthTokens([
    { type: MessageParameterType.AUTHORIZATION_TOKEN, value: new Uint8Array(encodeVarint(0x99)) },
  ]);
  assert.equal(p.state, "closing");
  const event = p.nextEvent();
  assert.ok(event);
  assert.equal(event.type, "closeSession");
  if (event.type === "closeSession") {
    assert.equal(event.error.code, SessionErrorCode.KEY_VALUE_FORMATTING_ERROR);
  }
});

test("processIncomingAuthTokens の重複 REGISTER で closeSession を積む", () => {
  const p = establishedWithCacheSize();
  p.processIncomingAuthTokens([
    authTokenParameter({
      kind: "register",
      alias: 4n,
      tokenType: 0n,
      tokenValue: new Uint8Array(),
    }),
  ]);
  p.processIncomingAuthTokens([
    authTokenParameter({
      kind: "register",
      alias: 4n,
      tokenType: 0n,
      tokenValue: new Uint8Array(),
    }),
  ]);
  assert.equal(p.state, "closing");
  // 2 つ目の processIncomingAuthTokens で積まれた closeSession を取り出す
  const ev1 = p.nextEvent();
  assert.ok(ev1);
  assert.equal(ev1.type, "closeSession");
  if (ev1.type === "closeSession") {
    assert.equal(ev1.error.code, SessionErrorCode.DUPLICATE_AUTH_TOKEN_ALIAS);
  }
});

test("USE_ALIAS / USE_VALUE はキャッシュを変えない", () => {
  const p = establishedWithCacheSize();
  const before = p.localAuthTokenCache.totalSize;
  p.processOutgoingAuthTokens([
    authTokenParameter({ kind: "useAlias", alias: 1n }),
    authTokenParameter({
      kind: "useValue",
      tokenType: 0n,
      tokenValue: new Uint8Array([1, 2]),
    }),
  ]);
  assert.equal(p.localAuthTokenCache.totalSize, before);

  const beforePeer = p.peerAuthTokenCache.totalSize;
  p.processIncomingAuthTokens([
    authTokenParameter({ kind: "useAlias", alias: 1n }),
    authTokenParameter({
      kind: "useValue",
      tokenType: 0n,
      tokenValue: new Uint8Array([1, 2]),
    }),
  ]);
  assert.equal(p.peerAuthTokenCache.totalSize, beforePeer);
});

test("DELETE で未登録 alias は no-op (throw しない)", () => {
  const p = establishedWithCacheSize();
  p.processOutgoingAuthTokens([authTokenParameter({ kind: "delete", alias: 99n })]);
  p.processIncomingAuthTokens([authTokenParameter({ kind: "delete", alias: 99n })]);
  // 何も起きない。encodeParameter を呼んでもエラーにならない
  encodeParameter(authTokenParameter({ kind: "delete", alias: 99n }));
});
