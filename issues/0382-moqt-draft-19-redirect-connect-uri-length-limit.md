# Redirect の Connect URI に 8,192 バイト上限を課している

- Priority: Low
- Created: 2026-08-06
- Completed: {YYYY-MM-DD}
- Model: DeepSeek V4 Flash
- Branch: feature/fix-moqt-draft-19-redirect-connect-uri-length-limit
- Polished: {YYYY-MM-DD}

## 目的

draft-ietf-moq-transport-19 §10.6.1 (Redirect Structure) に存在しない制約を撤去する。8,192 バイト上限は GOAWAY の New Session URI (§10.4) にのみ存在し、Redirect の Connect URI には最大長の規定がない。

## 優先度根拠

仕様にない制約を課しており、ドラフト準拠の Redirect (8,192 バイト超の Connect URI) を拒否しうる。過剰実装の是正。Low。

## 現状

- `src/message/session.ts:130-136` (`decodeRedirect`) が「GOAWAY と同様に」として Connect URI の 8,192 バイト超過時に ProtocolViolationError を送出する。
- draft-ietf-moq-transport-19 §10.6.1 の Redirect 構造には Connect URI の最大長規定がない。

## 設計方針

- `decodeRedirect` から 8,192 バイト上限チェックを削除する。
- 防御的チェックとして残す場合は、理由を仕様根拠ではなく実装上の制約として明記する。

## 完了条件

- 8,192 バイト超の Connect URI を含む Redirect がデコードできること。
- 関連テストが更新されていること。
- `CHANGES.md` の `## develop` に `[FIX]` があること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- draft-ietf-moq-transport-19 §10.6.1 (Redirect Structure)
- draft-ietf-moq-transport-19 §10.4 (GOAWAY の New Session URI 上限との対比)

## 解決方法

未着手。
