# codec/config.ts の設定生成関数にテストを追加する

- Priority: Medium
- Created: 2026-06-04
- Model: qwen3.7-plus
- Branch: feature/add-codec-config-tests
- Polished: 2026-06-04

## 目的

`src/codec/config.ts` のコーデック設定生成関数 (純粋関数) に対する単体テストを追加し、コーデック文字列のマッピングミスを検出できるようにする。

## 優先度根拠

`getVideoEncoderConfig` / `getVideoDecoderConfig` / `getAudioEncoderConfig` / `getAudioDecoderConfig` は WebCodecs に渡す codec 文字列 (例: `"vp09.00.10.08"`, `"av01.0.04M.08"`, `"avc1.42001f"`) を決定する純粋関数だが、直接の単体テストがない。codec 文字列を 1 文字でも誤ると WebCodecs の初期化が失敗するが、現状は E2E でしか検出できず発見が遅れる。純粋関数で容易にテストできるため Medium で対応する。

## 現状

`src/codec/config.ts` に以下の純粋関数があるが、`src/codec/config.test.ts` は存在しない。

- `getVideoEncoderConfig(codec, width, height, bitrate, framerate)` -> `VideoEncoderConfig`
- `getVideoDecoderConfig(codec, width, height, description?)` -> `VideoDecoderConfig`
- `getAudioEncoderConfig(codec, bitrate, sampleRate?, channels?)` -> `AudioEncoderConfig`
- `getAudioDecoderConfig(codec, sampleRate?, channels?)` -> `AudioDecoderConfig`

同ファイルの `isVideoEncoderSupported` 等 4 つの `isXxxSupported` 関数は WebCodecs のグローバル (`VideoEncoder.isConfigSupported` 等) に依存し純粋関数ではないため、モック禁止制約下では単体テスト対象外とする (E2E / 手動確認の対象)。

## 設計方針

`src/codec/config.test.ts` を新規作成し、4 つの設定生成関数について次を検証する。

### codec 文字列マッピング (実装から)

| 関数 | 入力 codec | 期待される `codec` 文字列 | 追加フィールド |
| --- | --- | --- | --- |
| getVideoEncoderConfig | `vp8` | `vp8` | - |
| getVideoEncoderConfig | `vp9` | `vp09.00.10.08` | - |
| getVideoEncoderConfig | `av1` | `av01.0.04M.08` | - |
| getVideoEncoderConfig | `h264` | `avc1.42001f` | `avc: { format: "annexb" }` |
| getVideoEncoderConfig | `h265` | `hvc1.1.6.L93.B0` | `hevc: { format: "annexb" }` |
| getAudioEncoderConfig | `opus` | `opus` | - |
| getAudioEncoderConfig | `aac` | `mp4a.40.2` | - |

`getVideoDecoderConfig` / `getAudioDecoderConfig` も同じ codec 文字列マッピングを検証する。

### その他の検証項目

- `width` / `height` / `bitrate` / `framerate` が引数の値どおりに反映される (Video Encoder)
- `getVideoDecoderConfig` が `codedWidth` / `codedHeight` に `width` / `height` を設定し、`description` を透過する
- デフォルト引数: `getAudioEncoderConfig` / `getAudioDecoderConfig` の `sampleRate` 既定値 `48000` (`DEFAULT_AUDIO_SAMPLE_RATE`)、`channels` 既定値 `2` (`DEFAULT_AUDIO_CHANNELS`) が適用される
- フォールバック: 未知の codec を渡した場合に Video は `vp8`、Audio は `opus` の設定が返る (default 分岐)

## 変更対象ファイル

- `src/codec/config.test.ts`: 新規作成
- 機能変更がないため `CHANGES.md` への追記は不要 (テスト追加のみ)

## テスト方針

- Vitest の test / assert (Chai API) を使用する。Jest API (it / describe / expect) は使わない
- テストメッセージは日本語で書く
- モックやスタブは利用しない
- codec ごとの固定マッピングは列挙して検証する。`width` / `height` 等の数値透過は PBT (`config.prop.ts`) でも表現できるが、本 issue では列挙テストで十分とする

## 完了条件

- 各コーデック (vp8 / vp9 / av1 / h264 / h265 / opus / aac) の設定生成と default フォールバックがテストされている
- デフォルト引数の適用がテストされている
- すべてのテストが PASS する
