# devtools の keyframeInterval に値域検証がなく 0 でキーフレームを要求しなくなる

- Created: 2026-09-23
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-devtools-keyframe-interval-range
- Polished: 2026-09-23

## 目的

`src/createMediaPublisher.ts` の `resolveKeyframeInterval` は 0655 で値域検証を入れるが、devtools はこの関数を通らず、独自の signal と剰余で同じ判定を行う。moqt-devtools はクエリパラメータ `keyframeInterval` を `Number.parseInt` の結果に対する `!Number.isNaN` だけで復元するため、`?keyframeInterval=0` で 0 が、`?keyframeInterval=-5` で負値が signal に入る。判定側に値域の検証が無いため、0 では `framesEncoded % 0` が NaN になり、先頭フレームを含めてキーフレームの要求が一度も出なくなる。`devtools/src/hooks/usePublisher.ts` の `shouldRequestKeyFrame` の JSDoc も「要求が一度も出ないと購読を開始できない」としており、購読側が復号を始められない状態になる。

## 現状

- `devtools/src/hooks/usePublisher.ts` の `shouldRequestKeyFrame` は `framesEncoded % keyframeInterval === 0` を返す。値域の検証は無い
- `devtools/src/webcodecs-devtools/signals.ts` は `encoderStats.value.frameCount % keyframeInterval.value === 0` をインラインで書く。`shouldRequestKeyFrame` を使っていない
- `devtools/src/hooks/usePublisher.ts` は `pub.keyframeInterval.value` を、`devtools/src/webcodecs-devtools/signals.ts` は同じファイルの signal を読む。実体は別の signal で、既定値 3600 は `devtools/src/signals/connectionSettings.ts` と `devtools/src/signals/publisher.ts` と `devtools/src/webcodecs-devtools/signals.ts` の 3 箇所にある
- `devtools/src/components/ConnectionSettings.tsx` と `devtools/src/webcodecs-devtools/components/ConfigPanel.tsx` の `keyframeInterval` は `<select>` である。選択肢は前者が 30 / 60 / 120 / 240 / 300 / 900 / 1800 / 2700 / 3600 / 7200、後者が 30 / 60 / 90 / 120 で、いずれも 1 以上の整数である。`Number(e.currentTarget.value)` はこの選択値にのみ適用されるため、UI から無効値は入らない
- 前者の選択肢は `ConnectionSettings.tsx` に直書きされており、`AUDIO_BITRATES` / `AUDIO_SAMPLE_RATES` / `AUDIO_CHANNELS` のように `devtools/src/signals/connectionSettings.ts` の定数から生成していない。URL の検証と select が同じ定数を参照する形になっていない
- `devtools/src/signals/connectionSettings.ts` の `initFromUrl` はクエリパラメータ `keyframeInterval` を `Number.parseInt` で復元し、`if (!Number.isNaN(parsed))` だけを確認する。`?keyframeInterval=0` は `"0"` が truthy で `Number.isNaN(0)` が false のため 0 のまま入り、負値も入る。`"1.5"` は 1 に切り捨てられて整数として入り、`"30abc"` も 30 として入る
- 同ファイルの `initAudioSettingsFromUrl` は数値の音声設定 (`audioBitrate` / `audioSampleRate` / `audioChannels`) にも許可リスト (`AUDIO_BITRATES` / `AUDIO_SAMPLE_RATES` / `AUDIO_CHANNELS`) を使う。理由は同ファイルのコメントに「選択肢に無い値を URL が受理すると、select の表示が空になって表示と実際の設定が食い違う」と書かれている
- `initFromUrl` を呼ぶのは `devtools/src/main.tsx` (moqt-devtools) だけである。`devtools/src/webcodecs-devtools/main.tsx` は呼ばないため、webcodecs-devtools の signal に無効値が入る経路は無い
- `devtools/src/hooks/usePublisher.test.ts` には境界値のテスト (先頭フレーム、間隔、2*間隔、間隔±1、2*間隔-1、間隔 1) があるが、無効値 (0 / 負値 / 非整数 / NaN / Infinity) のテストは無い
- `src/createMediaPublisher.ts` の `shouldSendKeyFrame` は export 済みで、`src/index.ts` の公開 API には含まれない。devtools は同じファイルから `allocateAudioObject` などを既に import している
- 0655 はライブラリの `resolveKeyframeInterval` だけを対象とし、devtools の同型 2 箇所は `resolveKeyframeInterval` を通らないため対象外としている

## 設計方針

- 判定に渡す値の規則は 0655 と同じ「1 以上の整数」に揃える。URL からの復元は音声設定と同じく選択肢の許可リストで検証する
- devtools 内の共有モジュール `devtools/src/utils/keyframeInterval.ts` を新設し、剰余・値域・既定値の扱いを 1 箇所に寄せる
  - `DEFAULT_KEYFRAME_INTERVAL = 3600` を持つ。`devtools/src/signals/connectionSettings.ts` / `devtools/src/signals/publisher.ts` / `devtools/src/webcodecs-devtools/signals.ts` の signal の初期値もこの定数を参照し、既定値の定義を 1 箇所にする
  - `KEYFRAME_INTERVAL_OPTIONS = [30, 60, 120, 240, 300, 900, 1800, 2700, 3600, 7200]` を持つ。moqt-devtools の `<select>` の選択肢であり、`ConnectionSettings.tsx` はこの定数から `option` を生成する。既存のラベルは値の 1/30 秒表記 (30 が `1 sec`、7200 が `240 sec`) なので `value / 30` で生成すると既存の表示が保たれる
  - `parseKeyframeIntervalParam(raw: string | null): number | null` がクエリ文字列を検証し、10 進表記の整数で `KEYFRAME_INTERVAL_OPTIONS` に含まれるときだけその値を返し、それ以外は null を返す。`Number.parseInt` の結果を検証するだけでは `"1.5"` が 1 として受理されるため、生の文字列で判定する
  - `shouldRequestKeyFrame(framesEncoded: number, keyframeInterval: number): boolean` が無効値を `DEFAULT_KEYFRAME_INTERVAL` に正規化してから `src/createMediaPublisher.ts` の `shouldSendKeyFrame` に委譲する。無効値でも throw しない (throw すると `devtools/src/hooks/usePublisher.ts` の `processFrames` の try-catch が配信ループごと抜けてしまう)
- `devtools/src/hooks/usePublisher.ts` の `shouldRequestKeyFrame` の定義を削除し、共有モジュールの同名関数を使う。`devtools/src/webcodecs-devtools/signals.ts` のインライン剰余も共有モジュールの関数に置き換える。剰余の実装は `shouldSendKeyFrame` の 1 箇所だけになる
- `devtools/src/signals/connectionSettings.ts` の `initFromUrl` は `parseKeyframeIntervalParam` を使い、null のときは signal に代入しない。代入しないことで初期値がそのまま残る
- 選択肢に無い正の整数 (`?keyframeInterval=7`) は受理しない。`initAudioSettingsFromUrl` が数値の選択式設定にも許可リストを使っている理由 (select の表示と実際の設定の食い違いを避ける) と同じ規則に揃える
- webcodecs-devtools は `initFromUrl` を呼ばず、`<select>` の選択肢も 30 / 60 / 90 / 120 と異なるため `ConfigPanel.tsx` は変更しない。共有するのは判定と既定値だけとする
- `devtools/src/hooks/usePublisher.test.ts` の既存の `shouldRequestKeyFrame` の境界値テストは、`shouldRequestKeyFrame` の定義が共有モジュールへ移るため `devtools/src/utils/keyframeInterval.test.ts` へ移す。`usePublisher.test.ts` は `DEFAULT_KEYFRAME_INTERVAL` を共有モジュールから import して残りの用途に使う
- `CHANGES.md` の `## develop` の先頭に `[FIX]` を追記する (0655 と同じ)

## 完了条件

- `?keyframeInterval=0` / `-5` / `1.5` / `30abc` / `abc` / 空文字 / 選択肢に無い `7` では signal の値が初期値のまま変わらない
- `?keyframeInterval=30` / `60` / `7200` はその値になる
- `shouldRequestKeyFrame` は 0 / 負値 / 非整数 / NaN / Infinity / -Infinity を渡されても `% 0` の NaN にならず、既定値 3600 として判定する
- `shouldRequestKeyFrame` は 1 と 3600 で境界 (先頭フレーム、間隔、2*間隔、間隔±1、2*間隔-1) が従来どおりになる
- 剰余の実装が devtools に重複して存在しない (ライブラリの `shouldSendKeyFrame` を共有モジュールから使う)
- `ConnectionSettings.tsx` の `<select>` の選択肢と `parseKeyframeIntervalParam` が受理する値が `KEYFRAME_INTERVAL_OPTIONS` の 1 箇所で一致する
- 既定値 3600 が `DEFAULT_KEYFRAME_INTERVAL` の 1 箇所になり、3 つの signal の初期値が同定数を参照する
- `devtools/src/utils/keyframeInterval.test.ts` に `parseKeyframeIntervalParam` の受理・拒否と `shouldRequestKeyFrame` の無効値・境界値のテストが入る (`usePublisher.test.ts` の境界値テストは同ファイルへ移し、`usePublisher.test.ts` からは削除する)
- `CHANGES.md` の `## develop` の先頭に `[FIX]` が入る
- `npx vp check` / `npx vp test --run` / `npx vp run e2e-test` が通る

## 参照

- 0655 (ライブラリ側 `resolveKeyframeInterval` の値域検証。devtools の同型 2 箇所は対象外とされている)
- `devtools/src/utils/keyframeInterval.ts` (新設) / `devtools/src/signals/connectionSettings.ts` の `initFromUrl` と `initAudioSettingsFromUrl` (許可リストの先例) / `devtools/src/hooks/usePublisher.ts` の `shouldRequestKeyFrame` / `devtools/src/webcodecs-devtools/signals.ts` / `src/createMediaPublisher.ts` の `shouldSendKeyFrame`
- `devtools/src/hooks/usePublisher.test.ts` の `shouldRequestKeyFrame` の既存テスト (移設元)

## 解決方法

{未着手}
