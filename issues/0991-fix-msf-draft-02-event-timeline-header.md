# Event Timeline の header property を購読側で確認する

- Created: 2026-11-16
- Completed: {YYYY-MM-DD}
- Branch: feature/update-msf-draft-02
- Polished: {YYYY-MM-DD}

## 目的

draft-02 §8.1 は、購読側が Event Timeline の payload を解釈する前に `MSF_EVENT_TIMELINE_HEADER` (0x7B) の有無を確認する MUST を定める。実装は property の定義と解決 helper を持つが、payload の decode と property の確認が分離しており、呼び出し側が確認を忘れられる。

## 現状

- `src/msf/timeline.ts` の `decodeEventTimeline` は payload だけを受け取る
- `src/properties.ts` の `resolveEventTimelineHeader` は実装済みだが、`decodeEventTimeline` と組み合わせる helper が無い
- devtools の購読経路 (`devtools/src/hooks/useSubscriber.ts`) は header を解決せずに payload を decode している

## 設計方針

- `src/msf/timeline.ts` に `decodeEventTimelineObject(obj)` を追加する。`MoqtObject` 相当の `{ properties?, payload }` を受け取り、`MSF_EVENT_TIMELINE_HEADER` が無ければエラーにする。property があれば既存の `decodeEventTimeline` に委譲する
- devtools の購読経路をこの helper に置き換える
- §8.1 が求めるのは「解釈前の確認」であり、property が無い payload を draft-02 の形式として解釈しないことを保証する

## 完了条件

- header property を持つ Object を decode できる。単体テストで固定する
- header property を持たない Object を拒否する。単体テストで固定する
- devtools の Event Timeline 表示が header を確認する経路になる。単体テストで固定する
- `npx vp check` / `npx tsc --noEmit` / `npx vp test --run` が通る
