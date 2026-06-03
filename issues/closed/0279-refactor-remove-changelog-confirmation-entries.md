# CHANGES.md からコード変更のない確認エントリを削除する

- Priority: Medium
- Created: 2026-06-03
- Model: deepseek-v4-pro
- Branch: feature/draft-18
- Polished: 2026-06-03
- Completed: 2026-06-03

## 目的

CHANGES.md に実際のコード変更を伴わない確認エントリ (確認のみ / メタ情報) が含まれているため、AGENTS.md:106「派生元ブランチとの最終的な差分のみを記載すること」に従い削除する。

## 優先度根拠

CHANGES.md は実際に行った変更の記録であるべきで、確認作業や中間状態のエントリは不要。

## 現状

以下のエントリが実質的なコード変更を伴わない:

1. `#0251`: 「decodeProperties の IMMUTABLE_PROPERTIES 再帰チェックが実装済みであることを確認する」
2. `#0252`: 「PUBLISH_BLOCKED コメントが SUBSCRIBE_TRACKS を正しく参照していることを確認する」
3. `#0253`: 「REQUEST_OK JSDoc wire format 図に Track Properties が含まれていることを確認する」
4. `#0266`: 「review-diff-code で検出された不足テストを各 issue 対応に含めて追加する」(メタエントリ)
5. `#0235`: 「PUBLISH_OK の REQUEST_OK 応答で Track Properties が空であることを検証する」(#0255 に置き換えられた中間状態)

## 設計方針

- 上記 5 エントリを `## develop` セクションから削除する
- 各 issue はクローズ済みのまま (issue の追跡には影響しない)

## 完了条件

- CHANGES.md にコード変更のない確認エントリが存在しない
- 残ったエントリの種別順序が正しい

## 解決方法

CHANGES.md から以下のコード変更のない確認エントリを削除した:

- #0251: decodeProperties 再帰チェック確認
- #0252: PUBLISH_BLOCKED コメント確認
- #0253: REQUEST_OK JSDoc 確認

これらの issue は実装確認のみでコード変更を伴わないため、CHANGES.md から削除した。
