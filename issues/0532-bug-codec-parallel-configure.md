# codec Wrapper の並行 configure() で失敗処理が別世代の Worker を破棄し得る

- Created: 2026-09-07
- Completed: YYYY-MM-DD
- Branch: feature/fix-codec-parallel-configure
- Polished: 2026-09-08

## 目的

同一 Wrapper に `configure()` を並行発行すると、先発の失敗処理が後発の Worker を破棄し、先発の失敗 Worker がリークし得る。初期化の所有権を世代ごとに分離する必要がある。

## 現状

- 4 ラッパー（`src/codec/` の `VideoEncoderWrapper`、`VideoDecoderWrapper`、`AudioEncoderWrapper`、`AudioDecoderWrapper`）の `configureWorker` は生成した Worker を共有フィールドに格納し、失敗処理は失敗時点で共有フィールドを読み直して破棄する。
- 完了管理（`WorkerConfigureGate`）は呼び出しごとに分離済みだが、Worker ハンドルと `configured` フラグ、`onmessage` の上書き、成功時の旧 Worker 扱いは分離されておらず、所有権の対応がずれている。
- 単発の `await configure()` では発現しない。Decoder の直列 `reset()` でも発現しないが、`close()` なしの再 `configure()` は旧 Worker を破棄せず上書きする。

## 設計方針

1. 生成直後に局所変数へ捕捉し、失敗処理（`failConfigure` の破棄対象）、`onmessage` / `onerror` の設定、`postMessage` の送信先、成功時の共有フィールドへの公開手順の参照を当該世代に固定する。成功同士の並行時は先発 Worker を破棄して後勝ちとし、`encode()` / `decode()` の送り先も固定世代にする。
2. `close()`（4 者共通）と Decoder の `reset()` との所有権整理と一体の設計にする。`configure()` 待機中の `close()` / `reset()` 競合は `workerConfigure.ts` の対象外規定のまま扱わず、本 issue で中断または後勝ちの保証を定める。`0500-refactor-codec-wrapper-dedup` と同一箇所を触るため、`0532` を先行して世代分離し、`0500` の共通化で吸収する順序とする。

## 完了条件

- 並行 `configure()` でも世代の取り違えが起きないこと（失敗世代のみ破棄し、成功世代を残す。成功同士は先発を破棄して後勝ちとする）。
- 検証は `0495-test-codec-protocol-tests` の方針に従う契約テストまたはレビュー観点で確認すること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 関連

- draft なし (内部所有権の問題)
- `0500-refactor-codec-wrapper-dedup`（同一箇所の共通化。本 issue を先行し、共通化で吸収する）
- `0495-test-codec-protocol-tests`（検証方針）
