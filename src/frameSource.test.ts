import { test, assert } from "vite-plus/test";
import { isMediaStreamTrackProcessorAvailable } from "./frameSource";

// テスト方針 (フォールバック経路の扱い):
// createVideoFrameSource は MediaStreamTrackProcessor の可用性で
// processor 経路と requestVideoFrameCallback 経路を切り替えるが、どちらの経路も
// 実ブラウザ基盤 (MediaStreamTrackProcessor / HTMLVideoElement /
// requestVideoFrameCallback / VideoFrame) を必要とする。
// Node.js の単体テスト環境にはこれらが存在せず、グローバルを差し替えて通すのは
// スタブを作ることにあたるため (AGENTS.md で禁止)、単体テストは可用性判定のみを
// 対象とする。実ブラウザ経路は Playwright e2e (chromium のみ) の対象外ともする。
// chromium は MediaStreamTrackProcessor をメインスレッドに公開するため
// フォールバック経路に入らず、同経路の確認は Safari 実機の手動確認に委ねる。

// Node.js 環境では MediaStreamTrackProcessor が存在しないため false を返す
test("isMediaStreamTrackProcessorAvailable は MediaStreamTrackProcessor が未定義の場合 false を返す", () => {
  assert.strictEqual(isMediaStreamTrackProcessorAvailable(), false);
});
