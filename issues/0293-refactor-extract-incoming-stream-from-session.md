# session.ts から handleIncomingStream を分離する

- Priority: Low
- Created: 2026-06-03
- Model: deepseek-v4-pro
- Branch: feature/draft-18
- Polished: 2026-06-03

## 目的

`session.ts` が 4086 行と過大。`handleIncomingStream` と `handleSubgroupStream` は合計約 380 行で、fetch ストリーム処理 / subgroup ストリーム処理 / padding ストリーム処理の 3 つの独立した責務を持つ。これらを分離する。

## 優先度根拠

コードの過大化は可読性と保守性を損ねる。責務分離の観点からも適切。

## 設計方針

- `handleIncomingStream` + `handleSubgroupStream` + `processFetchObjects` 呼び出し + `handleIncomingDatagram` を `session/incoming.ts` に抽出する
- `StreamStatsUpdate` インターフェースで既に抽象化済みの統計更新を活用する

## 完了条件

- `session/incoming.ts` が存在する
- session.ts が 3700 行以下になっている
- 全テストが PASS する
