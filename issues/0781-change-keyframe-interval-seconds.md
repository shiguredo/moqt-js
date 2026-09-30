# keyframeInterval の単位を frames から秒に変更する

- Created: 2026-09-30
- Completed: {YYYY-MM-DD}
- Branch: feature/change-keyframe-interval-seconds
- Polished: {YYYY-MM-DD}
- Reporter: @voluntas

## 目的

キーフレーム間隔をフレーム数で指定しているため、framerate を変えると実際の間隔が変わる。moqt-devtools の Keyframe Interval は値がフレーム数で、画面のラベルだけを既定 framerate (30) で割った秒数にしているため、Frame Rate を 60 fps にすると「10 sec」(300 フレーム) が実際には約 5 秒になり、画面の表示と実際の間隔が食い違う。指定した秒数の間隔でキーフレームを送れるようにする。

## 現状

- `src/createMediaPublisher.ts` の `shouldSendKeyFrame` はフレーム番号の剰余 (`frameCount % keyframeInterval === 0`) で判定する。`MediaPublisherImpl` は encode のたびに `videoFrameCount` を加算し、`requestKeyframe()` で 0 に戻す
- `src/createMediaPublisher.ts` の `resolveKeyframeInterval` は `keyframeInterval` を 1 以上の整数 (フレーム数) として検証し、未指定時は `Math.round(framerate * 2)` を使う
- `devtools/src/signals/connectionSettings.ts` の `keyframeInterval` は 300 (30 fps の 10 秒ぶん)、`devtools/src/signals/publisher.ts` は 60 (2 秒ぶん) を持つ
- `devtools/src/components/ConnectionSettings.tsx` の select は `KEYFRAME_INTERVAL_OPTIONS` (frames) から option を生成し、ラベルを `frames / DEFAULT_VIDEO_FRAMERATE` (30 固定) の秒数にする
- `devtools/src/hooks/usePublisher.ts` の `decideKeyFrame` は符号化したフレーム数で間隔を数え、`devtools/src/utils/keyframeInterval.ts` の `shouldRequestKeyFrame` が剰余で判定する
- `devtools/src/webcodecs-devtools/signals.ts` も同じくフレーム数で判定し、ConfigPanel の選択肢は 30 / 60 / 90 / 120 フレームである。この既定値 (3600 フレーム) は選択肢に無く、開いた直後の select が空表示になる
- 実測 (2026-09-30、ローカルの sora-moq-local と moqt-devtools、ダミー映像 1280x720、VP9、keyframeInterval 300): 60 fps では keyframe の間隔が 4865 / 5061 / 5059 / 5055 / 4856 ms になり、30 fps では 9948 / 9949 / 10160 ms になった

## 設計方針

- キーフレーム間隔の単位を秒に統一する。0 より大きい有限数を受理し、既定は 2 秒 (従来の framerate 30 の 2 秒ぶんと同じ) にする
- 判定をフレーム数からフレームの timestamp の差に変える。直前のキーフレームの timestamp (マイクロ秒) を記録し、経過時間が間隔以上ならキーフレームにする。先頭フレームと timestamp が巻き戻ったフレーム (映像の入力が差し替わった) もキーフレームにする
- `requestKeyframe()` は記録を null に戻す。破棄したフレームでは記録を更新しない (要求が次に encode するフレームへ移る現在の性質を維持する)
- moqt-devtools の signal・select の値とラベル・URL クエリを秒にする。選択肢は現行の表示と同じ秒数 (1 / 2 / 4 / 8 / 10 / 30 / 60 / 90 / 120 / 240) にする
- webcodecs-devtools の signal と選択肢も秒にし、既定値 (2 秒) を選択肢に含めて select が空表示になる不一致を解消する
- `keyframeInterval` は公開オプションのため後方互換はない。CHANGES.md に `[CHANGE]` として記載する

## 完了条件

- `keyframeInterval` が秒として扱われ、framerate を変えても指定した秒数の間隔でキーフレームが送られること
- moqt-devtools の Keyframe Interval の選択肢とラベルが秒で一致し、Frame Rate 60 fps でも「10 sec」が約 10 秒になること
- `vp check` / `tsc --noEmit` / `vp test run` / Playwright の e2e が通ること
