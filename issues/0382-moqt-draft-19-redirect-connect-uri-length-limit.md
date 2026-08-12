# Redirect の Connect URI に 8,192 バイト上限を課している

- Priority: Low
- Created: 2026-08-06
- Completed: {YYYY-MM-DD}
- Model: DeepSeek V4 Flash
- Branch: feature/fix-moqt-draft-19-redirect-connect-uri-length-limit
- Polished: 2026-08-12

## 目的

draft-ietf-moq-transport-19 §10.6.1 (Redirect Structure) に存在しない制約を撤去する。8,192 バイト上限は GOAWAY の New Session URI (§10.4) にのみ存在し、Redirect の Connect URI には最大長の規定がない。この上限は closed issue 0186 が GOAWAY の URI 長制限への準拠として導入した過剰実装であり、ドラフト準拠の Redirect (8,192 バイト超の Connect URI) を拒否しうる。

## 優先度根拠

moqt-js はクライアント専用であり、§10.6.1 のサーバー向け MUST (非ゼロ Connect URI Length の Redirect 受信で PROTOCOL_VIOLATION) は適用されない。過剰実装の是正であり、8,192 バイト超の Connect URI は実用上稀なため実害は限定的。Low。

## 現状

- `decodeRedirect` (`src/message/session.ts`) が「Connect URI の最大長は GOAWAY と同様に 8,192 バイト」という誤った仕様根拠のコメントとともに、8,192 バイト超過時に ProtocolViolationError を送出する。
- 8,192 バイト上限は GOAWAY の New Session URI (§10.4) にのみ存在し、§10.6.1 の Redirect 構造には Connect URI の最大長規定がない (上限は closed issue 0186 が GOAWAY の URI 長制限への準拠として導入した過剰実装)。
- `encodeRedirect` (`src/message/session.ts`) には上限チェックがなく、8,192 バイト超の Connect URI は既にエンコードできる (デコード側のチェックだけが非対称)。
- 変更対象ファイル: `src/message/session.ts` (`decodeRedirect` からチェック削除)、`src/message/session.prop.ts` / テスト (8192 超デコードのテスト追加)、`CHANGES.md`。

## 設計方針

- `decodeRedirect` から 8,192 バイト上限チェックを**削除する** (削除に確定。防御的チェックとして残す選択肢は取らない。仕様根拠がなく、完了条件「8,192 バイト超がデコードできること」と矛盾するため)。
- 削除は安全である: 制御メッセージは `ControlStreamReader` が Length (16-bit) でペイロードを切り出すため最大 65,535 バイトに制限され、`data.slice` はデータ実在範囲を超えて割り当てない。また過剰な Connect URI Length の宣言は `decodeRequestErrorPayload` 末尾の trailing 検査 (offset と data.length の一致検証) で検出される。
- GOAWAY 側の 8,192 バイトチェック (`decodeGoawayPayload`) は §10.4 の MUST に基づくため削除しない。
- テスト: 8,193 バイト以上の Connect URI を含む Redirect がデコードできることを検証するテストを追加する (既存の PBT は `fc.string({ minLength: 0, maxLength: 100 })` であり 8,192 バイト超を生成しないため、固定長の単体テストが必要)。削除しても既存テストは壊れない (既存テストに 8,192 バイト上限を検証するものは存在しない)。

## 完了条件

- 8,192 バイト超の Connect URI を含む Redirect がデコードできること (8,193 バイト以上の固定バイト列テストがあること)。
- 関連テストが更新されていること。
- GOAWAY 側の 8,192 バイト上限チェックが維持されていること。
- `CHANGES.md` の `## develop` に `[FIX]` があること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- draft-ietf-moq-transport-19 §10.6.1 (Redirect Structure / Connect URI の最大長規定なし)
- draft-ietf-moq-transport-19 §10.4 (GOAWAY / New Session URI の 8,192 バイト上限)
- 関連: `issues/closed/0186-draft-18-add-redirect-for-request-errors-and-established-subscriptions.md`（8,192 バイト上限を GOAWAY 準拠として導入した元）
- 関連: `issues/closed/0277-bug-redirect-trailing-data-not-detected.md`（Redirect の trailing 検査。チェック削除後の防御経路）

## 解決方法

未着手。
