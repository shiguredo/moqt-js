# moqt-devtools の Codec の選択に許可リストと型ガードを追加し、型キャストをなくす

- Created: 2026-09-25
- Completed: {YYYY-MM-DD}
- Branch: feature/refactor-devtools-codec-type-guard
- Polished: 2026-09-30

## 目的

moqt-devtools の映像 Codec の選択には、音声コーデック (`AUDIO_CODECS` / `isAudioCodecType`) や映像の入力元 (`VIDEO_SOURCES` / `isVideoSourceType`) にある許可リストと型ガードが無く、`as CodecType` の型キャストで signal へ代入している。選択肢は `<option>` の直書き、URL からの読み込みは直書きの配列で、選択肢と検証が 2 か所に分かれているため、片方だけ変えると表示と実際の設定が食い違う。音声や入力元と同じく許可リストと型ガードを 1 か所に置き、URL からの読み込みも同じ許可リストで検証する形に揃える。時雨堂 TypeScript 規約は `any` を禁止しており、型キャスト自体もこの対応で不要になる。

## 現状

- `devtools/src/signals/connectionSettings.ts` の `initFromUrl` は、`codec` のクエリパラメータを `["vp8", "vp9", "av1", "h264", "h265"].includes(codecParam)` の直書き配列で検証し、`codecParam as CodecType` で代入する
- `devtools/src/components/ConnectionSettings.tsx` の Codec の `<select>` の `onChange` は `e.currentTarget.value as CodecType` で `settings.codec` へ代入する。選択肢は `<option>` の直書きである
- 音声の Audio Codec は `AUDIO_CODECS` と `isAudioCodecType` を `connectionSettings.ts` に置き、select の `onChange` と URL の読み込みの両方で使う。映像の入力元も `VIDEO_SOURCES` と `isVideoSourceType` で同じ形になっている

## 設計方針

- `devtools/src/signals/connectionSettings.ts` に `CODECS: readonly CodecType[]` と `isCodecType` を置く。`AUDIO_CODECS` / `isAudioCodecType` と同じ形にする
- `initFromUrl` は `isCodecType` で検証し、`as CodecType` をなくす
- `ConnectionSettings.tsx` の Codec の `<select>` は `onChange` で `isCodecType` を通してから代入し、`as CodecType` をなくす。選択肢は `CODECS` から生成する (表示名は今のまま VP8 / VP9 / AV1 / H.264 / H.265)
- 許可リストに無い値は今までどおり無視し、今の設定のまま残す

## 完了条件

- `devtools/src/signals/connectionSettings.ts` に `CODECS` と `isCodecType` がある
- `devtools/src/components/ConnectionSettings.tsx` の Codec の `<select>` が `CODECS` から選択肢を生成し、型キャストを使わない (`isCodecType` を通してから代入する)
- `initFromUrl` が `isCodecType` で `codec` を検証する
- `devtools/src/signals/connectionSettings.test.ts` に `isCodecType` の許可リストの判定 (許可する値と許可しない値) と URL の往復のテストがある
- `vp check` / `vp test run` / 既存の E2E (`vp run e2e-test`) が通る

## 参照

- `devtools/src/signals/connectionSettings.ts` の `initFromUrl` / `AUDIO_CODECS` / `isAudioCodecType` / `VIDEO_SOURCES` / `isVideoSourceType`
- `devtools/src/components/ConnectionSettings.tsx` の Codec の `<select>` / Audio Codec の `<select>`
- `devtools/src/types.ts` の `CodecType`
