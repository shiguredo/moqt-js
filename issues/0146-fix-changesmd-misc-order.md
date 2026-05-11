# `CHANGES.md` の `### misc` エントリ順序を修正する

Created: 2026-05-10
Model: Opus 4.7

## 概要

`CHANGES.md` の `## develop` → `### misc` セクションにおいて、`[CHANGE]` エントリ (24 行目) が `[UPDATE]` エントリ (37 行目) より先に記載されている。AGENTS.md:95 は「エントリは種別の順番を守って記載すること（UPDATE → ADD → CHANGE → FIX の順）」と規定している。

## 根拠

- AGENTS.md:95: 「エントリは種別の順番を守って記載すること（UPDATE → ADD → CHANGE → FIX の順）」
- 現在の CHANGES.md では 24 行目に `[CHANGE] devtools の Preact + signals 利用を改善する`、37 行目に `[UPDATE] .oxlintrc.jsonc を...` が配置されている

## 修正方針

1. `[UPDATE] .oxlintrc.jsonc ...` のエントリ (37-42 行目) を `[CHANGE] devtools ...` のエントリ (24-36 行目) より前に移動する
2. 担当者 `@voluntas` のインデントや形式に変更がないことを確認する

## 影響範囲

- `CHANGES.md` のみ

## テスト戦略

- 目視で順序を確認する

## CHANGES.md 記載方針

- 本修正自体は CHANGES.md への追記不要（順序修正のみのため）

## 完了条件

- `### misc` 内で `[UPDATE]` → `[ADD]` → `[CHANGE]` → `[FIX]` の順になっている（該当エントリが UPDATE → CHANGE の順になっている）
