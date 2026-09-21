# SUBSCRIBE_TRACKS の fill 内側 Range Filter が MAX_FILTER_RANGES 検証をすり抜ける

- Created: 2026-09-21
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-subscribe-tracks-fill-filter-limit
- Polished: {YYYY-MM-DD}

## 目的

draft-ietf-moq-transport-21 §9.1.6 は MAX_FILTER_RANGES の既定を 0 とし、未指定ならピアは filter パラメータを送ってはならない (MUST NOT) と定める。§3.3.2 も MAX_FILTER_RANGES が 0 でない場合に限り Range Filters を許可する。SUBSCRIBE_TRACKS の初回送信は fill 内側の Range Filter を送るのに上限検証をすり抜けるため、ピアの上限を超えたパラメータを送ってしまう。

## 現状

- `src/session/namespaces.ts` の `namespacesSubscribeTracks` (`SessionImpl.subscribeTracks` の実装) は `validateRangeFilterLimits(options?.rangeFilters, session.peerMaxFilterRanges, "SUBSCRIBE_TRACKS")` しか呼ばず、`options.fill.rangeFilters` を数えていない
- `src/session/params.ts` の `buildSubscribeTracksParameters` は `options.fill` があるとき `buildFillParameters` を通して fill 内側の Range Filter を送る。この経路は `validateRangeFilterSpecs` による形状検証だけで上限を見ない
- SUBSCRIBE 経路 (`src/session/requests.ts` の `requestsSubscribe`) は購読本体と fill 内側の Range Filter を合算して `validateRangeFilterLimits` に渡しており、経路ごとに扱いが非対称である
- `src/session.test.ts` には SUBSCRIBE で fill 内側の Range Filter を指定すると peer 未広告で throw するテストがあるが、SUBSCRIBE_TRACKS 側には無い
- すり抜けるのは送信側のこの経路だけである。受信側は `countIncomingRangeFilterRanges` が fill 内側も数えており、REQUEST_UPDATE の送信経路も fill 内側を合算済み、FETCH は fill を持たない

## 設計方針

- `namespacesSubscribeTracks` の `validateRangeFilterLimits` に `options.fill.rangeFilters` も合算して渡す。SUBSCRIBE 経路 (`requestsSubscribe`) と同じ形に揃える
- 検証は既に `createBidirectionalStream` より前にあるため、その位置を維持する。ストリームを生成しないので失敗時の掃除は不要になる
- `FillRequestOptions.rangeFilters` の JSDoc に、ピアの MAX_FILTER_RANGES が 0 のとき、および Ranges の合計が上限を超えるときに指定すると throw することを追記する (`fill.rangeFilters` に限定した文面にし、fill 全体の制約と読ませない)。`SubscribeTracksOptions.rangeFilters` の既存記述は 0 の場合だけなので、上限超過の条件も足して揃える
- `src/session.test.ts` に、SUBSCRIBE_TRACKS で fill 内側に Range Filter を指定したときのテストを追加する。peer 未広告 (MAX_FILTER_RANGES = 0) は `createSessionImpl()` で throw を判別できる (`createBidirectionalStream` を持たない)。上限超過 (peer 上限 1 に対して fill 内側に 2 Ranges) は `createNamespaceSendFailureTransport` のように `createBidirectionalStream` を持つ transport を使い、ストリームを開かずに throw することを固定する

## 完了条件

- fill 内側の Range Filter も含めて MAX_FILTER_RANGES が検証され、peer 未広告と上限超過の両方で throw する
- 検証はストリーム生成より前に行われ、上限超過時にストリームを開かない
- `FillRequestOptions.rangeFilters` / `SubscribeTracksOptions.fill` の JSDoc が実装と揃う
- 追加したテストと既存テストが通る

## 参照

- draft-ietf-moq-transport-21 §9.1.6 (MAX_FILTER_RANGES の既定は 0。未指定ならピアは filter パラメータを送ってはならない。超過は INVALID_FILTER で拒否する MUST)
- draft-ietf-moq-transport-21 §3.3.2 (Range Filters は MAX_FILTER_RANGES が 0 でない場合に限り許可される)
- draft-ietf-moq-transport-21 §9.18.1 (SUBSCRIBE_TRACKS は Location Filter と FILL_PARAMETERS を指定できる)
- draft-ietf-moq-transport-21 §9.20.16 (FILL PARAMETERS Parameter の定義。内側に置ける Range Filter は 0x25-0x28)

## 解決方法

{未着手}
