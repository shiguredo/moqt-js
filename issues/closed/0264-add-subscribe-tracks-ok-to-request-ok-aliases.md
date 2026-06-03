# REQUEST_OK_ALIASES から SUBSCRIBE_TRACKS_OK が欠落しているのを修正する

- Priority: Medium
- Created: 2026-06-03
- Model: deepseek-v4-pro
- Branch: feature/draft-18
- Polished: 2026-06-03
- Completed: 2026-06-03

## 目的

`src/message/debug.ts` の `REQUEST_OK_ALIASES` から `SUBSCRIBE_TRACKS` のエントリが削除されている。SUBSCRIBE_TRACKS への応答は REQUEST_OK (0x07) であり、デバッグ表示用のエイリアスが必要。

draft-ietf-moq-transport-18 §10.5 (REQUEST_OK):

> The REQUEST_OK message is sent in response to PUBLISH, REQUEST_UPDATE,
> TRACK_STATUS, SUBSCRIBE_NAMESPACE, SUBSCRIBE_TRACKS and PUBLISH_NAMESPACE requests.

## 優先度根拠

SUBSCRIBE と FETCH をエイリアスから削除したのは正しい（独立したメッセージタイプ 0x04 / 0x18 のため）が、SUBSCRIBE_TRACKS は REQUEST_OK のエイリアスであり、デバッグ表示で "SUBSCRIBE_TRACKS_OK" と表示されるべき。

## 現状

- `src/message/debug.ts:23-29` の `REQUEST_OK_ALIASES` に `[MessageType.SUBSCRIBE_TRACKS]: "SUBSCRIBE_TRACKS_OK"` が存在しない
- コメントにも削除理由が記載されていない

## 設計方針

`[MessageType.SUBSCRIBE_TRACKS]: "SUBSCRIBE_TRACKS_OK"` を `REQUEST_OK_ALIASES` に追加する。

## 完了条件

- `REQUEST_OK_ALIASES` に SUBSCRIBE_TRACKS_OK が追加されていること
- デバッグ表示で SUBSCRIBE_TRACKS への REQUEST_OK 応答が "SUBSCRIBE_TRACKS_OK" と表示されること

## 解決方法

1. `src/message/debug.ts` の `REQUEST_OK_ALIASES` に `[MessageType.SUBSCRIBE_TRACKS]: "SUBSCRIBE_TRACKS_OK"` を追加する
