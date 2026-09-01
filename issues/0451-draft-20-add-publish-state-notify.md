# PUBLISH_STATE_NOTIFY メッセージを追加する

- Created: 2026-09-01
- Completed: {YYYY-MM-DD}
- Branch: feature/add-publish-state-notify
- Polished: {YYYY-MM-DD}

## 目的

draft-ietf-moq-transport-20 §10.10 で追加された `PUBLISH_STATE_NOTIFY` (Type 0x22) を実装する。publisher からの片方向の購読状態通知を受信できるようにし、未知メッセージによる PROTOCOL_VIOLATION を防ぐ。

## 現状

- `MessageType` (`src/message/types.ts`) に `PUBLISH_STATE_NOTIFY` が無い。制御メッセージ受信ループは未知 Type を PROTOCOL_VIOLATION 扱いする経路がある。
- draft-20 では Type 0x22、Length、Number of Parameters、Parameters。REQUEST_OK / REQUEST_ERROR 応答なし。MAX_REQUEST_UPDATES 対象外。
- LARGEST_OBJECT を known なら MUST で含める。LOCATION_FILTER 等、値が変わったパラメータのみ載せる。

## 設計方針

- `MessageType.PUBLISH_STATE_NOTIFY = 0x22` と encode / decode / `getMessageTypeName` を追加する。
- subscription bidi の受信ループ (`src/session/bidi.ts` 等) で publisher 発の本メッセージを受理し、パラメータ変更を subscriber 状態に反映する (少なくとも LARGEST_OBJECT / LOCATION_FILTER / FORWARD 等、仕様が許可するパラメータ)。
- subscriber 発、または非 subscription 文脈での受信は PROTOCOL_VIOLATION (§10.10)。
- 送信側 (自 publisher が対向 subscriber に送る) は、状態変更を能動通知する必要がある場合に後続で足す。本 issue の必須範囲は受信と型定義。送信が必要なら完了条件に明記して実装する。

## 完了条件

- Type 0x22 の encode / decode と名前解決があること。
- subscription bidi で受信でき、不正文脈では PROTOCOL_VIOLATION になること。
- 受信パラメータが subscriber の状態 (Largest Location 等) に反映されること。
- `CHANGES.md` の `## develop` に `[ADD]` があること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- draft-ietf-moq-transport-20 §10.10 (PUBLISH_STATE_NOTIFY)
- draft-ietf-moq-transport-20 §10.2.9 / §10.2.17 (LOCATION_FILTER / LARGEST_OBJECT の本メッセージでの扱い)
- draft-ietf-moq-transport-20 Appendix A.1 (#1820)
