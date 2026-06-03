# ブランチ名が破壊的変更の命名規則に違反している

- Priority: Low
- Created: 2026-06-03
- Model: deepseek-v4-pro
- Branch: feature/draft-18
- Polished: 2026-06-03

## 目的

ブランチ名 `feature/draft-18` は多数の破壊的変更 (CHANGE) を含むため、AGENTS.md:58「後方互換のない変更は prefix を `feature/change-`」に従い `feature/change-draft-18` であるべき。

## 優先度根拠

プロジェクト規約違反。ただし影響範囲はブランチ名のみで、次の issue から正しい命名にする方針で良い。

## 現状

ブランチ名: `feature/draft-18`

AGENTS.md:58:

> 後方互換のない変更は prefix を `feature/change-` でブランチを切って対応すること

AGENTS.md:110:

> draft の更新による仕様変更は 後方互換性を維持せず破壊的変更を行う こと

## 設計方針

- 当ブランチは既に作業が進んでいるため、次回以降のブランチで正しい命名規則を適用する
- この issue は注意喚起としてクローズする
- 対応不要。次回以降の破壊的変更ブランチで `feature/change-` prefix を適用する
