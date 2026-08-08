# PublishOptions / SubscribeOptions の deliveryTimeout doc コメントを実態に合わせて修正する

- Created: 2026-08-07
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-delivery-timeout-options-doc-comment
- Polished: {YYYY-MM-DD}

## 目的

`PublishOptions.deliveryTimeout` と `SubscribeOptions.deliveryTimeout`（`src/session.ts`）の doc コメント「Publisher と Subscriber の両方が指定した場合、小さい方の値が使用される。」を、moqt-js の実態に合わせて修正する。moqt-js は SUBSCRIBE を受信する経路を持たないクライアントライブラリであり、どちらの値も比較しない（比較は両方の値を知るエンドポイント、典型的にはリレーの責務）。

## 現状

- `src/session.ts` の `PublishOptions.deliveryTimeout` と `SubscribeOptions.deliveryTimeout` の doc コメントに「Publisher と Subscriber の両方が指定した場合、小さい方の値が使用される。」と記載されている。
- moqt-js の `handleIncomingBidirectionalStream()`（`src/session.ts`）は受信双方向ストリームの先頭メッセージを PUBLISH のみ許可しており、SUBSCRIBE を受信しない。publisher 側で subscriber 値との比較は発生しない。

## 設計方針

- 両方の doc コメントを、moqt-js が値の比較を行わない（比較はリレーの責務）実態に合わせて修正する。
- 修正後の文言例: 「moqt-js は SUBSCRIBE を受信しないため、subscriber 値との大小比較は行われず、本値のみが適用される。」

## 完了条件

- `PublishOptions.deliveryTimeout` と `SubscribeOptions.deliveryTimeout` の doc コメントが実態に合った内容に修正されていること。
- `vp check` / `tsc --noEmit` / `vp test run` が通る。

## 参照

- draft-ietf-moq-transport-19 §8 (Delivery Timeouts and Data Reliability)
- 関連: `0366-add-delivery-timeout-enforcement.md`（Delivery Timeout の強制。本 issue はそこから分離された doc 修正）

## 解決方法

未着手。
