import { test, assert } from "vite-plus/test";
import { extractC4mBase64, maskC4mValue } from "./c4m";

// draft-ietf-moq-msf-01 §11.1.1 の c4m 例 (パディング省略の Base64)
const C4M_EXAMPLE = "gqhkYWxnIGVzaGFyqGR0eXBNhdZ9hdWQAY3VybGZlbWlzcwZleWV2aW5uZWlhdGVwQWNyZW5lY";

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
