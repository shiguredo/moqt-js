import { test, assert } from "vite-plus/test";
import {
  parseHeadersText,
  parseProtocolsText,
  parseAnticipatedStreams,
  validateConnectionSettings,
  parseDatagramMaxAge,
  parseMaxBufferedDatagrams,
  parseSendOrder,
  parseCloseCode,
  buildSettingsQueryString,
  parseSettingsQueryString,
  type ConnectionSettings,
} from "./params";

// テスト間で使い回す接続時設定の既定値
// 全フィールドがデフォルト値の状態（クエリパラメータには何も載らないはず）
function defaultSettings(): ConnectionSettings {
  return {
    url: "https://127.0.0.1:4443/wt",
    certificateHash: "",
    allowPooling: false,
    requireUnreliable: false,
    congestionControl: "default",
    headersText: "",
    protocolsText: "",
    datagramsReadableType: "",
    anticipatedConcurrentIncomingUnidirectionalStreams: "",
    anticipatedConcurrentIncomingBidirectionalStreams: "",
  };
}

// parseHeadersText のテスト
// W3C §6.2 の forbidden request-header 制約と wt-available-protocols の禁止に基づく
test("headers: key: value 形式の複数行をパースできる", () => {
  const result = parseHeadersText("X-Foo: bar\nX-Baz: qux");
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.value, { "X-Foo": "bar", "X-Baz": "qux" });
  }
});

test("headers: 空行と前後の空白を無視する", () => {
  const result = parseHeadersText("  X-Foo: bar  \n\n  \nX-Baz:qux");
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.value, { "X-Foo": "bar", "X-Baz": "qux" });
  }
});

test("headers: 空入力は空のヘッダー集合を返す", () => {
  const result = parseHeadersText("");
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.value, {});
  }
});

test("headers: forbidden request-header を拒否する", () => {
  for (const name of ["Host", "Content-Length", "Cookie", "Origin", "Referer", "Connection"]) {
    const result = parseHeadersText(`${name}: value`);
    assert.equal(result.ok, false, `${name} は forbidden request-header のため拒否されるはず`);
  }
});

test("headers: Proxy- / Sec- プレフィックスの forbidden request-header を拒否する", () => {
  for (const name of ["Proxy-Authorization", "Sec-Fetch-Mode"]) {
    const result = parseHeadersText(`${name}: value`);
    assert.equal(result.ok, false, `${name} は forbidden request-header のため拒否されるはず`);
  }
});

test("headers: wt-available-protocols を拒否する", () => {
  // W3C §6.2 は wt-available-protocols ヘッダーの指定を TypeError にする
  const result = parseHeadersText("wt-available-protocols: foo");
  assert.equal(result.ok, false);
});

test("headers: コロンを含まない行を拒否する", () => {
  const result = parseHeadersText("no-colon-here");
  assert.equal(result.ok, false);
});

test("headers: コロンの前に名前が無い行を拒否する", () => {
  const result = parseHeadersText(": value-only");
  assert.equal(result.ok, false);
});

// parseProtocolsText のテスト
// W3C §6.2 の重複・空要素・512 文字超過の SyntaxError 条件に基づく
test("protocols: カンマ区切りをパースできる", () => {
  const result = parseProtocolsText("foo, bar ,baz");
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.value, ["foo", "bar", "baz"]);
  }
});

test("protocols: 空入力は空配列を返す", () => {
  const result = parseProtocolsText("");
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.value, []);
  }
});

test("protocols: 重複する名前を拒否する", () => {
  const result = parseProtocolsText("foo, foo");
  assert.equal(result.ok, false);
});

test("protocols: 空要素を拒否する", () => {
  const result = parseProtocolsText("foo,,bar");
  assert.equal(result.ok, false);
});

test("protocols: 512 文字超過の名前を拒否する", () => {
  const longProtocol = "x".repeat(513);
  const result = parseProtocolsText(longProtocol);
  assert.equal(result.ok, false);
});

test("protocols: ちょうど 512 文字の名前は受理する", () => {
  const protocol = "x".repeat(512);
  const result = parseProtocolsText(protocol);
  assert.equal(result.ok, true);
});

// parseAnticipatedStreams のテスト
// W3C §6.9 の unsigned short (0-65535) の制約に基づく
test("anticipated streams: 空入力は null を返す", () => {
  const result = parseAnticipatedStreams("");
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value, null);
  }
});

test("anticipated streams: 整数を受理する", () => {
  const result = parseAnticipatedStreams("100");
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value, 100);
  }
});

test("anticipated streams: 上限 65535 を超える値を拒否する", () => {
  const result = parseAnticipatedStreams("65536");
  assert.equal(result.ok, false);
});

test("anticipated streams: 負の値を拒否する", () => {
  const result = parseAnticipatedStreams("-1");
  assert.equal(result.ok, false);
});

test("anticipated streams: 整数でない値を拒否する", () => {
  const result = parseAnticipatedStreams("1.5");
  assert.equal(result.ok, false);
});

// validateConnectionSettings のテスト
// W3C §6.9 の allowPooling と serverCertificateHashes の排他制約に基づく
test("validate: allowPooling と certificateHash の同時指定を拒否する", () => {
  const settings = { ...defaultSettings(), allowPooling: true, certificateHash: "abc" };
  assert.equal(
    validateConnectionSettings(settings),
    "allowPooling and certificateHash cannot be specified together",
  );
});

test("validate: allowPooling のみなら問題ない", () => {
  const settings = { ...defaultSettings(), allowPooling: true };
  assert.equal(validateConnectionSettings(settings), null);
});

test("validate: certificateHash のみなら問題ない", () => {
  const settings = { ...defaultSettings(), certificateHash: "abc" };
  assert.equal(validateConnectionSettings(settings), null);
});

// parseDatagramMaxAge のテスト
// W3C §5.3 の incomingMaxAge / outgoingMaxAge setter 制約（負値・NaN は RangeError、0 は null）に基づく
test("datagram max age: 正の値を受理する", () => {
  const result = parseDatagramMaxAge("100");
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value, 100);
  }
});

test("datagram max age: 0 は null として扱う", () => {
  const result = parseDatagramMaxAge("0");
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value, null);
  }
});

test("datagram max age: 空入力は未指定として扱う", () => {
  const result = parseDatagramMaxAge("");
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value, undefined);
  }
});

test("datagram max age: 負の値を拒否する", () => {
  const result = parseDatagramMaxAge("-1");
  assert.equal(result.ok, false);
});

test("datagram max age: NaN を拒否する", () => {
  const result = parseDatagramMaxAge("abc");
  assert.equal(result.ok, false);
});

// parseMaxBufferedDatagrams のテスト
// W3C §5.3 の incomingMaxBufferedDatagrams / outgoingMaxBufferedDatagrams setter 制約（1 未満は 1）に基づく
test("datagram buffer count: 1 未満を 1 にクランプする", () => {
  for (const input of ["0", "-5"]) {
    const result = parseMaxBufferedDatagrams(input);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value, 1, `${input} は 1 にクランプされるはず`);
    }
  }
});

test("datagram buffer count: 1 以上はそのまま受理する", () => {
  const result = parseMaxBufferedDatagrams("10");
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value, 10);
  }
});

test("datagram buffer count: 整数でない値を拒否する", () => {
  const result = parseMaxBufferedDatagrams("1.5");
  assert.equal(result.ok, false);
});

// parseSendOrder のテスト
// W3C §6.11 の sendOrder (long long) に基づく
test("send order: 整数を受理する", () => {
  const result = parseSendOrder("5");
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value, 5);
  }
});

test("send order: 負の整数も受理する", () => {
  const result = parseSendOrder("-3");
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value, -3);
  }
});

test("send order: 空入力は未指定として扱う", () => {
  const result = parseSendOrder("");
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value, undefined);
  }
});

test("send order: 整数でない値を拒否する", () => {
  const result = parseSendOrder("1.5");
  assert.equal(result.ok, false);
});

// parseCloseCode のテスト
// W3C §6.10 の closeCode (unsigned long) に基づく
test("close code: 整数を受理する", () => {
  const result = parseCloseCode("1000");
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value, 1000);
  }
});

test("close code: 空入力は未指定として扱う", () => {
  const result = parseCloseCode("");
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value, undefined);
  }
});

test("close code: 負の値を拒否する", () => {
  const result = parseCloseCode("-1");
  assert.equal(result.ok, false);
});

test("close code: 4294967295 を超える値を拒否する", () => {
  const result = parseCloseCode("4294967296");
  assert.equal(result.ok, false);
});

// buildSettingsQueryString / parseSettingsQueryString のテスト
// デフォルト値の項目はクエリパラメータに含めない（既存の certificateHash 省略パターン）仕様に基づく
test("query string: デフォルト値の項目は含めない", () => {
  const query = buildSettingsQueryString(defaultSettings());
  assert.equal(query, "url=https%3A%2F%2F127.0.0.1%3A4443%2Fwt");
});

test("query string: 全項目を設定すると全て載る", () => {
  const settings: ConnectionSettings = {
    url: "https://example.com/wt",
    certificateHash: "hash",
    allowPooling: true,
    requireUnreliable: true,
    congestionControl: "low-latency",
    headersText: "X-Foo: bar",
    protocolsText: "foo, bar",
    datagramsReadableType: "bytes",
    anticipatedConcurrentIncomingUnidirectionalStreams: "10",
    anticipatedConcurrentIncomingBidirectionalStreams: "20",
  };
  const query = buildSettingsQueryString(settings);
  assert.equal(query.includes("url=https%3A%2F%2Fexample.com%2Fwt"), true);
  assert.equal(query.includes("certificateHash=hash"), true);
  assert.equal(query.includes("allowPooling=true"), true);
  assert.equal(query.includes("requireUnreliable=true"), true);
  assert.equal(query.includes("congestionControl=low-latency"), true);
  assert.equal(query.includes("headers=X-Foo%3A+bar"), true);
  assert.equal(query.includes("protocols=foo%2C+bar"), true);
  assert.equal(query.includes("datagramsReadableType=bytes"), true);
  assert.equal(query.includes("anticipatedConcurrentIncomingUnidirectionalStreams=10"), true);
  assert.equal(query.includes("anticipatedConcurrentIncomingBidirectionalStreams=20"), true);
});

test("query string: ラウンドトリップで値が復元できる", () => {
  // allowPooling と certificateHash は排他のため、同時には設定しない
  const settings: ConnectionSettings = {
    url: "https://example.com/wt",
    certificateHash: "hash",
    allowPooling: false,
    requireUnreliable: true,
    congestionControl: "throughput",
    headersText: "X-Foo: bar\nX-Baz: qux",
    protocolsText: "foo, bar",
    datagramsReadableType: "bytes",
    anticipatedConcurrentIncomingUnidirectionalStreams: "10",
    anticipatedConcurrentIncomingBidirectionalStreams: "20",
  };
  const restored = parseSettingsQueryString(buildSettingsQueryString(settings));
  assert.deepEqual(restored, settings);
});

test("query string: allowPooling と certificateHash が共存する場合は allowPooling を優先する", () => {
  // §6.9 の排他制約に基づき、復元時に certificateHash を無効化する
  const restored = parseSettingsQueryString(
    "url=https%3A%2F%2Fexample.com&allowPooling=true&certificateHash=hash",
  );
  assert.equal(restored.allowPooling, true);
  assert.equal(restored.certificateHash, "");
});

test("query string: 未知の congestionControl 値は default にフォールバックする", () => {
  const restored = parseSettingsQueryString("congestionControl=invalid");
  assert.equal(restored.congestionControl, "default");
});

test("query string: 未知の datagramsReadableType 値は未指定にフォールバックする", () => {
  const restored = parseSettingsQueryString("datagramsReadableType=invalid");
  assert.equal(restored.datagramsReadableType, "");
});
