# codec Worker の configure 失敗で Promise が永久ハングする

- Created: 2026-09-06
- Completed: YYYY-MM-DD
- Branch: feature/fix-worker-configure-hang
- Polished: 2026-09-06

## 目的

既定 (`useWorker: true`) で実行環境未対応のコーデックを選ぶと、`start()` (`createMediaPublisher` / `createMediaSubscriber` → `setupEncoders` / `setupDecoders` → Wrapper `configure()`) がタイムアウトなく停止する。Worker の初期化失敗を `configure()` の `reject` として呼び出し元に伝える必要がある。

## 現状

- 4 ラッパー (`src/codec/` の `VideoEncoder` / `VideoDecoder` / `AudioEncoder` / `AudioDecoder`) の `configureWorker` は `"configured"` 受信でのみ `resolve` し、`reject` 経路は worker 未生成時のみである。既存の `"error"` 分岐は `callbacks.error` 通知のみで Promise を settle させない。
- 4 Worker の `init` 分岐は `configure` を bare call し、throw 時に何も `postMessage` しない (`"configured"` も送られない)。
- 直接モードは throw が伝播するため非対称である。

## 設計方針

1. Worker 側 `init` 分岐全体 (constructor 含む) に `try/catch` を追加し、失敗時は既存形 `{type: "error", message}` で応答し `"configured"` を送らない。
2. ラッパー側は初期化完了前の `"error"` 受信時のみ `configureWorker` の Promise を `reject` する (二重解決ガード、失敗 Worker の破棄、`onmessage` 後始末。運用中の `"error"` は従来どおり `callbacks.error`)。
3. 回帰テストの手段 (ブラウザ非依存の契約テストか実ブラウザか) は `0495` の方針に従う。

## 完了条件

- 実行環境未対応コーデックで Wrapper `configure()` が `reject` し、ハングしないこと (4 Wrapper とも)。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 関連

- `0495` (codec プロトコルのテスト手段。本 issue の回帰テスト方針はそちらに従う)
- `0500` (同一 4 ラッパー / 4 Worker の重複整理。後始末の定義で競合しないよう調整する)
