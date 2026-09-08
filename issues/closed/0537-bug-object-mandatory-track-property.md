# Object Property の Mandatory Track Property を malformed として検出する

- Created: 2026-09-08
- Completed: 2026-09-09
- Branch: feature/fix-object-mandatory-track-property
- Polished: 2026-09-08

## 目的

draft-ietf-moq-transport-20 §2.5.1 は「An Object received with a Mandatory Track Property as an Object Property is malformed (see Section 2.4.2).」と定める。現状は Object Properties の ID を解釈しないため、Mandatory Track Property (0x4000-0x7FFF) を含む不正な Object を受理してしまう。

## 現状

- `src/dataStream.ts` の `decodeObjectFields` は Properties を宣言バイト数で切り出すだけで、Property ID をデコードしない。
- `src/dataStream.ts` の `decodeObjectDatagram` も Properties を切り出すだけで ID を解釈せず、`incomingHandleDatagram` はデコード後の properties をそのまま購読へ渡す。
- Object Properties を解釈する `src/properties.ts` の `decodeObjectPropertiesTolerant` は 0x4000-0x7FFF の判定を行わない。同関数は closed の `issues/closed/0361-change-loc-object-properties-delta-encoding.md` と `issues/closed/0379-moqt-draft-19-delta-type-overflow-validation.md` により、不正な delta / Length で `PROTOCOL_VIOLATION` を送出せず抽出できたフィールドのみで配信を継続する寛容契約が意図的に維持されている。本 issue はこの契約を変更しない。
- 対照的に Track Properties 側は `parseProperties` / `decodeProperties` が 0x4000-0x7FFF で `MalformedTrackError` を投げる。
- §2.4.2 は malformed track を検出した購読を MUST cancel とする。現状 `MalformedTrackError` を購読 cancel に変換する経路は無く、`handleMalformedFetchTrack`（`src/session.ts`）が FETCH 用に cancel するのみである。subgroup 経路では `handleIncomingStream` の最終分岐まで伝播し、`toProtocolViolationSessionError` が `MalformedTrackError` に null を返すため INTERNAL_ERROR でセッションを閉じてしまう。

## 設計方針

1. Object Properties を受信する subgroup 経路（`decodeObjectFields`）と datagram 経路（`decodeObjectDatagram`）の両方で、Property ID を走査して 0x4000-0x7FFF の Mandatory Track Property を検出したら `MalformedTrackError` とする。
2. 検出は `decodeObjectPropertiesTolerant` の寛容契約を変更せず、Property ID を走査する専用の検証関数（新設）で行う。delta オーバーフロー等の厳密検証は本 issue の対象外とし、寛容契約（closed 0361 / 0379）を維持する。
3. §2.4.2 に従い、検出した malformed track は当該購読を cancel する。購読 cancel は既存の `bidiCancelSubscription` を使う新規経路であり、FETCH の `handleMalformedFetchTrack` とは別に実装する。datagram 経路も同じ cancel 経路に接続する。
4. subgroup 経路の `MalformedTrackError` が INTERNAL_ERROR でセッションを閉じる現状の伝播を、購読 cancel に置き換える。
5. Mandatory Track Property を含む Object Property が malformed として扱われるテストを subgroup / datagram の両経路に追加する。

## 完了条件

- Object Property に 0x4000-0x7FFF の Mandatory Track Property を含む Object が subgroup / datagram の両経路で malformed として扱われること。
- 当該購読が §2.4.2 に従って cancel され、セッションが INTERNAL_ERROR で閉じないこと。
- `decodeObjectPropertiesTolerant` の寛容契約が維持されていること（不正な delta / Length で PROTOCOL_VIOLATION を送出しない）。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 関連

- draft-ietf-moq-transport-20 §2.5.1 / §2.4.2 / §1.4.3 / §12.7
- `decodeObjectFields` / `decodeObjectDatagram` / `processSubgroupObjects` / `incomingHandleDatagram`
- `decodeObjectPropertiesTolerant` / `parseProperties` / `decodeProperties`
- `bidiCancelSubscription` / `handleMalformedFetchTrack`
- `issues/closed/0361-change-loc-object-properties-delta-encoding.md` / `issues/closed/0379-moqt-draft-19-delta-type-overflow-validation.md`（寛容契約の先行判断）

## 解決方法

- `src/properties.ts` に `assertNoMandatoryTrackPropertyInObjectProperties` を追加し、Object Property の KVP を `decodeObjectPropertiesTolerant` で走査して 0x4000-0x7FFF を検出したら `MalformedTrackError` とする。IMMUTABLE_PROPERTIES の内容も再帰的に検査し、深さ上限 8 でスタック枯渇を防ぐ。
- `src/dataStream.ts` の `decodeObjectFields` / `decodeObjectDatagram` / `decodeFetchObjectFields` で Properties スライス後に検証を呼ぶ。non-Normal status の properties 検証 (§11.2.1.2) を先に行い、その後に mandatory 検証を行う。
- `src/session/bidi.ts` に `bidiCancelSubscriptionWithError` を追加し、アプリへ error を通知してから購読を closed にして cancel する。
- `src/session.ts` の `handleSubgroupStream` で `MalformedTrackError` を捕捉して購読を cancel し、セッションを閉じない。`src/session/incoming.ts` の datagram 経路も同様に cancel する。FETCH / fill は既存の malformed track 処理で cancel する。
- 各経路のテストを追加した。
- 検証: `vp check` / `tsc --noEmit` / `vp test run`（1824 tests）が通る。
