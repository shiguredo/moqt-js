# コメントと節番号参照を draft-20 に更新する

- Created: 2026-09-01
- Completed: {YYYY-MM-DD}
- Branch: feature/update-draft-20-section-references
- Polished: {YYYY-MM-DD}

## 目的

ソース・テストコメントに残る draft-ietf-moq-transport-19 参照と、draft-20 でずれた節番号・メッセージ節・Type Flags 説明を一括で draft-20 に更新する。実装変更は含めない。

## 現状

- `src/message/types.ts` / `parameter.ts` / `parameterScope.ts` / `dataStream.ts` / `error.ts` / session 配下など広範囲が draft-19 参照。
- draft-20 ではパラメータ節がシフト (例: EXPIRES 10.2.15→10.2.16、TRACK_NAMESPACE_PREFIX 10.2.19→10.2.20、FILL_PARAMETERS が 10.2.15)。
- メッセージ節も PUBLISH_STATE_NOTIFY 挿入で番号がずれている (PUBLISH_DONE / FETCH 等)。
- OBJECT_DATAGRAM / SUBGROUP_HEADER の Type Flags bitfield 説明 (A.1 #1774) もコメント追随が必要。実装検証は既にあるため本 issue は文書のみ。

## 設計方針

- `refs/moq/draft-ietf-moq-transport-20.txt` の目次・各節とコメントを照合し、ドラフト名・節番号・節タイトルを直す。
- ワイヤ値やロジックは変更しない。実装ギャップは他の draft-20 issue に任せる。
- 他 issue で触ったファイルのコメントは、可能ならその issue で直すが、取りこぼしは本 issue で回収する。

## 完了条件

- `rg 'draft-ietf-moq-transport-19'` が `src/` で 0 件 (または意図的残存が文書化されていること)。
- `MessageParameterType` / `MessageType` コメントの節番号が draft-20 目次と一致すること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること (コメントのみならテスト変化なし)。

## 参照

- draft-ietf-moq-transport-20 目次 §10.2 / §10.10–10.21 / §11
- draft-ietf-moq-transport-20 Appendix A.1 (Notable Editorial Changes, Type Flags)
- 先例: `issues/closed/0392-moqt-draft-19-comment-section-number.md`
- 先例: `issues/closed/0343-draft-19-update-spec-reference-comments.md`
