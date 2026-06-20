# Full Track Name 長など Object/Subgroup 送信時の検証を強化する

- Priority: Medium
- Created: 2026-06-17
- Model: Opus 4.8
- Branch: feature/fix-object-subgroup-validation
- Polished: 2026-06-20

## 目的

Object/Subgroup 送信時の各種検証を draft-ietf-moq-transport-18 に従って強化する。対象は以下の 4 項目。

## 優先度根拠

これらの検証はプロトコル違反やセッション不整合を防ぐために重要だが、通常の使用範囲では即座の障害につながらない。仕様厳格化の観点から Medium とする。

## 問題と修正内容

### 1. Full Track Name 長の合計値検証 (`src/message/parameter.ts`)

`MAX_TRACK_NAMESPACE_SIZE` と `MAX_TRACK_NAME_SIZE` がそれぞれ 4096 バイトで定義されているが、Full Track Name（Namespace 全フィールド長 + Track Name 長の合計）が 4096 バイトを超えてはならないという §2.4.1 の MUST NOT 要件に対し、合計値の検証が行われていない。個別フィールド長のみのチェックになっているため、namespace=4096 + name=4096 = 8192 バイトの Full Track Name が通過しうる。

修正: `parameter.ts` に `validateFullTrackName(namespace: TrackNamespace, trackName: string): void` を新設し、両者の合計長が 4096 バイトを超えた場合に `ProtocolViolationError` を throw する。呼び出し側（`subscribe()` / `fetch()` / `publish()` / `trackStatus()` 等、TrackNamespace と TrackName の両方を処理する全メソッド）で使用する。

### 2. Object ID 上限検証 (`src/session.ts`)

`sendObjectInternal` で送信する Object ID が `2^64-1` (`18446744073709551615n`) を超えた場合、§11.4.2 の MUST NOT に基づき `PROTOCOL_VIOLATION` でセッションを閉じなければならないが、送信側でこの検証を行っていない。受信側（`stream.ts` L156-162）では既に検証済み。

修正: `sendObjectInternal` の Object ID Delta 計算前に `objectId > maxObjectId` をチェックし、超過時は `this.closeWithError(new SessionError(..., SessionErrorCode.PROTOCOL_VIOLATION))` を直接呼び出す。単に throw すると `sendObject` の `.catch()` → `publisher.handleError()` に流れてセッション閉鎖に至らないため注意。定数 `maxObjectId`（`(1n << 64n) - 1n`）は `stream.ts` / `dataStream.ts` で既に定義済みの再利用または共通化を検討する。

### 3. PUBLISH_DONE 送信後の FIN 送信 (`src/session.ts` L3168-3205)

`sendPublishDone` は `streamInfo.writer.write(message)` で PUBLISH_DONE メッセージを書き込むが、writer の close（FIN 送信）を行っていない。§10.11 では publisher が PUBLISH_DONE を最後のメッセージとして送信した後に bidi ストリームを閉じる。

修正: `writer.write(message)` 成功後、`await writer.close()` を追加し、次に `this.requestStreams.delete(requestId)` でエントリを除去する。writer.close() 失敗は catch し、`this.closeWithError` でセッションを閉じる。

### 4. PUBLISH_DONE 受信後の状態破棄タイミング (`src/session/bidi.ts` L966-982)

`bidiHandlePublishDone` で PUBLISH_DONE 受信後、即座に `subscribers` と `subscribersByAlias` から削除している。§5.1 (Subscriptions) に従い、ストリームが閉じられるまで状態を保持すべき。

修正: `bidiHandlePublishDone` から `subscribers.delete()` / `subscribersByAlias.delete()` を除去する。代わりに `bidiReadRequestStreamMessages` の finally ブロック（`bidi.ts` L752-754）に `subscribers.delete(requestId)` / `subscribersByAlias.delete(trackAlias)` を追加し、ストリーム close 時に削除する。`handleEnd()` による subscriber 内部状態のクローズは PUBLISH_DONE 受信時に即時行ってよい。

## 仕様根拠

draft-ietf-moq-transport-18:

- **§2.4.1 (Full Track Name)**: Full Track Name の長さ（Namespace 全フィールド長 + Track Name 長）は 4096 バイトを超えてはならない (MUST NOT)
- **§11.4.2 (Subgroup)**: Object ID は `2^64-1` を超えてはならない (MUST NOT)。超えた場合 `PROTOCOL_VIOLATION` でセッションを閉じる
- **§10.11 (PUBLISH_DONE)**: publisher は PUBLISH_DONE を最後のメッセージとして送信した後、subscription の bidi ストリームを閉じる (SHOULD)
- **§5.1 (Subscriptions)**: サブスクリプションの状態はストリームが閉じられるまで保持すべき

## 設計方針

実装順序: 項目 3（PUBLISH_DONE FIN）→ 項目 4（状態破棄タイミング）の順で行う。FIN が送信されなければ受信側の read loop は `done = true` にならず、Map 削除が遅延するため。

## 変更対象ファイル

- `src/message/parameter.ts`: Full Track Name 合計長の検証を追加する
- `src/session.ts`: Object ID 上限検証を追加する（`sendObjectInternal` の `calculateObjectIdDelta` 呼び出し前）、`sendPublishDone` に writer.close() を追加する
- `src/session/bidi.ts`: `bidiHandlePublishDone` の状態破棄タイミングを調整する
- `CHANGES.md` に `[FIX]` エントリを追記する

## 完了条件

- Full Track Name 長が 4096 バイトを超える場合にエラーとなる
- 送信時の Object ID が `2^64-1` を超える場合に `PROTOCOL_VIOLATION` でセッションが閉じられる
- `PUBLISH_DONE` 送信後に FIN が送信される
- `PUBLISH_DONE` 受信後、ストリームが閉じられるまで状態が保持される
- 既存の全テストが PASS する
- `CHANGES.md` に `[FIX]` エントリが追記される

## テスト方針

- 既存の全テストが PASS することを必須とする
- 項目 1: `parameter.test.ts` に `validateFullTrackName` のテストを追加する（合計 4097 バイトでエラー、4096 バイトで通過）
- 項目 2: Object ID 境界値テスト（`objectId = 2^64 - 1` で通過、`objectId = 2^64` で PROTOCOL_VIOLATION）を追加する
- 項目 3: PUBLISH_DONE 送信後の writer.close() 呼び出しと requestStreams 削除は結合テストで検証する
- 項目 4: `bidi.test.ts` に PUBLISH_DONE 受信後も subscriber が Map に残っていることのテストを追加する
