# SUBSCRIBE_TRACKS_OK の REQUEST_OK Track Properties 検証を追加する

- Priority: Medium
- Created: 2026-06-03
- Model: deepseek-v4-pro
- Branch: feature/draft-18
- Relations: #0269 (共通関数抽出時に統合対象)

- Polished: 2026-06-03

## 目的

`startTracksStreamLoop` で REQUEST_OK (SUBSCRIBE_TRACKS_OK) を受信した際、Track Properties の空チェックが行われていない。他の 4 つの REQUEST_OK エイリアス (PUBLISH_OK, REQUEST_UPDATE_OK, SUBSCRIBE_NAMESPACE_OK, PUBLISH_NAMESPACE_OK) では検証が実装されている。

draft-ietf-moq-transport-18 §10.5 (REQUEST_OK):

> Track Properties are populated in TRACK_STATUS_OK; they are empty in
> PUBLISH_OK, REQUEST_UPDATE_OK, SUBSCRIBE_NAMESPACE_OK and PUBLISH_NAMESPACE_OK.

SUBSCRIBE_TRACKS は上記リストに明示的には含まれていないが、TRACK_STATUS ではないため Track Properties は空であるべき。

## 優先度根拠

TRACK_STATUS_OK 以外の REQUEST_OK で Track Properties が非空であることは仕様違反。現在 SUBSCRIBE_TRACKS_OK だけ検証が欠落しており、他の 4 つと一貫性がない。

## 現状

- `src/session.ts:2010` の `startTracksStreamLoop` で `decodeRequestOkPayload(messagePayload)` の戻り値が破棄されている
- `requestOk.trackProperties.length > 0` のチェックがない

## 設計方針

他の REQUEST_OK ハンドラと同様に、非空チェックを追加する。

```typescript
const requestOk = decodeRequestOkPayload(messagePayload);
if (requestOk.trackProperties.length > 0) {
  this.closeWithError(
    new SessionError(
      "track properties must be empty in SUBSCRIBE_TRACKS_OK",
      SessionErrorCode.PROTOCOL_VIOLATION,
    ),
  );
  return;
}
```

## 完了条件

- `startTracksStreamLoop` で SUBSCRIBE_TRACKS_OK の Track Properties 非空時に PROTOCOL_VIOLATION でセッションが閉じられること
- テストを追加すること

## 解決方法

1. `src/session.ts` の `startTracksStreamLoop` に Track Properties 非空チェックを追加する
2. テストを追加する（`session.test.ts` または `session.prop.ts` で SUBSCRIBE_TRACKS_OK の Track Properties 非空時に PROTOCOL_VIOLATION を検証）
