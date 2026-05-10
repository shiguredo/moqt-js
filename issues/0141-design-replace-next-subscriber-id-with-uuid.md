# `nextSubscriberId` カウンタを `crypto.randomUUID()` ベースの ID 生成に変更する

Created: 2026-05-10
Model: Opus 4.7

## 概要

`devtools/src/signals/subscriber.ts` の `addSubscriber` は、モジュールスコープのミュータブルカウンタ `let nextSubscriberId = 1` をインクリメントして `subscriber-${n}` の ID を生成している。

## 根拠

- モジュールスコープのミュータブル変数は HMR と相性が悪く、開発時に signal だけリセットされて `nextSubscriberId` が引き継がれることで ID 衝突や歯抜け番号が発生し得る。
- ID は内部識別子として使われ、UI に直接表示されている箇所は DebugPanel のコピーボタンラベルくらい。短い人間可読 ID にする必要は薄い。
- グローバル状態を減らす方向で整理する。

## 修正方針

1. `let nextSubscriberId = 1` と該当のインクリメントを削除する。
2. `addSubscriber` 内で `id = \`subscriber-\${crypto.randomUUID().slice(0, 8)}\`` のように短縮した UUID を生成する。
   - そのまま `crypto.randomUUID()` でもよいが、UI に表示されるラベルとしては長すぎるため先頭 8 文字程度に切り詰める。
3. 既存の `subscriber-N` 形式に依存しているテストやログ整形があれば併せて調整する (現状はないと想定)。

## 影響範囲

- `devtools/src/signals/subscriber.ts` のみ (DebugPanel のラベル表示は ID をそのまま使うので追従不要)
