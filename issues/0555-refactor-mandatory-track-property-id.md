# Mandatory Track Property の範囲判定を定数・述語に集約する

- Created: 2026-09-09
- Completed: YYYY-MM-DD
- Branch: feature/refactor-mandatory-track-property-id
- Polished: YYYY-MM-DD

## 目的

`id >= 0x4000n && id <= 0x7fffn` の判定が `src/properties.ts` の 3 箇所に重複している。述語関数に集約し、値域変更時の修正漏れを防ぐ。

## 現状

- `src/properties.ts` の `decodeProperties`（Track Properties の未知 Mandatory 検出）
- 同ファイルの `IMMUTABLE_PROPERTIES` 内側走査
- 同ファイルの `assertNoMandatoryTrackPropertyInObjectProperties`
  に同じ範囲判定がある。

## 設計方針

1. 非公開の述語 `isMandatoryTrackPropertyId(id: bigint): boolean` を追加する。
2. 3 箇所から述語を呼ぶ。挙動は変えない。

## 完了条件

- 範囲判定が 1 箇所に集約されること。
- 既存テストが通ること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 関連

- draft-ietf-moq-transport-20 §2.5.1
- `src/properties.ts`
