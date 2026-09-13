# codec Wrapper と Worker プロトコルをテストする

- Created: 2026-09-06
- Completed: 2026-09-14
- Branch: feature/add-codec-protocol-tests
- Polished: YYYY-MM-DD

## 目的

Wrapper の状態遷移と Worker メッセージ対応が未テストで、初期化ハング等の経路を検出できない。契約をテストまたは文書化する必要がある。

## 現状

- `src/codec/` のテストは `config.test.ts` (codec 文字列マッピング) のみである。
- `configured` フラグと実 `encoder.state` の二重管理、Worker 型 (`configured` / `encoded` / `decoded` / `skipped` / `error`) の送受信対応が未検証である。

## 設計方針

1. ブラウザ非依存の契約テスト (メッセージ shapes、状態遷移) を追加する。
2. 実ブラウザ実行が必要な範囲は方針 (E2E 寄せ等) を決める。

## 完了条件

- Wrapper / Worker の契約がテストまたは文書で pin されること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 解決方法

実 Chromium の WebCodecs を使った E2E テストで、4 ラッパーの状態遷移と Worker プロトコルを pin した。Node には WebCodecs が無く、モックやスタブを使わない方針のため、契約の pin は実ブラウザで行う。

### 追加したテスト

`tests/e2e/codec-wrappers.spec.ts` (11 テスト)。テストページは devtools 配下 (`devtools/codec-test.html` / `devtools/src/codec-test/`) に置き、ライブラリのソース (`../../../src/codec/*.ts`) を直接 import する。dev サーバー (port 5173) は playwright.config.ts の webServer が起動する。ビルド入力には追加していない。

- `VideoEncoderWrapper` 直接モード / Worker モード: `unconfigured` → `configured` → `unconfigured` の遷移、6 フレームで 6 chunk、`keyFrame` 指定が key chunk になること、`timestamp` の引き継ぎ、`encodeQueueSize`、close 後の無反応
- `VideoEncoderWrapper` 未設定時: configure 前と close 後の `encode()` が例外を投げず chunk も error も出さないこと (両モード)
- `VideoDecoderWrapper` 直接モード / Worker モード: キーフレーム待ちで delta を skip すること、`codedWidth` / `codedHeight`、復号ピクセル (RGBA で非ゼロ)、timestamp の引き継ぎ、`resetKeyframeWait()` の再待機 (Worker はメッセージ往復)
- `VideoDecoderWrapper` 未設定時: 実 chunk を渡しても何もしないこと (両モード)
- `AudioEncoderWrapper` 直接モード / Worker モード: 対応コーデック (opus) の選択、無音 1 秒で 20ms chunk が 50 件、状態遷移
- `AudioDecoderWrapper` 直接モード / Worker モード: encode した chunk から `AudioData` が得られること、sampleRate / numberOfFrames / timestamp の一致
- 音声ラッパー未設定時: `encode()` / `decode()` が何もしないこと (4 通り)

### テストで判明した事項 (未修正。別 issue または既存 issue の範囲)

1. `VideoDecoderWrapper` / `AudioDecoderWrapper` に `state` ゲッターが無い (エンコーダー側にはある)。デコーダーの設定状態を外から観測できないため、テストは出力件数と timestamp で契約を pin した。ラッパーは内部型のため実害は小さい。
2. 直接モードで `configure()` を繰り返すと旧コーデックが `close()` されない (`configureDirect` が無条件に差し替える。Worker 経路は旧 Worker を破棄しており非対称)。`0500` の「再 configure 時の破棄」の範囲。
3. `AudioEncoderWrapper` が `EncodedAudioChunkMetadata` を捨て、`AudioDecoderWrapper.configure` に description 引数が無いため、AAC の AudioSpecificConfig を運べない。`0605` として起票した。
4. Playwright Chromium では `AudioEncoder.isConfigSupported({ codec: "mp4a.40.2" })` が true を返すのに実際の encode は `EncodingError` になる。テストは opus を先に判定するため影響しない。`0605` に含めた。

### 検証

- `npx playwright test`: 14 件全通過 (既存 3 件 + 追加 11 件)。実 Chromium の WebCodecs と実 Worker を使用
- `vp test run`: 98 ファイル / 2,177 テスト全通過 (ライブラリのテストは未変更)
- `vp check` / `tsc --noEmit` 通過、`npx tsc -p devtools/tsconfig.json --noEmit` のエラーは既存の 11 件から増減なし
- プロダクションコード (`src/**`) は無変更
- `CHANGES.md` の `## develop` の `### misc` に `[UPDATE]` を追加した
