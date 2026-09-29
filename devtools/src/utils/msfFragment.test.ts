/**
 * msf fragment の解析のテスト
 *
 * MOQT URI / URI Fragment の入力欄から msf fragment を取り出し、
 * draft-ietf-moq-msf-01 §11.1 の namespace / track name / parameter を取り出せることを
 * 固定する。入力途中の値では undefined を返し、例外を投げないことも確かめる。
 */

import { test, assert } from "vite-plus/test";
import { parseMsfFragmentFromInput } from "./msfFragment";

test("URL 全体から msf fragment の namespace と track name を取り出す", () => {
  const parsed = parseMsfFragmentFromInput(
    "moqt://example.com/moqt#msf:15551-spam--catalog&c4m=QUFB",
  );
  assert.deepEqual(parsed?.trackNamespace, ["15551", "spam"]);
  assert.equal(parsed?.trackName, "catalog");
});

test("fragment 単体からも msf fragment を取り出せる", () => {
  const parsed = parseMsfFragmentFromInput("msf:room-123--video");
  assert.deepEqual(parsed?.trackNamespace, ["room", "123"]);
  assert.equal(parsed?.trackName, "video");
});

test("msf fragment の parameter を順序保持で取り出す", () => {
  const parsed = parseMsfFragmentFromInput(
    "msf:room-123--catalog&connection=wt&wallclock-range=100-200",
  );
  assert.deepEqual(parsed?.parameters, [
    ["connection", "wt"],
    ["wallclock-range", "100-200"],
  ]);
});

test("namespace の percent-encoding を decode する (§11.1.2 の .2d は literal のハイフン)", () => {
  // ハイフンやピリオドは `.HH` (小文字 16 進 2 桁) で表現する
  const parsed = parseMsfFragmentFromInput("msf:a.2db--c.2ed");
  assert.deepEqual(parsed?.trackNamespace, ["a-b"]);
  assert.equal(parsed?.trackName, "c.d");
});

test("msf 以外の fragment では undefined を返す", () => {
  // `#` 以降が msf でなければ、track 情報を取り出す対象ではない
  assert.equal(parseMsfFragmentFromInput("moqt://example.com/moqt#track:video"), undefined);
  // `#` が無い入力は fragment 単体として扱い、msf: で始まらなければ undefined
  assert.equal(parseMsfFragmentFromInput("track:video"), undefined);
});

test("解析できない msf fragment では undefined を返す", () => {
  // `--` が無い (namespace と track name の区切りが無い)
  assert.equal(parseMsfFragmentFromInput("msf:room123"), undefined);
  // track name が空
  assert.equal(parseMsfFragmentFromInput("msf:room-123--"), undefined);
  // 大文字 16 進の percent-encoding (§11.1.2 は小文字を MUST とする)
  assert.equal(parseMsfFragmentFromInput("msf:room.2D123--catalog"), undefined);
  // 空文字列
  assert.equal(parseMsfFragmentFromInput(""), undefined);
});
