# moqt-devtools の購読再生がかくつく (表示の早送り・120 fps の二重描画・巨大 canvas・ログ負荷)

- Created: 2026-09-24
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-devtools-smooth-playback
- Polished: {YYYY-MM-DD}

## 目的

moqt-devtools の購読表示がかくつく。relay の cache replay 配送 (別 issue で修正) が滑らかになっても、devtools 側に次の欠陥が残ると滑らかに再生できない。

1. 復号したフレームを到着順にすべて描画するため、cache replay の追い上げ中は早送りに見える。120 fps の映像では 1 表示周期に複数枚を描き、かくつく
2. 4K のフレームで canvas を実寸 (3840x2160) にするため、1 枚あたりの描画コストが大きい
3. 毎 Object の payload をログ用にコピーするため、120 fps / 4K (1 Object 約 31 KB) ではメインスレッドの負荷が大きい
4. キーフレーム間隔 (keyframeInterval) の既定が 3600 frames (30 fps で 120 秒) であり、後着購読が最初の絵を出すまで最大 2 分かかる。デフォルトのままでは relay の cache 上限 (600 Object) も超えやすく、視聴開始が遅れて「絵が出ない」と見える

## 現状

- `devtools/src/hooks/useSubscriber.ts` の `renderFrame` は Decoder の `output` ごとに `ctx.drawImage` を呼ぶ。rAF とは同期しない
- 同じ関数が `canvas.width = frame.displayWidth` と実寸を設定する
- `devtools/src/hooks/debugMessageLog.ts` は `message.payload` を常に `new Uint8Array` へコピーする
- `devtools/src/signals/connectionSettings.ts` / `signals/publisher.ts` の `keyframeInterval` は `signal(3600)` (120 秒)
- devtools publisher は先頭フレームと keyframeInterval ごとにキーフレームを要求するため、既定のままでは Group が 3600 Object になりうる

## 設計方針

- 復号済みフレームは 1 枚だけ保持し、requestAnimationFrame で 1 周期 1 枚だけ表示する (`presentFrame`)。それより古いフレームは復号済みのまま破棄する。teardown では保持中のフレームを破棄して予約した描画を取り消す (`clearPendingFrame`)
- canvas の幅を上限 (1280 px) に抑え、フレームを縮めて描く。表示は CSS で拡縮されるため見た目は変わらない
- ログへコピーする payload に上限 (4096 byte) を設け、超える payload はコピーせず `payloadSize` だけを残す
- `keyframeInterval` の既定を 60 frames (30 fps で 2 秒) にし、ライブラリの既定 (framerate の 2 倍) と揃える
- この欠陥は relay 側の配送品質と独立に再現するため、E2E (sora-moq の `test_moqtjs_smoothness.py`) で表示フレーム数と rAF 間隔を実測して固定する

## 完了条件

- 60 fps / 120 fps の購読 (後着を含む) で、表示フレーム数が表示上限 (配信 fps とディスプレイ fps の小さい方) の 7 割以上であることを Playwright で実測する
- rAF の最大間隔が 120 ms を超えないことを Playwright で実測する
- 4K 相当の frame でも canvas が 1280 px 幅に抑えられることをテストで固定する
- `vp check` と全テスト (vitest) が通る

## 参照

- `devtools/src/hooks/useSubscriber.ts` / `devtools/src/hooks/debugMessageLog.ts` / `devtools/src/signals/connectionSettings.ts`
- `e2e-test/browser/relay_interop/test_moqtjs_smoothness.py` (sora-moq 側)
