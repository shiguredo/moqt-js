/**
 * 配信 / 購読ステータスのメッセージの単体テスト
 *
 * 表示の規則: 確立したメディアトラックの Full Track Name (draft-ietf-moq-transport-21
 * §8.8) を audio → video の順に ", " で並べる (Catalog と Tracks カードの並びに揃える)。
 */

import { test, assert } from "vite-plus/test";
import { buildMediaTrackStatusMessage } from "./trackStatusMessage";

test("buildMediaTrackStatusMessage: Full Track Name を audio → video の順に並べる", () => {
  assert.equal(
    buildMediaTrackStatusMessage("Publishing", ["room", "123"], {
      audio: "audio",
      video: "video",
    }),
    "Publishing: room-123--audio, room-123--video",
  );
  assert.equal(
    buildMediaTrackStatusMessage("Subscribed", ["room", "123"], {
      audio: "audio",
      video: "video",
    }),
    "Subscribed: room-123--audio, room-123--video",
  );
});

test("buildMediaTrackStatusMessage: プロパティの順ではなく audio → video の順にする", () => {
  // オブジェクトリテラルの並びを video → audio にしても結果は変わらない
  assert.equal(
    buildMediaTrackStatusMessage("Subscribed", ["room"], {
      video: "video",
      audio: "audio",
    }),
    "Subscribed: room--audio, room--video",
  );
});

test("buildMediaTrackStatusMessage: 確立したトラックだけを並べる", () => {
  assert.equal(
    buildMediaTrackStatusMessage("Publishing", ["room"], { video: "video" }),
    "Publishing: room--video",
  );
  assert.equal(
    buildMediaTrackStatusMessage("Subscribed", [], { audio: "audio" }),
    "Subscribed: --audio",
  );
});

test("buildMediaTrackStatusMessage: トラック名の区切り文字は §8.8 の規則でエスケープする", () => {
  // "/" 連結では namespace ["a","b"] + track "c" と区別できなかった組み合わせ
  assert.equal(
    buildMediaTrackStatusMessage("Publishing", ["a"], { video: "b/c" }),
    "Publishing: a--b.2fc",
  );
  assert.equal(
    buildMediaTrackStatusMessage("Publishing", ["a", "b"], { video: "c" }),
    "Publishing: a-b--c",
  );
});
