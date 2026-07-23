# PUBLISH_BLOCKED を PUBLISH_SKIPPED にリネームする (draft-19 追従)

- Priority: Medium
- Created: 2026-07-07
- Model: Fable 5
- Branch: feature/change-draft-19-publish-skipped
- Polished: 2026-07-23

## 目的

draft-ietf-moq-transport-19 で PUBLISH_BLOCKED が PUBLISH_SKIPPED にリネームされた。変更履歴は Appendix A.1 `#1779`。コードポイント (Type `0xF`) とワイヤフォーマットは不変。

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

draft-18 の「利用可能な双方向ストリームがない場合」から、draft-19 では `"or any other reason"` まで理由が広がっている。抑止のスコープは単一の PUBLISH に限定される (Section 6.1)。

## 優先度根拠

ワイヤ互換は保たれるため相互運用は壊れないが、公開 API 名 (`onPublishBlocked` 等) が仕様用語と乖離すると利用者・実装者の混乱を招く。用語追従のみで済むうちに対応すべきなので Medium。

## 現状

- `src/message/types.ts`: `PUBLISH_BLOCKED: 0x0f`（仕様表記 `0xF` と同一値）。コメントにコード由来の古い「Request ID を割り当てられない場合」説明が残る（draft-18 Section 6.1 時点ですでに「no available bidirectional streams」、draft-19 はさらに `"or any other reason"`。いずれも Request ID ではない）
- `src/message/namespace.ts`: `PublishBlocked` / `encodePublishBlockedPayload` / `decodePublishBlockedPayload`。同ファイルにも上記 Request ID 説明と、隣接コメント内の `PUBLISH_BLOCKED` 言及がある
- `src/message/index.ts`: 上記を re-export
- `src/session.ts`: `TracksSubscriptionCallbacks.onPublishBlocked?`、`case MessageType.PUBLISH_BLOCKED` の受信処理（受信のみ。`encodePublishBlockedPayload` の呼び出しは無く送信 API は無い）。識別子以外の JSDoc / インラインコメントにも `PUBLISH_BLOCKED` が多数ある
- `src/message/namespace.prop.ts`: ヘッダに `PUBLISH_BLOCKED` 言及があるが、encode/decode の PBT 本体は無い
- `README.md`: コントロールメッセージ一覧に `PUBLISH_BLOCKED` が残る
- `devtools/` / `examples/` / `src/**/*.test.ts` に旧識別子の参照は無い（変更不要）

## 設計方針

- 型・定数・関数・コールバック名を PUBLISH_SKIPPED 系にリネームする: `MessageType.PUBLISH_SKIPPED` / `PublishSkipped` / `encodePublishSkippedPayload` / `decodePublishSkippedPayload` / `onPublishSkipped`
- コードポイント `0x0f`（仕様 `0xF`）とワイヤフォーマットは変更しない。送信経路の新設はしない（受信 + encode ヘルパのリネームのみ）
- 公開 API の主破壊面は `TracksSubscriptionCallbacks.onPublishBlocked` → `onPublishSkipped`（`src/index.ts` 経由で公開）。型・encode/decode 名も合わせてリネームする。`CHANGES.md` に `[CHANGE]` で明記する
- コメントの引用を次のように分ける:
  - メッセージ定義・"will not send a PUBLISH message to initiate..." → Section 10.20（draft-18 の "cannot send" 引用は残さない）
  - `"or any other reason"` / MUST NOT / `"scoped to a single PUBLISH"` → Section 6.1
  - コードに残る古い「Request ID」説明は削除する（仕様史ではなく誤ったコメントの除去）
- 本変更で編集するファイル内の識別子・コメント（散文・インライン含む）の旧名はここですべて `PUBLISH_SKIPPED` 系にする。未編集ファイルの `draft-ietf-moq-transport-18` 版文字列の一括置換だけ `#0343`（メッセージ名リネームの受け皿ではない）

## 完了条件

- 本 issue の変更対象ファイル（`types.ts` / `namespace.ts` / `index.ts` / `session.ts` / `namespace.prop.ts` / `README.md`）から `PUBLISH_BLOCKED` / `PublishBlocked` / `onPublishBlocked` / `encodePublishBlocked*` / `decodePublishBlocked*` が消えていること（過去の `CHANGES.md` 履歴エントリ・`issues/` は対象外）
- `src/message/namespace.prop.ts` に `PublishSkipped` の encode/decode ラウンドトリップ PBT があること（既存 Namespace 系と同型のフィールド一致。`MessageType.PUBLISH_SKIPPED === 0x0f` を維持していること。リネーム後に旧シンボルは無いので「リネーム前後バイト比較」は不要）
- `CHANGES.md` の `## develop` に公開 API 破壊を含む `[CHANGE]` があること（例: `[CHANGE] PUBLISH_BLOCKED を PUBLISH_SKIPPED にリネームする`）
- lint / build / typecheck / 既存テストが通ること

## 解決方法

1. `src/message/types.ts`: `PUBLISH_BLOCKED` → `PUBLISH_SKIPPED`（値 `0x0f` 維持）。当該定数コメントを Section 10.20 / 必要なら 6.1 に更新。同ファイル内の隣接コメント（例: `SUBSCRIBE_TRACKS` 説明内の旧名）も置換
2. `src/message/namespace.ts`: 型・encode/decode を Skipped 名にリネーム。ワイヤ・フィールドは不変。ファイルヘッダ・Request ID 説明・隣接コメントの旧名も更新 / 削除
3. `src/message/index.ts`: re-export を新名に合わせる
4. `src/session.ts`: import・`onPublishSkipped`・`case MessageType.PUBLISH_SKIPPED`・コールバック JSDoc（10.20 の "will not send"）に加え、同ファイル内の旧名コメントをすべて置換
5. `src/message/namespace.prop.ts`: ヘッダ更新。`encodePublishSkippedPayload` / `decodePublishSkippedPayload` のラウンドトリップ PBT を追加（既存 Namespace 系と同型）
6. `README.md`: コントロールメッセージ一覧を `PUBLISH_SKIPPED` に更新
7. `CHANGES.md`: `[CHANGE] PUBLISH_BLOCKED を PUBLISH_SKIPPED にリネームする` を追記（`onPublishBlocked` → `onPublishSkipped` を箇条書き）
8. `vp check` / `tsc --noEmit` / `vp test run` で確認
