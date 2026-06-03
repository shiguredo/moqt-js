# CHANGES.md に review-diff-code で検出された未記載の変更を追記する

- Priority: High
- Created: 2026-06-03
- Model: deepseek-v4-pro
- Branch: feature/draft-18
- Polished: 2026-06-03
- Relations: 全 #0255-#0271 の解決後に実施（CHANGES.md エントリは全修正の最終状態を反映するため）
- Completed: 2026-06-03

## 目的

`feature/draft-18` ブランチの working tree 上に未コミットの変更が多数あるが、いずれも `CHANGES.md` の `## develop` セクションに記載されていない。AGENTS.md の「変更履歴は `CHANGES.md` に記載すること」に違反する。

## 優先度根拠

AGENTS.md の規約違反。リリース時に変更履歴が不完全になり、利用者が変更内容を把握できなくなる。

## 現状

以下の未コミット変更が CHANGES.md に全く記載されていない:

| 変更内容                                                                               | ファイル                                                  |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `normalizeRequestErrorCode` / `normalizePublishDoneCode` 新設                          | `src/error.ts`                                            |
| 全 REQUEST_ERROR 受信箇所を `as RequestErrorCode` → `normalizeRequestErrorCode` に置換 | `src/session/bidi.ts`, `src/session.ts`                   |
| PUBLISH_DONE 受信で `normalizePublishDoneCode` 使用                                    | `src/session/bidi.ts`                                     |
| SUBSCRIBE_NAMESPACE_OK で Track Properties 検証追加                                    | `src/session.ts`                                          |
| PUBLISH_NAMESPACE_OK で Track Properties 検証追加                                      | `src/session.ts`                                          |
| REQUEST_UPDATE_OK で Track Properties 検証追加                                         | `src/session/bidi.ts`                                     |
| `decodeProperties` に IMMUTABLE_PROPERTIES 再帰禁止の早期検出追加                      | `src/properties.ts`                                       |
| REQUEST_OK_ALIASES から SUBSCRIBE_OK / FETCH_OK エイリアス削除                         | `src/message/debug.ts`                                    |
| Impl クラスに `goawayCallback` フィールド追加                                          | `src/fetcher.ts`, `src/publisher.ts`, `src/subscriber.ts` |
| リクエストストリーム上 GOAWAY の挙動変更 (closeWithError → callback 呼出)              | `src/session/bidi.ts`                                     |
| PUBLISH_OK / SUBSCRIBE_OK / FETCH_OK 応答で goawayCallback 永続化                      | `src/session/bidi.ts`                                     |
| `classifyIncomingStreamType` に FIRST_OBJECT 範囲 (0x50-0x5F, 0x70-0x7F) 追加          | `src/session/params.ts`                                   |

## 設計方針

既存の `CHANGES.md` `## develop` セクションのエントリ形式に従い、`[ADD]` / `[FIX]` / `[UPDATE]` で適切な種別を選んで追記する。

エントリの例:

```
- [FIX] Grease (§14) に基づき、未知の REQUEST_ERROR / PUBLISH_DONE エラーコードを INTERNAL_ERROR に正規化する
  - normalizeRequestErrorCode / normalizePublishDoneCode を src/error.ts に新設し、全受信箇所に適用する
  - @voluntas
```

## 完了条件

- 上記全変更が `CHANGES.md` の `## develop` セクションに記載されていること
- 種別の順番 (CHANGE → ADD → UPDATE → FIX) が守られていること
- 担当者 (`@voluntas`) が記載されていること

## 解決方法

1. `CHANGES.md` の `## develop` セクションに全変更エントリを追記する
2. 種別順を確認する
