# OBJECT_DELIVERY_TIMEOUT の起算を last header byte に合わせる

- Created: 2026-09-01
- Completed: {YYYY-MM-DD}
- Branch: feature/update-delivery-timeout-start-last-header-byte
- Polished: {YYYY-MM-DD}

## 目的

draft-ietf-moq-transport-20 §8 では OBJECT_DELIVERY_TIMEOUT の経過時間起算が Object の last header byte になった (A.1 #1844)。pending の強制実装 (0366) とコメントを draft-20 に揃える。

## 現状

- `issues/pending/0366-add-delivery-timeout-enforcement.md` は draft-19 文言 (first byte of the object) を前提に設計している。
- 強制自体は未実装。値の抽出・伝搬のみ (`publish.ts` / `stream.ts`)。
- 本変更は 0366 実装時の起算点定義を draft-20 に更新することが主目的。0366 が先に実装される場合は本 issue を同時に取り込む。

## 設計方針

- 0366 の設計文言・完了条件を 「last header byte」 起算に書き換えるか、本 issue で実装時に起算点を last header byte とする。
- subgroup では Object Fields ヘッダー書き込み完了時点を起算に使う。datagram も同様にヘッダー相当の境界を定義する。
- コードコメントの draft-19 参照を draft-20 §8 に更新する (節番号の網羅更新は 0461 と重複しないよう本 issue は起算点のみ)。

## 完了条件

- OBJECT_DELIVERY_TIMEOUT 強制の起算が last header byte であること (0366 実装と同時または本 issue 単独で検証可能であること)。
- pending 0366 の本文が draft-20 起算と矛盾しないこと。
- `CHANGES.md` への記載は強制実装が入るコミットに含めてよい。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- draft-ietf-moq-transport-20 §8 (Delivery Timeout Calculations)
- draft-ietf-moq-transport-20 Appendix A.1 (#1844)
- 関連: `issues/pending/0366-add-delivery-timeout-enforcement.md`
