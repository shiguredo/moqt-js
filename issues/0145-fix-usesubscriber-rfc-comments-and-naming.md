# `useSubscriber.ts` の RFC 節番号誤り・変数名省略・節参照記法不統一を修正する

Created: 2026-05-10
Model: Opus 4.7

## 概要

`useSubscriber.ts` 内のコメントに以下の問題がある:

1. 22-25 行目の `draft-ietf-moq-transport-17 §10.3` の引用が誤っている。§10.3 は "Datagrams" を扱っており、Subgroup ストリーム配送の記述は存在しない。Subgroup ストリームは §10.4.2 "Subgroup Header" で定義されている。
2. 425 行目の変数名 `ext` が省略形であり、AGENTS.md の「変数名を省略しないこと」に違反している。同一ファイル 124 行目では `locProperties` と命名している。
3. 674 行目の `Section 9.3.11` が `§9.14.2.1` (67 行目) や `§10.3 / §10.4` (458 行目) と記法が混在している。
4. 361 行目の `draft-ietf-moq-loc-02 §2.1` が大まかすぎる。VideoDecoderConfig.description へのマッピングは §2.1.2 "Parameter Sets in Headers" に明記されている。

## 根拠

- §10.3 の誤り: `refs/moq/draft-ietf-moq-transport-17.txt` の §10.3 (4568 行目〜) の表題は "Datagrams" であり、本文中に Subgroup の語は一度も出現しない。Subgroup ストリーム配送は §10.4.2 "Subgroup Header" (4721 行目〜) で定義されている。
- 変数名 `ext`: AGENTS.md:112 に違反。124 行目の `const locProperties = LOC.decodeVideoProperties(obj.properties);` と一貫性がない。
- LOC 節番号: §2.1.2 "Parameter Sets in Headers" に "map to the WebCodecs VideoDecoderConfig description property" と明記されている。なお §2.2 "MOQ Object Mapping" は internal data に関する記述であり、361 行目（description プロパティ）とは無関係（internal data の記述は 137 行目の別コメントが参照すべき）。

## 修正方針

1. `useSubscriber.ts:22-25` の `§10.3` → `§10.4.2` に修正する。コメントは Subgroup ストリームの配送順を扱っているため、Subgroup Header を定義する §10.4.2 を参照するのが適切。なお 458-461 行目の `§10.3 / §10.4` は Datagram と Stream の両方に言及しているため正確でありそのまま
2. `useSubscriber.ts:425` の `ext` → `locProperties` に修正する（`ext.frameMarking` と `ext.frameMarking.isIndependent` の 2 箇所も連動して変更）
3. `useSubscriber.ts:674` の `Section 9.3.11` → `§9.3.11` に修正する
4. `useSubscriber.ts:361` の `draft-ietf-moq-loc-02 §2.1` → `draft-ietf-moq-loc-02 §2.1.2` に具体化する

## 影響範囲

- `devtools/src/hooks/useSubscriber.ts` のみ

## テスト戦略

- `vp run build:devtools` でビルドが通ることを確認する
- `vp run test` で既存の全テストがパスすることを確認する

## CHANGES.md 記載方針

- `### misc` サブセクションに `[UPDATE]` で記載する（コードの振る舞いを変更しない修正のため）

## 完了条件

- 4 箇所の修正がすべて適用されている（`ext` のリネームは `ext.frameMarking` / `ext.frameMarking.isIndependent` の 2 箇所も含めて変更されている）
- `vp run build:devtools` が成功する
- `vp run test` が全テストパスする
