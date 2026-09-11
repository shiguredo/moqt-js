# 空必須メッセージの未知 Mandatory Track Property でセッションを閉じない

- Created: 2026-09-12
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-empty-message-track-properties-close
- Polished: {YYYY-MM-DD}

## 目的

draft-ietf-moq-transport-21 §9.3 は「Track Properties are populated in TRACK_STATUS_OK; they are empty in PUBLISH_OK, REQUEST_UPDATE_OK, SUBSCRIBE_NAMESPACE_OK and PUBLISH_NAMESPACE_OK. If an endpoint receives Track Properties in one of these messages it MUST close the session with a PROTOCOL_VIOLATION.」と定める。しかし、未知 Mandatory Track Property (0x4000-0x7FFF) は `decodeProperties` が `MalformedTrackError` を投げ、`toSessionCloseError` が変換しないため catch の一般分岐で reject のみとなり、セッションが閉じない。

## 現状

- `src/session/bidi.ts` の `bidiReadPublishResponse` は、既知 Type の非空 Track Properties を `decoded.trackProperties.length > 0` で検出して PROTOCOL_VIOLATION で閉じるが、未知 Mandatory Track Property は `decodeRequestOkPayload` の段階で `MalformedTrackError` として throw され、catch の一般分岐で reject のみとなる。
- `bidiReadRequestStreamMessages` の `handleRequestStreamReadError` も `MalformedTrackError` を close せず、対象によっては保留中の更新も reject しない。
- `src/session/namespaceLoops.ts` の初期 SUBSCRIBE_NAMESPACE_OK / PUBLISH_NAMESPACE_OK 検証も `decodeRequestOkPayload` を先に呼ぶため、未知 Mandatory Track Property で同じ経路に落ちる。
- 既知 Type の非空 Track Properties を検出する検証 (`namespaceValidateInitialOk` 等) に到達しない点が、既知 Type と未知 Mandatory の扱いの非対称になっている。

## 設計方針

1. 空必須メッセージ (PUBLISH_OK / REQUEST_UPDATE_OK / SUBSCRIBE_NAMESPACE_OK / PUBLISH_NAMESPACE_OK) では、`MalformedTrackError` を PROTOCOL_VIOLATION のセッションクローズにマップする。または、Track Properties のデコード前に残りバイトの非空を検査して close する。
2. 対象メッセージを横断的に整理し、経路ごとの削除集合・reject・close の順序を既存パターンに揃える。
3. 未知 Mandatory Track Property を含む各メッセージで close されるテストを追加する。

## 完了条件

- 未知 Mandatory Track Property を含む PUBLISH_OK / REQUEST_UPDATE_OK / SUBSCRIBE_NAMESPACE_OK / PUBLISH_NAMESPACE_OK の応答で PROTOCOL_VIOLATION によりセッションが閉じること。
- pending / requestStreams などの state が残留しないこと。
- 上記を検証するテストがあること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。
- `CHANGES.md` の `## develop` に `[FIX]` を追加すること。

## 関連

- draft-ietf-moq-transport-21 §9.3 / §8.3
- `bidiReadPublishResponse` / `handleRequestStreamReadError` (`src/session/bidi.ts`)
- `namespaceValidateInitialOk` (`src/session/namespaceLoops.ts`)
- `decodeProperties` / `MalformedTrackError` (`src/properties.ts` / `src/error.ts`)
- `toSessionCloseError` (`src/session/errors.ts`)
- `issues/closed/0567-bug-subscribe-ok-fetch-ok-cross-cancel.md` (MalformedTrackError の cancel 経路)
