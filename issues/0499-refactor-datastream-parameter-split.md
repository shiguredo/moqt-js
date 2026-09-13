# dataStream と parameter モジュールを分割する

- Created: 2026-09-06
- Completed: 2026-09-14
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

## 解決方法

`src/dataStream.ts` と `src/message/parameter.ts` を機能単位のモジュールに分割し、Uint8Array の連結ボイラープレートを共通ヘルパーに集約した。公開 API と挙動は変えていない。

### 分割

`src/dataStream.ts` (2,025 → 68 行。再輸出のみ)

| ファイル | 行数 | 内容 |
| --- | --- | --- |
| `src/dataStream/common.ts` | 103 | `MoqtObject` / Priority・Object Status の検証 |
| `src/dataStream/subgroup.ts` | 560 | Subgroup Header (§11.3.1) と Object fields |
| `src/dataStream/datagram.ts` | 404 | Object Datagram (§11.2.1) |
| `src/dataStream/fetch.ts` | 971 | Fetch Header と Fetch Object fields (§11.4.1) |

`src/message/parameter.ts` (1,734 → 99 行。再輸出のみ)

| ファイル | 行数 | 内容 |
| --- | --- | --- |
| `src/message/parameter/common.ts` | 46 | `Parameter` と上限値 |
| `src/message/parameter/kvp.ts` | 158 | Key-Value-Pair の encode / decode |
| `src/message/parameter/messageParameter.ts` | 552 | Message Parameter と FILL_PARAMETERS |
| `src/message/parameter/locationFilter.ts` | 349 | Location Filter |
| `src/message/parameter/rangeFilter.ts` | 338 | Range Filter |
| `src/message/parameter/trackNamespace.ts` | 309 | Track Namespace / Track Name |

元の 2 モジュールは既存の import パス (`./dataStream` / `./message/parameter`) を維持するための再輸出のみとした。`parameter/index.ts` 化はせず、`parameter.ts` と `parameter/` を併存させている (既存 import を 1 文字も変えずに解決させるため)。

### 連結ヘルパーの集約

`src/bytes.ts` に `concatUint8Arrays` を置き、手書きの連結 (合計長の算出 → 領域確保 → `set` ループ) 18 箇所を置き換えた。`src/dataStream/bytes.ts` ではなく `src/bytes.ts` にしたのは、`src/message/parameter/*` から `src/dataStream/*` への逆方向依存を作らないため (`src/varint.ts` / `src/length.ts` と同じ src 直下の共通ヘルパー)。テスト専用ヘルパー `src/testSupport/helpers.ts` にあった同名の重複実装も、この共通ヘルパーの再公開に置き換えた。

### 未実施とした項目

設計方針 2 のうち `hasContainsEndOfGroup` の命名は `0517` で解消済み。`SubgroupHeader.firstObject?: boolean` はデコード時に `true` か `undefined` しか取らない optional boolean であり曖昧さが残るが、公開型の変更 (必須化または別名化) になるため本 issue では変更していない。別途 issue を起こして判断する。

### 検証

- `vp test run`: 98 ファイル / 2,177 テスト全通過 (テストは 1 ファイルも変更していない)
- 公開 API 不変の確認: `vp pack` 後の `dist/index.js` の実行時輸出 63 件が分割前と完全一致、`dist/index.d.ts` の宣言名 316 件も完全一致
- 移動前後の有意行を多重集合として比較し、差分が「連結ボイラープレートの削除」「helper 呼び出しへの置換」「import / 再輸出の追加」のみであることを確認 (ロジック行の改変なし)
- `vp check` / `tsc --noEmit` / `vp pack` 通過
- `CHANGES.md` の `## develop` の `### misc` に `[UPDATE]` を追加した
