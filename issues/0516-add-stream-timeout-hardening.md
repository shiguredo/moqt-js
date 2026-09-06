# ストリームのタイムアウトとバッファ上限の締めを実装する

- Created: 2026-09-06
- Completed: YYYY-MM-DD
- Branch: feature/add-stream-timeout-hardening
- Polished: YYYY-MM-DD

## 目的

半端 Length の無期限バッファでメモリが蓄積し、overflow 通知後の集計が他ストリームを巻き添えにする。DoS 耐性の締めが必要である。

## 現状

- `src/controlStream.ts` の Length 不足 `feed` が無期限にバッファする。`CONTROL_MESSAGE_TIMEOUT` / `DATA_STREAM_TIMEOUT` は定義のみで実装がない。
- `src/pendingSubgroupBuffer.ts` は overflow 通知後も加算が続き、巻き添え overflow を起こしうる。

## 設計方針

1. タイムアウト値を実装し、期限切れバッファを破棄する (値の既定は仕様の brief period と整合させる)。
2. overflow 後の `append` を no-op 化するか、所有者側の読取停止を強制する。

## 完了条件

- 半端入力が有界に処理され、巻き添え overflow が起きないこと。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。
