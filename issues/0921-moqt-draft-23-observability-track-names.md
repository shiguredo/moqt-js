# ログとメトリクスの namespace を 3 field にし Track Name を ASCII 数字にする

- Created: 2026-11-03
- Completed: {YYYY-MM-DD}
- Branch: feature/change-observability-track-names
- Polished: {YYYY-MM-DD}

## 目的

moq-log-04 §4 / §5.1 と moq-metrics-03 §4.1 / §5.1 は namespace を domain / v1 / resourceID の 3 field、レベルの Track Name を ASCII 数字に変更した。旧 URL 文字列 + resourceID とバイナリ 1 バイトの名前では新しい収集側が発見できない。

## 現状

- `src/moqlog.ts` の `MOQLOG_NAMESPACE_PREFIX` は `moq://moq-syslog.arpa/logs-v1/`
- `src/moqmetrics.ts` の `MOQMETRICS_NAMESPACE_PREFIX` は `moq://metrics.moq.arpa/v1/`
- 両 module は `src/observability.ts` の `observabilityTrackNamespace` で 2 field を作り、`observabilityTrackName` は 0〜7 をそのまま 1 バイトにする

## 設計方針

- ログは `["logs.moq.arpa", "v1", resourceID]`、メトリクスは `["metrics.moq.arpa", "v1", resourceID]` とする
- resourceID は 16 桁の小文字 hexadecimal ASCII として検証する。ブラウザから MAC address を取得する機能は追加せず、生成・保持は利用者の責務とする
- レベル 0〜7 は ASCII `"0"`〜`"7"` にする。metrics の `catalog` Track Name も新しい helper で表現できるようにする
- MSF publishTracks で使う namespace の文字列表現は MOQT の serialization で作り、`%resourceId%` の置換経路を確認する
- MSF-01 §§9 / 10 は旧 log / metrics 版を固定参照している。本変更は最新 companion draft の形式を採用するものであり、MSF-01 本文との不一致を文書に明記する。既存 0850 の publishTracks 配置検証は別目的である

## 完了条件

- 両 namespace の 3 field と既定 prefix、全レベルの ASCII バイトが固定ワイヤで一致する
- resourceID の長さ・文字種と、MOQT 文字列表現の往復を検証する
- metrics catalog と data track の名前を混同しない
- 旧 URL prefix / バイナリ Track Name の使用箇所と説明を移行する

## 参照

- `refs/moq/draft-jennings-moq-log-04.txt` §4 / §5.1 / §6
- `refs/moq/draft-jennings-moq-metrics-03.txt` §4.1 / §5.1 / §6
- `src/observability.ts`、`src/moqlog.ts`、`src/moqmetrics.ts`、`src/msf/variables.ts`

## 解決方法

{未着手}
