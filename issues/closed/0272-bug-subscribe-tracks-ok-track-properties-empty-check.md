# SUBSCRIBE_TRACKS_OK の Track Properties 空チェックを削除する

- Priority: High
- Created: 2026-06-03
- Model: deepseek-v4-pro
- Branch: feature/draft-18
- Polished: 2026-06-03
- Completed: 2026-06-03

## 目的

`startTracksStreamLoop` 内で `validateRequestOkNoTrackProperties` を呼び出し、SUBSCRIBE_TRACKS_OK 応答の Track Properties 非空時に PROTOCOL_VIOLATION でセッションを閉じている。しかし仕様 §10.5 で空を MUST で要求しているのは `PUBLISH_OK` / `REQUEST_UPDATE_OK` / `SUBSCRIBE_NAMESPACE_OK` / `PUBLISH_NAMESPACE_OK` の 4 つのみであり、`SUBSCRIBE_TRACKS_OK` は含まれていない。この検証を削除する。

## 優先度根拠

正当な Track Properties を含む SUBSCRIBE_TRACKS_OK 応答が PROTOCOL_VIOLATION (0x3) で接続断になる。相互運用性に致命的な影響がある。仕様 §10.5 が定義する空必須一覧に SUBSCRIBE_TRACKS_OK は列挙されていない。

## 現状

`src/session.ts:2059-2068` (`startTracksStreamLoop`):

```typescript
const requestOk = decodeRequestOkPayload(messagePayload);
if (
  !bidi.validateRequestOkNoTrackProperties(
    requestOk.trackProperties,
    "SUBSCRIBE_TRACKS_OK",
    (error) => this.closeWithError(error),
  )
) {
  return;
}
```

draft-ietf-moq-transport-18 §10.5:

> Track Properties are populated in TRACK_STATUS_OK; they are empty in
> PUBLISH_OK, REQUEST_UPDATE_OK, SUBSCRIBE_NAMESPACE_OK and PUBLISH_NAMESPACE_OK.
> If an endpoint receives Track Properties in one of these messages it MUST
> close the session with a PROTOCOL_VIOLATION.

注意: `PUBLISH_NAMESPACE_OK` と `SUBSCRIBE_NAMESPACE_OK` の空チェックは引き続き有効 (仕様に明記されている)。

## 設計方針

- `src/session.ts:2060-2068` の `validateRequestOkNoTrackProperties` 呼び出しブロック全体を削除する
- SUBSCRIBE_TRACKS_OK では Track Properties が非空でもそのまま受容し、上位の `TracksSubscriptionCallbacks` 経由で通知する

## 完了条件

- `startTracksStreamLoop` 内の SUBSCRIBE_TRACKS_OK Track Properties 空検証が削除されている
- `startTracksStreamLoop` (`SUBSCRIBE_NAMESPACE_OK`) と `startNamespacePublicationStreamLoop` (`PUBLISH_NAMESPACE_OK`) の空検証はそのまま維持されている
- 関連テストが PASS する

## 解決方法

`src/session.ts` の `startTracksStreamLoop` メソッド内、SUBSCRIBE_TRACKS_OK 応答処理 (`case MessageType.REQUEST_OK`) から `decodeRequestOkPayload` 呼び出しと `validateRequestOkNoTrackProperties` による Track Properties 空検証ブロック (10 行) を削除した。削除後も `resolved = true` → `resolve(tracksSubscription)` の順序は維持されている。

仕様 §10.5 で Track Properties 空を MUST で要求しているのは PUBLISH_OK / REQUEST_UPDATE_OK / SUBSCRIBE_NAMESPACE_OK / PUBLISH_NAMESPACE_OK の 4 つのみであり、SUBSCRIBE_TRACKS_OK は含まれていないため。

変更ファイル: `src/session.ts` (10 行削除)。全テスト 624/624 PASS 確認済み。
