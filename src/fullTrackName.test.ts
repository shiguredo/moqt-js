/**
 * Full Track Name の比較キーと文字列表現の単体テスト
 * draft-ietf-moq-transport-22 Section 2.4.1 (Track Naming) / Section 8.8
 * (Representing Namespace and Track Names)
 */

import { test, assert } from "vite-plus/test";
import {
  formatFullTrackName,
  formatTrackNamespace,
  fullTrackNameKey,
  parseTrackNamespace,
} from "./fullTrackName";

/**
 * draft-ietf-moq-transport-22 §2.4.1:
 * 区切り文字の曖昧さで異なる Full Track Name が同じキーにならないことを、
 * 旧実装 ("/" 連結) が衝突していた具体例で検証する。
 */
test("fullTrackNameKey: 区切り文字の曖昧さで衝突する Full Track Name を区別する", () => {
  // namespace ["a"] + trackName "b/c" と namespace ["a","b"] + trackName "c" は
  // "/" 連結ではどちらも "a/b/c" になっていた
  assert.equal(fullTrackNameKey(["a"], "b/c"), "1:a|3:b/c");
  assert.equal(fullTrackNameKey(["a", "b"], "c"), "1:a|1:b|1:c");
  assert.notEqual(fullTrackNameKey(["a"], "b/c"), fullTrackNameKey(["a", "b"], "c"));

  // 値に長さ付きキーの区切り ("|" / ":") が含まれてもフィールド境界が保たれる
  assert.notEqual(fullTrackNameKey(["a"], "|1:b"), fullTrackNameKey(["a|1:b"], ""));
  assert.notEqual(fullTrackNameKey(["1"], "a"), fullTrackNameKey(["1:a"], ""));
});

/**
 * draft-ietf-moq-transport-22 §2.4.1:
 * Track Namespace は 0 フィールド、Track Name は空を許す。境界が消えないよう
 * 空フィールドにも長さ ("0:") を付ける (空の Track Namespace Field は §8.7 が
 * 1 バイト以上を MUST とするため wire 上は現れないが、キー生成は任意の入力で
 * 境界を保つ)。
 */
test("fullTrackNameKey: 空の Track Namespace / Track Name でも境界が残る", () => {
  assert.equal(fullTrackNameKey([], ""), "0:");
  assert.equal(fullTrackNameKey([], "a"), "1:a");
  assert.equal(fullTrackNameKey(["a"], ""), "1:a|0:");
  // 空フィールドの位置と個数が違えば別のキーになる
  assert.notEqual(fullTrackNameKey(["", "a"], ""), fullTrackNameKey(["a"], ""));
  assert.notEqual(fullTrackNameKey([], "a"), fullTrackNameKey(["a"], ""));
});

/**
 * draft-ietf-moq-transport-22 §8.8:
 * Track Namespace のフィールドを "-" で並べ、Track Name を "--" でつなぐ。
 * 仕様の例 (draft-ietf-moq-msf-01 §11.1.3) をそのまま検証する。
 */
test("formatFullTrackName: 仕様の例を組み立てる", () => {
  assert.equal(
    formatFullTrackName(["customer", "livestream", "123"], "catalog"),
    "customer-livestream-123--catalog",
  );
  assert.equal(formatFullTrackName(["room", "123"], "video"), "room-123--video");
});

/**
 * draft-ietf-moq-transport-22 §8.8:
 * a-z / A-Z / 0-9 / _ 以外のバイトは "." + 小文字 16 進 2 桁にする。構造の
 * 区切り ("-" / "--") と紛らわしい文字、非 ASCII の UTF-8 バイトを検証する。
 */
test("formatFullTrackName: 予約文字と非 ASCII をエスケープする", () => {
  // "-" / "." / "/" は .2d / .2e / .2f になるため、区切りと混ざらない
  assert.equal(formatFullTrackName(["a-b.c/d"], "e-f.g"), "a.2db.2ec.2fd--e.2df.2eg");
  // 非 ASCII は UTF-8 のバイトごとにエスケープする ("あ" = E3 81 82)
  assert.equal(formatFullTrackName(["あ"], "い"), ".e3.81.82--.e3.81.84");
  // 大文字 hex は使わず、予約文字集合はそのまま出す
  assert.equal(formatFullTrackName(["AZaz09_"], "Z"), "AZaz09_--Z");
});

/**
 * draft-ietf-moq-transport-22 §2.4.1:
 * "/" 連結では namespace ["a"] + track "b/c" と namespace ["a","b"] + track "c" が
 * 同じ "a/b/c" になっていた。§8.8 の表現ではエスケープが両者を区別する。
 */
test("formatFullTrackName: 区切り文字の曖昧さで異なる Full Track Name が同じ文字列にならない", () => {
  assert.equal(formatFullTrackName(["a"], "b/c"), "a--b.2fc");
  assert.equal(formatFullTrackName(["a", "b"], "c"), "a-b--c");
  assert.notEqual(formatFullTrackName(["a"], "b/c"), formatFullTrackName(["a", "b"], "c"));
});

/**
 * draft-ietf-moq-transport-22 §8.7:
 * Track Namespace は 0 フィールドを許す。空のときは "--" の左側だけが空になる。
 * Track Namespace Field は 1 バイト以上を MUST とするため、空のフィールドは
 * 区切りと区別できず拒否する。
 */
test("formatFullTrackName: 空の Track Namespace と空の Track Name を扱う", () => {
  assert.equal(formatFullTrackName([], "video"), "--video");
  // Track Name は §8.7 が空を許す (カタログでは §5.2.3 が空を拒否する)
  assert.equal(formatFullTrackName(["room"], ""), "room--");
  assert.throws(
    () => formatFullTrackName(["room", "", "123"], "video"),
    /track namespace field at index 1 must not be empty/,
  );
});

/**
 * draft-ietf-moq-transport-22 §8.8:
 * namespace 単体の表記は track name を除いた部分であり、`--` の左側がそのまま残る。
 * ログ等で namespace だけを出すときに使う。
 */
test("formatTrackNamespace: Track Namespace だけを組み立てる", () => {
  assert.equal(formatTrackNamespace(["customer", "livestream", "123"]), "customer-livestream-123");
  assert.equal(formatTrackNamespace(["room", "123"]), "room-123");
  // Track Namespace は §8.7 が 0 フィールドを許す
  assert.equal(formatTrackNamespace([]), "");
  // フィールドのエスケープ規則は Full Track Name と同じ
  assert.equal(formatTrackNamespace(["a-b.c/d"]), "a.2db.2ec.2fd");
  assert.equal(formatTrackNamespace(["あ"]), ".e3.81.82");
  assert.throws(
    () => formatTrackNamespace(["room", "", "123"]),
    /track namespace field at index 1 must not be empty/,
  );
});

/**
 * draft-ietf-moq-transport-22 §8.8:
 * Track Namespace の文字列表現をフィールド列へ戻す。仕様の例 (§11.1.3 の MSF URL が
 * 使う `customer-livestream-123`) と、literal で書けない byte の復号を検証する。
 */
test("parseTrackNamespace: 仕様の例とエスケープを復号する", () => {
  assert.deepEqual(parseTrackNamespace("customer-livestream-123"), [
    "customer",
    "livestream",
    "123",
  ]);
  assert.deepEqual(parseTrackNamespace("room-123"), ["room", "123"]);
  // "-" / "." / "/" は .2d / .2e / .2f として復号する
  assert.deepEqual(parseTrackNamespace("a.2db.2ec.2fd"), ["a-b.c/d"]);
  // 非 ASCII は UTF-8 のバイト列から復号する ("あ" = E3 81 82)
  assert.deepEqual(parseTrackNamespace(".e3.81.82"), ["あ"]);
  // literal で書ける byte はそのまま復号する
  assert.deepEqual(parseTrackNamespace("AZaz09_"), ["AZaz09_"]);
  // 0 フィールドの Track Namespace は §8.7 が許す
  assert.deepEqual(parseTrackNamespace(""), []);
});

/**
 * draft-ietf-moq-transport-22 §8.8:
 * 「a period not followed by exactly two lowercase hexadecimal digits」と
 * 「a byte that could have been represented literally but was hex-encoded」は
 * MUST reject である。空の Track Namespace Field は §8.7 が 1 バイト以上を MUST と
 * するため、区切りと区別できない入力として拒否する。
 */
test("parseTrackNamespace: §8.8 の規則に合わない文字列を拒否する", () => {
  // 空のフィールド (連続する区切りと末尾の区切り)
  assert.throws(
    () => parseTrackNamespace("a--b"),
    /track namespace field at index 1 must not be empty/,
  );
  assert.throws(
    () => parseTrackNamespace("a-"),
    /track namespace field at index 1 must not be empty/,
  );
  // literal で書ける byte の hex 表現
  assert.throws(
    () => parseTrackNamespace("na.61"),
    /byte "\.61" must be written literally in track namespace field at index 0/,
  );
  assert.throws(() => parseTrackNamespace("n.5f"), /byte "\.5f" must be written literally/);
  // 大文字 hex と、16 進 2 桁に満たない "."
  assert.throws(
    () => parseTrackNamespace("a.2D"),
    /percent-encoding must use two lowercase hexadecimal digits in track namespace field at index 0, got "\.2D"/,
  );
  assert.throws(
    () => parseTrackNamespace("a."),
    /"." must be followed by two lowercase hexadecimal digits in track namespace field at index 0/,
  );
  // literal で書けない文字 (区切りの "-" も含めてエスケープが要る)
  assert.throws(
    () => parseTrackNamespace("a/b"),
    /character "\/" in track namespace field at index 0 is not in \[A-Za-z0-9_\]/,
  );
  // UTF-8 として読めない byte 列
  assert.throws(
    () => parseTrackNamespace(".ff"),
    /percent-encoded bytes in track namespace field at index 0 are not valid UTF-8/,
  );
});
