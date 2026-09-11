# TRACK_STATUS_OK の malformed 応答で cross-cancel とストリーム後始末が行われない

- Created: 2026-09-12
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-track-status-malformed-handling
- Polished: {YYYY-MM-DD}

## 目的

draft-ietf-moq-transport-21 §9.13 は TRACK_STATUS_OK が SUBSCRIBE_OK と同じ Track Properties を運ぶと定める。malformed な Track Properties を受信したとき、現状は pending の reject のみで、成功経路 / REQUEST_ERROR 経路が行う bidi ストリームの FIN (§6.4.2.2) も、同一 Track の購読 / FETCH の cross-cancel (§12.1 の適用可否) も行われない。

## 現状

- `src/session/bidi.ts` の `bidiReadTrackStatusResponse` は、成功経路と REQUEST_ERROR 経路で `closeRequestStreamWriter` を呼んで自方向を FIN するが、catch の一般分岐 (`MalformedTrackError` を含む) では `pendingTrackStatus.delete` / `requestStreams.delete` / reject のみで writer を閉じない。
- `requestStreams` から削除されるため、後からストリームを cancel する参照も失われる。
- §3.6 の MUST は PUBLISH / SUBSCRIBE_OK / FETCH_OK に限定され、TRACK_STATUS_OK は列挙されていない。§12.1 の cross-cancel を TRACK_STATUS_OK の malformed 検出にも適用するかは一次資料から確定できない。
- 現状は `MalformedTrackError` を一般分岐で reject するのみで、cross-cancel も FIN も行わない。

## 設計方針

1. §3.6 / §9.13 / §12.1 を突き合わせ、TRACK_STATUS_OK の malformed 検出で cross-cancel を行うかを整理する。
2. 少なくとも writer の後始末 (FIN または cancel) と `requestStreams` の整理を行い、成功経路 / REQUEST_ERROR 経路と揃える。
3. cross-cancel を適用する場合は `cancelMalformedTrackPeers` を呼ぶ。
4. 上記を検証するテストを追加する。

## 完了条件

- TRACK_STATUS_OK の malformed 検出で bidi ストリームの後始末 (FIN または cancel) が行われること。
- cross-cancel の要否を整理し、適用する場合は同一 Track の購読 / FETCH が cancel されること。
- 上記を検証するテストがあること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。
- `CHANGES.md` の `## develop` に `[FIX]` を追加すること。

## 関連

- draft-ietf-moq-transport-21 §9.13 / §3.6 / §6.4.2.2 / §12.1
- `bidiReadTrackStatusResponse` / `closeRequestStreamWriter` / `cancelMalformedTrackPeers` (`src/session/bidi.ts`)
- `issues/closed/0567-bug-subscribe-ok-fetch-ok-cross-cancel.md` (SUBSCRIBE_OK / FETCH_OK の cross-cancel)
