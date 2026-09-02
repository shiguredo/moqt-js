# コメントと節番号参照を draft-20 に更新する

- Created: 2026-09-01
- Completed: {YYYY-MM-DD}
- Branch: feature/update-draft-20-section-references
- Polished: 2026-09-02

## 目的

ソース・テストコメントに残る draft-ietf-moq-transport-19 参照と、draft-20 でずれた節番号・メッセージ節・Type Flags 説明を一括で draft-20 に更新する。実装変更は含めない。

## 現状

- `src/message/types.ts` / `parameter.ts` / `parameterScope.ts` / `dataStream.ts` / `error.ts` / session 配下など広範囲が draft-19 参照。
- draft-20 ではパラメータ節がシフト (例: EXPIRES 10.2.15→10.2.16、TRACK_NAMESPACE_PREFIX 10.2.19→10.2.20、FILL_PARAMETERS が 10.2.15)。
- メッセージ節も PUBLISH_STATE_NOTIFY 挿入で番号がずれている (PUBLISH_DONE / FETCH 等)。
- OBJECT_DATAGRAM / SUBGROUP_HEADER の Type Flags bitfield 説明 (A.1 #1774) もコメント追随が必要。実装検証は既にあるため本 issue は文書のみ。

## 設計方針

- 着手ゲート: 実装変更を伴う draft-20 対応 issue (0448–0460) がすべて closed になっていること。各 issue が自分の変更箇所の参照を更新するため、本 issue は残りを対象とする (先例 0343 と同様)。
- `refs/moq/draft-ietf-moq-transport-20.txt` の目次・各節とコメントを照合し、ドラフト名・節番号・節タイトルを直す。
- 対象パス: `src/`（`*.ts` / `*.test.ts` / `*.prop.ts`）、`tests/`、`devtools/`、`README.md`、`.env.example`。除外: `CHANGES.md` の過去エントリ、`issues/`、`refs/`、draft-ietf-moq-msf-01 など MSF 仕様そのものの参照。
- ワイヤ値やロジックは変更しない。実装ギャップは他の draft-20 issue に任せる。
- 他 issue で触ったファイルのコメントは、可能ならその issue で直すが、取りこぼしは本 issue で回収する。
- 関連 open issue `0412`（MessageParameterType ヘッダコメント）と `0435`（subgroupDeliveryTimeout doc コメント）とは編集対象が重なる。0412 / 0435 が先に closed ならその結果を継承して本 issue で draft-20 節番号に揃え、open の場合は相互に参照して調整する (0412 の draft-19 前提は本 issue で陳腐化する)。
- 完了後に polish-refs で全引用を検証する。
- `CHANGES.md` への追記は不要 (コメントのみ。動作・API 変更なし)。

## 完了条件

- `rg 'draft-ietf-moq-transport-19'` が対象パス（`src/` / `tests/` / `devtools/` / `README.md` / `.env.example`）で 0 件 (または意図的残存が該当コメント内に draft-19 のままにする理由を明記して文書化されていること。除外: `CHANGES.md` / `issues/` / `refs/` / msf-01 文字列)。
- `MessageParameterType` / `MessageType` コメントの節番号が draft-20 目次と一致すること。
- polish-refs の検証で引用の不一致が報告されないこと。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること (コメントのみならテスト変化なし)。

## 参照

- draft-ietf-moq-transport-20 目次 §10.2 / §10.10–10.21 / §11
- draft-ietf-moq-transport-20 Appendix A.1 (Notable Editorial Changes, Type Flags)
- 関連: `issues/0412-doc-fix-message-parameter-type-header-comment.md`
- 関連: `issues/0435-update-subgroup-delivery-timeout-options-doc-comment.md`
- 先例: `issues/closed/0392-moqt-draft-19-comment-section-number.md`
- 先例: `issues/closed/0343-draft-19-update-spec-reference-comments.md`
