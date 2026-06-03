# review-diff-code で検出された不足テストを追加する

- Priority: High
- Created: 2026-06-03
- Model: deepseek-v4-pro
- Completed: 2026-06-03
- Branch: feature/draft-18
- Polished: 2026-06-03
- Completed: 2026-06-03

## 目的

`feature/draft-18` ブランチの未コミット変更に対し、以下のテストが全く存在しない。仕様準拠を保証するために、全パスをカバーするテストを追加する。

## 優先度根拠

新機能・新規検証ロジックにテストがないのは致命的。AGENTS.md の「全てのテストが通らない限りコミットしないこと」に加え、プロトコル準拠の検証にはテストが必須。

## 現状（不足テスト一覧）

### 新規検証ロジックのテスト不足

| #   | 対象                                                              | ファイル              | 行        |
| --- | ----------------------------------------------------------------- | --------------------- | --------- |
| 1   | PUBLISH_OK Track Properties 非空 → PROTOCOL_VIOLATION             | `src/session/bidi.ts` | 188-232   |
| 2   | REQUEST_UPDATE_OK Track Properties 非空 → PROTOCOL_VIOLATION      | `src/session/bidi.ts` | 812-820   |
| 3   | SUBSCRIBE_NAMESPACE_OK Track Properties 非空 → PROTOCOL_VIOLATION | `src/session.ts`      | 1797-1805 |
| 4   | PUBLISH_NAMESPACE_OK Track Properties 非空 → PROTOCOL_VIOLATION   | `src/session.ts`      | 2241-2249 |
| 5   | SUBSCRIBE_TRACKS_OK Track Properties 非空 → PROTOCOL_VIOLATION    | `src/session.ts`      | 2010      |

### goawayCallback 関連のテスト不足

| #   | 対象                                                      | ファイル              | 行      |
| --- | --------------------------------------------------------- | --------------------- | ------- |
| 6   | PUBLISH 応答で goawayCallback 永続化                      | `src/session/bidi.ts` | 191     |
| 7   | SUBSCRIBE 応答で goawayCallback 永続化                    | `src/session/bidi.ts` | 258     |
| 8   | FETCH 応答で goawayCallback 永続化                        | `src/session/bidi.ts` | 375     |
| 9   | 確立済みリクエストストリーム GOAWAY → goawayCallback 呼出 | `src/session/bidi.ts` | 528-547 |
| 10  | 初期応答 GOAWAY (PUBLISH) → pending goawayCallback 呼出   | `src/session/bidi.ts` | 217-222 |
| 11  | 初期応答 GOAWAY (SUBSCRIBE) → pending goawayCallback 呼出 | `src/session/bidi.ts` | 313-318 |
| 12  | 初期応答 GOAWAY (FETCH) → pending goawayCallback 呼出     | `src/session/bidi.ts` | 402-407 |

### その他のテスト不足

| #   | 対象                                                                | ファイル                 | 行      |
| --- | ------------------------------------------------------------------- | ------------------------ | ------- |
| 13  | `bidiHandlePublishDone` + `normalizePublishDoneCode`                | `src/session/bidi.ts`    | 781     |
| 14  | PUBLISH_OK decode で Track Properties 非空 → ProtocolViolationError | `src/message/publish.ts` | 182-189 |

## 設計方針

- テストは Vitest の Chai API (`test` / `assert`) を使用すること
- モックやスタブは利用しないこと
- PBT でカバーできるものは `.prop.ts` に実装すること
- テストメッセージは日本語にすること

## 完了条件

- 上記全 14 項目に対応するテストが追加されていること
- 全 test がパスすること

## 解決方法

1. 各項目に対応するテストを追加する
2. `vp run test` で全テストが通ることを確認する
