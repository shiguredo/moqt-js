import { test, assert } from "vite-plus/test";
import { C4M } from "moqt-js";
import { decodeC4mTokenInfo, extractC4mBase64, extractC4mTrackNames, maskC4mValue } from "./c4m";
import {
  buildCat,
  buildCatWithClaims,
  buildCatWithTrackNames,
  buildCatWithoutMoqtClaim,
} from "./c4mTestSupport";

// draft-ietf-moq-msf-01 §11.1.1 の c4m 例 (パディング省略の Base64)
const C4M_EXAMPLE = "gqhkYWxnIGVzaGFyqGR0eXBNhdZ9hdWQAY3VybGZlbWlzcwZleWV2aW5uZWlhdGVwQWNyZW5lY";

const TEXT_ENCODER = new TextEncoder();

// MSF URL 全体 (`#` 以降に msf fragment) から c4m を取り出せることを確認する。
test("extractC4mBase64: MSF URL 全体から c4m を取り出す", () => {
  const url = `moqt://example.com/moqt#msf:room-123--catalog&c4m=${C4M_EXAMPLE}`;

  assert.equal(extractC4mBase64(url), C4M_EXAMPLE);
});

// URI Fragment 欄への貼り付けを想定し、`msf:` から始まる fragment 単体でも取り出せることを確認する。
test("extractC4mBase64: msf fragment 単体から c4m を取り出す", () => {
  const fragment = `msf:room-123--catalog&c4m=${C4M_EXAMPLE}`;

  assert.equal(extractC4mBase64(fragment), C4M_EXAMPLE);
});

// `#` が無い URL は fragment を持たないため対象外になる。
test("extractC4mBase64: fragment が無い入力では undefined を返す", () => {
  assert.equal(extractC4mBase64("moqt://example.com/moqt"), undefined);
});

// msf 以外の fragment type では c4m は予約 parameter ではないため対象外になる。
test("extractC4mBase64: msf 以外の fragment では undefined を返す", () => {
  assert.equal(
    extractC4mBase64(`moqt://example.com/moqt#track:video&c4m=${C4M_EXAMPLE}`),
    undefined,
  );
});

// c4m を持たない msf fragment では undefined になる。
test("extractC4mBase64: c4m が無い場合は undefined を返す", () => {
  assert.equal(
    extractC4mBase64("moqt://example.com/moqt#msf:room-123--catalog&connection=wt"),
    undefined,
  );
});

// c4m は parameter 部にのみ現れる。track-identifier 内の `c4m=` は parameter ではないため無視する。
test("extractC4mBase64: track-identifier 内の c4m= は parameter として扱わない", () => {
  assert.equal(extractC4mBase64("msf:c4m=abc--catalog&connection=wt"), undefined);
});

// 複数 parameter の中にある c4m を取り出せることを確認する。
test("extractC4mBase64: 他の parameter と並んでいても c4m を取り出す", () => {
  const fragment = `msf:room-123--catalog&connection=wt&c4m=${C4M_EXAMPLE}&location-range=1.0`;

  assert.equal(extractC4mBase64(fragment), C4M_EXAMPLE);
});

// 同一 key が複数ある場合は最初の c4m を返す (仕様の union 解釈は range のみ)。
test("extractC4mBase64: c4m が複数ある場合は最初の値を返す", () => {
  const first = "QUFB";
  const second = "QkJC";

  assert.equal(extractC4mBase64(`msf:room-123--catalog&c4m=${first}&c4m=${second}`), first);
});

// Base64 として復号できない値は c4m として扱わない (入力途中で例外を投げない)。
test("extractC4mBase64: 不正な Base64 の c4m は undefined を返す", () => {
  assert.equal(extractC4mBase64("msf:room-123--catalog&c4m=not base64!!"), undefined);
});

// 値が空の c4m はトークンとして扱わない。
test("extractC4mBase64: c4m の値が空の場合は undefined を返す", () => {
  assert.equal(extractC4mBase64("msf:room-123--catalog&c4m="), undefined);
});

// `=` を含まない parameter は key=value 形式ではないため読み飛ばす。
test("extractC4mBase64: = を含まない parameter は読み飛ばす", () => {
  assert.equal(extractC4mBase64(`msf:room-123--catalog&c4m&c4m=${C4M_EXAMPLE}`), C4M_EXAMPLE);
});

// 伏せ字は URL 全体の c4m を潰す。接続に使う値 (signal) は変えず、テキストへ出すときだけ通す。
test("maskC4mValue: URL 全体の c4m の値を伏せ字にする", () => {
  const url = `moqt://example.com/moqt#msf:room-123--catalog&c4m=${C4M_EXAMPLE}`;

  assert.equal(maskC4mValue(url), "moqt://example.com/moqt#msf:room-123--catalog&c4m=<redacted>");
});

// fragment 欄への貼り付けも同じ関数で扱える。
test("maskC4mValue: fragment 単体の c4m の値を伏せ字にする", () => {
  assert.equal(
    maskC4mValue(`msf:room-123--catalog&c4m=${C4M_EXAMPLE}`),
    "msf:room-123--catalog&c4m=<redacted>",
  );
});

// parameter の区切りは `&` のため、値は `&` の手前までを潰し、後ろの parameter は残す。
test("maskC4mValue: 他の parameter は残す", () => {
  assert.equal(
    maskC4mValue(`msf:room-123--catalog&connection=wt&c4m=${C4M_EXAMPLE}&location-range=1.0`),
    "msf:room-123--catalog&connection=wt&c4m=<redacted>&location-range=1.0",
  );
});

// extractC4mBase64 は最初の c4m しか見ないが、伏せ字は出現をすべて潰す。
test("maskC4mValue: c4m が複数あってもすべて伏せ字にする", () => {
  assert.equal(
    maskC4mValue("msf:room-123--catalog&c4m=QUFB&c4m=QkJC"),
    "msf:room-123--catalog&c4m=<redacted>&c4m=<redacted>",
  );
});

// c4m を持たない入力は変えない。
test("maskC4mValue: c4m が無い入力はそのまま返す", () => {
  assert.equal(
    maskC4mValue("moqt://example.com/moqt#msf:room-123--catalog&connection=wt"),
    "moqt://example.com/moqt#msf:room-123--catalog&connection=wt",
  );
  assert.equal(maskC4mValue(""), "");
});

// 実際の URL に載る c4m は base64url (RFC 4648 Section 5、パディング省略) で発行される
// ことがある (draft-ietf-moq-c4m-01 付録 A のテストベクタも base64url)。
// 標準 Base64 と同じく取り出せることを、base64url 固有の文字 (- と _) を含む値で固定する。
test("extractC4mBase64: base64url の c4m を取り出す", () => {
  // 0xfb 0xff 0xbf の base64url は "-_-_"。atob では復号できない文字を含む
  assert.equal(extractC4mBase64("msf:room-123--catalog&c4m=-_-_"), "-_-_");
});

// 発行した CAT を base64url にした c4m も取り出せる (URL に載る実際の形)。
test("extractC4mBase64: 発行した CAT の base64url を取り出す", async () => {
  const base64Url = await buildCatWithTrackNames(["catalog"]);

  assert.equal(
    extractC4mBase64(`moqt://example.com/moqt#msf:15551-spam--catalog&c4m=${base64Url}`),
    base64Url,
  );
});

// moqt クレームの exact な track match から track name を取り出す。
// devtools は audio / video の欄へ反映するため、取り出す順序はスコープの順に従う。
test("extractC4mTrackNames: exact な track name をスコープの順に取り出す", async () => {
  const base64 = await buildCatWithTrackNames(["catalog", "audio", "video", "events"]);

  assert.deepEqual(extractC4mTrackNames(base64), ["catalog", "audio", "video", "events"]);
});

// prefix / suffix の track match は 1 つの名前を表さないため取り出さない。
test("extractC4mTrackNames: prefix / suffix の track match は取り出さない", async () => {
  const scope = C4M.createMoqtScope(["Subscribe"]);
  scope.namespace.push(C4M.namespaceMatchValue(C4M.exactMatch(TEXT_ENCODER.encode("15551"))));
  scope.track = C4M.prefixMatch(TEXT_ENCODER.encode("vid"));
  const base64 = await buildCat([scope]);

  assert.deepEqual(extractC4mTrackNames(base64), []);
});

// track match を持たないスコープ (すべての track にマッチする) からも名前は取り出さない。
test("extractC4mTrackNames: track match の無いスコープからは取り出さない", async () => {
  const scope = C4M.createMoqtScope(["ClientSetup"]);
  const base64 = await buildCat([scope]);

  assert.deepEqual(extractC4mTrackNames(base64), []);
});

// moqt クレームを持たないトークンからは track name を取り出せない。
test("extractC4mTrackNames: moqt クレームが無いトークンでは空配列を返す", async () => {
  const base64 = await buildCatWithoutMoqtClaim();

  assert.deepEqual(extractC4mTrackNames(base64), []);
});

// Base64 として復号できない値と、CAT としてデコードできない値では空配列を返す
// (入力途中で例外を投げない)。
test("extractC4mTrackNames: 復号できない値では空配列を返す", () => {
  assert.deepEqual(extractC4mTrackNames("not base64!!"), []);
  assert.deepEqual(extractC4mTrackNames("QUFB"), []);
  assert.deepEqual(extractC4mTrackNames(""), []);
});

// --- decodeC4mTokenInfo ---

// デコード結果は画面に出すため、形式 / alg / 主要なクレーム / スコープ / track name を
// 表示用の文字列で取り出す (署名検証はしない)
test("decodeC4mTokenInfo: クレームとスコープを表示用に取り出す", async () => {
  const claims = C4M.createCatClaims();
  claims.issuer = "https://auth.example.com";
  claims.audience.push("https://relay.example.com", "https://other.example.com");
  claims.expiration = 1700086400;
  claims.notBefore = 1700000000;
  claims.issuedAt = 1700043200;
  const scope = C4M.createMoqtScope(["Subscribe", "Publish"]);
  scope.namespace.push(C4M.namespaceMatchValue(C4M.exactMatch(TEXT_ENCODER.encode("15551"))));
  scope.namespace.push(C4M.namespaceMatchValue(C4M.prefixMatch(TEXT_ENCODER.encode("spam"))));
  scope.namespace.push(C4M.namespaceMatchEnd());
  scope.track = C4M.exactMatch(TEXT_ENCODER.encode("audio"));
  claims.moqt = { scopes: [scope] };
  const base64 = await buildCatWithClaims(claims);

  const info = decodeC4mTokenInfo(base64);

  assert.isDefined(info);
  // HMAC のトークンは COSE_Mac0 (draft-ietf-moq-c4m-01 §7.1.1 の Token Type 0x01)
  assert.equal(info?.format, "coseMac0");
  assert.equal(info?.algorithm, "HmacSha256");
  assert.equal(info?.issuer, "https://auth.example.com");
  assert.equal(info?.audience, "https://relay.example.com, https://other.example.com");
  assert.equal(info?.expiration, "1700086400 (2023-11-15T22:13:20.000Z)");
  assert.equal(info?.notBefore, "1700000000 (2023-11-14T22:13:20.000Z)");
  assert.equal(info?.issuedAt, "1700043200 (2023-11-15T10:13:20.000Z)");
  assert.deepEqual(info?.scopes, [
    { actions: ["SUBSCRIBE", "PUBLISH"], namespace: "15551, prefix:spam, end", track: "audio" },
  ]);
  assert.deepEqual(info?.trackNames, ["audio"]);
});

// クレームを持たないトークンではクレームが undefined になり、スコープも空になる
test("decodeC4mTokenInfo: クレームが無いトークンでも形式だけを取り出せる", async () => {
  const base64 = await buildCatWithClaims(C4M.createCatClaims());

  const info = decodeC4mTokenInfo(base64);

  assert.isDefined(info);
  assert.equal(info?.format, "coseMac0");
  assert.isUndefined(info?.issuer);
  assert.isUndefined(info?.audience);
  assert.isUndefined(info?.expiration);
  assert.deepEqual(info?.scopes, []);
  assert.deepEqual(info?.trackNames, []);
});

// track の無いスコープは "any"、namespace の無いスコープは "-" として出す。
// ClientSetup の表示名は draft-ietf-moq-transport-21 の 1 つの SETUP メッセージに合わせる
test("decodeC4mTokenInfo: track と namespace の無いスコープを any / - で出す", async () => {
  const scope = C4M.createMoqtScope(["ClientSetup"]);
  const base64 = await buildCat([scope]);

  const info = decodeC4mTokenInfo(base64);

  assert.deepEqual(info?.scopes, [{ actions: ["SETUP"], namespace: "-", track: "any" }]);
});

// prefix / suffix の track match は名前を 1 つに定めないため trackNames に含めない
test("decodeC4mTokenInfo: prefix の track match は trackNames に含めない", async () => {
  const scope = C4M.createMoqtScope(["Publish"]);
  scope.namespace.push(C4M.namespaceMatchValue(C4M.exactMatch(TEXT_ENCODER.encode("15551"))));
  scope.track = C4M.suffixMatch(TEXT_ENCODER.encode("audio"));
  const base64 = await buildCat([scope]);

  const info = decodeC4mTokenInfo(base64);

  assert.deepEqual(info?.scopes, [
    { actions: ["PUBLISH"], namespace: "15551", track: "suffix:audio" },
  ]);
  assert.deepEqual(info?.trackNames, []);
});

// 復号できない値では undefined を返す (入力途中で例外を投げない)
test("decodeC4mTokenInfo: 復号できない値では undefined を返す", () => {
  assert.isUndefined(decodeC4mTokenInfo("not base64!!"));
  assert.isUndefined(decodeC4mTokenInfo("QUFB"));
  assert.isUndefined(decodeC4mTokenInfo(""));
});
