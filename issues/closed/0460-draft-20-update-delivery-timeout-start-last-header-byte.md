# OBJECT_DELIVERY_TIMEOUT の起算を last header byte に合わせる

- Created: 2026-09-01
- Completed: 2026-09-05
- Branch: feature/update-delivery-timeout-start-last-header-byte
- Polished: 2026-09-02

## 目的

draft-ietf-moq-transport-20 §8 では OBJECT_DELIVERY_TIMEOUT の経過時間起算が Object の last header byte になった (A.1 #1844)。pending の強制実装 (0366) とコメントを draft-20 に揃える。

## 現状

- `issues/pending/0366-add-delivery-timeout-enforcement.md` は draft-19 文言 (first byte of the object) を前提に設計している。
- 強制自体は未実装。値の抽出・伝搬のみ (`publish.ts` / `stream.ts`)。
- 本変更は 0366 実装時の起算点定義を draft-20 に更新することが主目的。0366 が先に実装される場合は本 issue を同時に取り込む。

## 設計方針

- 0366 の設計文言・完了条件・参照節番号を「last header byte」起算に書き換える (完了条件「pending 0366 の本文が draft-20 起算と矛盾しないこと」を満たすため必須。書き換えずに実装だけで揃える選択肢では満たせない)。
- 起算点は「Object の last header byte がアプリにより提供された時点」とし (draft-20 §8 の provided by the original publisher application / Table 4)、moqt-js ではオブジェクト提供の入口 (`publishSendObject` / `publishSendDatagram`) で記録する (0366 の既存設計と一致)。「書き込み完了時点」を起算にすると提供時点より遅れ、送信キュー滞留分を起算から外してしまうため使わない。
- 0366 の更新は本文・設計方針・完了条件に加えて 0366 の参照節番号も対象とする (0461 は src/ のコメントのみ対象であり issue ファイルの参照欄はカバーしない)。0366 は pending のまま本文を更新し (閉めない・reopened にしない)、強制実装着手時は 0366 の pending 理由に従い再オープン手順を踏む。
- コードコメントの draft-19 参照を draft-20 §8 に更新する (節番号の網羅更新は 0461 と重複しないよう本 issue は起算点のみ)。

## 完了条件

- 0366 実装と同時の場合は、0366 のテストにより強制の起算が last header byte であることを検証できること。本 issue 単独の場合は、強制ロジックは 0366 の責務であるため、本 issue は 0366 本文と記録ロジック (オブジェクト提供入口での記録) が last header byte 起算と一致することを検証すること。
- pending 0366 の本文が draft-20 起算と矛盾しないこと。
- `CHANGES.md` への記載は強制実装が入るコミットに含めてよい。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- draft-ietf-moq-transport-20 §8 (Delivery Timeouts and Data Reliability)
- draft-ietf-moq-transport-20 Appendix A.1 (#1844)
- 関連: `issues/pending/0366-add-delivery-timeout-enforcement.md`

## 解決方法

- pending 0366 の目的・設計方針・完了条件・参照節番号を draft-20 の last header byte 起算に書き換えた。0366 は pending のまま維持する。
- 0366 が規定する提供入口での時刻記録 (publishSendObject / publishSendDatagram) が、draft-20 §8 の provided by the original publisher application と一致することを確認した。記録コード自体は未実装であり 0366 の責務とする。
- 起算点のコードコメントは src/ に存在しないため変更なし (節番号の網羅更新は 0461 の責務)。
- 変更履歴への記載は強制実装時に行う (本 issue では不要)。
