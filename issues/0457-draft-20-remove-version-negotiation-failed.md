# VERSION_NEGOTIATION_FAILED セッションエラーを削除する

- Created: 2026-09-01
- Completed: {YYYY-MM-DD}
- Branch: feature/remove-version-negotiation-failed
- Polished: {YYYY-MM-DD}

## 目的

draft-ietf-moq-transport-20 でセッションエラー `VERSION_NEGOTIATION_FAILED` が削除された (A.1 #1867)。未使用の定数を除去して仕様と揃える。

## 現状

- `SessionErrorCode.VERSION_NEGOTIATION_FAILED = 0x15` (`src/error.ts`) が定義されているが、使用箇所が無い。
- draft-20 Table 18 (Session Error Codes) から当該コードは消えている。

## 設計方針

- `VERSION_NEGOTIATION_FAILED` を削除する。
- エクスポート・コメント・テストの参照を掃除し、未知コード受信時の既存正規化に任せる。

## 完了条件

- `SessionErrorCode` に `VERSION_NEGOTIATION_FAILED` が無いこと。
- 参照漏れが無いこと (`rg` で確認)。
- `CHANGES.md` の `## develop` に `[REMOVE]` があること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- draft-ietf-moq-transport-20 §15.11.1 (Session Errors)
- draft-ietf-moq-transport-20 Appendix A.1 (#1867)
