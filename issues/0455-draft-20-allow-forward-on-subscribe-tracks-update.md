# SUBSCRIBE_TRACKS の REQUEST_UPDATE で FORWARD を送れるようにする

- Created: 2026-09-01
- Completed: {YYYY-MM-DD}
- Branch: feature/add-forward-on-subscribe-tracks-update
- Polished: {YYYY-MM-DD}

## 目的

draft-ietf-moq-transport-20 §10.2.18 / A.1 #1812 で SUBSCRIBE_TRACKS の REQUEST_UPDATE に FORWARD が許可された。Tracks 購読の Forward State を更新できるようにする。

## 現状

- `NamespaceUpdateOptions` (`src/session.ts`) は `trackNamespacePrefix` のみ。
- `bidiSendNamespaceRequestUpdate` / `TracksSubscription.update` は TRACK_NAMESPACE_PREFIX 更新が中心で FORWARD を載せない。
- `REQUEST_UPDATE_ALLOWED_PARAMS` は FORWARD を含むが、Tracks 更新 API が露出していない。

## 設計方針

- `NamespaceUpdateOptions` に `forward?: boolean` (または既存 FORWARD 表現に揃えた型) を追加する。
- `TracksSubscription.update` / `bidiSendNamespaceRequestUpdate` で FORWARD パラメータを送る。
- Namespace 専用更新と Tracks 更新で許可パラメータが異なる場合は経路ごとに検証する。

## 完了条件

- `TracksSubscription.update` で FORWARD を送れること。
- 受信・応答経路の既存スコープ検証と矛盾しないこと。
- テストでワイヤ上に FORWARD が載ることを確認すること。
- `CHANGES.md` の `## develop` に `[ADD]` または `[UPDATE]` があること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- draft-ietf-moq-transport-20 §10.2.18 (FORWARD Parameter)
- draft-ietf-moq-transport-20 Appendix A.1 (#1812)
