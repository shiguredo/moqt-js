# devtools の keyframeInterval に値域検証がなく 0 でキーフレームを要求しなくなる

- Created: 2026-09-23
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-devtools-keyframe-interval-range
- Polished: {YYYY-MM-DD}

## 目的

`src/createMediaPublisher.ts` の `resolveKeyframeInterval` は 0655 で値域検証を入れるが、devtools はこの関数を通らず、独自の signal と剰余で同じ判定を行う。`keyframeInterval` に 0 が入ると `framesEncoded % 0` が NaN になり、キーフレームを一度も要求しなくなる。負値・非整数・NaN・Infinity も意図しない判定になる。devtools は相互運用を実測する道具であり、キーフレームが一度も出ない状態では映像の復号を確認できない。

## 現状

- `devtools/src/hooks/usePublisher.ts` の `shouldRequestKeyFrame` は `framesEncoded % keyframeInterval === 0` を返す。値域の検証は無い
- `devtools/src/webcodecs-devtools/signals.ts` は `encoderStats.value.frameCount % keyframeInterval.value === 0` をインラインで書く。`usePublisher.ts` の `shouldRequestKeyFrame` を使っていない
- `devtools/src/hooks/usePublisher.ts` は `pub.keyframeInterval.value` を、`devtools/src/webcodecs-devtools/signals.ts` は同じファイルの signal を読む。実体は別の signal で、既定値はどちらも 3600
- `devtools/src/components/ConnectionSettings.tsx` と `devtools/src/webcodecs-devtools/components/ConfigPanel.tsx` の数値入力は `Number(e.currentTarget.value)` を代入する。入力欄を空にすると `Number("")` が 0 になり、`1.5` で非整数、`-5` で負値が入る
- `devtools/src/signals/connectionSettings.ts` の `initFromUrl` はクエリパラメータ `keyframeInterval` を `Number.parseInt` で復元し、`if (parsed)` で 0 と NaN を弾く。負値と小数点以下は素通りする
- `devtools/src/hooks/usePublisher.test.ts` に `shouldRequestKeyFrame` の値域と境界値のテストは無い
- 0655 はライブラリの `resolveKeyframeInterval` だけを対象とし、devtools の同型 2 箇所は `resolveKeyframeInterval` を通らないため対象外としている

## 設計方針

- devtools の入力経路で無効値を拒否する。規則は 0655 と同じ「1 以上の整数」に揃える
- 判定を 1 箇所に寄せる。`devtools/src/webcodecs-devtools/signals.ts` のインライン剰余も `shouldRequestKeyFrame` 相当の純関数に置き換える。signal の実体が 2 つあるため、値域の検証と剰余を devtools 内の共有モジュールに置き、両方から使う
- 入力欄の `onChange` で無効値を弾く。空入力は直前の値を維持する。無効値のときにキーフレーム要求が止まらないことを優先し、入力値そのものは変えない
- クエリパラメータからの復元も同じ規則で検証し、無効値は既定値 3600 にフォールバックする。`if (parsed)` だけでは負値と小数点以下を弾けないため、整数かつ 1 以上を明示的に確認する
- ライブラリ側の 0655 と規則を揃え、判定の実装は二重管理にしない
- `CHANGES.md` の `## develop` に `[FIX]` を追記する

## 完了条件

- `keyframeInterval` が 0 / 負値 / 非整数 / NaN / Infinity のとき、キーフレーム要求の判定が無効値にならず、拒否されるか既定値へフォールバックする
- 入力欄を空にしてもキーフレーム要求が停止しない
- クエリパラメータ由来の負値と小数点以下が既定値になる
- `devtools/src/hooks/usePublisher.test.ts` に `shouldRequestKeyFrame` の値域と境界値 (1・2・3600・0・負値・非整数・NaN) のテストが追加される
- `CHANGES.md` の `## develop` に `[FIX]` が入る
- `npx vp check` / `npx vp test --run` / `npx vp run e2e-test` が通る

## 参照

- 0655 (ライブラリ側 `resolveKeyframeInterval` の値域検証。devtools の同型 2 箇所は対象外とされている)
- `devtools/src/hooks/usePublisher.ts` の `shouldRequestKeyFrame` / `devtools/src/webcodecs-devtools/signals.ts` / `devtools/src/signals/connectionSettings.ts` の `initFromUrl`

## 解決方法

{未着手}
