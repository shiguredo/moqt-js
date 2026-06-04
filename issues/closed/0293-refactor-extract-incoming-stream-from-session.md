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

## 解決方法

本 issue は不要と判断し close する。

### 判断根拠

1. **部分解決済み**: `processFetchObjects` / `processSubgroupObjects` の純粋関数は既に `session/stream.ts` に抽出済み。`session.ts` 内の同名メソッドは既に薄いラッパー（各 25 行/15 行）になっている
2. **状態結合が強い**: `handleIncomingStream` / `handleSubgroupStream` / `handleIncomingDatagram` は `this.fetchers` / `this.subscribersByAlias` / `this.pendingSubgroupBuffer` / `this.closeWithError()` など約 20 箇所で SessionImpl の内部状態を参照しており、純粋関数 + コールバックインターフェースの既存抽出パターンでは抽出しづらい。これらは本質的に SessionImpl の内部状態と協調動作する指揮者メソッドであり、無理に抽出すると大量のコールバックインターフェースが必要になる
3. **effort 対 value が悪い**: 抽出可能なのは約 414 行で、session.ts は 4125 → 3711 行になり目標の 3700 行をわずかに達成できない可能性がある
4. **優先度**: Low 優先度であり、0277 (High/バグ修正) など未対応の高優先度 issue がある中で今対応する必要性は低い
5. **代替案**: より適切なアプローチとして、SessionImpl から受信ストリーム処理部分のみを責務とするクラス (`IncomingStreamHandler`) を導入し、SessionImpl をコンストラクタで受け取る設計を検討する方が良い
