# Full Track Name 長など Object/Subgroup 送信時の検証を強化する

- Priority: Medium
- Created: 2026-06-17
- Model: Opus 4.8
- Branch: feature/fix-object-subgroup-validation

## 目的

Object/Subgroup 送信時の各種検証を draft-ietf-moq-transport-18 に従って強化する。具体的には Full Track Name の最大長検証、Object ID の上限検証、`PUBLISH_DONE` 送信後の FIN 送信、`PUBLISH_DONE` 受信後の状態破棄タイミングの改善である。

## 優先度根拠

これらの検証・振る舞いはプロトコル違反やセッション不整合を防ぐため重要だが、通常の使用範囲では即座の障害には繋がりにくい。仕様厳格化の観点から Medium とする。

## 現状

`src/message/parameter.ts` L220-L298:

- Full Track Name (Namespace 全フィールド長 + Track Name 長) の合計が 4096 バイトを超えてはならないが、個別のフィールド長のみをチェックしており、合計値の検証を行っていない (§2.4.1)。

`src/message/publish.ts` L67:

- 関連する検証が不足している可能性がある (詳細はコード確認時に調査)。

`src/session/params.ts` `calculateObjectIdDelta` L356:

- 送信時の Object ID が `2^64-1` を超えた場合、`PROTOCOL_VIOLATION` でセッションを閉じなければならないが、送信側でこの検証を行っていない (§11.4.2)。

`src/session.ts` `sendPublishDone` L3200-L3205:

- `PUBLISH_DONE` メッセージを送信後、ストリームの FIN を送信していない (§10.11 SHOULD)。

`src/session.ts` `bidiHandlePublishDone` L973-L982:

- `PUBLISH_DONE` を受信後、関連する状態を即座に破棄している。draft §5.1.1 に従い、ストリームが閉じられるまで状態を保持すべき場合がある。

## 仕様根拠

draft-ietf-moq-transport-18:

- **§2.4.1 (Full Track Name)**: Full Track Name の長さ (Namespace 全フィールド長 + Track Name 長) は 4096 バイトを超えてはならない (MUST NOT)。
- **§11.4.2 (Subgroup)**: Object ID は `2^64-1` を超えてはならない (MUST NOT)。超えた場合、セッションを `PROTOCOL_VIOLATION` で閉じなければならない。
- **§10.11 (PUBLISH_DONE)**: 送信側は `PUBLISH_DONE` を送信した後、ストリームを FIN するべきである (SHOULD)。
- **§5.1.1 (Session Termination)**: 状態はストリームが閉じられるまで保持すべきである。`PUBLISH_DONE` 受信後も、関連するストリームが完全に閉じられるまでは状態を維持する。

## 設計方針

1. Full Track Name 長の検証:
   - `src/message/parameter.ts` のトラック名/ネームスペース検証関数で、全 namespace フィールド長と track name 長の合計が 4096 バイト以下かをチェックする。
   - 超過時は適切なエラーコードでセッションを閉じるか、エラーを返す。

2. Object ID 上限検証:
   - `src/session/params.ts` の `calculateObjectIdDelta` または `sendObjectInternal` 呼び出し前に、Object ID が `2^64-1` (`18446744073709551615n`) を超えていないかを検証する。
   - 超過時は `PROTOCOL_VIOLATION` で `closeWithError` する。

3. `PUBLISH_DONE` 後の FIN 送信:
   - `sendPublishDone` でメッセージ送信後、writer を close して FIN を送信する。
   - WebTransport writer の `close()` を適切に await し、エラー時はセッション終了処理へ繋げる。

4. `PUBLISH_DONE` 受信後の状態破棄:
   - `bidiHandlePublishDone` で即座に状態を破棄するのではなく、対応するストリームの `closed` promise 等を待ってから破棄する。
   - ただし、リソースリークを防ぐためタイムアウトや既存のクリーンアップ機構と統合する。

5. テスト追加:
   - Full Track Name 長が 4096 バイト境界のケースを検証する。
   - Object ID が `2^64-1` を超えるケースでセッションが `PROTOCOL_VIOLATION` になることを検証する。
   - `PUBLISH_DONE` 送信後に FIN が送信されることを検証する (可能な範囲で)。

## 完了条件

- Full Track Name 長が 4096 バイトを超える場合にエラーとなる
- 送信時の Object ID が `2^64-1` を超える場合に `PROTOCOL_VIOLATION` でセッションが閉じられる
- `PUBLISH_DONE` 送信後に FIN が送信される
- `PUBLISH_DONE` 受信後、ストリームが閉じられるまで状態を保持するようになる
- 上記検証のテストが追加される
- 既存の全テストが PASS する
- `CHANGES.md` に `[FIX]` エントリを追記する
