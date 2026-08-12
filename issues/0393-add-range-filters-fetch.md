# FETCH で Range Filters を送信できるようにし、Range Filter の送信ガードを実装する

- Priority: Medium
- Created: 2026-08-07
- Completed: {YYYY-MM-DD}
- Model: DeepSeek V4 Flash
- Branch: feature/add-range-filters-fetch
- Polished: 2026-08-12

## 目的

draft-ietf-moq-transport-19 §5.1.3 の「Range Filters are parameters in SUBSCRIBE, FETCH, or SUBSCRIBE_TRACKS」に従い、FETCH（standalone / Joining Fetch）で Range Filters を送信できるようにする。あわせて、§5.1.3 の Range Filter 送信ガード（削除は REQUEST_UPDATE のみ・TRACK_PROPERTY_FILTER (0x29) は SUBSCRIBE_TRACKS / その REQUEST_UPDATE のみ・組み合わせ重複は in any message で禁止）を、対象とする送信経路（SUBSCRIBE / SUBSCRIBE_TRACKS / FETCH / Joining Fetch / REQUEST_UPDATE。PUBLISH_OK は対象外）に適用する。

closed issue 0341 の完了条件のうち FETCH 配線と送信ガードが未達で残っており、同種の SUBSCRIBE_TRACKS / REQUEST_UPDATE 配線は closed issue 0400 で対応済みである。

## 優先度根拠

FETCH で Range Filters を送信できない状態が残っており (FetchOptions.rangeFilters は定義済みだが黙って捨てられる)、また 0x29 を SUBSCRIBE に無検証で載せると §10.2.1 により対向が PROTOCOL_VIOLATION でセッションを閉じる実害がある。仕様 MUST の充足と既存経路の実害の解消。Medium。

## 現状

- `FetchOptions.rangeFilters`（`src/session.ts` の `FetchOptions`）は定義済みだが、`buildFetchParameters()`（`src/session/params.ts`）が FILL_TIMEOUT / AUTHORIZATION_TOKEN のみをエンコードし、rangeFilters を黙って捨てる。`fetch()` にも `validateRangeFilterLimits()` の呼び出しがない。
- `JoiningFetchOptions`（`src/session.ts`）に `rangeFilters` フィールドがなく、`bidiSendJoiningFetch()`（`src/session/bidi.ts`）も `parameters: []` 固定で Range Filters を載荷しない。
- 送信前ガード（ピア `MAX_FILTER_RANGES` が 0 なら throw、Range 総数超過なら throw）は SUBSCRIBE / SUBSCRIBE_TRACKS / REQUEST_UPDATE で適用済み（0400）だが、FETCH 経路にはない。
- TRACK_PROPERTY_FILTER (0x29) のスコープ検証がない: `buildSubscribeParameters()`（`src/session/params.ts`）と `bidiSendRequestUpdate()`（`src/session/bidi.ts`）は 0x29 を無検証で載せており、§10.2.1 により対向が PROTOCOL_VIOLATION でセッションを閉じる実害がある。Length=0 の削除（`RangeFilterRemove`）も REQUEST_UPDATE 以外で指定可能なまま（削除の意味論は §5.1.3 により REQUEST_UPDATE のみに定義されており、他メッセージでの指定は仕様未定義。0400 のテストは SUBSCRIBE_TRACKS での削除エンコードを検証済み）。
- 前提: 本 issue のエンコード修正は issue 0362（Range Filter の Length 二重エンコード修正）で実施済みであること。0362 の修正後の 1 Length 構造を前提とするため、実装順は 0362 が先。

## 設計方針

- `buildFetchParameters()` に `rangeFilters` 載荷処理を追加し、`fetch()` から渡す。`FetchOptions.rangeFilters` の JSDoc に、ピアの MAX_FILTER_RANGES が 0 (未広告含む) の場合に指定すると throw する旨を追記する (`SubscribeOptions.rangeFilters` / `SubscribeTracksOptions.rangeFilters` の JSDoc と同じ形式)。
- `JoiningFetchOptions` に `rangeFilters` を追加し、`bidiSendJoiningFetch()` に載荷処理を追加する。
- **送信ガードの集約**: 削除 throw / 0x29 throw / 組み合わせ重複 (同じ (Type, SetID, PropertyType) の重複。0380 からの委譲) は、0400 の `validateRangeFilterLimits()` と同様の純関数 `validateRangeFilterSpecs(rangeFilters, contextName, options)` へ集約する。シグネチャは (rangeFilters, contextName, { allowRemove, allowTrackProperty }) とし、メッセージごとの許可をオプションで切り替える。MAX_FILTER_RANGES ガードは `validateRangeFilterLimits(rangeFilters, peerMaxFilterRanges, contextName)` のまま呼び出し側 (session 状態にアクセスできる層) でのみ呼ぶ (純関数のエンコード関数からは session 状態にアクセスできないため)。
- **適用箇所**: メッセージ別のエンコード関数 (`buildSubscribeParameters()` / `buildSubscribeTracksParameters()` / `buildFetchParameters()`) から `validateRangeFilterSpecs` を呼び、`bidiSendJoiningFetch()` / `bidiSendRequestUpdate()` からは `validateRangeFilterSpecs` と `validateRangeFilterLimits` の両方を呼ぶ (共有の `buildRangeFilterParameters()` にはガードを入れない。REQUEST_UPDATE の削除が壊れるため)。standalone FETCH の MAX_FILTER_RANGES ガードは session 状態 (`peerMaxFilterRanges`) を要するため、`SessionImpl.fetch()` 側から `validateRangeFilterLimits` を呼ぶ (ガードは `pendingFetch.set` より前に配置し、throw 時に pending エントリが残らないようにする。既存の `subscribe()` の配置 (pendingSubscribe.set の後) は pending エントリが残留するため踏襲しない)。`bidiSendJoiningFetch()` は fire-and-forget (`void`) で起動されるため、ガードの throw が未処理 rejection にならないよう、既存の try/catch 内 (`options.onError` 通知経路) に配置する。ガード違反はアプリに throw として観測されず `options.onError` で通知される。
- Length=0 の削除（`RangeFilterRemove`）は仕様上 REQUEST_UPDATE のみのため、REQUEST_UPDATE 以外のメッセージ（SUBSCRIBE / SUBSCRIBE_TRACKS / FETCH / Joining Fetch）で削除を指定した場合は throw する (`allowRemove: false`)。
- TRACK_PROPERTY_FILTER (0x29) は仕様 §5.1.3 で SUBSCRIBE_TRACKS / その REQUEST_UPDATE のみ許可のため、SUBSCRIBE / FETCH / Joining Fetch に指定された場合は throw する (`allowTrackProperty: false`。SUBSCRIBE_TRACKS メッセージ自体では 0400 の配線を維持して許可する)。**REQUEST_UPDATE では 0x29 は一律 throw する**: moqt-js が送信する REQUEST_UPDATE はすべて per-subscription の更新 (§10.9 の「A subscriber can also send REQUEST_UPDATE to modify parameters of a subscription established with PUBLISH」) であり、§5.1.3 で 0x29 が許可されるのは SUBSCRIBE_TRACKS リクエスト自身のストリーム上の REQUEST_UPDATE (「REQUEST_UPDATE for it」) のみ。moqt-js はその送信 API を持たないため、SubscriberImpl の由来フラグは不要 (従来設計の「SUBSCRIBE_TRACKS 由来では許可」は仕様上のメッセージスコープと不一致のため不採用)。
- **組み合わせ重複検証 (0380 からの委譲)**: 送信側の組み合わせ重複 (同じ (Type, SetID, PropertyType) のタプル重複。0x25-0x27 は (Type, SetID)) は `validateRangeFilterSpecs` に含めて送信前に throw する (§5.1.3 の MUST。0380 の polish で本 issue への委譲が確定済み)。Length=0 の削除エントリは SetID / Property Type を持たないため重複判定の対象外 (0380 と同じルール)。
- **SUBSCRIBE_TRACKS の更新 API はスコープ外**: SUBSCRIBE_TRACKS 由来の subscription はアプリに Subscriber インスタンスが返されず (onPublish は SubscribeCallbacks のみを返す)、アプリから `update()` に到達する公開 API 経路がない。公開 API の追加は別 issue の対応とする (0385 の polish の「更新 API は 0393 が別途扱う」という文言は、本 issue の実装時に 0385 の issue ファイルを「更新 API は別 issue の対応」に修正する)。
- PUBLISH_OK の配線は対象外（0341 の完了条件として未達のまま残る）。
- 受信側の 0x29 スコープ検証（REQUEST_UPDATE の由来判別。現状は `REQUEST_UPDATE_ALLOWED_PARAMS` が 0x29 を一律許可）は本 issue のスコープ外とし、別途起票する（0389 は SUBSCRIBE_TRACKS 受信時の検証であり対象が異なる）。

## 完了条件

- `fetch()` が `rangeFilters` をワイヤエンコードして送信し、ピアの MAX_FILTER_RANGES を超える指定は throw する。
- Joining Fetch（`JoiningFetchOptions.rangeFilters`）でも Range Filters を送信でき、ピアの MAX_FILTER_RANGES を超える指定は throw する。
- FETCH（standalone / Joining Fetch）で削除（Length=0）・TRACK_PROPERTY_FILTER (0x29) を指定すると throw する。
- SUBSCRIBE / SUBSCRIBE_TRACKS で削除（Length=0）を指定すると throw する。SUBSCRIBE で 0x29 を指定すると throw する。REQUEST_UPDATE で 0x29 を指定すると throw する (per-subscription の REQUEST_UPDATE には 0x29 を載せられないため。由来によらず一律)。
- 送信側の組み合わせ重複 (同じ (Type, SetID, [PropertyType])) を指定すると throw する。
- 0400 で追加された既存テストの更新: `bidiSendRequestUpdate` の 0x29 送信テスト (`src/session/bidi.test.ts`。throw 期待への変更) と SUBSCRIBE_TRACKS の削除指定テスト (`src/session/params.test.ts`。throw 期待への変更) がガード方針に合わせて更新されていること (`buildRangeFilterParameters` の追加・削除混在テストは `buildRangeFilterParameters` にガードを入れない設計のため変更不要)。
- 上記を検証するテストがあること。
- `CHANGES.md` の `## develop` に `[ADD]` があること。
- `vp check` / `tsc --noEmit` / `vp test run` が通る。

## 参照

- draft-ietf-moq-transport-19 §5.1.3 (Range Filters / 削除は REQUEST_UPDATE のみ / 0x29 は SUBSCRIBE_TRACKS / その REQUEST_UPDATE のみ / 組み合わせ重複の MUST)
- draft-ietf-moq-transport-19 §10.2.1 (Message Parameter Scoping)
- draft-ietf-moq-transport-19 §10.3.1.6 (MAX_FILTER_RANGES)
- 関連: `issues/closed/0341-draft-19-add-range-filters.md`（FETCH 配線と送信ガードが未達のまま closed になった）
- 関連: `issues/closed/0400-add-range-filters-subscribe-tracks.md`（SUBSCRIBE_TRACKS / REQUEST_UPDATE 配線の先例）
- 関連: `0362-bug-range-filter-length-encoding.md`（エンコード修正。実装順は先に 0362）
- 関連: `0380-moqt-draft-19-range-filter-value-validation.md`（送信側の組み合わせ重複検証を本 issue の `validateRangeFilterSpecs` 相当に委譲）
- 関連: `0385-moqt-draft-19-range-filter-evaluation-logic.md`（実装順は先に本 issue の 0x29 throw ガードを確認してから。SUBSCRIBE_TRACKS の更新 API は本 issue のスコープ外である旨を修正)
- 関連: `0389-moqt-draft-19-subscribe-tracks-allowed-params-unwired.md`（受信側の検証。スコープ外）

## 解決方法

未着手。
