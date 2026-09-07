# codec Wrapper の並行 configure() で失敗処理が別世代の Worker を破棄し得る

- Created: 2026-09-07
- Completed: YYYY-MM-DD
- Branch: feature/fix-codec-parallel-configure
- Polished: YYYY-MM-DD

## 目的

同一 Wrapper に `configure()` を並行発行すると、先発の失敗処理が後発の Worker を破棄し、先発の失敗 Worker がリークし得る。初期化の所有権を世代ごとに分離する必要がある。

## 現状

- 4 ラッパー (`src/codec/` の `VideoEncoderWrapper` 等) の `configureWorker` は生成した Worker を共有フィールドに格納し、失敗処理は失敗時点で共有フィールドを読み直して破棄する。
- 完了管理は呼び出しごとに分離済みだが、Worker ハンドルのみ分離されておらず、所有権の対応がずれている。
- 単発の `await configure()` や直列の `reset()` では発現しない。

## 設計方針

1. 生成直後に局所変数へ捕捉し、失敗処理・送受信・送信の参照を固定する方向で検討する。
2. `close()` / `reset()` との所有権整理と一体の設計にする。重複整理と競合しないよう調整する。

## 完了条件

- 並行 `configure()` でも世代の取り違えが起きないこと。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 関連

- draft なし (内部所有権の問題)
- 重複整理と競合しないよう調整する
