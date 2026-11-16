# multi-variant publisher の開始 Group ID と altGroup の付与を直す

- Created: 2026-11-16
- Completed: {YYYY-MM-DD}
- Branch: feature/update-msf-draft-02
- Polished: {YYYY-MM-DD}

## 目的

draft-02 §4.3 は alternate group 内の各 track が同じ開始 Group ID を持つことと、keyframeSpacing を映像 track に載せることを求める。0977 で追加した `initialGroupId` は単調ガードに阻まれて音声と映像で値がずれ、`altGroup` と `keyframeSpacing` は音声 track にも載ってしまっている。

## 現状

- `src/createMediaPublisher.ts` のコンストラクタは `allocateInitialGroupId(initialGroupId ?? ...)` を音声と映像で 2 回呼ぶ。`allocateInitialGroupId` は共有の `maxGroupIdSeen` を必ず +1 するため、`initialGroupId` に同じ値を渡しても 2 回目は +1 された値になる
- `createCatalogTracks` の `latencyFields` に `altGroup` と `keyframeSpacing` が入り、音声 track にも spread される。`keyframeSpacing` は「キーフレーム間隔あたりの Object 数」であり音声には意味が無い。`altGroup` も音声と映像を同じ alternate group に入れるのは意味が異なる
- publisher の新オプションに対するテストが無い

## 設計方針

- `initialGroupId` を指定したときは単調ガードを通さず、その値を音声と映像の両方に使う。呼び出し側が「過去のどの Group ID よりも大きい」ことを保証する契約とし、JSDoc に明記する
- `altGroup` と `keyframeSpacing` は映像 track にだけ載せる。`targetLatency` と `renderGroup` は従来どおり両方に載せる
- 開始 Group ID の解決を純関数に切り出し、単体テストで固定する

## 完了条件

- `initialGroupId` を指定すると音声と映像の開始 Group ID が一致する。単体テストで固定する
- `initialGroupId` を省略したときは従来どおり単調増加する値になる。単体テストで固定する
- catalog の `altGroup` と `keyframeSpacing` が映像 track にだけ載る。単体テストで固定する
- `npx vp check` / `npx tsc --noEmit` / `npx vp test --run` が通る
