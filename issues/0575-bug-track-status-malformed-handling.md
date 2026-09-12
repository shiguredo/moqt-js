# TRACK_STATUS_OK の malformed 応答で cross-cancel とストリーム後始末が行われない

- Created: 2026-09-12
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-track-status-malformed-handling
- Polished: 2026-09-12

## 目的

draft-ietf-moq-transport-21 §9.13 は「The receiver of a TRACK_STATUS message treats it identically as if it had received a SUBSCRIBE message, except it does not create downstream subscription state or send any Objects. If successful, the publisher responds with a TRACK_STATUS_OK with the same parameters and Track Properties it would have set in a SUBSCRIBE_OK.」と定める。TRACK_STATUS の requester も購読者として扱われ、TRACK_STATUS_OK は SUBSCRIBE_OK と同じ Track Properties を運ぶため、未知 Mandatory Track Property (0x4000-0x7FFF) を TRACK_STATUS_OK で受信することは §12.1 の malformed Track の検出に当たる。§12.1 は「When a subscriber detects a Malformed Track, it MUST cancel any corresponding subscription or fetches for that Track from that publisher (see Section 6.4.2.3), and SHOULD deliver an error to the application.」と定めるが、現状は pending の reject のみで、bidi ストリームの FIN (§9.13 / §6.4.2.2) も、同一 Track の購読 / FETCH の cross-cancel (§12.1 の MUST) も行われない。

§3.6 が未知 Mandatory Track Property の扱いとして列挙するのは PUBLISH / SUBSCRIBE_OK / FETCH_OK であり TRACK_STATUS_OK を含まないが、これは §12.1 の malformed Track 検出の適用を排除しない (cross-cancel の根拠は §12.1 の MUST と §9.13 の同一視規定に置く)。

## 現状

- `src/session/bidi.ts` の `bidiReadTrackStatusResponse` は、成功経路と REQUEST_ERROR 経路で `closeRequestStreamWriter` を呼んで自方向を FIN し `requestStreams` から削除するが、`handleMalformedTrack` を定義していない。未知 Mandatory Track Property は応答リーダーの共通 catch から `handleError` に落ち、`pendingTrackStatus.delete` / `requestStreams.delete` / reject のみとなる。writer は閉じられず、`requestStreams` から削除されるため後からストリームを cancel する参照も失われる。
- 既知 Type の serialization 不一致 (§8.3) は別経路である。`decodeRequestOkPayload` が `SessionError(KEY_VALUE_FORMATTING_ERROR)` を throw し、`toSessionCloseError` 経由で `handleCloseError` に落ちて reject と同時にセッションを閉じる (既存テスト「bidiReadTrackStatusResponse: malformed Track Properties で KEY_VALUE_FORMATTING_ERROR で閉じる」が `["reject", "close"]` を固定)。本 issue はこの経路を変更しない。
- SUBSCRIBE_OK の malformed 経路 (`bidiReadSubscribeResponse` の `handleMalformedTrack`) は、pending の reject → `markClosed` → ストリームの cancel → `cancelMalformedTrackPeers` による同一 Track の cross-cancel を行う。FETCH_OK も同形であり、TRACK_STATUS_OK だけがこの扱いから漏れている。
- `cancelMalformedTrackPeers` は Full Track Name の比較キーで購読 / FETCH / pending を走査して cancel する (0571 / 0572 / 0574 で整備済み)。ただし `PendingTrackStatus` (`src/session/bidi.ts`) は `resolve` / `reject` しか持たず TRACK_STATUS の対象 Track (namespace / trackName) を保持していないため、現状のままでは cross-cancel の比較キーを組み立てられない。
- TRACK_STATUS は購読を作らない (`§9.13` の「does not create downstream subscription state」は publisher 側の記述だが、requester 側も `pendingTrackStatus` のみを持つ) ため、cross-cancel の対象は同一 Full Track Name の既存購読 / FETCH である。

## 設計方針

1. §12.1 の MUST と §9.13 の同一視規定に基づき、TRACK_STATUS_OK で未知 Mandatory Track Property を検出したら、同一 Full Track Name の購読 / FETCH を `cancelMalformedTrackPeers` で cross-cancel する (無条件に適用する。§3.6 の列挙に TRACK_STATUS_OK が無いことは適用除外の根拠にならない)。
2. `bidiReadTrackStatusResponse` に `handleMalformedTrack` を追加し、pending の reject → 自方向の FIN (`closeRequestStreamWriter`) → `requestStreams` / `pendingTrackStatus` の削除 → `cancelMalformedTrackPeers` の順で処理する (reject を先に行い、アプリへの失敗通知を後始末の完了に依存させない。SUBSCRIBE_OK / FETCH_OK の malformed 経路と同じ順序)。TRACK_STATUS のストリームは §9.13 の「The bidi stream is closed with a FIN after TRACK_STATUS_OK or REQUEST_ERROR are sent.」と §6.4.2.2 (FIN は graceful な方向クローズであり cancel ではない) に従い FIN で閉じる。RESET_STREAM / STOP_SENDING (§6.4.2.3) は同一 Track の購読 / FETCH 側の後始末として分離する。セッションは閉じない。
3. cross-cancel の比較キーを組み立てるため、`PendingTrackStatus` に Track の比較キー (`fullTrackNameKey` の戻り値) を追加し、`SessionImpl.trackStatus()` の pending 登録時に設定する。`resolve` / `reject` の既存の挙動は変えない。
4. `MalformedTrackError` 以外の例外は従来どおり再 throw し、`toSessionCloseError` が変換するエラー (KEY_VALUE_FORMATTING_ERROR 等) の扱いは変更しない (SUBSCRIBE_OK / FETCH_OK 経路と同じ切り分け)。
5. テストを追加する: 同一 Full Track Name の購読 / FETCH を確立した状態で、未知 Mandatory Track Property を含む TRACK_STATUS_OK を実ストリームで注入し、(a) pending が `MalformedTrackError` で reject され、(b) 自方向が FIN され (`closeRequestStreamWriter` 相当の writer 終端)、(c) 同一 Track の購読 / FETCH が cancel され、(d) 別 Track の購読 / FETCH は active のままであることを検証する。既存の SUBSCRIBE_OK / FETCH_OK cross-cancel テストと同型の相手役を用意する。

## 完了条件

- TRACK_STATUS_OK の malformed 検出で自方向が FIN され、`requestStreams` / `pendingTrackStatus` にエントリが残留しないこと。
- malformed 検出時に同一 Full Track Name の購読 / FETCH が存在する場合、それらが `cancelMalformedTrackPeers` で cancel されること (§12.1 の MUST)。
- 別 Full Track Name の購読 / FETCH は cancel されないこと。
- セッションは閉じないこと。
- SUBSCRIBE_OK / FETCH_OK の malformed 経路の挙動 (reject と cross-cancel) が従来どおりであること (非退行)。
- 既知 Type の serialization 不一致 (§8.3) は従来どおり `KEY_VALUE_FORMATTING_ERROR` で reject と同時にセッションを閉じること (既存テストを維持。未知 Mandatory の経路とは分けたままにする)。
- 上記を検証するテストがあること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。
- `CHANGES.md` の `## develop` に `[FIX]` を追加すること。

## 関連

- draft-ietf-moq-transport-21 §9.13 / §12.1 / §6.4.2.2 / §6.4.2.3 / §3.6
- `bidiReadTrackStatusResponse` / `closeRequestStreamWriter` / `cancelMalformedTrackPeers` / `PendingTrackStatus` (`src/session/bidi.ts`)
- `SessionImpl.trackStatus` (`src/session.ts`。pending 登録時に比較キーを設定する)
- `issues/closed/0567-bug-subscribe-ok-fetch-ok-cross-cancel.md` (SUBSCRIBE_OK / FETCH_OK の cross-cancel)
- `issues/closed/0571-bug-pending-track-cross-cancel-missing.md` / `issues/closed/0574-bug-full-track-name-collision.md` (cross-cancel の走査対象と Full Track Name の比較キー)
- `issues/0578-refactor-bidi-response-handler-dedup.md` / `issues/0579-test-bidi-response-missing-branches.md` (応答リーダーのハンドラ表の共通化と未テスト分岐。本 issue を先に処理し、共通化の際は TRACK_STATUS 経路の malformed も同じ形で表現できるようにする)
- 対象外: `bidiReadTrackStatusResponse` の `handleGoaway` / `handleUnexpected` が writer を閉じない点は本 issue の対象外とする (malformed 検出の経路ではない)
