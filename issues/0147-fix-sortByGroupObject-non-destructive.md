# `sortByGroupObject` を非破壊的に動作するよう修正する

Created: 2026-05-10
Model: Opus 4.7

## 概要

`useSubscriber.ts:25-35` の `sortByGroupObject` 関数は `Array.prototype.sort()` をそのまま使用しているため、引数配列を in-place で破壊的にソートする。呼び出し側 (`useSubscriber.ts:462, 510`) はすべて `[...instance.liveObjectBuffer.value]` でコピーしてから渡しているため現状は安全だが、関数シグネチャがこの破壊的挙動を隠蔽している。

## 根拠

- `useSubscriber.ts:26` の `return objects.sort((a, b) => { ... });` は in-place 操作
- 呼び出し側 (`useSubscriber.ts:462, 510`) はスプレッド構文でコピーを渡しているため現状安全
- 将来コピーなしで呼ばれた場合、signal の `.value` 配列が直接破壊され、Preact の変更検知が正しく動作しなくなる

## 修正方針

1. `sortByGroupObject` 内で `return [...objects].sort((a, b) => { ... });` に変更する
2. 戻り値の型は `MoqtObject[]` のまま

## 影響範囲

- `devtools/src/hooks/useSubscriber.ts` の `sortByGroupObject` 関数定義と呼び出し側（影響なし、引数の渡し方は変更不要）

## テスト戦略

- `vp run build:devtools` でビルドが通ることを確認する
- 既存の 456 テストがすべてパスすることを確認する

## CHANGES.md 記載方針

- `### misc` サブセクションに `[FIX]` で記載する

## 完了条件

- `sortByGroupObject` 内でスプレッド構文によるコピーが行われている
- `vp run build:devtools` が成功する
- `vp test` が全テストパスする
