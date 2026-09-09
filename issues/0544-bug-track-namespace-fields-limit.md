# Track Namespace の送信時に 32 フィールド上限を検証する

- Created: 2026-09-08
- Completed: YYYY-MM-DD
- Branch: feature/fix-track-namespace-fields-limit
- Polished: 2026-09-09

## 目的

draft-ietf-moq-transport-21 §8.7 (Track Namespace Structure) は「If an endpoint receives a Track Namespace consisting of greater than 32 Track Namespace Fields, it MUST close the session with a PROTOCOL_VIOLATION.」と定める (draft-ietf-moq-transport-21 §2.4.1 (Track Naming) も Track Namespace を「between 0 and 32 Track Namespace Fields」と定める)。送信側で 33 フィールド以上の Track Namespace を組み立てられると、仕様準拠のピアがセッションを閉じてしまい、アプリケーションの入力ミスがプロトコル違反として伝播する。

## 現状

- `src/message/parameter.ts` の `createTrackNamespace` はフィールド長 0 と合計 4,096 バイトのみ検証し、フィールド数上限 32 を検証しない。
- `src/session/params.ts` の `validateTrackNamespaceForSend` は予約 namespace（`.` 始まり）のみ検証し、フィールド数を見ない。
- `src/message/parameter.ts` の `decodeTrackNamespace` は受信側で `MAX_TRACK_NAMESPACE_FIELDS` (32) を検証する。`MAX_TRACK_NAMESPACE_FIELDS` の参照は受信側の 1 箇所のみである。
- 送信経路 `bidiSendNamespaceRequestUpdate` は `validateTrackNamespaceForSend` と `createTrackNamespace` を通すが、33 フィールド以上でも通過する。

## 設計方針

1. `createTrackNamespace` でフィールド数が `MAX_TRACK_NAMESPACE_FIELDS` を超える場合にエラーを投げる。エラーは既存の 4,096 バイト超過と同じく `Error` とし、受信したワイヤの違反用 `ProtocolViolationError` は使わない。
2. 送信検証 `validateTrackNamespaceForSend` にもフィールド数上限を追加し、公開 API 経由の送信を拒否する。エラーは既存の予約 namespace 拒否と同じく `Error` とし、`ProtocolViolationError` は使わない。
3. 受信側 `decodeTrackNamespace` の既存検証は変更しない。
4. 32 フィールドは許可、33 フィールドは拒否するテストを追加する。

## 完了条件

- 33 フィールド以上の Track Namespace を送信できないこと。
- 32 フィールドは送信・エンコードできること。
- 受信側の既存検証が維持されていること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 関連

- draft-ietf-moq-transport-21 §8.7 / §2.4.1
- `createTrackNamespace` / `decodeTrackNamespace` / `MAX_TRACK_NAMESPACE_FIELDS`
- `validateTrackNamespaceForSend`
- `bidiSendNamespaceRequestUpdate`
