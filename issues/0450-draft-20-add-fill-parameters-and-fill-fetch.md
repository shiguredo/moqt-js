# FILL_PARAMETERS を追加し fill fetch ストリームを実装する

- Created: 2026-09-01
- Completed: {YYYY-MM-DD}
- Branch: feature/add-fill-parameters-and-fill-fetch
- Polished: {YYYY-MM-DD}

## 目的

draft-ietf-moq-transport-20 で Joining FETCH の代替として導入された `FILL_PARAMETERS` (0x23) と fill fetch ストリーム (§5.1.3) を実装する。購読と同時に live 手前の範囲を fill できるようにする。

## 現状

- `MessageParameterType` (`src/message/types.ts`) に `FILL_PARAMETERS` (0x23) が無い。`FILL_TIMEOUT` (0x0a) はあるが FETCH / Joining 経路向け。
- Joining FETCH (`bidiSendJoiningFetch`) は 0449 で削除予定のため、同等機能が無い状態になる。
- 受信側の FETCH ストリーム処理 (`handleFetchStream` 等) は独立 FETCH の Request ID を前提としており、subscription Request ID / REQUEST_UPDATE Request ID を持つ fill fetch の関連付けが無い。
- 前提: 0448 (Location Filter)、0449 (FETCH / Joining 削除)。

## 設計方針

- `MessageParameterType.FILL_PARAMETERS = 0x23` を追加し、値は内部 Parameters 列 (FILL_TIMEOUT / SUBSCRIBER_PRIORITY / LOCATION_FILTER / GROUP_ORDER / Range Filters) を length-prefixed で格納する (§10.2.15)。
- SUBSCRIBE / subscription の REQUEST_UPDATE 送信経路 (`buildSubscribeParameters` / `bidiSendRequestUpdate`) で `FILL_PARAMETERS` を載せられる API を提供する。旧 `JoiningFetchOptions` の用途をここに寄せる。
- 受信: FETCH_HEADER の Request ID が既存 subscription / pending REQUEST_UPDATE に一致する場合は fill fetch として扱い、購読に紐付ける (§5.1.3)。
- 送信側が SUBSCRIBE を受けて fill を開く義務は、moqt-js が SUBSCRIBE 受信を持たないため対象外。
- fill と subscription の二重配送のアプリ向け扱い詳細は `issues/0459-draft-20-handle-fill-vs-subscription-delivery.md` に分離する。本 issue はパラメータ送出とストリーム関連付けまで。

## 完了条件

- `FILL_PARAMETERS` の encode / decode とスコープ検証があること。
- SUBSCRIBE / REQUEST_UPDATE で fill を要求できる公開 API があること。
- 対向が開いた fill fetch ストリームを subscription Request ID で関連付けて受信できること。
- `CHANGES.md` の `## develop` に `[ADD]` があること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- draft-ietf-moq-transport-20 §5.1.3 (Fill Semantics)
- draft-ietf-moq-transport-20 §5.1.3.1 (Opening and Closing Fill Fetch Streams)
- draft-ietf-moq-transport-20 §10.2.15 (FILL PARAMETERS Parameter)
- draft-ietf-moq-transport-20 §11.4.4 (FETCH_HEADER)
- draft-ietf-moq-transport-20 Appendix A.1 (#1673, #1868)
- 前提: `issues/0448-draft-20-restructure-location-filter-wire.md`
- 前提: `issues/0449-draft-20-change-fetch-to-location-filter-remove-joining.md`
- 関連: `issues/0459-draft-20-handle-fill-vs-subscription-delivery.md`
