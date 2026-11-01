# 映像の表示が rAF の位相で 1 表示周期余分に遅れるのを直す

- Created: 2026-11-02
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-video-presentation-vsync
- Polished: {YYYY-MM-DD}
- Reporter: @voluntas

## 目的

実リレーで 30 fps の映像を購読すると、フレームの到着と復号は表示時刻に間に合っているのに、表示間隔が 33.3 ms ではなく 50 ms になる回が数秒おきに出る。実アプリでは 1 フレーム分の引っかかり (ジャダー) として見え、ライブ視聴の品質を損なう。

原因は、表示の可否を rAF のたびに「表示時刻を過ぎたか」で問い合わせる現行方式と、表示先ごとの「書き込み・描画から実際の表示までの遅延」をモデル化していないことにある。vsync を基準にした表示スケジューラへ移し、意図した表示時刻の vsync にフレームを提示する。

## 現状

- `src/playout/videoPlayoutSession.ts` の `VideoPlayoutSession.drain` は、rAF のコールバックで `PlayoutBuffer.select(nowMs)` を呼び、表示時刻を過ぎたフレームを出す。表示時刻を過ぎた後の最初の rAF まで待つため、rAF の位相が表示時刻の直後に来ると 1 周期余分に待つ
- `VideoPlayoutPacing` は `drainImmediately` と `framesPerDrain` だけを持ち、表示先が何 vsync 後に表示するかを表す情報を持たない
- ライブラリは `src/createMediaSubscriber.ts` の `presentVideoFrame` で `MediaStreamTrackGenerator` に書く。書いたフレームは次の vsync で表示される。フレームの `timestamp` は LOC の壁時計マイクロ秒のままで、表示周期には使われない (下記の実測)
- devtools は `devtools/src/hooks/useSubscriber.ts` の `drawFrame` で rAF のコールバック内に canvas へ描く。rAF の位相ずれはライブラリと同じ
- `src/playout/timeline.ts` の `PlayoutTimeline.recordPresentation` は `present` を呼んだ時刻を表示実績として記録する。generator は実際の表示が約 1 vsync 後なので、A/V 同期の推定が片側にずれる
- `devtools/src/utils/playoutTimingStats.ts` の `PlayoutTimingStats.recordDisplay` は、表示間隔がフレーム間隔の 1.5 倍を超えたら停止と数える。この 1.5 倍は現行方式の 1 vsync の位相ずれを停止として拾ってしまう
- `docs/MEDIA_PLAYOUT.md` は「表示の間隔は `MediaStreamTrackGenerator` の先のブラウザが TIMESTAMP から決める」としているが、実測では書き込み時刻で決まる

### 実ブラウザの実測

Chromium 156.0.8078.4 (Playwright の `channel: "chromium"`、新しい headless) で、`MediaStreamTrackGenerator` へ書いたフレームを `<video>` + `requestVideoFrameCallback` で観測した。

- rAF の tick T に書いたフレームは T + 16.6〜16.8 ms の vsync で表示される
- 2 tick ごと (30 fps) に書くと、表示間隔は 33.2〜33.4 ms で安定する
- 20 枚を約 6 ms で書き込むと (各 timestamp は 33.3 ms 間隔)、`requestVideoFrameCallback` は 1 回だけ呼ばれ、`presentedFrames` は 20 になる。中間のフレームは表示されない
- timestamp を 100 ms 過去にしても、表示周期は書き込みの周期に従う

つまり、`MediaStreamTrackGenerator` は書き込みの次の vsync で最新フレームを表示し、`VideoFrame.timestamp` は表示周期を決めない。この 1 vsync を補わないまま表示時刻後に書くと、意図した表示より必ず遅れ、位相の揺れで 2〜3 vsync 間隔になる。

### 実リレー CI の計測

実リレーの 60 秒の長時間試験で、音声と映像の遅延・停止の内訳を記録した。

- `render` 停止は 8 回 / 60 秒の回と、25 回 / 60 秒の回があった
- 停止の表示間隔は平均 50.4 ms、最大 51.2 ms である一方、同時点の media step は 33.1〜34.5 ms だった
- 表示間隔の p50 は 33.3 ms、p95 の最大は 50.7 ms
- メインスレッドの停止は最大 22〜23 ms で、長いタスクは無かった

30 fps の 33.3 ms が 50 ms になるのは、位相の揺れで 1 tick 余分に待つためであり、generator では書き込み後の 1 vsync も加わる。描画負荷ではなく、表示周期の量子化と提示遅延の問題である。

## 設計方針

- vsync 基準の表示スケジューラを `VideoPlayoutSession` から分離して作る (`src/playout/presentationScheduler.ts` など)。`PlayoutBuffer` は到着・復号・期限切れの判定に残し、いつ表示先へ渡すかはスケジューラが決める
- `requestFrame` から rAF のコールバック引数 (vsync 時刻) を受け取り、表示周期 R を実測する。直近の rAF 間隔の中央値を使い、変化したら取り直す
- `VideoPlayoutOutput` または `VideoPlayoutPacing` に、表示先の提示遅延を tick 数で持たせる
  - canvas: 0 (rAF コールバック内の描画はその vsync のフレームに含まれる)
  - `MediaStreamTrackGenerator`: 1 (書き込みの次の vsync で表示される)
- 各フレームの `presentationMs` を vsync のグリッドへ量子化し、目標表示 tick を `round((presentationMs - tickOrigin) / R)` で求める。表示先へ渡す tick は `目標表示 tick - 提示遅延 tick` とする
- 1 tick に 1 枚だけ渡す。目標表示 tick を過ぎたフレームは捨て、遅れと原因を計器へ残す。追いつくときは古いフレームを飛ばす
- 表示実績は「渡した tick の時刻 + 提示遅延 × R」を `PlayoutTimeline.recordPresentation` へ記録する。`AvSyncStats` の意味と閾値は変えない
- `drainImmediately` による即時書き込みは generator では表示スケジューラ経由に統一する。1 tick に複数枚を書くとまとめられて中間フレームが表示されないためである。rAF が使えない環境だけ従来の即時書き込みへフォールバックする
- `VideoFrame.timestamp` は現状の LOC の壁時計マイクロ秒を維持する。表示周期に使われないことは Chrome 156 の実測であり仕様の保証ではないため、コメントと docs に測定条件を書く
- 非表示タブの復帰時は溜まったフレームを捨てて最新へ追いつく。120 Hz など R が変わったらスケジューラを取り直す
- 停止判定 (フレーム間隔の 1.5 倍) の基準そのものの見直しと、Chromium 以外のブラウザの表示先の検証はこの issue では行わない

## 完了条件

- rAF の timestamp を注入した単体テストで、30 fps / 60 fps / 120 Hz のとき、位相の揺れがあっても表示 tick が等間隔になること、generator は目標表示 tick の 1 tick 前に書くこと、目標を過ぎたフレームを捨てることを固定する
- 実ブラウザ (Playwright、Chromium) の試験で、generator へ 30 fps で書いたときの `requestVideoFrameCallback` の表示間隔 p95 がフレーム間隔 + 1 ms 以下になることを確認する。canvas は描画 tick の間隔で同じことを確認する
- 実リレー CI の長時間試験で、media step が正常な `render` 停止 (1 vsync の量子化由来) が 0 回になることを確認する。音声の欠落、A/V 同期 (`skewMs`)、鳴り始めの遅れに回帰がないこと
- `vp check`、`vp test run`、Playwright の chromium / relay が通る
- `docs/MEDIA_PLAYOUT.md` と該当コードのコメントが実装と一致している
