# PUBLISH_BLOCKED を PUBLISH_SKIPPED にリネームする (draft-19 追従)

- Priority: Medium
- Created: 2026-07-07
- Model: Fable 5
- Branch: feature/change-draft-19-publish-skipped
- Polished: 2026-07-23

## 目的

draft-ietf-moq-transport-19 Section 10.20 で、PUBLISH_BLOCKED メッセージが PUBLISH_SKIPPED にリネームされた (draft-18 → 19 変更履歴 "Rename PUBLISH_BLOCKED to PUBLISH_SKIPPED (#1779)")。コードポイント (Type 0xF) とワイヤフォーマットは不変。

draft-19 Section 10.20:

> The publisher sends the PUBLISH_SKIPPED control message to indicate
> it will not send a PUBLISH message

あわせてセマンティクスも微修正されている。draft-18 は「利用可能な双方向ストリームがない場合 (cannot send)」だったが、draft-19 では理由を問わず (will not send / "or any other reason")、また PUBLISH 抑止の効果は単一の PUBLISH にスコープされる:

> The Publisher MUST NOT send a PUBLISH for a Track for a given
> SUBSCRIBE_TRACKS after PUBLISH_SKIPPED has been sent, scoped to a
> single PUBLISH.

## 優先度根拠

ワイヤ互換は保たれるため相互運用は壊れないが、公開 API 名 (`onPublishBlocked` コールバック等) が仕様の用語と乖離すると利用者・実装者の混乱を招く。用語追従のみで済むうちに対応すべきなので Medium。

## 現状

- `src/message/types.ts:42-50`: `PUBLISH_BLOCKED: 0x0f`
- `src/message/namespace.ts:349-354`: `PublishBlocked` interface
- `src/message/namespace.ts:358-373`: `encodePublishBlockedPayload`
- `src/message/namespace.ts:378-392`: `decodePublishBlockedPayload`
- `src/message/index.ts:153, 158, 164`: re-export
- `src/session.ts:619-629`: 公開コールバック `onPublishBlocked?` (draft-18 Section 10.20 の英文を引用)
- `src/session.ts:2268-2275`: `case MessageType.PUBLISH_BLOCKED` の受信処理
- そのほか `src/session.ts:555, 603, 812, 984, 1788, 1924, 2104, 2151` 等に PUBLISH_BLOCKED へ言及するコメント多数

## 設計方針

- 型・定数・関数・コールバック名を PUBLISH_SKIPPED 系にリネームする: `MessageType.PUBLISH_SKIPPED` / `PublishSkipped` / `encodePublishSkippedPayload` / `decodePublishSkippedPayload` / `onPublishSkipped`
- コードポイント 0x0f とワイヤフォーマットは変更しない
- 公開 API (コールバック名・型名) の破壊的変更となるため、CHANGES.md には破壊的変更であることを明記する
- コメントの引用を draft-19 Section 10.20 の文言 ("will not send"、"scoped to a single PUBLISH") に更新する

## 完了条件

- コードベースに PUBLISH_BLOCKED / PublishBlocked の識別子・コメントが残っていないこと
- リネーム後もエンコード・デコードのワイヤ表現が不変であることをテストで確認していること
- lint / build / typecheck / 既存テストが通ること
