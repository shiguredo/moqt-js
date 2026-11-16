# Event Timeline の index key を大文字にし、header property を実装する

- Created: 2026-11-16
- Completed: {YYYY-MM-DD}
- Branch: feature/update-msf-draft-02
- Polished: {YYYY-MM-DD}

## 目的

draft-02 §8.2 は Event Timeline の index reference を `'T'` (wallclock)、`'L'` (Location)、`'M'` (Media PTS) と定める。draft-01 の小文字 `t` / `l` / `m` から変わり、wire 互換性が壊れる。また §8.1 と §12.3.1 で、payload の解釈に必要な header data を `MSF_EVENT_TIMELINE_HEADER` Track property (0x7B) で運ぶ仕組みが入り、購読側は payload 解釈前に property の有無を確認する MUST がある。現行実装は小文字 key だけで、header property を持たない。

draft-01 との互換性は維持しない。小文字 key は受理しない。

## 現状

- `src/msf/types.ts` の `EventTimelineEntry` は `t` / `l` / `m` を持つ。この型は `src/index.ts` から公開している
- `src/msf/timeline.ts` の `encodeEventTimeline` は `t` / `l` / `m` を出力し、`decodeEventTimeline` と `isEventTimelineEntry` は小文字 key だけを受理する。大文字 key の payload は `invalid event timeline entry` で拒否する
- `src/properties.ts` は 0x7B を Property Type として定義していない。`PROPERTY_SCOPES` と `SUPPORTED_PROPERTY_TYPES` にも無い
- `resolveTrackProperty` は varint 値を持つ property だけを返すため、length + bytes 形式の 0x7B を解決できない
- devtools の `devtools/src/utils/eventTimeline.ts` と `devtools/src/components/MessageList.tsx` が `t` / `l` / `m` を直接読む

## 設計方針

- `EventTimelineEntry` のフィールドを `T` / `L` / `M` に変える。小文字との union や変換層は作らない
- `encodeEventTimeline` と `decodeEventTimeline` を大文字 key だけに変える。`isEventTimelineEntry` の index 個数検査 (ちょうど 1 つ) は維持する
- `src/properties.ts` に `MSF_EVENT_TIMELINE_HEADER` の Property Type 0x7B を追加し、scope を `track` にする。value は length + bytes で、中身は eventType が定義するバイト列である
- 0x7B を解決する専用の helper を `src/properties.ts` に追加する。`resolveTrackProperty` の varint 前提を崩さず、length + bytes の property を ID で探して `data` を返す関数にする
- Event Timeline の payload と header を組で扱う API を `src/msf/timeline.ts` に追加する。header を JSON として解釈するかは eventType 次第なので、ライブラリはバイト列のまま渡す
- devtools の表示コードを大文字 key に追随させる

## 完了条件

- `T` / `L` / `M` の payload を encode / decode できる。単体テストで固定する
- `t` / `l` / `m` の payload を拒否する。単体テストで固定する
- `MSF_EVENT_TIMELINE_HEADER` (0x7B) を Track property として encode / decode でき、`resolveTrackProperty` 相当の helper で値を取り出せる。単体テストで固定する
- 0x7B を Object property として受け取った場合に scope 違反として拒否する。単体テストで固定する
- devtools の Event Timeline 表示が大文字 key で動く
- `npx vp check` / `npx tsc --noEmit` / `npx vp test --run` が通る
