# 映像の表示を表示時刻に最も近い vsync に合わせ、表示先の提示遅延を補償する

- Created: 2026-11-02
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-video-presentation-vsync
- Polished: 2026-11-02
- Reporter: @voluntas

## 目的

映像のフレームを「表示時刻を過ぎた後の最初の rAF」ではなく「表示時刻に最も近い vsync」に提示し、表示先ごとの提示遅延 (書き込み・描画から実際の表示までの遅延) を補償する。

現行方式には次の問題がある。

- rAF 経路は表示時刻を過ぎた後の最初の tick まで待つため、平均で表示周期の半分だけ遅れる。位相の揺れで余分に 1 tick 待つことがある
- ライブラリの `MediaStreamTrackGenerator` 経路は、書き込みの次の vsync で表示されるため、さらに 1 周期遅れる
- 表示実績を `present` の呼び出し時刻で記録しているため、generator 経路の A/V 同期の推定が実際の表示より 1 周期早い

表示時刻と提示 tick の差を計測できるようにし、`AvSyncStats` の映像側の表示実績も書き込み時刻ではなく推定表示時刻にする。

### この issue で直さないこと

30 fps 素材の media step が 33.4 ms の場合、60 Hz では 2.004 tick/frame であり、1800 フレームあたり 7〜8 回の 3 tick 間隔 (50 ms) は vsync 量子化上不可避である。50 ms 間隔そのものを 0 にすることは目的にしない。現行の停止判定 (表示間隔がフレーム間隔の 1.5 倍を超えたら停止) も、この不可避な周期変換を停止として数えるため、判定基準の見直しは別 issue とする。

ライブラリの `createMediaSubscriber` は `VideoPlayoutTiming` を渡していないため、ライブラリ経路で捨てたフレームの計器は持たない。ライブラリ側の計器の追加はこの issue では行わない (必要なら別 issue)。ライブラリの挙動は実ブラウザ試験で確認する。

## 現状

- `src/playout/videoPlayoutSession.ts` の `VideoPlayoutSession.handleDecodedFrame` は、`drainImmediately` が true (ライブラリの既定) なら積んだ時点で `drain` を呼び、表示時刻を過ぎたフレームをすぐに書く。false (devtools) なら rAF のコールバックで `drain` を呼び、`PlayoutBuffer.select(nowMs)` で表示時刻を過ぎたフレームを出す。どちらの経路も「表示時刻を過ぎた後の最初の tick」であり、表示時刻に最も近い tick ではない
- `PlayoutBuffer.select` は、表示時刻を過ぎたフレームのうち `MAX_PRESENTATION_LAG_MS` (20 ms) 以内のものを描き、それより古いものを捨てる。20 ms 以内なら次の tick でも遅れて描くため、配信 fps と表示周期が近いときに表示間隔が半分になる組み合わせを作り得る
- `VideoPlayoutPacing` は `drainImmediately` と `framesPerDrain` だけを持ち、表示先が何 vsync 後に表示するかを表す情報を持たない。この型は `src/index.ts` で公開されており、`createMediaPlayout` の `video.pacing` として利用者が指定できる
- ライブラリは `src/createMediaSubscriber.ts` の `presentVideoFrame` で `MediaStreamTrackGenerator` に書く。書いたフレームは次の vsync で表示される。フレームの `timestamp` は LOC の壁時計マイクロ秒のままで、表示周期には使われない (下記の実測。Chrome 156 の測定であり仕様の保証ではない)
- devtools は `devtools/src/hooks/useSubscriber.ts` の `drawFrame` で rAF のコールバック内に canvas へ描く。canvas への描画はその vsync のフレームに含まれるため、rAF の位相ずれだけが問題になる
- `src/playout/timeline.ts` の `PlayoutTimeline.recordPresentation` は `present` を呼んだ時刻を表示実績として記録する。generator は実際の表示が約 1 vsync 後なので、A/V 同期の推定が片側にずれる
- `src/codec/types.ts` の `AvSyncStats.skewMs` と `docs/HIGH_LEVEL_API.md` は、映像の表示時刻を「write した時刻」と定義している。この定義は映像の提示方式を変えると実態と合わなくなる
- `docs/MEDIA_PLAYOUT.md` と `src/playout/mediaPlayout.ts` のコメントは「表示の間隔は `MediaStreamTrackGenerator` の先のブラウザが TIMESTAMP から決める」としているが、実測では書き込み時刻で決まる

### 実ブラウザの実測

Chromium 156.0.8078.4 (Playwright 1.64.1 の `channel: "chromium"`、新しい headless) で、64x64 の canvas から作ったフレームを `MediaStreamTrackGenerator` へ書き、`<video>` の `requestVideoFrameCallback` で実際の表示時刻を観測した。

- rAF の tick T のコールバック内で書いたフレームは T + 16.6〜16.8 ms の vsync で表示される
- 2 tick ごと (30 fps) に書くと、表示間隔は 33.2〜33.4 ms で安定する
- 20 枚を約 6 ms で書き込むと (各 timestamp は 33.3 ms 間隔)、`requestVideoFrameCallback` は 1 回だけ呼ばれ、`presentedFrames` は 20 になる。中間のフレームは表示されない
- timestamp を 100 ms 過去にしても、表示周期は書き込みの周期に従う

この結果から、少なくとも Chrome 156 の新しい headless では、`MediaStreamTrackGenerator` は書き込みの次の vsync で最新フレームを表示し、`VideoFrame.timestamp` は表示周期を決めない。この挙動はブラウザの仕様として保証されたものではないため、実装では測定条件をコメントと docs に残す。この実測は一時的な probe で行ったものであり、同じ条件を完了条件の実ブラウザ試験で固定する。

### 実リレー CI の計測

実リレーの 60 秒の長時間試験 (`tests/e2e/relay/devtools-both-audio.spec.ts` の「長時間の配信で、送信の遅れと受信の遅れが悪化しない」、640x360 / VP8 / 30 fps、moqt-devtools の購読) で、`window.moqtDevTools.getSubscribers()[0].playoutTiming` を読む計測を別途行った。

- `render` 停止は 8 回 / 60 秒の回と、25 回 / 60 秒の回があった
- 停止の表示間隔は平均 50.4 ms、最大 51.2 ms である一方、同時点の media step は 33.1〜34.5 ms だった
- 表示間隔の p50 は 33.3 ms、p95 の最大は 50.7 ms
- メインスレッドの停止は最大 22〜23 ms で、長いタスクは無かった

33.4 ms の media step は 60 Hz で 2.004 tick/frame であり、1800 フレームで 7〜8 回の 3 tick 間隔が必要になる。観測した `render` 停止の回数は、この不可避な周期変換と、位相の揺れによる余分な待ちの両方を含む。本 issue は後者 (余分な待ちと系統的な遅れ) を対象とする。

なお、この計測は開発中の診断機能で取得した参考値であり、現在の `develop` の長時間試験は音声中心の判定で映像の `playoutTiming` を読む検証を持っていない。同一条件での再現は完了条件の長時間試験の拡張と実ブラウザ試験で固定する。

## 設計方針

### 公開 API の変更

- `VideoPlayoutOutput` に `presentationLatencyTicks: number` を必須で追加する。`present()` を呼んでからフレームが実際に表示されるまでの遅延を、表示周期の tick 数で表す
  - canvas: 0 (rAF コールバック内の描画はその vsync に含まれる)
  - `MediaStreamTrackGenerator`: 1 (書き込みの次の vsync で表示される)
- `VideoPlayoutPacing` (`drainImmediately` / `framesPerDrain`) と `MediaPlayoutVideoOptions.pacing` を削除する。表示は常に rAF の tick で 1 枚ずつ行い、到着時の即時書き込みと 1 tick 複数枚の書き込みはしない。`src/index.ts` の公開型、`mediaPlayout.ts` の既定、`src/createMediaSubscriber.ts` の `MediaStreamTrackGenerator` の出力、`devtools/src/hooks/useSubscriber.ts` の canvas の出力、`tests/e2e/` の playout 用ハーネスと各 spec、テスト、docs を更新する。`CODEBASE.md` の方針により破壊的変更を許容し、MOQT のドラフト中のため `CHANGES.md` は更新しない
- `VideoPlayoutSessionOptions.requestFrame` のコールバックに rAF のタイムスタンプを渡す (`(timestampMs: number) => void`)。既定は `requestAnimationFrame` をそのまま使う

### 表示スケジューラ

以下では、rAF のコールバック時刻を「書き込み tick W」、フレームの推定表示時刻を「D = W + `presentationLatencyTicks` × R」、表示周期を R と書く。canvas は `D = W`、`MediaStreamTrackGenerator` は `D = W + R` である。

- `VideoPlayoutSession` が rAF のタイムスタンプから表示周期 R を実測する。直近 16 tick の間隔の中央値を使い、tick 間隔のサンプルが 2 つ未満の間は 60 Hz (16.667 ms) を仮定する。4 tick 分 (約 66.7 ms) を超える間隔は外れ値としてサンプルを捨てて 60 Hz に戻し、古いフレームは後述の規則で捨てる
- 各書き込み tick W で目標表示時刻 D = W + `presentationLatencyTicks` × R を求める。キューから「表示時刻が D に最も近いフレーム」を許容幅 R / 2 で 1 枚だけ選び、1 tick に 1 枚だけ出す。選ばれなければ次の tick へ予約を続ける。これを `PlayoutBuffer` の新しい選択 API (`selectNearest(targetMs, toleranceMs)`) として追加し、戻り値は「描くフレーム、表示せずに捨てるフレーム、描くフレームの表示時刻」を持つ型にする
- 表示時刻が `D - R / 2` より前のフレームは、原則としてその tick では選択せずに捨てる。遅れて提示すると、次のフレームを早く出して表示間隔が半分になるためである
  - 例外として、目標表示時刻に合うフレームがキューに無く、フレームの遅れが `MAX_PRESENTATION_LAG_MS` (20 ms) 以内なら、表示を止めないため 1 枚だけ遅れて提示する。遅れて提示したときは `drawLate` を返し、捨てたフレームとは区別する。`presentationLatencyTicks` が 1 以上の出し先は、書き込みの次の vsync まで待てないフレームを拾えるよう、遅れてよい上限を提示遅延の分だけ広げる
- 同じ表示時刻の近傍に 2 枚が入り、1 枚しか選べない場合 (60 fps を 60 Hz で表示し、位相が揺れた場合など) は、D に近い方を選ぶ。もう片方は、次の target の許容幅に入れば残し、入らなければ捨てる。捨てたフレームは、`VideoPlayoutTiming` が渡されているときは `recordLateDrop` に記録する。これにより表示間隔が半分になることはない
  - `recordLateDrop` / `lateFramesDropped` の意味は「表示時刻を過ぎて間に合わなかったフレーム」から「表示周期に重なったため、または表示時刻を過ぎたために提示しなかったフレーム」へ広げる。devtools の help、`stallAnalysis` の `lateDropped` の説明も同じ意味に更新する
- `presentationMs === null` のフレーム (壁時計の TIMESTAMP を持たない) は従来どおり 1 tick に 1 枚出す
- 表示待ちが空でも、最後の表示から 250 ms までは rAF の予約を続ける (30 fps のように到着間隔が表示周期より長いとき、予約を止めると R の推定が壊れるため)。250 ms を過ぎたら予約を止め、フレームが積まれたら再開する

### 表示実績時刻

- `present` が true を返し、そのフレームが表示時刻を持つ場合だけ、`PlayoutTimeline.recordPresentation("video", timestamp, BigInt(Math.round((performance.timeOrigin + W + presentationLatencyTicks × R) * 1_000)))` を記録する。第 3 引数は Unix epoch のマイクロ秒である。false のときは同期の実績に記録しない (既存契約を守る)
- `AvSyncStats.skewMs` の意味は「映像の表示時刻と音声の表示時刻の差」のまま変えない。ただし映像側の算出を「write 時刻」から「推定表示時刻」へ改めるため、`src/codec/types.ts` の JSDoc と `docs/HIGH_LEVEL_API.md` の記述を更新する。同期制御の式、閾値、不感帯は変えない
- devtools の `PlayoutTimingStats.recordDisplay` は引き続き `present` 時点の時刻で表示間隔を記録する。tick の時刻は `present` の引数に含めない

### 既存の設計との関係

- 「表示時刻前のフレームは書かない」という従来の設計 (moqt-devtools とライブラリの映像再生を共有したときの完了条件) は、全出力で「表示時刻に最も近い vsync の許容幅 R / 2 まで早期提示する」規則へ置き換える。canvas は D = W のため最大 R / 2 前まで描き、generator は W から見ると実質 1 tick 前の書き込みになる。コードのコメント、`buffer.prop.ts` の「表示時刻より前に描かない」PBT、`buffer.test.ts`、`videoPlayoutSession.test.ts` の「表示時刻を過ぎていないフレームはキューに残す」テストを更新する
- 表示時刻から 20 ms 以内の遅れは捨てずに描く既存の規則は、目標に合うフレームが無いときの逃げ道として残す。通常は目標に最も近いフレームを選び、20 ms を超えて遅れたフレームだけを捨てる。`MAX_PRESENTATION_LAG_MS` の定義、`PlayoutBuffer` のコメント、PBT、関連する docs を更新する
- 停止判定 (表示間隔がフレーム間隔の 1.5 倍を超えたら停止) の基準そのものの見直しは行わない
- Chromium 以外のブラウザの表示先の検証は行わない

## 完了条件

- rAF の timestamp を注入した単体テストで次を固定する。モックやスタブライブラリは使わず、既存のテストと同じく `requestFrame` / `cancelFrame` / 出力を注入する
  - 30 fps / 60 fps / 120 Hz の 30 秒分の tick 列と、位相が ±3 ms 揺れる tick 列で、提示した各フレームの推定表示時刻 D が、そのフレームの表示時刻に最も近い vsync になること
  - 提示したフレームだけを対象に、表示間隔が、各フレームの表示時刻を累積的に最も近い vsync へ量子化した参照列と一致すること (捨てたフレームは参照列から除く。不可避な 3 tick 間隔は許容する)
  - 同じ target に 2 枚が重なる 60 fps / 60 Hz の条件で、1 枚だけを提示し、もう 1 枚を捨て、表示間隔が半分にならないこと。捨てたフレームが `recordLateDrop` に記録されること
  - 系統的な遅れがないこと。時間軸の映像の表示の遅れが提示遅延以上ある条件で、提示したフレームについて、推定表示時刻 D と表示時刻の差の平均が 1 ms 以内、最大が R / 2 + 1 ms 以内であること。平均は、位相を 0 から R まで均等に掃引した tick 列で取る
  - 時間軸の映像の表示の遅れが提示遅延未満のときは、書き込みの次の vsync より前に表示できないため 1 tick 遅れることを許容し、フレームを捨てないこと (docs に明記する)
  - 1 tick に 1 枚だけ出し、同じフレームを 2 回出さないこと
  - `presentationLatencyTicks` が 1 のとき、書き込み tick W に対して W + R が推定表示時刻 D になること
  - 目標を過ぎたフレームを原則として遅れて提示せず、`recordLateDrop` に記録して捨てること。目標に合うフレームが無く遅れが 20 ms 以内のときだけ 1 枚を遅れて提示し、`drawLate` を返すこと
  - `presentationMs === null` のフレームを 1 tick 1 枚で出すこと
  - `present` が false を返したフレームの実績を `recordPresentation` に記録しないこと
  - 60 Hz から 120 Hz への R の変化、66.7 ms を超える tick 間隔の後の取り直し
- `PlayoutBuffer` の新しい選択 API を単体テストと PBT で固定する。描くフレームの表示時刻と目標表示時刻の差が許容幅以内であること、許容幅を超えたフレームを描かないこと、各フレームを 2 回出さないことを検証する。`MAX_PRESENTATION_LAG_MS` を削除または意味を変える場合は、関連する `buffer.test.ts` / `buffer.prop.ts` / `videoPlayoutSession.test.ts` を更新する
- 既存テストを新しい契約に合わせて更新する。少なくとも `src/playout/videoPlayoutSession.test.ts` の「1 つの表示周期ですべて出す」と「表示時刻を過ぎたフレームを出す」、`src/createMediaSubscriber.playout.test.ts` の「表示時刻を過ぎたフレームだけを書く」、`src/playout/buffer.test.ts`、`src/playout/buffer.prop.ts`、`src/playout/timeline.test.ts` (`MAX_PRESENTATION_LAG_MS` の import と A/V 同期の予算)、`src/playout/mediaPlayout.test.ts` (`VideoPlayoutOutput` の必須項目)、`tests/e2e/playoutBrowserHarness.ts`、`tests/e2e/media-playout-*.spec.ts` の `pacing` 利用、devtools の `useSubscriber` まわりのテストを更新する
- 実ブラウザ (Playwright、Chromium、モックなし) の試験を追加する
  - `MediaStreamTrackGenerator` + `<video>` + `createMediaPlayout` に合成した壁時計 TIMESTAMP のフレームを 30 fps で流す。`requestAnimationFrame` をラップして tick の時刻 W と表示周期 R を記録し、`requestVideoFrameCallback` の expectedDisplayTime と W + R (generator の推定表示時刻 D) の差の p95 が 3 ms 以下 (rAF と expectedDisplayTime の軸差を含む) で、平均の偏りが 2 ms 以下であること
  - canvas の出し先で `present` の呼び出し時刻 (= 書き込み tick W) を記録し、W が表示時刻に最も近い vsync であること、表示間隔が累積量子化の参照列と一致することを確認する。計測は `present` をラップするか、テスト用の出力を注入して行う
- 実リレー CI (secret がある環境) の長時間試験に、映像の `playoutTiming` の読み出しと記録を追加する。secret が無い環境では従来どおり skip する。映像の遅延と停止は判定に使わず、記録のみとする (判定は単体テストと実ブラウザ試験で行う)
- `AvSyncStats` の回帰がないこと。既存の実リレー A/V 同期試験 (`tests/e2e/relay/audio-timestamp.spec.ts` など) が通り、`skewMs` が既存の許容内であること。音声の欠落、鳴り始めの遅れ、`missedFrames` / `gapMs` に回帰がないこと
- `vp check`、`tsc --noEmit`、`vp test run`、Playwright の chromium / relay が通る
- `devtools/src/utils/playoutTimingStats.ts` の `lateFramesDropped`、`devtools/src/components/statsHelp.ts` の説明、`devtools/src/utils/stallAnalysis.ts` の `lateDropped` の意味を新しい選択規則 (表示時刻を過ぎたフレームと、同じ表示周期に重なって提示しなかったフレームを含む) に合わせて更新する
- `docs/MEDIA_PLAYOUT.md` (pacing の削除、`presentationLatencyTicks`、選択規則、TIMESTAMP の記述の修正)、`docs/HIGH_LEVEL_API.md` (`AvSyncStats` の映像側の基準)、`docs/ARCHITECTURE.md` (pacing の記述の削除)、該当コードのコメントが実装と一致している
