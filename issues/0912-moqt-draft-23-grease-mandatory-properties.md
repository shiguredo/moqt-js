# Mandatory Track Property の判定から GREASE 値を除外する

- Created: 2026-11-03
- Completed: {YYYY-MM-DD}
- Branch: feature/change-grease-mandatory-properties
- Polished: 2026-11-03

## 目的

draft 23 §3.7 は 0x4000〜0x7FFF の GREASE 値を Mandatory Track Properties から除外した。現在は値域だけで判定し、拡張性確認用の合法な Property で Track を拒否する。

## 現状

- `src/properties.ts` の `isMandatoryTrackPropertyId` は値域だけを比較する
- `decodeProperties`、`parseProperties`、`decodeImmutableProperties`、Object Property 検証などがこの述語を使う
- `src/grease.ts` に `isGreaseValue` があり、0x7f * N + 0x9D を判定できる

## 設計方針

- Mandatory 判定を「値域内、かつ GREASE でない」にする。各 decoder の判定を別々に変更しない
- Track / Object、mutable / Immutable Properties 内側の全経路へ反映する
- GREASE Property の値は未知 Property として扱い、既知型の意味論や一意性を誤適用しない
- 非 GREASE の未知 Mandatory Property は引き続き拒否する。TRACK_STATUS_OK での未知 Mandatory Property は `bidiReadTrackStatusResponse` が既に失敗処理を持つため、その制御を壊さない

## 完了条件

- 0x4000〜0x7FFF に入る実際の GREASE 値、その前後の非 GREASE 値、値域境界を検証する
- PUBLISH / SUBSCRIBE_OK / FETCH の OK / TRACK_STATUS_OK、Object、Immutable Properties 内側で GREASE を誤拒否しない
- 未知 Mandatory Property の既存の拒否・取消し処理を維持する

## 参照

- `refs/moq/draft-ietf-moq-transport-23.txt` §3.7 / §13
- `src/properties.ts` の `isMandatoryTrackPropertyId`、`src/grease.ts` の `isGreaseValue`
- `issues/closed/0555-refactor-mandatory-track-property-id.md` は述語の集約であり、GREASE 除外は実装していない

## 解決方法

{未着手}
