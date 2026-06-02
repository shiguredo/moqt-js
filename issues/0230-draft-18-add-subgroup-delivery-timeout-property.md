# SUBGROUP_DELIVERY_TIMEOUT Track Property (Type 0x06) が未定義

- Priority: High
- Created: 2026-06-02
- Model: deepseek-v4-pro
- Branch: {Git-Flow のブランチ名}
- Polished: {YYYY-MM-DD}

## 目的

draft-ietf-moq-transport-18 §12.1 で定義されている SUBGROUP_DELIVERY_TIMEOUT Track Property (Type 0x06) が TrackPropertyId に未定義である問題を修正する。

## 優先度根拠

仕様で定義された Track Property の欠落であり、他実装がこの Property を含むトラックを正しく処理できないため High。

## 現状

`src/properties.ts` の `TrackPropertyId` に `0x06` のエントリがない。
定義済みの Track Property: MAX_CACHE_DURATION (0x04), OBJECT_DELIVERY_TIMEOUT (0x02), DEFAULT_PUBLISHER_PRIORITY (0x0E), DEFAULT_PUBLISHER_GROUP_ORDER (0x22), DYNAMIC_GROUPS (0x30)。

## 一次資料の引用

draft-ietf-moq-transport-18 §12.1 (SUBGROUP_DELIVERY_TIMEOUT):

> SUBGROUP_DELIVERY_TIMEOUT (0x06): A varint property identifying the
> maximum amount of time, in milliseconds, that the relay has to deliver
> an entire subgroup after it has started delivering the subgroup.

## 設計方針

1. `TrackPropertyId` に `SUBGROUP_DELIVERY_TIMEOUT: 0x06` を追加
2. `decodeTrackProperties` / `encodeTrackProperties` のテストを追加

## 完了条件

- `TrackPropertyId` に `SUBGROUP_DELIVERY_TIMEOUT: 0x06` が定義されている
- `vp run test` 全パス
- `vp run build` 成功
