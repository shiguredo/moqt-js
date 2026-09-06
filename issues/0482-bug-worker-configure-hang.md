# codec Worker の configure 失敗で Promise が永久ハングする

- Created: 2026-09-06
- Completed: YYYY-MM-DD
- Branch: feature/fix-worker-configure-hang
- Polished: YYYY-MM-DD

## 目的

既定 (`useWorker: true`) で非対応コーデックを選ぶと `start()` がタイムアウトなく停止する。Worker の初期化失敗を呼び出し元に伝える必要がある。

## 現状

- 4 ラッパー (`src/codec/` の `VideoEncoder` / `VideoDecoder` / `AudioEncoder` / `AudioDecoder`) の `configureWorker` は `"configured"` 受信でのみ `resolve` し、`reject` 経路は worker 未生成時のみである。
- 4 Worker の `init` 分岐は `configure` を bare call し、throw 時に何も `postMessage` しない。
- 直接モードは throw が伝播するため非対称である。

## 設計方針

1. Worker 側 `init` に `try/catch` を追加し、失敗を `"error"` で応答する。
2. ラッパー側で `"error"` 受信時に `reject` する (既存の分岐を流用)。

## 完了条件

- 非対応コーデックの `configure` が失敗として返り、ハングしないこと (4 Wrapper とも)。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。
