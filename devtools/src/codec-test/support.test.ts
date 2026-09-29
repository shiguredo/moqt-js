/**
 * codec テストページの共通ヘルパーの単体テスト
 *
 * 候補順の解決と非対応コーデックの選定はブラウザ API に依存しない部分のため、
 * Node の vitest で固定する (Node に無いブラウザ API は境界として置き換える)。
 * 実ブラウザでの符号化プローブと選定結果は e2e (tests/e2e/codec-wrappers.spec.ts) が担う。
 */

import { test, assert } from "vite-plus/test";
import { withVideoDecoder } from "../../../src/testSupport/helpers.ts";
import {
  VIDEO_CODEC_CANDIDATES,
  resolveAudioCodecCandidates,
  selectUnsupportedVideoCodec,
} from "./support.ts";

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

test("selectUnsupportedVideoCodec: 候補を先頭から試して最初の非対応を選ぶ", async () => {
  // h264 (avc1) だけが非対応の環境を再現する。選ばれるのは h264 であり、
  // 候補のうち h264 より前のものだけが supportedCodecs に載る (h264 自身は載らない)
  await withVideoDecoder(
    {
      isConfigSupported: async (config: VideoDecoderConfig) => ({
        supported: !config.codec.startsWith("avc1"),
      }),
    },
    async () => {
      const selection = await selectUnsupportedVideoCodec();

      assert.equal(selection.codec, "h264");
      assert.equal(selection.codecString, "avc1.42001f");
      assert.deepEqual(
        selection.supportedCodecs,
        VIDEO_CODEC_CANDIDATES.slice(0, VIDEO_CODEC_CANDIDATES.indexOf("h264")),
      );
      // 候補の先頭は対応 codec (vp8) であり、対応と判定した候補が 1 件以上載る。
      // e2e はこの性質を使って「選んだ非対応 codec が supportedCodecs に含まれない」
      // ことを空振りせずに検証するため、候補順の変更でこの性質を壊さない
      assert.isTrue(selection.supportedCodecs.length > 0);
    },
  );
});

test("selectUnsupportedVideoCodec: 全候補が非対応なら先頭を選び supportedCodecs は空になる", async () => {
  // 1 件も対応が無い環境では候補の先頭が選ばれ、対応と判定した候補は 1 つも無い
  await withVideoDecoder({ isConfigSupported: async () => ({ supported: false }) }, async () => {
    const selection = await selectUnsupportedVideoCodec();

    assert.equal(selection.codec, VIDEO_CODEC_CANDIDATES[0]);
    assert.deepEqual(selection.supportedCodecs, []);
  });
});

test("selectUnsupportedVideoCodec: 全候補が対応なら理由付きで Error になる", async () => {
  // 非対応 codec の経路を駆動できない環境は、テストを skip せず選定の時点で失敗させる
  await withVideoDecoder({ isConfigSupported: async () => ({ supported: true }) }, async () => {
    let thrown: unknown = null;
    try {
      await selectUnsupportedVideoCodec();
    } catch (error) {
      thrown = error;
    }

    assert.instanceOf(thrown, Error);
    // 候補はすべて VIDEO_CODEC_CANDIDATES の並びのまま報告される
    assert.equal(
      (thrown as Error).message,
      `no unsupported video codec in this browser (all candidates are supported: ${VIDEO_CODEC_CANDIDATES.join(", ")})`,
    );
  });
});
