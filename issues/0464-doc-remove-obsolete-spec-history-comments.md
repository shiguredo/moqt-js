# 仕様の履歴メモコメントを削除する

- Created: 2026-09-05
- Completed: {YYYY-MM-DD}
- Branch: feature/remove-obsolete-spec-history-comments
- Polished: {YYYY-MM-DD}

## 目的

現行仕様の理解に不要になった履歴メモコメントが残っており、読み手の sorting コストになる。0461 のレビューで検出された 3 件を整理する。

## 現状

- `src/message/types.ts` の CLIENT_SETUP と SERVER_SETUP の統合メモは、単一 SETUP が前提の現行実装では不要。
- `src/message/types.ts` の旧 SUBSCRIBE_NAMESPACE (0x11) 分割メモは、現行定義 (0x50 / 0x51) があれば足りる。
- `src/message/types.ts` の draft-16 削除メモ (Object Does Not Exist) は、現行値定義と重複する。

## 設計方針

- 上記 3 件のコメントを削除する。コード変更は含めない。
- 0412 (MessageParameterType ヘッダコメント修正) と編集箇所が近いため、着手時に 0412 との重複に注意する。

## 完了条件

- 上記 3 件の履歴メモが除去されていること。
- `CHANGES.md` の `## develop` の `### misc` サブセクションに `[UPDATE]` があること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- draft-ietf-moq-transport-20 §10.3 (SETUP)
- draft-ietf-moq-transport-20 §10.19 (SUBSCRIBE_NAMESPACE) / §10.20 (SUBSCRIBE_TRACKS)
- 関連: `issues/0412-doc-fix-message-parameter-type-header-comment.md`
