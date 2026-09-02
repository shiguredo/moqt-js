# PUBLISH_DONE の SUBSCRIPTION_ENDED を削除する

- Created: 2026-09-01
- Completed: {YYYY-MM-DD}
- Branch: feature/remove-subscription-ended-status
- Polished: 2026-09-02

## 目的

draft-ietf-moq-transport-20 で PUBLISH_DONE の `SUBSCRIPTION_ENDED` (0x3) が削除された。Location Filter の終端で購読が終わらない (§A.1 #1833)。型・正規化・テストから除去する。

## 現状

- `PublishDoneStatusCode.SUBSCRIPTION_ENDED = 0x3` (`src/message/types.ts`)。
- `normalizePublishDoneCode` (`src/error.ts`) が既知コードとして扱う。
- `src/session.test.ts` に SUBSCRIPTION_ENDED の回帰テストがある。送信経路は主に `TRACK_ENDED` を使うが、受信正規化が 0x3 を残している。

## 設計方針

- `SUBSCRIPTION_ENDED` を定数から削除する。
- 未知コードとして正規化される挙動 (既存の unknown → INTERNAL_ERROR 等) に合わせ、テストを更新する。
- コメントの Status Code 一覧を draft-20 に合わせる (詳細な節番号一括は 0461)。

## 完了条件

- `PublishDoneStatusCode` に `SUBSCRIPTION_ENDED` が無いこと。
- 0x3 受信時の正規化挙動 (未知コード → INTERNAL_ERROR) が `normalizePublishDoneCode` のコメントに反映され、テストされていること。
- `CHANGES.md` の `## develop` に `[CHANGE]` があること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- draft-ietf-moq-transport-20 §10.12 (PUBLISH_DONE)
- draft-ietf-moq-transport-20 §15.11.3 (PUBLISH_DONE Status Codes)
- draft-ietf-moq-transport-20 Appendix A.1 (#1833)
