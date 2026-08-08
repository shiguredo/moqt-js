# FETCH で Range Filters を送信できるようにし、Range Filter の送信ガードを実装する

- Created: 2026-08-07
- Completed: {YYYY-MM-DD}
- Branch: feature/add-range-filters-fetch
- Polished: {YYYY-MM-DD}

## 目的

draft-ietf-moq-transport-19 §5.1.3 の「Range Filters are parameters in SUBSCRIBE, FETCH, or SUBSCRIBE_TRACKS」に従い、FETCH（standalone / Joining Fetch）で Range Filters を送信できるようにする。あわせて、§5.1.3 の Range Filter 送信ガード（削除は REQUEST_UPDATE のみ・TRACK_PROPERTY_FILTER (0x29) は SUBSCRIBE_TRACKS / その REQUEST_UPDATE のみ）を全送信経路に適用する。

closed issue 0341 の完了条件のうち FETCH 配線と送信ガードが未達で残っており、同種の SUBSCRIBE_TRACKS / REQUEST_UPDATE 配線は closed issue 0400 で対応済みである。

## 現状

- `FetchOptions.rangeFilters`（`src/session.ts` の `FetchOptions`）は定義済みだが、`buildFetchParameters()`（`src/session/params.ts`）が FILL_TIMEOUT / AUTHORIZATION_TOKEN のみをエンコードし、rangeFilters を黙って捨てる。`fetch()` にも `validateRangeFilterLimits()` の呼び出しがない。
- `JoiningFetchOptions`（`src/session.ts`）に `rangeFilters` フィールドがなく、`bidiSendJoiningFetch()`（`src/session/bidi.ts`）も `parameters: []` 固定で Range Filters を載荷しない。
- 送信前ガード（ピア `MAX_FILTER_RANGES` が 0 なら throw、Range 総数超過なら throw）は SUBSCRIBE / SUBSCRIBE_TRACKS / REQUEST_UPDATE で適用済み（0400）だが、FETCH 経路にはない。
- TRACK_PROPERTY_FILTER (0x29) のスコープ検証がない: `buildSubscribeParameters()`（`src/session/params.ts`）と `bidiSendRequestUpdate()`（`src/session/bidi.ts`）は 0x29 を無検証で載せており、§10.2.1 により対向が PROTOCOL_VIOLATION でセッションを閉じる実害がある。Length=0 の削除（`RangeFilterRemove`）も REQUEST_UPDATE 以外で指定可能なまま（0400 のテストは SUBSCRIBE_TRACKS での削除エンコードを検証済みであり、仕様違反）。
- 前提: 本 issue のエンコード修正は issue 0362（Range Filter の Length 二重エンコード修正）で実施済みであること。0362 の修正後の 1 Length 構造を前提とするため、実装順は 0362 が先。

## 設計方針

- `buildFetchParameters()` に `rangeFilters` 載荷処理を追加し、`fetch()` から渡す。
- `JoiningFetchOptions` に `rangeFilters` を追加し、`bidiSendJoiningFetch()` に載荷処理を追加する。
- 送信前ガード（`validateRangeFilterLimits()` 相当）を `fetch()` と `bidiSendJoiningFetch()` に適用する。`bidiSendJoiningFetch()` は fire-and-forget（`void`）で起動されるため、throw が未処理 rejection にならないよう既存の try/catch 内（`options.onError` 通知経路）に配置する。
- Length=0 の削除（`RangeFilterRemove`）は仕様上 REQUEST_UPDATE のみのため、REQUEST_UPDATE 以外のメッセージ（SUBSCRIBE / SUBSCRIBE_TRACKS / FETCH / Joining Fetch）で削除を指定した場合は throw する。
- TRACK_PROPERTY_FILTER (0x29) は仕様 §5.1.3 で SUBSCRIBE_TRACKS / その REQUEST_UPDATE のみ許可のため、SUBSCRIBE / FETCH / Joining Fetch に指定された場合は throw する（SUBSCRIBE_TRACKS では 0400 の配線を維持して許可する）。REQUEST_UPDATE での 0x29 は、SUBSCRIBE 由来の subscription では throw し、SUBSCRIBE_TRACKS 由来では許可を維持する方針とする（`session.ts` の受信 PUBLISH 処理は SUBSCRIBE_TRACKS にマッチした SubscriberImpl に `onUpdate` を配線済みであり、経路は実装済み。未実装なのはその `update()` を呼ぶ公開 API のみ。由来を判別するため、SubscriberImpl に SUBSCRIBE / SUBSCRIBE_TRACKS 由来のフラグを記録し、`bidiSendRequestUpdate()` が参照する。フラグの設定方法は、既存テスト（`src/session/bidi.test.ts`）が `new SubscriberImpl(...)` を直接生成しているため、コンストラクタ引数または setter のいずれかを実装時に確定する）。
- 削除 throw / 0x29 throw / MAX_FILTER_RANGES ガードは、0400 の `validateRangeFilterLimits()` と同様に純関数（例: `validateRangeFilterSpecs(rangeFilters, contextName)`）へ集約し、メッセージ別のエンコード関数（`buildSubscribeParameters()` / `buildSubscribeTracksParameters()` / `buildFetchParameters()`）と呼び出し側（`bidiSendJoiningFetch()` / `bidiSendRequestUpdate()`）から呼ぶ（共有の `buildRangeFilterParameters()` にはガードを入れない。REQUEST_UPDATE の削除が壊れるため）。
- PUBLISH_OK の配線は対象外（0341 の完了条件として未達のまま残る）。
- 受信側の 0x29 スコープ検証（REQUEST_UPDATE の由来判別。現状は `REQUEST_UPDATE_ALLOWED_PARAMS` が 0x29 を一律許可）は本 issue のスコープ外とし、別途起票する（0389 は SUBSCRIBE_TRACKS 受信時の検証であり対象が異なる）。

## 完了条件

- `fetch()` が `rangeFilters` をワイヤエンコードして送信し、ピアの MAX_FILTER_RANGES を超える指定は throw する。
- Joining Fetch（`JoiningFetchOptions.rangeFilters`）でも Range Filters を送信できる。
- FETCH（standalone / Joining Fetch）で削除（Length=0）・TRACK_PROPERTY_FILTER (0x29) を指定すると throw する。
- SUBSCRIBE / SUBSCRIBE_TRACKS で削除（Length=0）を指定すると throw する。SUBSCRIBE で 0x29 を指定すると throw する。SUBSCRIBE 由来の REQUEST_UPDATE で 0x29 を指定すると throw し、SUBSCRIBE_TRACKS 由来では throw しない。
- 0400 で追加された既存テスト（`bidiSendRequestUpdate` の 0x29 送信テスト `src/session/bidi.test.ts`、SUBSCRIBE_TRACKS の削除指定テスト `src/session/params.test.ts`、`buildRangeFilterParameters` の追加・削除混在テスト `src/session/params.test.ts` 等）が、ガード方針に合わせて更新されていること。
- 上記を検証するテストがあること。
- `CHANGES.md` の `## develop` に `[ADD]` があること。
- `vp check` / `tsc --noEmit` / `vp test run` が通る。

## 参照

- draft-ietf-moq-transport-19 §5.1.3 (Range Filters)
- draft-ietf-moq-transport-19 §10.2.1 (Message Parameter Scoping)
- draft-ietf-moq-transport-19 §10.3.1.6 (MAX_FILTER_RANGES)
- 関連: `issues/closed/0341-draft-19-add-range-filters.md`（FETCH 配線と送信ガードが未達のまま closed になった）
- 関連: `issues/closed/0400-add-range-filters-subscribe-tracks.md`（SUBSCRIBE_TRACKS / REQUEST_UPDATE 配線の先例）
- 関連: `0362-bug-range-filter-length-encoding.md`（エンコード修正。実装順は先に 0362）

## 解決方法

未着手。
