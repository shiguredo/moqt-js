# PUBLISH_STATE_NOTIFY メッセージを追加する

- Created: 2026-09-01
- Completed: 2026-09-04
- Branch: feature/add-publish-state-notify
- Polished: 2026-09-02

## 目的

draft-ietf-moq-transport-20 §10.10 で追加された `PUBLISH_STATE_NOTIFY` (Type 0x22) を実装する。publisher からの片方向の購読状態通知を受信できるようにし、未知メッセージによる PROTOCOL_VIOLATION を防ぐ。

## 現状

- `MessageType` (`src/message/types.ts`) に `PUBLISH_STATE_NOTIFY` が無い。制御メッセージ受信ループは未知 Type を PROTOCOL_VIOLATION 扱いする経路がある。
- draft-20 では Type 0x22、Length、Number of Parameters、Parameters。REQUEST_OK / REQUEST_ERROR 応答なし。MAX_REQUEST_UPDATES 対象外。
- LARGEST_OBJECT を known なら MUST で含める。LOCATION_FILTER 等、値が変わったパラメータのみ載せる。

## 設計方針

- `MessageType.PUBLISH_STATE_NOTIFY = 0x22` と encode / decode / `getMessageTypeName` を追加する。
- subscription bidi の受信ループで publisher 発の本メッセージを受理し、パラメータ変更を subscriber 状態に反映する (少なくとも LARGEST_OBJECT / LOCATION_FILTER / FORWARD 等、仕様が許可するパラメータ)。対象は SUBSCRIBE で確立した subscription の受信ループ (`bidiReadRequestStreamMessages`) と、受信 PUBLISH で確立した subscription の受信ループ (`runPublishStreamSubLoop`) の両方とする。両ループとも未知メッセージによる PROTOCOL_VIOLATION が防がれること。
- subscriber 発、または非 subscription 文脈での受信は PROTOCOL_VIOLATION (§10.10)。
- 受信パラメータは本メッセージに許可されたもの (LARGEST_OBJECT / LOCATION_FILTER / FORWARD) のみ受理し、許可外のパラメータは §10.2.1 の MUST に従い PROTOCOL_VIOLATION で拒否する。
- 送信側 (自 publisher が対向 subscriber に送る) は、状態変更を能動通知する必要がある場合に後続で足す。本 issue の必須範囲は受信と型定義。送信が必要なら完了条件に明記して実装する。

## 解決方法

`MessageType.PUBLISH_STATE_NOTIFY` (0x22) と符号化・名前解決を追加し、両購読受信ループで受理するようにした。

- 受信は presence のパラメータのみ subscriber 状態に反映し (省略時は不変)、応答は送信しない
- 購読以外の文脈 (応答待ちリーダー・namespace 系) と subscriber 発と許可外パラメータではセッションを閉じる
- 送信側は受信専用の範囲に留める
- `CHANGES.md` の `## develop` に `[ADD]` を追記する

## 完了条件

- Type 0x22 の encode / decode と名前解決があること。
- SUBSCRIBE で確立した subscription と受信 PUBLISH で確立した subscription の双方の bidi で受信でき、subscriber 発・非 subscription 文脈・許可外パラメータの各場合は PROTOCOL_VIOLATION になること。
- 受信パラメータが subscriber の状態 (Largest Location 等) に反映されること。
- `CHANGES.md` の `## develop` に `[ADD]` があること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- draft-ietf-moq-transport-20 §10.10 (PUBLISH_STATE_NOTIFY)
- draft-ietf-moq-transport-20 §10.2.9 / §10.2.17 (LOCATION_FILTER / LARGEST_OBJECT の本メッセージでの扱い)
- draft-ietf-moq-transport-20 Appendix A.1 (#1820)
