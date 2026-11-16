# Event Timeline の header property を購読側で確認する

- Created: 2026-11-16
- Completed: 2026-11-16
- Branch: feature/update-msf-draft-02
- Polished: {YYYY-MM-DD}

## 目的

draft-02 §8.1 は、購読側が Event Timeline の payload を解釈する前に `MSF_EVENT_TIMELINE_HEADER` (0x7B) の有無を確認する MUST を定める。実装は property の定義と解決 helper を持つが、payload の decode と property の確認が分離しており、呼び出し側が確認を忘れられる。

## 現状

- `src/msf/timeline.ts` の `decodeEventTimeline` は payload だけを受け取る
- `src/properties.ts` の `resolveEventTimelineHeader` は実装済みだが、`decodeEventTimeline` と組み合わせる helper が無い
- devtools の購読経路 (`devtools/src/hooks/useSubscriber.ts`) は header を解決せずに payload を decode している

## 設計方針

- `src/msf/timeline.ts` に `decodeEventTimelineObject(trackProperties, payload)` を追加する。`MSF_EVENT_TIMELINE_HEADER` は Track scope の property (0x7B) であり Object properties には載らないため、購読ハンドルが持つ Track Properties を受け取る
- §8.1 は「payload の解釈前に property の有無を確認する MUST」と「property の利用は optional で、不在はヘッダデータなしを意味する」を定める。したがって不在をエラーにせず、解決結果 (`header`) を呼び出し側へ返す
- devtools の購読経路をこの helper に置き換える
- §8.1 が求めるのは「解釈前の確認」であり、property が無い payload を draft-02 の形式として解釈しないことを保証する

## 完了条件

- header property を持つ Track で、header を解決しつつエントリを decode できる。単体テストで固定する
- header property を持たない Track でも、ヘッダデータなしとして decode できる (不在は不正ではない)。単体テストで固定する
- devtools の Event Timeline 表示が header を確認する経路になる。単体テストで固定する
- `npx vp check` / `npx tsc --noEmit` / `npx vp test --run` が通る

## 解決方法

- `src/msf/timeline.ts` に `decodeEventTimelineObject(trackProperties, payload)` を追加した。payload の解釈と `MSF_EVENT_TIMELINE_HEADER` の確認を 1 つの入口にまとめ、header の解決結果を返す
- `MSF_EVENT_TIMELINE_HEADER` (0x7B) は Track scope の property であり Object properties には載らないため、購読ハンドルが持つ Track Properties を渡す形にした
- §8.1 は property の利用を optional とし、不在は「ヘッダデータなし」を意味するため、不在をエラーにしない。issue の設計方針をこの仕様解釈に合わせて更新した
- devtools の event timeline 購読が、購読ハンドルの Track Properties を渡して decode するようにした
- header あり / なしの両方を単体テストで固定した
