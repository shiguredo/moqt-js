# Mandatory Track Property の範囲判定を定数・述語に集約する

- Created: 2026-09-09
- Completed: 2026-09-13
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

## 解決方法

`src/properties.ts` に述語 `isMandatoryTrackPropertyId` と値域定数 2 つを追加し、重複していた 6 箇所の判定を置き換えた。

- 定数 `MANDATORY_TRACK_PROPERTY_ID_MIN` (0x4000n) / `MANDATORY_TRACK_PROPERTY_ID_MAX` (0x7fffn) と、述語 `isMandatoryTrackPropertyId(id)` を `TrackPropertyId` の直後に追加した。draft-ietf-moq-transport-21 §3.6 (Mandatory Track Properties) を根拠としてコメントに残した。
- 置き換えた 6 箇所は `decodeImmutableProperties` の外側と内側、`parseProperties`、`decodeProperties`、`assertKnownPropertyValueInObjectProperties` の内側走査、`validateTrackPropertyValue` である (起票時は 3 箇所と記載されていたが、着手時の調査で 6 箇所あった)。
- 挙動は変えていない。`MANDATORY_TRACK_PROPERTY_ID_MAX` は数値リテラルの桁区切りを避けるため既存表記 (0x7fffn) のままにした。
- `CHANGES.md` の `## develop` の `### misc` に `[UPDATE]` を追加した。

## 検証

- `rg "0x4000n && |0x7fffn"` で判定の重複が残っていないことを確認した (定数定義のみが残る)。
- `pnpm test run`: 70 ファイル / 2,091 テスト全通過
- `pnpm typecheck` / `pnpm lint` / `pnpm fmt` すべて成功
