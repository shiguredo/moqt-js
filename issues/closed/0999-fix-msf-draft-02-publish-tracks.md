# publishTracks の生成 / 消費経路を実装する

- Created: 2026-11-16
- Completed: 2026-11-16
- Branch: feature/update-msf-draft-02
- Polished: {YYYY-MM-DD}

## 目的

D-38 を実装する。§5.1.5 の publishTracks を組み立てる helper と、購読側が読む helper を追加する。

## 現状

- 型と検証はあるが、生成 / 消費の経路が無い

## 設計方針

- `src/msf/tracks.ts` に `createPublishTracks(entries)` を追加し、log / metrics の track を `publishTracks` に載せられる形にする
- 購読側に `getPublishTracks(catalog, role?)` を追加する
- 高レベル publisher の log / metrics 配信までは広げない

## 完了条件

- `createPublishTracks` が §9.4 / §10.4 の必須フィールドを満たす。単体テストで固定する
- `getPublishTracks` が role で絞れる。単体テストで固定する
- `npx vp check` / `npx tsc --noEmit` / `npx vp test --run` が通る

## 解決方法

- `src/msf/tracks.ts` に `createPublishTracks` と `getPublishTracks` を追加した。log / metrics の track を publishTracks に載せ、role で絞って取り出せる
- 高レベル publisher が log / metrics を配信する機能までは広げず、helper の提供に留めた
