# Publisher Priority の未検証による黙示丸め

- Created: 2026-09-06
- Completed: YYYY-MM-DD
- Branch: feature/fix-publisher-priority-range
- Polished: YYYY-MM-DD

## 目的

範囲外 priority が `Uint8Array` 化で黙って丸められ (`300` → `44`)、意図しない優先度で送信される。送信前に検証して失敗させる必要がある。

## 現状

- `src/session/publish.ts` の subgroup header 組み立ては `params.priority` を 0-255 検証なしに使う。
- `src/session/params.ts` の `buildPublishTrackProperties` は同値を検証して `throw` するため不整合である。
- 仕様 (§12.4) は 255 超を invalid と定義する。

## 設計方針

1. 送信前に 0-255 を検証し、範囲外は `throw` する (既存の検証パターンに合わせる)。
2. 境界値の単体テストを追加する。

## 完了条件

- 範囲外 priority で送信前に失敗し、丸め送信が起きないこと。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 関連

- draft-ietf-moq-transport-20 §12.4
