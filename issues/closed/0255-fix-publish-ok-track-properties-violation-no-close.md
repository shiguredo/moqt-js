# PUBLISH_OK の Track Properties 違反時にセッションが閉じられない問題を修正する

- Priority: High
- Created: 2026-06-03
- Model: deepseek-v4-pro
- Branch: feature/draft-18
- Polished: 2026-06-03
- Relations: #0235 (先行 FIX), #0269 (共通化リファクタリング)

## 目的

`decodePublishOkPayload` が Track Properties 非空を検出して `ProtocolViolationError` を throw するが、呼び出し元 `bidiReadPublishResponse` の catch 節が `pending.reject()` のみを行い、`session.closeWithError()` を呼んでいない。仕様で MUST と規定されているセッションクローズが行われない。

draft-ietf-moq-transport-18 §10.5 (REQUEST_OK):

> Track Properties are populated in TRACK_STATUS_OK; they are empty in PUBLISH_OK,
> REQUEST_UPDATE_OK, SUBSCRIBE_NAMESPACE_OK and PUBLISH_NAMESPACE_OK.
> If an endpoint receives Track Properties in one of these messages it MUST
> close the session with a PROTOCOL_VIOLATION.

なお `bidiReadSubscribeResponse` / `bidiReadFetchResponse` / `bidiReadTrackStatusResponse` でも、
`decodeGoawayPayload` 等が throw する `ProtocolViolationError` が同様に catch 節で握り潰される
が、これらは GOAWAY 側の検証不足に起因し、本 issue のスコープ外（#0257, #0258, #0259 で対応）。

## 優先度根拠

MUST 違反検出時にセッションを閉じないのはプロトコル準拠違反であり、致命的。即時修正が必要。

## 現状

- `src/message/publish.ts` の `decodePublishOkPayload` は独自に `decodeParameters` + `decodeProperties` を呼び、末尾で Track Properties 非空チェック (`trackProperties.length > 0` → `ProtocolViolationError`) を行う
- `src/session/bidi.ts` の `bidiReadPublishResponse` で `decodePublishOkPayload(msg.payload)` を呼び、RE 節の catch は `pending.reject()` のみで `closeWithError` なし
- 正しい先行実装: `bidiHandleRequestUpdateOk` (bidi.ts:800-820) は呼び出し側で `decodeRequestOkPayload` → `msg.trackProperties.length > 0` チェック → `closeWithError(PROTOCOL_VIOLATION)` を実装済み
- `decodePublishOkPayload` と `decodeRequestOkPayload` (session.ts:291-303) は独立した実装だが、decode するワイヤーフォーマットは同一（REQUEST_OK 構造）

## 設計方針

`bidiHandleRequestUpdateOk` に揃え、呼び出し側 (`bidiReadPublishResponse`) で `decodeRequestOkPayload` を使い、Track Properties 非空チェックと `closeWithError` を行う。

`decodePublishOkPayload` は存廃を以下の方針で決める:

- **選択**: `decodePublishOkPayload` を削除し、全使用箇所で `decodeRequestOkPayload` に統一する
- 理由: 両者は同一ワイヤーフォーマットのパーサであり、重複を許容する意義がない
- 既存の `encodePublishOkPayload` は存続（エンコード側は `encodeParameters` + `encodeProperties` の組み合わせで一意）
- `publish.prop.ts` 内の `decodePublishOkPayload` 呼び出しを `decodeRequestOkPayload` に置き換える
- `ProtocolViolationError` import を `publish.ts` から削除する

`closeWithError` と同時に `pending.reject()` も呼ぶ。`bidiReadSubscribeResponse` / `bidiReadFetchResponse` の既存パターンに従う。

```typescript
// bidiReadPublishResponse の修正後:
if (msg.type === MessageType.REQUEST_OK) {
  const decoded = decodeRequestOkPayload(msg.payload);
  if (decoded.trackProperties.length > 0) {
    const error = new SessionError(
      "track properties must be empty in PUBLISH_OK",
      SessionErrorCode.PROTOCOL_VIOLATION,
    );
    session.pendingPublish.delete(requestId);
    session.requestStreams.delete(requestId);
    pending.reject(error);
    session.closeWithError(error);
    return;
  }
  pending.impl.goawayCallback = pending.goawayCallback;
  session.pendingPublish.delete(requestId);
  session.publishers.set(requestId, pending.impl);
  const forwardState = extractForwardState(decoded.parameters);
  pending.impl.setForwardState(forwardState);
  pending.resolve(pending.impl);
  void bidiReadRequestStreamMessages(session, requestId, stream, controlReader);
}
```

エラーメッセージは小文字始まり、全 REQUEST_OK エイリアス検証で `"track properties must be empty in <CONTEXT>"` に統一する。#0269 の共通化時に抽出対象とする。

## 完了条件

- `bidiReadPublishResponse` で PUBLISH_OK の Track Properties 非空時に `PROTOCOL_VIOLATION` でセッションが閉じられ、かつ `pending.reject()` が呼ばれること
- `decodePublishOkPayload` 関数を削除し、全使用箇所を `decodeRequestOkPayload` に置き換えること
- `publish.prop.ts` のテストを修正し、全テストがパスすること
- `src/session/bidi.test.ts` に Track Properties 非空受信 → `closeWithError` のテストを追加すること
- エラーメッセージが `"track properties must be empty in PUBLISH_OK"` であること（小文字始まり）

## 解決方法

1. `src/session/bidi.ts` の `bidiReadPublishResponse` の REQUEST_OK 分岐で Track Properties 非空チェックを追加し、違反時は `closeWithError(PROTOCOL_VIOLATION)` + `pending.reject()` を呼ぶ
2. `src/message/publish.ts` の `decodePublishOkPayload` 関数を削除し、`ProtocolViolationError` import を削除する
3. `src/message/publish.prop.ts` の `decodePublishOkPayload` 呼び出しを `decodeRequestOkPayload` に置き換える
4. `src/session/bidi.test.ts` に Track Properties 非空 PUBLISH_OK 受信時の異常系テストを追加する
