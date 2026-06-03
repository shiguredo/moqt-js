# → #0273 に統合する

- Priority: Low
- Created: 2026-06-03
- Model: deepseek-v4-pro
- Branch: feature/draft-18
- Polished: 2026-06-03
- Completed: 2026-06-03

## 統合理由

#0273 の受信側パリティ修正に統合する。単独では対応不要。

#0273 `bug-client-goaway-request-id-parity` が GOAWAY の送信側・受信側両方のパリティバグ（コメント修正を含む）を包括的に扱っているため、本 issue の内容は #0273 の「受信側のパリティチェック修正（`expected odd` → `expected even`）」の一部としてカバーされている。

## 解決方法

#0273 の対応に包含。コメント修正は `src/session.ts:3317-3322` に適用済み。
