# MediaPublisher の純粋ロジックを切り出してテストする

- Created: 2026-09-06
- Completed: YYYY-MM-DD
- Branch: feature/add-media-publisher-tests
- Polished: YYYY-MM-DD

## 目的

`createMediaPublisher` に対応テストがなく、グループ管理・キーフレーム判定等の純粋ロジックが private に埋没して検証できない。Subscriber 側と同様に切り出して pin する必要がある。

## 現状

- `src/createMediaSubscriber.test.ts` は存在するが `src/createMediaPublisher.test.ts` がない。
- `keyframeInterval` 境界、音声グループ周期、優先度定数等が未検証である。

## 設計方針

1. グループ管理・キーフレーム判定を純関数に切り出す (Subscriber 側の切り出し方針に合わせる)。
2. 切り出した関数の単体テストを追加する。

## 完了条件

- 純粋ロジックがテストで pin されること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。
