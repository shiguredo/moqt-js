# SUBSCRIBE_TRACKS / REQUEST_UPDATE で Range Filters を送信できるようにする

- Created: 2026-08-07
- Completed: 2026-08-07
- Branch: feature/add-range-filters-subscribe-tracks
- Polished: (未磨き上げ)

## 目的

draft-ietf-moq-transport-19 では Range Filters (§5.1.3) が SUBSCRIBE_TRACKS と REQUEST_UPDATE (subscription 向け) でも使用できると定められているが、moqt-js は送信手段を公開 API に持ちながらワイヤに載せておらず、仕様に未対応である。draft-19 対応のリリースに備えて送信できるようにする。

## 現状

- `SubscribeTracksOptions.rangeFilters` (`src/session.ts` の `SubscribeTracksOptions`) は定義されているが、`buildSubscribeTracksParameters` (`src/session/params.ts`) は GROUP_ORDER / FORWARD のみをエンコードしており、Range Filters を SUBSCRIBE_TRACKS に載せられない。
- `RequestUpdateOptions.rangeFilters` (`src/subscriber.ts` の `RequestUpdateOptions`) は定義されているが、`bidiSendRequestUpdate` (`src/session/bidi.ts`) は `options.parameters` と FORWARD / AUTHORIZATION_TOKEN のみをエンコードしており、`options.rangeFilters` をワイヤに載せられない。
- `subscribe()` は `peerMaxFilterRanges` をチェックして送信をガードしているが、`subscribeTracks()` (`src/session.ts` の `SessionImpl.subscribeTracks`) と REQUEST_UPDATE 経路には同ガードがない。

## 設計方針

draft-ietf-moq-transport-19 の記述に従う:

- §10.19.1: "Any Parameter that can be specified on a Subscription (ie: in SUBSCRIBE) is valid in SUBSCRIBE_TRACKS, unless otherwise specified."
- §6.3: "Range Filters Section 5.1.3 can be used in SUBSCRIBE_TRACKS to filter Tracks in a namespace using the Track Property Filter."
- §5.1.3: "In REQUEST_UPDATE, Length can be 0 to remove a filter parameter or non-zero to replace that entire filter parameter including all sets and Property Types. If a filter parameter is omitted from REQUEST_UPDATE, the value is unchanged."
- §10.3.1.6: MAX_FILTER_RANGES が 0 (未広告含む) のときは Range Filter を送信してはならない。上限超過時は送信前に拒否する。

実装方針:

- `buildSubscribeTracksParameters` に `rangeFilters` を追加し、`subscribeTracks()` から渡す。
- `subscribeTracks()` に `subscribe()` と同様の MAX_FILTER_RANGES ガードを追加する。
- `bidiSendRequestUpdate` で `options.rangeFilters` をエンコードして parameters に追加し、MAX_FILTER_RANGES ガードを追加する。REQUEST_UPDATE は置換 / 削除 (Length=0) を伴うため、削除以外の Ranges 数のみ上限チェックする。
- `buildSubscribeParameters` の Range Filters エンコード (`rangeFilterTypeToParamType` + `encodeRangeFilter`) を再利用する形で共通化する。

## 完了条件

- `subscribeTracks(prefix, callbacks, { rangeFilters: [...] })` が SUBSCRIBE_TRACKS に Range Filters (TRACK_PROPERTY_FILTER 含む) をワイヤエンコードして送信する。
- `subscriber.update({ rangeFilters: [...] })` が REQUEST_UPDATE に Range Filters をワイヤエンコードして送信し、`{ rangeFilters: [{ type, remove: true }] }` で Length=0 の削除を送信する。
- `subscribeTracks()` / REQUEST_UPDATE でピアの MAX_FILTER_RANGES を超える指定は throw する。
- 上記の PBT / 単体テストが追加され、`pnpm test` が全てパスする。

## 解決方法

- `src/session/params.ts` に `buildRangeFilterParameters` (Range Filter 指定 → Message Parameter 列) と `validateRangeFilterLimits` (MAX_FILTER_RANGES ガード) を追加し、`buildSubscribeParameters` / `buildSubscribeTracksParameters` / `bidiSendRequestUpdate` で共通利用する
- `buildSubscribeTracksParameters` に `rangeFilters` オプションを追加し、SUBSCRIBE_TRACKS に Range Filters (TRACK_PROPERTY_FILTER 含む) をエンコードして送信できるようにする
- `bidiSendRequestUpdate` に `options.rangeFilters` のエンコード (Length=0 の削除含む) を追加する
- `SessionImpl.subscribeTracks` にピアの MAX_FILTER_RANGES ガードを追加し、`subscribe` の既存ガードを `validateRangeFilterLimits` に置き換える
- テスト: `src/session/params.test.ts` に `buildSubscribeTracksParameters` / `buildRangeFilterParameters` / `validateRangeFilterLimits` の単体テスト、`src/session/bidi.test.ts` に `bidiSendRequestUpdate` の Range Filters ワイヤテストと上限ガードテストを追加する
