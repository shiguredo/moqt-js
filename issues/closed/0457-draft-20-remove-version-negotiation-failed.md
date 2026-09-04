# VERSION_NEGOTIATION_FAILED セッションエラーを削除する

- Created: 2026-09-01
- Completed: 2026-09-05
- Branch: feature/remove-version-negotiation-failed
- Polished: 2026-09-02

## 目的

draft-ietf-moq-transport-20 でセッションエラー `VERSION_NEGOTIATION_FAILED` が削除された (A.1 #1867)。公開 API にエクスポートされている `SessionErrorCode` から、使用箇所の無い当該メンバーを除去して仕様と揃える (破壊的変更)。

## 現状

- `SessionErrorCode.VERSION_NEGOTIATION_FAILED = 0x15` (`src/error.ts`) が定義されているが、使用箇所が無い。
- draft-20 Table 18 (Session Error Codes) から当該コードは消えている。

## 設計方針

- `VERSION_NEGOTIATION_FAILED` を削除する。
- エクスポート・コメント・テストの参照を掃除し、未知コード受信時の既存正規化に任せる。

## 完了条件

- `SessionErrorCode` に `VERSION_NEGOTIATION_FAILED` が無いこと。
- 0x15 受信時の正規化挙動 (未知コード → INTERNAL_ERROR) が `normalizeSessionErrorCode` のコメントに反映され、テストされていること。
- 参照漏れが無いこと (`rg` で確認)。
- `CHANGES.md` の `## develop` に `[CHANGE]` があること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- draft-ietf-moq-transport-20 §15.11.1 (Session Errors)
- draft-ietf-moq-transport-20 Appendix A.1 (#1867)

## 解決方法

- 公開 API の SessionErrorCode から VERSION_NEGOTIATION_FAILED (0x15) を削除し、定義箇所に欠番注記を追加した。
- normalizeSessionErrorCode のコメントに未知コードとしての正規化を明記し、0x15 の回帰テストを追加した。
- 変更履歴の develop に破壊的変更を追記した。
