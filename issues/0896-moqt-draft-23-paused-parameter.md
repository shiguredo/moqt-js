# FORWARD を PAUSED に置き換えて値の意味を反転する

- Created: 2026-11-03
- Completed: {YYYY-MM-DD}
- Branch: feature/change-paused-parameter
- Polished: 2026-11-03

## 目的

draft 23 §3.1.1 / §9.19.18 は FORWARD (0x10) を PAUSED (0x11) に置き換えた。0 が unpaused、1 が paused、初期省略値が 0 になるため、識別子の変更だけでは配信が逆転する。

## 現状

- `src/message/types.ts` は `MessageParameterType.FORWARD = 0x10` を定義する
- `src/message/parameter/messageParameter.ts` は 0x10 を uint8 として処理する
- `src/session/params.ts` の `extractForwardState` と各 builder、`src/session/bidi.ts`、`src/session/incomingPublish.ts` は true / 1 を転送として扱う
- `SubscriberImpl` / `PublisherImpl`、公開 options、namespace 更新、`PUBLISH_STATE_NOTIFY` に forward の名前と状態が広がっている

## 設計方針

- 新しい型・識別子・公開設定を PAUSED の意味に揃える。旧パラメータを同時送信したり、draft 22 との自動判別を加えたりしない
- 初期省略値は unpaused、REQUEST_UPDATE と PUBLISH_STATE_NOTIFY の省略は状態維持とする
- SUBSCRIBE / PUBLISH / SUBSCRIBE_TRACKS と更新・通知の許可集合、フィルタ判定、送信キューでの再確認まで更新する。paused の間に fill を開かない規則も維持する
- 内部に転送可否の表現を残す場合も境界で一度だけ反転し、公開 API とワイヤの意味をコメントで明示する

## 完了条件

- PAUSED 0 / 1 / 省略、値域外、旧 0x10 を検証する
- 初期停止、停止・再開、更新省略、通知省略、キュー待機中の停止で転送状態が一致する
- SUBSCRIBE_TRACKS の PAUSED 更新が将来の購読だけに作用する
- 同じ値を送受信しても反転の二重適用が起きないことをテストする

## 参照

- `refs/moq/draft-ietf-moq-transport-23.txt` §3.1.1 / §3.3.3 / §9.5 / §9.8 / §9.10 / §9.19.18
- `src/message/parameterScope.ts`、`src/session/params.ts`、`src/subscriber.ts`、`src/publisher.ts`、`src/session/publish.ts`

## 解決方法

{未着手}
