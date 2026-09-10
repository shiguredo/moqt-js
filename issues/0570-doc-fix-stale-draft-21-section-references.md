# fetcher.ts と types.ts に残る draft-21 の古い節番号・パラメータ表現を修正する

- Created: 2026-09-10
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-stale-draft-21-section-references
- Polished: {YYYY-MM-DD}

## 目的

0558 で draft-ietf-moq-transport-21 の節番号参照への更新が行われたが、以下の漏れが残っている。誤った節番号・出現メッセージの記述は、読み手の仕様確認コストを増やし誤解を招く。

- `src/fetcher.ts` のモジュールヘッダコメント: 「Section 9.11 (FETCH) — 10.14 (FETCH_OK)」の `10.14` は draft-20 の番号。draft-21 では FETCH_OK は §9.12。
- `src/fetcher.ts` のモジュールヘッダコメント: 「(Section 11.4.4, Table 7)」の `11.4.4` は draft-20 の番号。draft-21 では不明範囲 (End of Range) は §11.4.1.2、Table 7 は §11.4.1。
- `src/message/types.ts` の `MessageParameterType.SUBGROUP_DELIVERY_TIMEOUT` のエントリコメント: 「PUBLISH_OK / SUBSCRIBE / REQUEST_UPDATE に出現可能」は draft-20 以前の記述。draft-21 §9.20.4 は SUBSCRIBE / PUBLISH / REQUEST_UPDATE。

## 現状

- 上記 3 箇所はいずれもコメントのみの誤りで、実装ロジック・公開 API には影響しない。
- 0558 の更新時に `src/fetcher.ts` の同種の参照 (FETCH_OK の `10.14` 等) は修正済みだが、モジュールヘッダの 2 箇所だけが残っている。
- `src/message/types.ts` は 0412 (MessageParameterType ヘッダコメント修正) と 0464 (履歴メモ削除) が同じファイルを編集対象にしている。

## 設計方針

- コメントのみを修正する。コード・公開 API は変更しない。
- 0412 / 0464 と編集箇所が近いため、着手時に重複と編集順序に注意する。

## 完了条件

- 上記 3 箇所の節番号・出現メッセージが draft-21 と一致すること。
- `CHANGES.md` の `## develop` の `### misc` に `[UPDATE]` があること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- `refs/moq/draft-ietf-moq-transport-21.txt` §9.12 (FETCH_OK) / §11.4.1 (Fetch Header / Table 7) / §11.4.1.2 (End of Range) / §9.20.4 (SUBGROUP_DELIVERY_TIMEOUT Parameter)
- `issues/closed/0558-doc-update-draft-21-section-references.md` (節番号更新の先行 issue)
- `issues/0412-doc-fix-message-parameter-type-header-comment.md` / `issues/0464-doc-remove-obsolete-spec-history-comments.md` (同じ `src/message/types.ts` を編集)
