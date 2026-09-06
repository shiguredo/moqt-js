# createMedia の責務分離と重複除去

- Created: 2026-09-06
- Completed: YYYY-MM-DD
- Branch: feature/refactor-createmedia-structure
- Polished: YYYY-MM-DD

## 目的

700〜900 行級の 2 クラスに接続・カタログ・送受信・状態機械が同居し、同文の重複が残る。分離と共通化が必要である。

## 現状

- `src/createMediaPublisher.ts` と `src/createMediaSubscriber.ts` の `connectToServer` 29 行が一字一句同一である。
- Publisher の `createCatalogTracks` と `setupEncoders` で設定解決が二重化し、乖離しうる。
- `requestKeyframe` の `0x32` 直書きが `src/message/types.ts` の `MessageParameterType.NEW_GROUP_REQUEST` と二重管理である。
- `index.ts` への循環 import がある (`connect` の分離で解消可能)。

(低レベル `src/subscriber.ts` の `handleObject` / `handleDatagram` の重複は `0504` の範囲のため本 issue の対象外とする。)

## 設計方針

1. 接続・カタログ・音声経路・映像経路に分離し、重複を共有ヘルパー化する。
2. 定数・循環の解消を合わせる (公開 API の変更は `0517` と調整する)。

## 完了条件

- 重複が除去され、既存テストと挙動が保たれること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 関連

- `0494` (切り出しはテスト容易性にも寄与する)、`0504` (低レベル送受信の重複はそちらで扱う)、`0517` (公開 API 境界)
