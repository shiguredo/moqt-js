# dataStream と parameter モジュールを分割する

- Created: 2026-09-06
- Completed: YYYY-MM-DD
- Branch: feature/refactor-datastream-split
- Polished: YYYY-MM-DD

## 目的

1800 行超の 2 モジュールに複数機能が同居し、見通しを超えている。機能単位に分割する必要がある。

## 現状

- `src/dataStream.ts` (約 1900 行) に Subgroup / Datagram / Fetch の encode / decode が同居する。
- `src/message/parameter.ts` (約 1700 行) に KVP / Message Parameter / Location Filter / Range Filter / Track Namespace が同居する。
- `Uint8Array` 連結ボイラープレートが約 57 箇所に反復する。
- `firstObject` と `type` の正規化 (`hasContainsEndOfGroup` の命名含む) が曖昧である。

## 設計方針

1. 機能単位にモジュール分割し、連結ヘルパー (`concatParts` 等) に寄せる。
2. `type` と `firstObject` の正規化と命名を整理する (公開 API の改名は `0517` と調整する)。

## 完了条件

- 機能単位で見通せる分割になり、重複が除去されること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 関連

- `0517` (公開 API 境界の整理。改名を伴う場合は連携する)
