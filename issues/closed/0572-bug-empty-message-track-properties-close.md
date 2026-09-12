# 空必須メッセージの未知 Mandatory Track Property でセッションを閉じない

- Created: 2026-09-12
- Completed: 2026-09-12
- Branch: feature/fix-empty-message-track-properties-close
- Polished: 2026-09-12

## 目的

draft-ietf-moq-transport-21 §9.3 は「Track Properties are populated in TRACK_STATUS_OK; they are empty in PUBLISH_OK, REQUEST_UPDATE_OK, SUBSCRIBE_NAMESPACE_OK and PUBLISH_NAMESPACE_OK. If an endpoint receives Track Properties in one of these messages it MUST close the session with a PROTOCOL_VIOLATION.」と定める。しかし、未知 Mandatory Track Property (0x4000-0x7FFF) は `decodeProperties` が `MalformedTrackError` を投げ、`toSessionCloseError` が変換しないため catch の一般分岐で reject のみとなり、セッションが閉じない。

## 現状

- `src/session/bidi.ts` の `bidiReadPublishResponse` は、既知 Type の非空 Track Properties を `validateRequestOkNoTrackProperties` で検出して PROTOCOL_VIOLATION で閉じるが、未知 Mandatory Track Property は `decodeRequestOkPayload` の段階で `MalformedTrackError` として throw され、catch の一般分岐で reject のみとなる (`bidiReadPublishResponse` は応答リーダーの `handleMalformedTrack` を定義していない)。
- `bidiReadRequestStreamMessages` の `handleRequestStreamReadError` は `MalformedTrackError` で早期 return するため、close に加えて `rejectPendingRequestUpdates` と role 別の後始末 (publish の `handlePublishPeerCancel` / subscribe の `notifySubscriberFailure`) も一律にスキップされる。
- `src/session/namespaceLoops.ts` の初期 SUBSCRIBE_NAMESPACE_OK 検証 (`namespaceValidateInitialOk`) と PUBLISH_NAMESPACE_OK の検証 (`namespaceStartPublicationStreamLoop` 内) も `decodeRequestOkPayload` を先に呼ぶため、未知 Mandatory Track Property で同じ経路に落ちる。確立後の namespace / tracks ストリームの REQUEST_UPDATE_OK を扱う `handleNamespaceRequestUpdateOk` も同様である。
- 既知 Type の非空 Track Properties を検出する検証 (`namespaceValidateInitialOk` 等) に到達しない点が、既知 Type と未知 Mandatory の扱いの非対称になっている。
- `closeWithError` は `SessionError` を受け取る前提であり、`MalformedTrackError` は `code` を持たないため変換せずに渡すと close コードが失われる。

## 設計方針

1. 空必須メッセージ (PUBLISH_OK / REQUEST_UPDATE_OK / SUBSCRIBE_NAMESPACE_OK / PUBLISH_NAMESPACE_OK) の経路で、Track Properties のデコードが投げる `MalformedTrackError` を `new SessionError(error.message, SessionErrorCode.PROTOCOL_VIOLATION)` に変換し、その同一オブジェクトを pending の reject と `closeWithError` の両方に渡してセッションを閉じる (§9.3 の MUST)。
2. `MalformedTrackError` は SUBSCRIBE_OK / FETCH_OK / データストリームでは §3.6 / §12.1 の cancel を意味するため、共有の `toSessionCloseError` / `toProtocolViolationSessionError` は変更しない。空必須メッセージの経路だけで変換する。
3. Track Properties のデコード自体は現行どおり行う。既知 Type の serialization 不一致は §8.3 の MUST により KEY_VALUE_FORMATTING_ERROR で閉じる現行挙動を維持し、デコード前の残りバイト検査で置き換えない (置き換えると §8.3 の MUST を破り、Track Properties を運べる TRACK_STATUS_OK / SUBSCRIBE_TRACKS_OK まで巻き込む)。
4. 変更対象は、空必須メッセージの Track Properties をデコードする次の地点とする (Track Properties のデコードは各ループ / 応答リーダー内で行われるため、変換も decode の呼び出し元で行う)。
   - PUBLISH_OK: `bidiReadPublishResponse` (`src/session/bidi.ts`) の応答リーダーに `handleMalformedTrack` を定義して閉じる
   - bidi リクエストストリームの確立後 REQUEST_UPDATE_OK: `bidiReadRequestStreamMessages` の `MessageType.REQUEST_OK` 処理 (`src/session/bidi.ts`)。`rejectPendingRequestUpdates` で保留中の更新を reject してから閉じる (`handleRequestStreamReadError` は REQUEST_OK 以外の読み取りエラー用であり、そちらでは閉じない)
   - namespace ストリームの SUBSCRIBE_NAMESPACE_OK / 確立後の REQUEST_UPDATE_OK: `namespaceStartNamespaceStreamLoop` の `decodeRequestOkPayload` 呼び出し (`src/session/namespaceLoops.ts`)。保留中の更新には `rejectPendingNamespaceUpdates` を使う
   - tracks ストリームの確立後の REQUEST_UPDATE_OK: `namespaceStartTracksStreamLoop` の `decodeRequestOkPayload` 呼び出し。保留中の更新には `rejectPendingNamespaceUpdates` を使う (SUBSCRIBE_TRACKS_OK 自体は対象外)
   - publication ストリームの PUBLISH_NAMESPACE_OK: `namespaceStartPublicationStreamLoop` の `decodeRequestOkPayload` 呼び出し (publication ストリームは REQUEST_UPDATE を扱わず、確立後の 2 通目 REQUEST_OK は既存の重複違反として閉じる)
5. SUBSCRIBE_TRACKS_OK は §9.3 の空必須リストに含まれず Track Properties を運べるため対象外とする (`namespaceValidateInitialOk` の `checkTrackProperties = false` を維持する)。
6. 経路ごとの後始末は既存パターンに揃える: pending / requestStreams / fillFetchTargets の削除 → pending の reject → `closeWithError` の順とし、reject と close には同一の `SessionError` を渡す。
7. 未知 Mandatory Track Property を含む各メッセージで close されるテストを追加する。

## 完了条件

- 未知 Mandatory Track Property を含む PUBLISH_OK / REQUEST_UPDATE_OK / SUBSCRIBE_NAMESPACE_OK / PUBLISH_NAMESPACE_OK の応答で PROTOCOL_VIOLATION によりセッションが閉じること。
- 既知 Type の serialization 不一致な Track Properties を含む空必須メッセージは、従来どおり KEY_VALUE_FORMATTING_ERROR で閉じること (§8.3)。
- SUBSCRIBE_TRACKS_OK は Track Properties を運べてセッションを閉じないこと。
- SUBSCRIBE_OK / FETCH_OK / データストリーム / fill の malformed Track Property は、従来どおりセッションを閉じず cancel のみであること (非退行)。
- pending / requestStreams / fillFetchTargets などの state が残留しないこと。
- 上記を検証するテストがあること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。
- `CHANGES.md` の `## develop` に `[FIX]` を追加すること。

## 関連

- draft-ietf-moq-transport-21 §9.3 / §8.3 / §3.6 / §12.1
- `bidiReadPublishResponse` / `bidiReadRequestStreamMessages` / `handleRequestStreamReadError` / `rejectPendingRequestUpdates` (`src/session/bidi.ts`)
- `namespaceValidateInitialOk` / `namespaceStartNamespaceStreamLoop` / `namespaceStartPublicationStreamLoop` / `handleNamespaceRequestUpdateOk` / `rejectPendingNamespaceUpdates` (`src/session/namespaceLoops.ts`)
- `decodeRequestOkPayload` (`src/message/session.ts`) / `decodeProperties` (`src/properties.ts`)
- `MalformedTrackError` / `SessionError` / `SessionErrorCode` (`src/error.ts`)
- `toSessionCloseError` (`src/session/errors.ts`)
- `issues/closed/0567-bug-subscribe-ok-fetch-ok-cross-cancel.md` (MalformedTrackError の cancel 経路。SUBSCRIBE_OK / FETCH_OK でセッションを閉じない非退行条件の根拠)

## 解決方法

空必須メッセージ (PUBLISH_OK / REQUEST_UPDATE_OK / SUBSCRIBE_NAMESPACE_OK / PUBLISH_NAMESPACE_OK) で Track Properties を受信したら PROTOCOL_VIOLATION でセッションを閉じるようにした (draft-ietf-moq-transport-21 §9.3 の MUST)。

- `src/session/errors.ts` に `toTrackPropertiesViolationSessionError` を追加し、未知 Mandatory Track Property (0x4000-0x7FFF) で `decodeProperties` が throw する `MalformedTrackError` を `SessionError(PROTOCOL_VIOLATION)` に変換する。共有の `toSessionCloseError` / `toProtocolViolationSessionError` は変更せず、SUBSCRIBE_OK / FETCH_OK / データストリームの cancel (セッションは閉じない) を維持する
- `src/session/bidi.ts` の `bidiReadPublishResponse` に `handleMalformedTrack` を追加し、PUBLISH_OK で pendingPublish / requestStreams を削除 → reject → close する
- `src/session/bidi.ts` に `handleRequestUpdateOkMessage` を追加し、bidi リクエストストリームの確立後 REQUEST_UPDATE_OK で fill 関連付けを削除 → 保留中の更新を reject → close する (`MalformedTrackError` 以外は再 throw し、既知 Type の serialization 不一致は §8.3 の KEY_VALUE_FORMATTING_ERROR のまま)
- `src/session/namespaceLoops.ts` に `namespaceHandleRequestOkMessage` を追加し、namespace / tracks ループの初期 OK と確立後 REQUEST_UPDATE_OK を処理する (確立後は `rejectPendingNamespaceUpdates` → close)。SUBSCRIBE_TRACKS_OK は §9.3 の空必須一覧に含まれないため対象外とし、従来どおりセッションを閉じない
- `src/session/namespaceLoops.ts` に `namespaceDecodeRequestOkWithoutTrackProperties` を追加し、publication ループの初期 PUBLISH_NAMESPACE_OK を処理する
- テストを 8 件追加した (bidi.test.ts 2 件 / namespaceLoops.test.ts 6 件)。7 件は変更前の実装では失敗し、残り 1 件は SUBSCRIBE_TRACKS_OK の非退行を検証する
- `CHANGES.md` の `## develop` に `[FIX]` を追加した
