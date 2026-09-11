# KEY_VALUE_FORMATTING_ERROR でセッションを閉じる経路を実装する

- Created: 2026-09-09
- Completed: 2026-09-11
- Branch: feature/fix-key-value-formatting-error-session-close
- Polished: 2026-09-11

## 目的

draft-ietf-moq-transport-21 §8.3 は、既知 Type の Value / Length が仕様の serialization に一致しない場合、KEY_VALUE_FORMATTING_ERROR でセッションを閉じる MUST を定める。issue 0558 の適合監査 (改善-1) で `src/properties.ts` は `SessionError(KEY_VALUE_FORMATTING_ERROR)` を送出するようになったが、受信経路の変換が `SessionError` を扱わないためセッションが閉じられない。

## 現状

- `src/session/errors.ts` の `toProtocolViolationSessionError` は `ProtocolViolationError` / `IncompleteDataError` のみを `PROTOCOL_VIOLATION` に変換し、`SessionError` は null を返す (既存テストで保証)。
- `src/properties.ts` の `decodeKnownPropertyVarint` が送出する `SessionError(KEY_VALUE_FORMATTING_ERROR)` は、Track Properties を厳密デコードする次の受信経路の catch でセッションクローズに伝播しない。
  1. `SessionImpl.handleIncomingBidirectionalStream` の `decodePublishPayload` catch (`src/session.ts`、受信 PUBLISH)
  2. `bidiReadPublishResponse` (`src/session/bidi.ts`、PUBLISH_OK)
  3. `bidiReadSubscribeResponse` (`src/session/bidi.ts`、SUBSCRIBE_OK)
  4. `bidiReadFetchResponse` (`src/session/bidi.ts`、FETCH_OK)
  5. `bidiReadTrackStatusResponse` (`src/session/bidi.ts`、TRACK_STATUS_OK)
  6. `handleRequestStreamReadError` (`src/session/bidi.ts`。`bidiReadRequestStreamMessages` の catch から呼ばれ、subscribe ロールの REQUEST_UPDATE_OK を含む)
  7. `namespaceStartNamespaceStreamLoop` / `namespaceStartTracksStreamLoop` / `namespaceStartPublicationStreamLoop` (`src/session/namespaceLoops.ts` の各 OK)
  8. `SessionImpl.runPublishStreamSubLoop` の catch (`src/session.ts`。受信 PUBLISH ストリーム上の REQUEST_UPDATE_OK)
- データストリーム / datagram は `decodeObjectPropertiesTolerant` 経由で `SessionError` を送出しない。制御ストリーム (GOAWAY) にも Key-Value-Pair は無い。これらは対象外。

## 設計方針

1. `src/session/errors.ts` に、`SessionError` はそのまま返し、`ProtocolViolationError` / `IncompleteDataError` は従来どおり `PROTOCOL_VIOLATION` に変換する新ヘルパー (例: `toSessionCloseError`) を追加する。既存の `toProtocolViolationSessionError` の意味は変えない。
2. 現状に列挙した 8 経路の catch で `toProtocolViolationSessionError` を新ヘルパーに置き換え、`SessionError` を検出したらそのコードで `closeWithError` する。
3. 各経路の後始末は、同一経路の既存 `ProtocolViolationError` / `IncompleteDataError` 分岐と同一の順序・削除集合に揃える。pending / 保留中の更新を具体エラーで reject してから閉じる既存分岐 (受信応答読み取り 4 経路、`bidiHandleRequestUpdateOk` の違反分岐) では、SessionError 経路でも同一 `SessionError` オブジェクトで reject してから閉じる (closed issue 0470 の順序契約を維持)。`handleRequestStreamReadError` のように既存分岐が close のみの経路は close のみとする。
4. 既存テストの期待 (`toProtocolViolationSessionError` が `SessionError` を null として返す) は変更しない。

## 完了条件

- 現状に列挙した全経路で、既知 Type の Value / Length が varint として完結しない Track Properties を受信すると KEY_VALUE_FORMATTING_ERROR でセッションが閉じること。
- pending / 保留中の更新を具体エラーで reject してから閉じる経路では、`closeWithError` に渡す `SessionError` と同一オブジェクトで reject してから閉じること (closed issue 0470 の契約)。
- 上記を検証するテストがあること。受信経路のテストは `src/session/bidi.test.ts` / `src/session/namespaceLoops.test.ts` / `src/session.test.ts` の既存の受信駆動テストパターンに合わせる。
- `CHANGES.md` の `## develop` に `[FIX]` があること。
- `vp check` / `tsc --noEmit` / `vp test run` が通る。

## 参照

- `refs/moq/draft-ietf-moq-transport-21.txt` §8.3 (Key-Value-Pair Structure) / §12.2 (KEY_VALUE_FORMATTING_ERROR)
- 監査: issue 0558 の適合監査 (改善-1)
- `issues/closed/0470-bug-response-scope-violation-error-loss.md` (pending reject → close の順序契約)
- `issues/closed/0409-bug-publish-stream-request-update-decode-failure.md` (受信経路の decode 失敗の対応方式)

## 解決方法

- `src/session/errors.ts` に `toSessionCloseError` を追加した。`SessionError` は同一オブジェクトのまま返し、`ProtocolViolationError` / `IncompleteDataError` は `PROTOCOL_VIOLATION` の `SessionError` に変換し、それ以外は null を返す。既存の `toProtocolViolationSessionError` の意味は変えていない
- 現状に列挙した受信 8 経路の catch を新ヘルパーに置き換え、既知 Type の Value / Length が varint として完結しない Track Properties を受信したら `KEY_VALUE_FORMATTING_ERROR` でセッションを閉じるようにした
- 受信応答読み取り 4 経路 (`bidiReadPublishResponse` / `bidiReadSubscribeResponse` / `bidiReadFetchResponse` / `bidiReadTrackStatusResponse`) は、`closeWithError` に渡す `SessionError` と同一オブジェクトで pending を reject してから閉じる順序契約を維持した。`handleRequestStreamReadError` は既存どおり close のみとした
- 上記を検証するテストを 15 件追加した (`src/session/errors.test.ts` / `src/session/bidi.test.ts` / `src/session/namespaceLoops.test.ts` / `src/session.test.ts`)
- `CHANGES.md` の `## develop` に `[FIX]` を追記した
