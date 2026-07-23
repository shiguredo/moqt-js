# PUBLISH_BLOCKED を PUBLISH_SKIPPED にリネームする (draft-19 追従)

- Priority: Medium
- Created: 2026-07-07
- Model: Fable 5
- Branch: feature/change-draft-19-publish-skipped
- Polished: 2026-07-23

## 目的

draft-ietf-moq-transport-19 で PUBLISH_BLOCKED が PUBLISH_SKIPPED にリネームされた。変更履歴は Appendix A.1 `#1779` ("Rename PUBLISH_BLOCKED to PUBLISH_SKIPPED")。コードポイント (Type `0xF`) とワイヤフォーマットは不変。

メッセージ定義は Section 10.20 (PUBLISH_SKIPPED)、セマンティクス (いつ送るか・送った後の MUST NOT) は Section 6.1 (Subscribing to Namespaces) にある。混同しないこと。

draft-19 Section 10.20 (PUBLISH_SKIPPED):

> The publisher sends the PUBLISH_SKIPPED control message to indicate
> it will not send a PUBLISH message to initiate a new Subscription for
> a Track in the SUBSCRIBE_TRACKS's Track Namespace.

ワイヤフォーマット:

```
PUBLISH_SKIPPED Message {
  Type (vi64) = 0xF,
  Length (16),
  Track Namespace Suffix (..),
  Track Name Length (vi64),
  Track Name (..),
}
```

draft-19 Section 6.1 (Subscribing to Namespaces):

> If a Subscription cannot be created because there are no available
> bidirectional streams or any other reason, the Publisher sends a
> PUBLISH_SKIPPED message on the SUBSCRIBE_TRACKS response stream to
> indicate the Full Track Name of the Subscription that was not
> created. The Publisher MUST NOT send a PUBLISH for a Track for a
> given SUBSCRIBE_TRACKS after PUBLISH_SKIPPED has been sent, scoped to
> a single PUBLISH.

draft-18 の「利用可能な双方向ストリームがない場合 (cannot send)」から、draft-19 では `"or any other reason"` まで理由が広がっている。抑止のスコープは単一の PUBLISH に限定される (Section 6.1)。

## 優先度根拠

ワイヤ互換は保たれるため相互運用は壊れないが、公開 API 名 (`onPublishBlocked` 等) が仕様用語と乖離すると利用者・実装者の混乱を招く。用語追従のみで済むうちに対応すべきなので Medium。

## 現状

- `src/message/types.ts`: `PUBLISH_BLOCKED: 0x0f`
- `src/message/namespace.ts`: `PublishBlocked` interface、`encodePublishBlockedPayload` / `decodePublishBlockedPayload`
- `src/message/index.ts`: re-export
- `src/session.ts`: 公開コールバック `onPublishBlocked?` (旧 Section 10.20 文言を引用)
- `src/session.ts`: `case MessageType.PUBLISH_BLOCKED` の受信処理
- そのほか PUBLISH_BLOCKED へ言及するコメントが多数

## 設計方針

- 型・定数・関数・コールバック名を PUBLISH_SKIPPED 系にリネームする: `MessageType.PUBLISH_SKIPPED` / `PublishSkipped` / `encodePublishSkippedPayload` / `decodePublishSkippedPayload` / `onPublishSkipped`
- コードポイント `0x0f` とワイヤフォーマットは変更しない
- 公開 API (コールバック名・型名) の破壊的変更となるため、CHANGES.md には破壊的変更であることを明記する
- コメントの引用を次のように分ける:
  - メッセージ定義・"will not send a PUBLISH message to initiate..." → Section 10.20
  - `"or any other reason"` / MUST NOT / `"scoped to a single PUBLISH"` → Section 6.1

## 完了条件

- コードベースに PUBLISH_BLOCKED / PublishBlocked の識別子・コメントが残っていないこと
- リネーム後もエンコード・デコードのワイヤ表現が不変であることをテストで確認していること
- lint / build / typecheck / 既存テストが通ること
