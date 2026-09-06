# moqlog と moqmetrics の対称重複を共通化する

- Created: 2026-09-06
- Completed: YYYY-MM-DD
- Branch: feature/refactor-observability-unify
- Polished: YYYY-MM-DD

## 目的

値同一の定数と同型ヘルパーが 2 モジュールに並立し、修正漏れの温床になる。共通化する必要がある。

## 現状

- severity 8 項目表、`GROUP_ID_MASK_62`、track namespace / name ヘルパー、JSON object 検証が `src/moqlog.ts` と `src/moqmetrics.ts` で同型である (差分は文字列と単位のみ)。

## 設計方針

1. 共有モジュールに寄せ、両者から利用する。
2. 検証強化 (`0489`) との順序を調整する (先後どちらでもよいが同時編集の競合に注意)。

## 完了条件

- 重複が除去され、既存テストが全て通ること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 関連

- `0489` (payload 検証強化)
