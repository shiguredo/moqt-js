import { test, assert } from "vite-plus/test";
import {
  parseHeadersText,
  parseProtocolsText,
  parseAnticipatedStreams,
  validateConnectionSettings,
  parseCertificateHash,
  parseDatagramMaxAge,
  parseMaxBufferedDatagrams,
  parseSendOrder,
  parseCloseCode,
  truncateCloseReason,
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

// 文字種の検証のテスト
// W3C §6.2 step 13 は「negotiated application protocol の要素の要件」を満たさない値に
// SyntaxError を要求する。protocols は wt-available-protocols ヘッダーで構造化ヘッダー
// (RFC 8941) の string item として送られるため、RFC 8941 §3.3.3 の string が許す
// ASCII 印字可能文字 (%x20-7E) だけを受理する
test("protocols: ASCII 印字可能文字だけで構成された名前を受理する", () => {
  const result = parseProtocolsText("h3, moqt-1, foo~bar!, A-Z_a-z.0");
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.value, ["h3", "moqt-1", "foo~bar!", "A-Z_a-z.0"]);
  }
});

test("protocols: 非 ASCII 文字を含む名前を拒否する", () => {
  // RFC 8941 の string に含められない文字 (アクセント付きラテン文字・日本語・
  // 全角文字・サロゲートペアを持つ文字) を含む名前は、接続時の SyntaxError を待たずに
  // 入力段階で拒否する
  for (const protocol of ["café", "プロトコル", "ｈ３", "moqt𠮷"]) {
    const result = parseProtocolsText(protocol);
    assert.equal(result.ok, false, `${protocol} は ASCII 印字可能文字以外を含むため拒否されるはず`);
  }
});

test("protocols: 制御文字を含む名前を拒否する", () => {
  // RFC 8941 §3.3.3 の string の ABNF は %x20-7E 以外の文字を許さない。
  // 名前の先頭と末尾の空白は trim() で除去されるため、途中に制御文字を置いて検証する
  for (const protocol of ["foo\tbar", "foo\nbar", "foo\u0000bar", "foo\u007Fbar"]) {
    const result = parseProtocolsText(protocol);
    assert.equal(
      result.ok,
      false,
      `${JSON.stringify(protocol)} は制御文字を含むため拒否されるはず`,
    );
  }
});

test("protocols: 文字種の検証を追加しても既存の検証は維持される", () => {
  // §6.2 step 13 の重複・空要素・512 文字超過の検証は、文字種の検証を追加した後も
  // 同じ結果を返す (ASCII 印字可能文字だけなら長さの判定はそのまま使える)
  assert.equal(parseProtocolsText("foo, foo").ok, false);
  assert.equal(parseProtocolsText("foo,,bar").ok, false);
  assert.equal(parseProtocolsText("x".repeat(513)).ok, false);
  assert.equal(parseProtocolsText("x".repeat(512)).ok, true);
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

// parseCertificateHash のテスト
// W3C §6.9 の WebTransportHash.value は DER 証明書の SHA-256 ハッシュ (32 byte) を
// 表す ArrayBuffer であり、serverCertificateHashes でサーバー証明書を検証する
test("certificate hash: 32 byte の SHA-256 を Base64 から復号できる", () => {
  // 0x00-0x1F の 32 byte を Base64 にしたもの
  const result = parseCertificateHash("AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=");
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.byteLength, 32);
    // 復号結果が Base64 の元のバイト列と一致する
    assert.deepEqual(
      new Uint8Array(result.value),
      new Uint8Array(Array.from({ length: 32 }, (_, index) => index)),
    );
  }
});

test("certificate hash: 復号長が 32 byte でない値を拒否する", () => {
  // 31 byte / 33 byte / 16 byte に復号される Base64 は SHA-256 の長さと一致しないため、
  // 接続時のハンドシェイク失敗を待たずに入力段階で拒否する
  for (const base64 of [
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==",
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "AAAAAAAAAAAAAAAAAAAAAA==",
  ]) {
    const result = parseCertificateHash(base64);
    assert.equal(result.ok, false, `${base64} は 32 byte でないため拒否されるはず`);
  }
});

test("certificate hash: 不正な Base64 を拒否する", () => {
  // atob が例外を投げる文字列は、例外をそのまま伝播させずエラーとして返す
  for (const base64 of ["not base64!!", "@@@@", "AAAA!"]) {
    const result = parseCertificateHash(base64);
    assert.equal(result.ok, false, `${base64} は Base64 でないため拒否されるはず`);
  }
});

test("certificate hash: 空文字を拒否する", () => {
  // 空文字は呼び出し側で「未指定」として扱うため、この検証関数ではエラーにする
  assert.equal(parseCertificateHash("").ok, false);
  assert.equal(parseCertificateHash("   ").ok, false);
});

test("certificate hash: 前後の空白を無視して復号する", () => {
  // クエリパラメータ経由の入力に空白が混ざっても復号できることを pin する
  const result = parseCertificateHash("  AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=  ");
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.byteLength, 32);
  }
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

// unsigned long の上限のテスト
// W3C §5.3 の incomingMaxBufferedDatagrams / outgoingMaxBufferedDatagrams は
// unsigned long であり、上限は 4294967295 である
test("datagram buffer count: unsigned long の上限 4294967295 を受理する", () => {
  const result = parseMaxBufferedDatagrams("4294967295");
  assert.deepEqual(result, { ok: true, value: 4294967295 });
});

test("datagram buffer count: 4294967296 以上を拒否する", () => {
  // 上限を超える値を setter に渡すと、WebIDL の変換で 2^32 を法として巡回する
  // (4294967296 は 0 になり 1 にクランプされる)。入力した値と設定される値が
  // 一致しなくなるため、入力段階で拒否する
  assert.equal(parseMaxBufferedDatagrams("4294967296").ok, false);
  assert.equal(parseMaxBufferedDatagrams("4294967297").ok, false);
});

test("datagram buffer count: 巨大な負値も 1 にクランプする", () => {
  // 1 未満を 1 にクランプする既存挙動は、上限の検証を追加しても維持される
  assert.deepEqual(parseMaxBufferedDatagrams("-4294967296"), { ok: true, value: 1 });
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

test("send order: 安全な整数の上限と下限を受理する", () => {
  // §6.11 の long long は 64 bit だが、JavaScript の Number が正確に表せる整数は
  // 2^53-1 までである。Number.MAX_SAFE_INTEGER / MIN_SAFE_INTEGER はその境界になる
  const max = Number.MAX_SAFE_INTEGER;
  const min = Number.MIN_SAFE_INTEGER;
  assert.deepEqual(parseSendOrder(String(max)), { ok: true, value: max });
  assert.deepEqual(parseSendOrder(String(min)), { ok: true, value: min });
});

test("send order: 安全な整数でない値 (2^53 以上) を拒否する", () => {
  // 2^53 以上は Number で正確に表せず、WebIDL の long long への変換でも丸められる。
  // 入力した値と setter に渡る値が一致しないため、入力段階で拒否する
  for (const input of ["9007199254740992", "9007199254740993", "-9007199254740992"]) {
    const result = parseSendOrder(input);
    assert.equal(result.ok, false, `${input} は安全な整数でないため拒否されるはず`);
  }
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

// truncateCloseReason のテスト
// W3C §6.4 step 6 により close() は closeInfo.reason のうち、UTF-8 エンコード後の
// 長さが 1024 byte を超えない最大の code unit prefix を送信する
const utf8ByteLength = (text: string): number => new TextEncoder().encode(text).byteLength;

test("close reason: 1024 byte ちょうどの ASCII は切り詰めない", () => {
  const reason = "a".repeat(1024);
  const result = truncateCloseReason(reason);
  assert.equal(result.truncated, false);
  assert.equal(result.text, reason);
  assert.equal(utf8ByteLength(result.text), 1024);
});

test("close reason: 1024 byte を超える ASCII を 1024 byte で切り詰める", () => {
  const reason = "a".repeat(1025);
  const result = truncateCloseReason(reason);
  assert.equal(result.truncated, true);
  assert.equal(result.text, "a".repeat(1024));
  assert.equal(utf8ByteLength(result.text), 1024);
});

test("close reason: 日本語 (1 文字 3 byte) を code point 単位で切り詰める", () => {
  // 341 文字 = 1023 byte に ASCII 1 文字を足すと 1024 byte ちょうどになる
  const exact = "あ".repeat(341) + "a";
  const exactResult = truncateCloseReason(exact);
  assert.equal(exactResult.truncated, false);
  assert.equal(exactResult.text, exact);
  // 342 文字 = 1026 byte は 1024 byte を超えるため、341 文字 (1023 byte) で切る
  const over = "あ".repeat(342);
  const overResult = truncateCloseReason(over);
  assert.equal(overResult.truncated, true);
  assert.equal(overResult.text, "あ".repeat(341));
  assert.equal(utf8ByteLength(overResult.text), 1023);
});

test("close reason: サロゲートペア (1 文字 4 byte) を分断せずに切り詰める", () => {
  // 𠮷 (U+20BB7) は UTF-16 では 2 code unit、UTF-8 では 4 byte である。
  // UTF-16 の code unit 単位で切るとサロゲートペアを分断するため、code point 単位で切る
  const exact = "𠮷".repeat(256);
  const exactResult = truncateCloseReason(exact);
  assert.equal(exactResult.truncated, false);
  assert.equal(exactResult.text, exact);
  // 257 文字 = 1028 byte は 1024 byte を超えるため、256 文字 (1024 byte) で切る
  const over = "𠮷".repeat(257);
  const overResult = truncateCloseReason(over);
  assert.equal(overResult.truncated, true);
  assert.equal(overResult.text, "𠮷".repeat(256));
  assert.equal(utf8ByteLength(overResult.text), 1024);
  // 結果に孤立したサロゲートが残っていないこと (サロゲートペアが壊れていないこと)
  assert.equal(overResult.text.isWellFormed(), true);
  // 1020 byte の ASCII の後にサロゲートペアを持つ文字を置き、その後ろの 1 byte が
  // 入らない場合でも、その文字のサロゲートペアは分断されない
  const mixed = "a".repeat(1020) + "𠮷b";
  const mixedResult = truncateCloseReason(mixed);
  assert.equal(mixedResult.truncated, true);
  assert.equal(mixedResult.text, "a".repeat(1020) + "𠮷");
  assert.equal(utf8ByteLength(mixedResult.text), 1024);
});

test("close reason: 空文字は切り詰めなしで返す", () => {
  assert.deepEqual(truncateCloseReason(""), { text: "", truncated: false });
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

// 数値入力の表記ゆれのテスト
// 各パーサは Number() の解釈に従うため、16 進数 / 2 進数 / 指数表記も受理する。
// 入力表記そのものは制限せず、各 API の型制約 (整数・範囲) だけで弾く契約を pin する。
test("数値入力: 16 進数表記 (0x10) は 16 として受理する", () => {
  assert.deepEqual(parseAnticipatedStreams("0x10"), { ok: true, value: 16 });
  assert.deepEqual(parseDatagramMaxAge("0x10"), { ok: true, value: 16 });
  assert.deepEqual(parseMaxBufferedDatagrams("0x10"), { ok: true, value: 16 });
  assert.deepEqual(parseSendOrder("0x10"), { ok: true, value: 16 });
  assert.deepEqual(parseCloseCode("0x10"), { ok: true, value: 16 });
});

test("数値入力: 2 進数表記 (0b11) は 3 として受理する", () => {
  assert.deepEqual(parseAnticipatedStreams("0b11"), { ok: true, value: 3 });
  assert.deepEqual(parseDatagramMaxAge("0b11"), { ok: true, value: 3 });
  assert.deepEqual(parseMaxBufferedDatagrams("0b11"), { ok: true, value: 3 });
  assert.deepEqual(parseSendOrder("0b11"), { ok: true, value: 3 });
  assert.deepEqual(parseCloseCode("0b11"), { ok: true, value: 3 });
});

test("数値入力: 指数表記 (1e3) は 1000 として受理する", () => {
  assert.deepEqual(parseAnticipatedStreams("1e3"), { ok: true, value: 1000 });
  assert.deepEqual(parseDatagramMaxAge("1e3"), { ok: true, value: 1000 });
  assert.deepEqual(parseMaxBufferedDatagrams("1e3"), { ok: true, value: 1000 });
  assert.deepEqual(parseSendOrder("1e3"), { ok: true, value: 1000 });
  assert.deepEqual(parseCloseCode("1e3"), { ok: true, value: 1000 });
});

test("数値入力: 指数表記の小数 (1e-1) は整数を要求するパーサだけが拒否する", () => {
  // Number("1e-1") === 0.1。§5.3 の max age だけが小数を受理する
  assert.deepEqual(parseDatagramMaxAge("1e-1"), { ok: true, value: 0.1 });
  assert.equal(parseAnticipatedStreams("1e-1").ok, false);
  assert.equal(parseMaxBufferedDatagrams("1e-1").ok, false);
  assert.equal(parseSendOrder("1e-1").ok, false);
  assert.equal(parseCloseCode("1e-1").ok, false);
});

test("数値入力: Infinity は整数を要求するパーサだけが拒否する", () => {
  // Number("Infinity") === Infinity。Number.isInteger(Infinity) は false だが、
  // max age の検査は Number.isNaN による NaN 拒否のみのため Infinity を通過させる。
  // 現行契約として pin する (setter へ Infinity が渡りうる)。
  assert.deepEqual(parseDatagramMaxAge("Infinity"), {
    ok: true,
    value: Number.POSITIVE_INFINITY,
  });
  assert.equal(parseDatagramMaxAge("-Infinity").ok, false);
  assert.equal(parseAnticipatedStreams("Infinity").ok, false);
  assert.equal(parseMaxBufferedDatagrams("Infinity").ok, false);
  assert.equal(parseSendOrder("Infinity").ok, false);
  assert.equal(parseCloseCode("Infinity").ok, false);
});

test("数値入力: 桁区切り (1_000) は数値として解釈されず拒否する", () => {
  // Number("1_000") === NaN。max age は NaN 専用のエラー、その他は整数エラーになる
  assert.equal(parseDatagramMaxAge("1_000").ok, false);
  assert.equal(parseAnticipatedStreams("1_000").ok, false);
  assert.equal(parseMaxBufferedDatagrams("1_000").ok, false);
  assert.equal(parseSendOrder("1_000").ok, false);
  assert.equal(parseCloseCode("1_000").ok, false);
});

test("truncateCloseReason: 2 byte 文字は 1024 byte ちょうどで切り詰めない", () => {
  // "é" (U+00E9) は UTF-8 で 2 byte。512 文字で 1024 byte ちょうどになる
  const reason = "é".repeat(512);
  const result = truncateCloseReason(reason);
  assert.equal(new TextEncoder().encode(result.text).byteLength, 1024);
  assert.equal(result.truncated, false);
  assert.equal(result.text, reason);
});

test("truncateCloseReason: 2 byte 文字は 1025 byte で 1 文字切り詰める", () => {
  // 512 文字 + 1 文字 ("a") だと 1025 byte になるため、最後の 1 byte を落とす
  const reason = "é".repeat(512) + "a";
  const result = truncateCloseReason(reason);
  assert.equal(new TextEncoder().encode(result.text).byteLength, 1024);
  assert.equal(result.truncated, true);
  assert.equal(result.text, "é".repeat(512));
});

test("parseCertificateHash: Base64 内の空白は無視して復号する", () => {
  // atob は Base64 の ASCII 空白を無視する。32 byte の SHA-256 として受理する
  const hash = new Uint8Array(32);
  const base64 = btoa(String.fromCharCode(...hash));
  const withSpace = `${base64.slice(0, 10)} ${base64.slice(10)}`;
  const result = parseCertificateHash(withSpace);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.byteLength, 32);
  }
});

test("parseCertificateHash: 末尾のパディングが無い Base64 も受理する", () => {
  // 32 byte の Base64 は 44 文字 (末尾 "=" 1 個)。パディングを外した 43 文字も
  // atob は受理するため、32 byte として扱う
  const hash = new Uint8Array(32);
  const base64 = btoa(String.fromCharCode(...hash)).replace(/=+$/, "");
  const result = parseCertificateHash(base64);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.byteLength, 32);
  }
});

test("parseCertificateHash: URL-safe Base64 は拒否する", () => {
  // atob は "-" と "_" を受理しない。サーバー証明書のハッシュは標準 Base64 で入力する
  const hash = new Uint8Array(32).fill(0xfb);
  const urlSafe = btoa(String.fromCharCode(...hash))
    .replaceAll("+", "-")
    .replaceAll("/", "_");
  assert.equal(parseCertificateHash(urlSafe).ok, false);
});

test("parseProtocolsText: 引用符とバックスラッシュは受理する", () => {
  // RFC 8941 §3.3.3 の string は DQUOTE で囲むため、" と \ はエスケープして送れる。
  // 0x20-0x7E の印字可能 ASCII なので、devtools の検証では受理する
  const result = parseProtocolsText(String.raw`a"b, c\d`);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.value, ['a"b', String.raw`c\d`]);
  }
});

test("parseProtocolsText: 名前の内部の空白は受理する", () => {
  // 構造化ヘッダーの string は 0x20 (空白) を含められる。ALPN の要件は別途あるが、
  // devtools の入力検証では文字種の制約だけを見る
  const result = parseProtocolsText("foo bar");
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.value, ["foo bar"]);
  }
});

test("parseProtocolsText: カンマは区切りとして扱い、名前に含められない", () => {
  // UI はカンマ区切りで入力するため、カンマを含む 1 個の protocol 名は表現できない
  const result = parseProtocolsText("foo,bar");
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.value, ["foo", "bar"]);
  }
});

test("validateConnectionSettings: 空白だけの certificateHash は未指定として扱う", () => {
  // 接続時も trim 後の空文字は未指定として扱うため、排他検証でも同じ判定にする
  const settings: ConnectionSettings = {
    url: "https://127.0.0.1:4443/wt",
    certificateHash: "   ",
    allowPooling: true,
    requireUnreliable: false,
    congestionControl: "default",
    headersText: "",
    protocolsText: "",
    datagramsReadableType: "",
    anticipatedConcurrentIncomingUnidirectionalStreams: "",
    anticipatedConcurrentIncomingBidirectionalStreams: "",
  };
  assert.equal(validateConnectionSettings(settings), null);
});
