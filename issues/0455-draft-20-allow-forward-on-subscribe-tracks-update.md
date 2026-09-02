# SUBSCRIBE_TRACKS の REQUEST_UPDATE で FORWARD を送れるようにする

- Created: 2026-09-01
- Completed: {YYYY-MM-DD}
- Branch: feature/add-forward-on-subscribe-tracks-update
- Polished: 2026-09-02

## 目的

draft-ietf-moq-transport-20 §10.2.18 / A.1 #1812 で SUBSCRIBE_TRACKS の REQUEST_UPDATE に FORWARD が許可された。SUBSCRIBE_TRACKS の REQUEST_UPDATE の FORWARD は prefix に一致する将来の購読の Forwarding State を指定し、既存購読には影響しない (§10.2.18)。Tracks 更新 API からこの Forwarding State を送れるようにする。

## 現状

- `NamespaceUpdateOptions` (`src/session.ts`) は `trackNamespacePrefix` のみ。
- `bidiSendNamespaceRequestUpdate` / `TracksSubscription.update` は TRACK_NAMESPACE_PREFIX 更新が中心で FORWARD を載せない。
- `REQUEST_UPDATE_ALLOWED_PARAMS` は FORWARD を含むが、Tracks 更新 API が露出していない。

## 設計方針

- Tracks 更新専用のオプション型を新設し (例: `TracksUpdateOptions`、`NamespaceUpdateOptions` の内容を引き継ぐ)、`TracksSubscription.update` にのみ `forward?: boolean` を追加する。`NamespaceSubscription.update` (SUBSCRIBE_NAMESPACE) には FORWARD を露出させない (draft-20 §10.2.18 は SUBSCRIBE_NAMESPACE 向け REQUEST_UPDATE での FORWARD を許可しない)。
- `TracksSubscription.update` / `bidiSendNamespaceRequestUpdate` で FORWARD パラメータを送る。REQUEST_UPDATE では FORWARD 省略時は現在値が不変のため (§10.2.18)、`forward` 指定時は 0 / 1 を明示送信する (`bidiSendRequestUpdate` の既存表現 `forward !== undefined → 0/1` に揃える)。初期リクエストの `forward === false` のみ送信する表現は流用しない (FORWARD=0 送信後の true 復帰が不能になる)。
- Namespace 専用更新 (SUBSCRIBE_NAMESPACE) では FORWARD を送らない (§10.2.18 の列挙外)。TRACK_NAMESPACE_PREFIX のみ両経路で更新できる (§10.2.20)。

## 完了条件

- `TracksSubscription.update` で FORWARD を送れること。
- 受信・応答経路の既存スコープ検証と矛盾しないこと。
- テストで FORWARD=0 / FORWARD=1 の両方がワイヤ上に載ることを確認すること。
- `CHANGES.md` の `## develop` に `[ADD]` があること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- draft-ietf-moq-transport-20 §10.2.18 (FORWARD Parameter)
- draft-ietf-moq-transport-20 Appendix A.1 (#1812)
