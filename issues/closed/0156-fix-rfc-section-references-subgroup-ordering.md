# `useSubscriber.ts` の Subgroup 配送順に関する RFC 節参照を `§2.2` に修正する

Created: 2026-05-11
Completed: 2026-05-11
Model: Opus 4.7

## 概要

`useSubscriber.ts` の 2 箇所で、Subgroup ストリーム間の配送順非保証の根拠として `§10.4.2` および `§10.3 / §10.4` を引用しているが、これらの節は SUBGROUP_HEADER / Datagram / Stream の **ワイヤフォーマット定義** であって、ストリーム間の到着順序に関する規範は含まない。配送順非保証の根拠は `draft-ietf-moq-transport-17 §2.2 (Subgroups)` にある。issue #0145 で `§10.3` を `§10.4.2` に「修正」したが、結果として誤った定義節への参照を確定させてしまった。

## 根拠

- `refs/moq/draft-ietf-moq-transport-17.txt` §10.4.2 (4721-4746 行) は SUBGROUP_HEADER の構造を定義する節:
  > All Objects on a Subgroup stream belong to the track identified by Track Alias (see Section 10.1) and the Subgroup indicated by 'Group ID' and Subgroup ID indicated by the SUBGROUP_HEADER.
- 配送順非保証の根拠は §2.2 (820-877 行) にある:
  > Streams offer in-order reliable delivery and the ability to cancel sending and retransmission of data. … many QUIC and WebTransport implementations offer the ability to control the relative scheduling priority of pending stream data.
- §10.3 (4568-4602 行) は「単一 Object を Datagram で運ぶことができる」という用法の説明であって、Subgroup ストリームと Datagram の並行配送順序については書いていない
- CHANGES.md の `(Subgroup ストリームは §10.4.2 で定義)` という補足説明も同じ誤りを増幅している

## 修正方針

1. `devtools/src/hooks/useSubscriber.ts:22-24` の `§10.4.2` 引用を `§2.2 (Subgroups)` に修正する
2. `devtools/src/hooks/useSubscriber.ts:490-493` の `§10.3 / §10.4` 引用を `§2.2 (Subgroups)` に修正する
3. `CHANGES.md` の `### misc` 配下 `#0145` エントリ内 `§10.3 を §10.4.2 に修正する (Subgroup ストリームは §10.4.2 で定義)` を訂正する記述を `### misc` 配下に `[FIX]` で追加する

## 影響範囲

- `devtools/src/hooks/useSubscriber.ts` のコメントのみ
- `CHANGES.md` への新エントリ追加

## テスト戦略

- `vp run build:devtools` でビルドが通ることを確認する
- `vp run test` で全 456 テストがパスすることを確認する
- 該当節の本文を `refs/moq/draft-ietf-moq-transport-17.txt` で目視確認する

## CHANGES.md 記載方針

- `### misc` サブセクションに `[FIX]` で記載する

## 完了条件

- `useSubscriber.ts:22-24` の RFC 引用が `§2.2 (Subgroups)` を指している
- `useSubscriber.ts:490-493` の RFC 引用が `§2.2 (Subgroups)` を指している
- `CHANGES.md` に訂正エントリが追加されている
- `vp run build:devtools` が成功する
- `vp run test` が全テストパスする

## 解決方法

- `devtools/src/hooks/useSubscriber.ts` の 2 箇所 (sortByGroupObject 上 / Joining Fetch onEnd 内 sort コメント) を `§2.2 (Subgroups)` 参照に修正し、配送順非保証の規範根拠を明確にした。
- `CHANGES.md` の `### misc` セクションに `[FIX]` エントリを追加した。
