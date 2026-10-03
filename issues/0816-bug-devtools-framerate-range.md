# devtools の framerate が URL から値域と選択肢の検証なく復元される

- Created: 2026-09-30
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-devtools-framerate-range
- Polished: {YYYY-MM-DD}
- Reporter: @voluntas

## 目的

moqt-devtools の Frame Rate は `<select>` (60 / 30 / 15) であるため画面からは無効値が入らないが、`initFromUrl` はクエリパラメータ `framerate` を `Number.parseInt` の結果に対する `!Number.isNaN` だけで復元する。`?framerate=0` で 0 が、`?framerate=-5` で負値が signal に入り、select が空表示になって表示と実際の設定が食い違う。0 は `getUserMedia` の `frameRate: { ideal: 0 }` とエンコーダーの `framerate` にも渡る。

## 現状

- `devtools/src/signals/connectionSettings.ts` の `framerate` は、`<select>` の 60 / 30 / 15 に対応する選択肢の定数を持たない
- 同じファイルの `initFromUrl` は `framerate` を `Number.parseInt` と `!Number.isNaN` だけで復元する。`keyframeInterval` は `resolveOptionNumber` と `KEYFRAME_INTERVAL_OPTIONS` の許可リストで、音声の数値設定 (`audioBitrate` / `audioSampleRate` / `audioChannels`) も許可リスト (AUDIO_BITRATES など) で検証しており、framerate だけが許可リストを持たない
- `devtools/src/components/ConnectionSettings.tsx` の Frame Rate の select は 60 / 30 / 15 を直書きする
- `devtools/src/hooks/usePublisher.ts` の `getVideoStream` は `frameRate: { ideal: framerate }` に、エンコーダーの configure は framerate にそのまま渡す
- 実測 (2026-09-30、Chromium の headless): `VideoEncoder.configure` は `framerate` が 0 / -1 / -0.5 でも成功し、`NaN` / `Infinity` は TypeError で throw する
- ライブラリ側の同じ値域は別 issue で扱う

## 設計方針

- `framerate` の選択肢を `FRAMERATES` (60 / 30 / 15) として `devtools/src/signals/connectionSettings.ts` に置き、`initFromUrl` は他の数値設定と同じ `resolveOptionNumber` で検証する
- `devtools/src/components/ConnectionSettings.tsx` の select はこの定数から option を生成し、URL の検証と画面の選択肢が同じ定数を参照する形にする (`keyframeInterval` と同じ規則)
- 選択肢に無い値 (0 / 負値 / 非整数 / 選択肢外の正の整数) は復元しない (現在の値のまま残す)
- `usePublisher.ts` の `startPublishing` が配信側の signal へ写す経路は変更しない

## 完了条件

- `?framerate=0` / `?framerate=-5` / `?framerate=1.5` / `?framerate=45` で signal が変わらず、select が空表示にならないこと
- `?framerate=60` などの選択肢の値は復元されること
- `vp check` / `tsc --noEmit` / `vp test run` が通ること
