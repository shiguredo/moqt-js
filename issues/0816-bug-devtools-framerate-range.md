# devtools の framerate と bitrate が URL から値域と選択肢の検証なく復元される

- Created: 2026-09-30
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-devtools-framerate-bitrate-range
- Polished: 2026-10-03
- Reporter: @voluntas

## 目的

moqt-devtools の Frame Rate は `<select>` (60 / 30 / 15)、Bitrate は `<select>` (16 Mbps / 8 Mbps / 4 Mbps / 2 Mbps / 1 Mbps / 500 Kbps) であるため画面からは無効値が入らないが、`initFromUrl` はクエリパラメータ `framerate` と `bitrate` を `Number.parseInt` の結果に対する `!Number.isNaN` だけで復元する。`?framerate=0` で 0 が、`?framerate=-5` で負値が signal に入り、select が空表示になって表示と実際の設定が食い違う。0 は `getUserMedia` の `frameRate: { ideal: 0 }` とエンコーダーの `framerate` にも渡る。`?bitrate=0` でも同様に 0 が signal に入り、select が空表示になってエンコーダーの `bitrate` にも 0 が渡る。

## 現状

- `devtools/src/signals/connectionSettings.ts` の `framerate` と `bitrate` は、`<select>` の 60 / 30 / 15 と 16000000 / 8000000 / 4000000 / 2000000 / 1000000 / 500000 に対応する選択肢の定数を持たない
- 同じファイルの `initFromUrl` は `framerate` と `bitrate` を `Number.parseInt` と `!Number.isNaN` だけで復元する。`keyframeInterval` は `resolveOptionNumber` と `KEYFRAME_INTERVAL_OPTIONS` の許可リストで、音声の数値設定 (`audioBitrate` / `audioSampleRate` / `audioChannels`) も許可リスト (AUDIO_BITRATES など) で検証しており、framerate と bitrate だけが許可リストを持たない
- `devtools/src/components/ConnectionSettings.tsx` の Frame Rate の select は 60 / 30 / 15 を、Bitrate の select は 16000000 / 8000000 / 4000000 / 2000000 / 1000000 / 500000 を直書きする
- `devtools/src/hooks/usePublisher.ts` の `getVideoStream` はカメラのとき `frameRate: { ideal: framerate }` に、`startVideoPublishing` は `getEncoderConfig` を経て framerate と bitrate をそのままエンコーダーの設定 (`VideoEncoderConfig`) に渡す
- 実測 (2026-09-30、Chromium の headless): `VideoEncoder.configure` は `framerate` が 0 / -1 / -0.5 でも成功し、`NaN` / `Infinity` は TypeError で throw する
- `initFromUrl` を呼ぶのは `devtools/src/main.tsx` (moqt-devtools) だけである。`devtools/src/webcodecs-devtools` は URL から設定を復元しないため、同じ 60 / 30 / 15 や 6 択の Bitrate の select でも無効値が入る経路は無く、変更の対象外とする (0676 と同じ扱い)
- ライブラリ側の同じ値域は 0815 で扱う (0815 は devtools の URL 復元の検証を別 issue としている)

## 設計方針

- `framerate` の選択肢を `FRAMERATES` (60 / 30 / 15)、`bitrate` の選択肢を `BITRATES` (16000000 / 8000000 / 4000000 / 2000000 / 1000000 / 500000) として `devtools/src/signals/connectionSettings.ts` に置き、`initFromUrl` は他の数値設定と同じ `resolveOptionNumber` で検証する
- `devtools/src/components/ConnectionSettings.tsx` の Frame Rate と Bitrate の select はこの定数から option を生成し、URL の検証と画面の選択肢が同じ定数を参照する形にする (`keyframeInterval` と同じ規則。表示名は既存の "60 fps" / "16 Mbps" などから変えない)
- 選択肢に無い値 (0 / 負値 / 非整数 / 選択肢外の正の整数) は復元しない (現在の値のまま残す)
- 空文字 (`framerate=` / `bitrate=`) は未指定として signal に代入しない。`framerate` / `bitrate` の signal は null を持てないため、`resolveOptionNumber` の null をそのまま代入すると型が合わない (`keyframeInterval` と同じ扱い)
- `usePublisher.ts` の `startPublishing` が配信側の signal へ写す経路は変更しない

## 完了条件

- `?framerate=0` / `?framerate=-5` / `?framerate=1.5` / `?framerate=45` / `?framerate=` で signal が変わらず、select が空表示にならないこと
- `?framerate=60` などの選択肢の値は復元されること
- `?bitrate=0` / `?bitrate=-5` / `?bitrate=1.5` / `?bitrate=3000000` / `?bitrate=` で signal が変わらず、select が空表示にならないこと
- `?bitrate=2000000` などの選択肢の値は復元されること
- `vp check` / `tsc --noEmit` / `vp test run` が通ること
