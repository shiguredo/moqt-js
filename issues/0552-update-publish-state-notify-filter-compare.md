# PUBLISH_STATE_NOTIFY の相対 LOCATION_FILTER を前回値と比較して再解決を避ける

- Created: 2026-09-09
- Completed: YYYY-MM-DD
- Branch: feature/update-publish-state-notify-filter-compare
- Polished: YYYY-MM-DD

## 目的

draft-ietf-moq-transport-20 §10.10 は PUBLISH_STATE_NOTIFY が値の変化したパラメータのみを運ぶと定める。しかし現状は LOCATION_FILTER が届けば内容が同一でも再解決するため、LARGEST_OBJECT が進んだ後に不変の相対 Location Filter が再報告されると開始位置が前進し、Object を破棄し得る。適合 peer 前提では実害がないが、防御的に前回値との比較で再解決を避ける。

## 現状

- `src/session/bidi.ts` の `bidiHandlePublishStateNotify` は LARGEST_OBJECT を反映した後、LOCATION_FILTER が存在すれば無条件に `setLocationFilter` を呼ぶ。
- `src/subscriber.ts` の `setLocationFilter` は常に `resolvedFilterCache` を再計算する。

## 設計方針

1. 受信した LOCATION_FILTER が現在保持しているフィルタと等価なら再解決しない。
2. 等価判定の方法（構造比較または保持値の記録）は実装時に確定する。
3. 不変の相対 LOCATION_FILTER の再報告で開始位置が前進しないテストを追加する。

## 完了条件

- 不変の相対 LOCATION_FILTER を含む PUBLISH_STATE_NOTIFY で開始位置が前進しないこと。
- 変化した LOCATION_FILTER は従来どおり反映されること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 関連

- draft-ietf-moq-transport-20 §5.1.2 / §10.2.9 / §10.10
- `bidiHandlePublishStateNotify` / `setLocationFilter`
