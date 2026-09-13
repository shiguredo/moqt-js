# codec ラッパーと Worker の重複を除去する

- Created: 2026-09-06
- Completed: 2026-09-14
- Branch: feature/refactor-codec-wrapper-dedup
- Polished: YYYY-MM-DD

## 目的

同型ロジックが 8 箇所に分散し、1 件の修正が複数箇所保守になる。共通化する必要がある。

## 現状

- 4 ラッパー (`src/codec/` の両 Encoder / 両 Decoder) の `configureWorker` / `configureDirect` / `state` / `close` が骨格同一である。
- 4 Worker の `init` / `encode` / `decode` / `close` 分岐が重複する。
- 再 `configure` で旧 Worker を破棄しない (Decoder の `reset` は破棄する非対称)。
- 未設定時の `console.warn` 6 件が `callbacks.error` と二重化する。
- `default` フォールバックが型網羅を隠す。

## 設計方針

1. 共通ベースまたはヘルパーに寄せる (ラッパー側と Worker 側)。
2. 再 `configure` 時の破棄、`console.warn` の一本化、網羅 `switch` 化を合わせる。

## 完了条件

- 重複が除去され、既存テストと挙動が保たれること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 解決方法

4 ラッパーと 4 Worker の重複を共有モジュールへ集約し、直接実行モードの再 configure で旧コーデックを破棄するようにした。あわせて 0495 で追加した実ブラウザ e2e テストに再 configure の検証を追加した。

### ラッパー側

`configureWrapperWorker` (`src/codec/workerConfigure.ts`) を新設し、4 ラッパーで一字一句同一だった Worker 初期化フローを集約した。

- 世代採番 (待機前) → Worker モジュール読み込み → 世代確認 → Worker 生成 → `{type: "init", config}` 送信
- 二重解決ガード (`WorkerConfigureGate`) と、初期化完了前 `"error"` の reject / 完了後 `"error"` の通知
- 最新世代は旧公開 Worker を破棄して公開 (後勝ち)、旧世代の遅延成功は自世代を破棄して reject (先発破棄)

データ応答 (`"encoded"` / `"decoded"` / `"skipped"`) はラッパーごとに異なるため `handleWorkerData` へ委譲し、`dataTypes` に列挙した `type` だけを委譲する (契約外の応答は無視する)。各ラッパーの `configureWorker` は 12 行程度になった。

### Worker 側

- メッセージ型の正本を `src/codec/workerMessages.ts` に置き、4 Worker と 4 ラッパーが同じ型を参照する。`switch` の `default` は `never` を取る `ignoreUnknownWorkerRequest` / `ignoreUnknownWorkerResponse` を呼び、`case` の追加漏れを `tsc --noEmit` で検出する
- `src/codec/codecLifecycle.ts` に `isCodecConfigured` / `closeCodecQuiet` / `replaceCodec` / `codecStateLabel` / `warnCodecNotConfigured` を置き、4 Worker の init (旧コーデックの破棄)・encode / decode (state ガード)・close の後始末を共通化した
- 実行時エラーの応答生成を `workerErrorResponse` に集約した (`toFailureMessage` 経由で非空 string を保証)

### 再 configure 時の破棄

`replaceCodec(previous, next)` が `previous` を `closeCodecQuiet` で閉じてから `next` を返す。従来の `configureDirect` は無条件に差し替えており、直接実行モードで再 configure すると旧コーデックが解放されずに残っていた (Worker モードは旧 Worker を破棄していたため非対称)。4 ラッパーすべてで解消した。`closeCodecQuiet` は `state !== "closed"` を確認してから閉じるため、エラーで既に閉じたコーデックへの二重 close による InvalidStateError も起きない。

### 現状認識の訂正

- 未設定時の `console.warn` は 6 件ではなく 5 件 (`not configured` 4 件 + `cannot reset without config` 1 件) で、いずれも `callbacks.error` を呼んでおらず二重化していなかった。文言を `warnCodecNotConfigured` に集約し、「未設定時は warn のみで error コールバックは呼ばない」契約をコメントで明示した (挙動は変えない)
- 「再 configure で旧 Worker を破棄しない」は Worker モードでは既に破棄しており、直接実行モードの話だった (上記のとおり修正)
- 「`default` フォールバックが型網羅を隠す」は Worker の `switch` に `default` が無い状態だったため、`never` 型の網羅性検査を追加した

### デコーダーの `state`

`VideoDecoderWrapper` / `AudioDecoderWrapper` に `state` ゲッターを追加した (`codecStateLabel` 経由)。エンコーダーとの非対称を解消する。ラッパーは内部型のため公開 API の変更ではない。

### 検証

- `vp test run`: 98 ファイル / 2,177 テスト全通過 (ライブラリのテストは未変更)
- `npx playwright test`: 16 件全通過。うち 2 件は今回追加した再 configure テスト (直接モード / Worker モード) で、解像度を変えて configure() を 2 回呼び、chunk 出力が継続し error が発生しないことを確認する
- `vp check` / `tsc --noEmit` 通過、`npx tsc -p devtools/tsconfig.json --noEmit` は既存の 11 件のまま
- 行数: ラッパー 4 ファイルは 893 → 736 行 (-157)、Worker 4 ファイルは 419 → 370 行 (-49)、共有モジュールは `codecLifecycle.ts` 92 行 + `workerMessages.ts` 161 行 + `workerConfigure.ts` の +158 行。重複は消えたが共有側に型と doc を持つため総量は増えている
- `CHANGES.md` の `## develop` の `### misc` に `[UPDATE]` を追加した
