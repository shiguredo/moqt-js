# fill-delivered と subscription-delivered の受信経路を分離して扱う

- Created: 2026-09-01
- Completed: {YYYY-MM-DD}
- Branch: feature/add-handle-fill-vs-subscription-delivery
- Polished: 2026-09-02

## 目的

draft-ietf-moq-transport-20 §5.1.2 / §5.1.3 は Object を subscription-delivered と fill-delivered に区別する。重複し得るため、受信側で経路を分離しアプリが一度だけ処理できるようにする。

## 現状

- fill fetch 実装 (0450) 後、同一 Location が fill ストリームと subgroup / datagram の両方で届き得る。
- 現行 Subscriber コールバックは配信経路の区別が無い。
- 送信側の fill / subscription スケジューリングは SUBSCRIBE 受信が無いため対象外。

## 設計方針

- fill fetch 由来の Object は subscription の Location Filter / Range Filter 再適用 (`SubscriberImpl.handleObject`) を通さず、配信オブジェクトに fill-delivered を示すメタデータを付けて subscription 由来と区別してアプリに渡す (fill-delivered は FILL_PARAMETERS のフィルタに従属するため §5.1.2)。
- デフォルトでアプリが二重処理しない推奨パターン (例: Next Object の subscription (StartGroup = 0 かつ StartObject = 0) + open-ended fill。§5.1.3 の exactly-once パターン) をドキュメントまたは API コメントで示す。
- 自動 dedup を入れる場合はオプションとし、仕様の「subscriber that wants each Object delivered exactly once」の例に合わせる。必須は区別可能なこと。

## 完了条件

- fill 経由と subscription 経由の Object をアプリが区別できること。
- 同一 Location が fill 経由と subscription 経由の両方で届く場合に、アプリが両者を区別して受け取れるテストがあること (自動 dedup はオプションであり、本 issue は区別可能の検証まで)。
- `CHANGES.md` の `## develop` に `[ADD]` があること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- draft-ietf-moq-transport-20 §5.1.2 (Location Filters: subscription-delivered / fill-delivered)
- draft-ietf-moq-transport-20 §5.1.3 (Fill Semantics)
- draft-ietf-moq-transport-20 Appendix A.1 (#1673)
- 前提: `issues/0450-draft-20-add-fill-parameters-and-fill-fetch.md`
