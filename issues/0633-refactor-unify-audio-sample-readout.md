# AudioData の読み出し手順を 1 箇所に寄せる

- Created: 2026-09-20
- Completed: {YYYY-MM-DD}
- Branch: feature/refactor-unify-audio-sample-readout
- Polished: {YYYY-MM-DD}

## 目的

復号した `AudioData` から第 1 チャンネルのサンプル列を読み出す手順が 2 箇所にある。

- `devtools/src/utils/audioLevel.ts` の `readAudioSamples` (可視化のレベル計算で使用)
- `devtools/src/codec-test/support.ts` の `summarizeAudioData` (codec-test ページの契約テストで使用)

どちらも `allocationSize({ planeIndex: 0, format: "f32-planar" })` + `copyTo` という同じ手順で、`readAudioSamples` のコメントにも「`summarizeAudioData` と同じ手順」と書いている。手順が増えると、片方だけ直したときに「devtools のレベル表示」と「codec-test の検証」が別の読み出しを見ることになる。

## 現状

- `devtools/src/utils/audioLevel.ts` の `readAudioSamples` はサンプル列を返すだけの薄い関数で、`AudioData` を閉じない契約を持つ
- `devtools/src/codec-test/support.ts` の `summarizeAudioData` は読み出したサンプル列から非ゼロ数などを数え、`ObservedAudioData` (codec-test の結果型) を組み立てる
- `devtools/src/codec-test/audio.ts` には `readAudioSamples` を直接使う `runAudioSamplesTest` があり、同じファイル内で 2 つの手順が併存している

## 設計方針

- `summarizeAudioData` の読み出し部分を `readAudioSamples` に置き換える (要約の組み立てだけを残す)
- `readAudioSamples` は devtools 共通のユーティリティとして `devtools/src/utils/audioLevel.ts` に残す。codec-test からは既存の相対 import で参照する
- 振る舞いを変えない。codec-test の `audioSamples` / `audioDecoder*` の結果型と値は変えない
- `AudioData` を閉じる責務は呼び出し側のままとする (現状と同じ)

## 完了条件

- `summarizeAudioData` が `readAudioSamples` を使ってサンプル列を読み出す
- 読み出し手順の記述が 1 箇所になる (`audioLevel.ts` の `readAudioSamples`)
- `npx vp check` / `npx vp test --run` / `npx vp run e2e-test` が通る (振る舞いを変えない)

## 参照

- draft-ietf-moq-loc-04 §2.3.3.2 (Audio Level: level は payload が符号化するサンプルから求める)
- RFC 6464 §3 (level は payload が符号化するサンプルの RMS で測る)

## 解決方法

{未着手}
