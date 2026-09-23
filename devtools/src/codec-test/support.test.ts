/**
 * codec テストページの共通ヘルパーの単体テスト
 *
 * 候補順の解決はブラウザ API に依存しない純関数のため、Node の vitest で固定する。
 * 実ブラウザでの符号化プローブは e2e (tests/e2e/codec-wrappers.spec.ts) が担う。
 */

import { test, assert } from "vite-plus/test";
import { resolveAudioCodecCandidates } from "./support.ts";

test("resolveAudioCodecCandidates: 指定が無ければ既定の候補順になる", () => {
  // クエリパラメータが無い場合は既定の候補順 (opus 優先) をそのまま使う
  assert.deepEqual(resolveAudioCodecCandidates(""), ["opus", "aac"]);
  assert.deepEqual(resolveAudioCodecCandidates("?"), ["opus", "aac"]);
  // 無関係なパラメータは無視する
  assert.deepEqual(resolveAudioCodecCandidates("?foo=bar"), ["opus", "aac"]);
});

test("resolveAudioCodecCandidates: カンマ区切りで候補順を差し替えられる", () => {
  // 符号化できないコーデックを先頭に固定して再現するための経路
  assert.deepEqual(resolveAudioCodecCandidates("?audioCodecs=aac,opus"), ["aac", "opus"]);
  assert.deepEqual(resolveAudioCodecCandidates("?audioCodecs=opus"), ["opus"]);
  // 前後の空白は無視する
  assert.deepEqual(resolveAudioCodecCandidates("?audioCodecs=%20aac%20,%20opus%20"), [
    "aac",
    "opus",
  ]);
});

test("resolveAudioCodecCandidates: 未知の名前と空要素は無視する", () => {
  // 綴り間違いで「候補が無い」状態に落ちないよう、解釈できない要素だけを捨てる
  assert.deepEqual(resolveAudioCodecCandidates("?audioCodecs=vorbis,opus"), ["opus"]);
  assert.deepEqual(resolveAudioCodecCandidates("?audioCodecs=,aac,,opus,"), ["aac", "opus"]);
  // 名前は大文字小文字を区別する (OPUS は opus として扱わない)
  assert.deepEqual(resolveAudioCodecCandidates("?audioCodecs=OPUS"), []);
});

test("resolveAudioCodecCandidates: 同名のパラメータが複数あるときは最初の値を使う", () => {
  // URLSearchParams.get の挙動に合わせる (2 つ目以降は無視する)
  assert.deepEqual(resolveAudioCodecCandidates("?audioCodecs=aac&audioCodecs=opus"), ["aac"]);
  assert.deepEqual(resolveAudioCodecCandidates("?audioCodecs=opus&audioCodecs=aac"), ["opus"]);
});

test("resolveAudioCodecCandidates: 重複した名前は最初の 1 つだけを残す", () => {
  // 同じ候補を 2 度試すと符号化の失敗を繰り返すため、重複は取り除く
  assert.deepEqual(resolveAudioCodecCandidates("?audioCodecs=aac,opus,aac"), ["aac", "opus"]);
});

test("resolveAudioCodecCandidates: 有効な候補が無ければ空になる", () => {
  // 空配列は「符号化できる候補が無い」として選定側が明示的な Error にする
  assert.deepEqual(resolveAudioCodecCandidates("?audioCodecs="), []);
  assert.deepEqual(resolveAudioCodecCandidates("?audioCodecs=unknown"), []);
});
