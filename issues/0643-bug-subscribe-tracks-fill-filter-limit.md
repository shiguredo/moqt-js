# SUBSCRIBE_TRACKS の fill 内側 Range Filter が MAX_FILTER_RANGES 検証をすり抜ける

- Created: 2026-09-21
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-subscribe-tracks-fill-filter-limit
- Polished: {YYYY-MM-DD}

## 目的

draft-ietf-moq-transport-21 §9.1.6 は MAX_FILTER_RANGES の既定を 0 とし、未指定ならピアは filter パラメータを送ってはならない (MUST NOT) と定める。§3.3.2 も MAX_FILTER_RANGES が 0 でない場合に限り Range Filters を許可する。SUBSCRIBE_TRACKS は fill 内側の Range Filter を送るのに上限検証をすり抜けるため、ピアの上限を超えたパラメータを送ってしまう。

## 現状

- `src/session/namespaces.ts` の `namespacesSubscribeTracks` (`SessionImpl.subscribeTracks` の実装) は `validateRangeFilterLimits(options?.rangeFilters, session.peerMaxFilterRanges, "SUBSCRIBE_TRACKS")` しか呼ばず、`options.fill.rangeFilters` を数えていない
- `src/session/params.ts` の `buildSubscribeTracksParameters` は `options.fill` があるとき `buildFillParameters` を通して fill 内側の Range Filter を送る。この経路は `validateRangeFilterSpecs` による形状検証だけで上限を見ない
- SUBSCRIBE 経路 (`src/session/requests.ts` の `requestsSubscribe`) は購読本体と fill 内側の Range Filter を合算して `validateRangeFilterLimits` に渡しており、経路ごとに扱いが非対称である
- `src/session.test.ts` には SUBSCRIBE で fill 内側の Range Filter を指定すると peer 未広告で throw するテストがあるが、SUBSCRIBE_TRACKS 側には無い

## 設計方針

- `namespacesSubscribeTracks` の `validateRangeFilterLimits` に `options.fill.rangeFilters` も合算して渡す。SUBSCRIBE 経路と同じ形に揃える
- SUBSCRIBE 経路と同じく、ストリーム生成より前に検証して throw する (失敗時にストリームのロックを残さない既存の掃除経路に乗せる)
- `src/session.test.ts` に、SUBSCRIBE_TRACKS で fill 内側に Range Filter を指定すると peer 未広告で throw するテストを追加する

## 完了条件

- fill 内側の Range Filter も含めて MAX_FILTER_RANGES が検証される
- 上限超過時にストリームを開かずに throw する
- 追加したテストと既存テストが通る

## 参照

- draft-ietf-moq-transport-21 §9.1.6 (MAX_FILTER_RANGES の既定は 0。未指定ならピアは filter パラメータを送ってはならない。超過は INVALID_FILTER で拒否する MUST)
- draft-ietf-moq-transport-21 §3.3.2 (Range Filters は MAX_FILTER_RANGES が 0 でない場合に限り許可される)
- draft-ietf-moq-transport-21 §9.20.16 (FILL PARAMETERS Parameter)

## 解決方法

{未着手}
