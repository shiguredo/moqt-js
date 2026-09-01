# fill-delivered と subscription-delivered の受信経路を分離して扱う

- Created: 2026-09-01
- Completed: {YYYY-MM-DD}
- Branch: feature/add-handle-fill-vs-subscription-delivery
- Polished: {YYYY-MM-DD}

## 目的

draft-ietf-moq-transport-20 §5.1.2 / §5.1.3 は Object を subscription-delivered と fill-delivered に区別する。重複し得るため、受信側で経路を分離しアプリが一度だけ処理できるようにする。

## 現状

- fill fetch 実装 (0450) 後、同一 Location が fill ストリームと subgroup / datagram の両方で届き得る。
- 現行 Subscriber コールバックは配信経路の区別が無い。
- 送信側の fill / subscription スケジューリングは SUBSCRIBE 受信が無いため対象外。

## 設計方針

- fill fetch 由来の Object に fill-delivered 印を付け、subscription 由来とコールバックまたはメタデータで区別する。
- デフォルトでアプリが二重処理しない推奨パターン (例: Next Group の subscription + open-ended fill) をドキュメントまたは API コメントで示す。
- 自動 dedup を入れる場合はオプションとし、仕様の「subscriber that wants each Object delivered exactly once」の例に合わせる。必須は区別可能なこと。

## 完了条件

- fill 経由と subscription 経由の Object をアプリが区別できること。
- 重複 Delivery のテストケースがあること。
- `CHANGES.md` の `## develop` に `[ADD]` または `[UPDATE]` があること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- draft-ietf-moq-transport-20 §5.1.2 (Location Filters: subscription-delivered / fill-delivered)
- draft-ietf-moq-transport-20 §5.1.3 (Fill Semantics)
- draft-ietf-moq-transport-20 Appendix A.1 (#1673)
- 前提: `issues/0450-draft-20-add-fill-parameters-and-fill-fetch.md`
