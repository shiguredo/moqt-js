# FORWARD を PAUSED に置き換えて値の意味を反転する

- Created: 2026-11-03
- Completed: 2026-11-03
- Branch: feature/change-moqt-draft-23
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

- `MessageParameterType.FORWARD` (0x10) を削除し、`PAUSED` (0x11) を追加した。エンコーディングは uint8 のまま、値域検証を `validatePausedValue` (0 = unpaused / 1 = paused のみ許可) に移した。0x10 は draft-23 に定義が無いため、受信すると未知の Message Parameter として拒否される。draft-22 との自動判別や旧パラメータの同時送信は行わない。
- 内部表現・公開 API・ワイヤをすべて「true / 1 = paused」に統一し、境界での反転を不要にした (二重反転が構造的に起きない)。公開 API は `Publisher.paused` / `Subscriber.paused`、`setPaused`、`onPausedChange`、オプション `paused`、`extractPaused` に改名し、`forwardState` / `setForwardState` / `onForwardStateChange` / `extractForwardState` を削除した。
- 初期状態は unpaused。SUBSCRIBE / PUBLISH / SUBSCRIBE_TRACKS の builder は `paused === true` のときだけ PAUSED=1 を載せ、省略・false では載せない (既定値 0)。REQUEST_UPDATE と PUBLISH_STATE_NOTIFY はパラメータが存在するときだけ状態を更新し、省略時は状態維持とする。raw parameters の PAUSED も送信前の重複検査・値検証・1 バイト長検証を通し、REQUEST_OK 後に `Subscriber.paused` へ反映する。
- 送信制御を PAUSED の意味に更新した。`PublisherImpl.guardSend` / `publishSendObject` / `publishSendDatagram`、送信キュー先頭、`createUnidirectionalStream` の await 後、Subgroup Header の write 後の各点で paused を再確認し、paused 中は Object / Datagram を送らない。Header 送信後に paused で中断したストリームは空 Subgroup として Stream Count に計上し、RESET で閉じる。paused 中は fill を開かず、unpaused への更新と同時の fill 要求は拒否する。catalog / Audio Config / Video Config の送り直しは paused が 1 から 0 になった時点で行う。
- 許可集合を更新した。PUBLISH / REQUEST_UPDATE / SUBSCRIBE_TRACKS 系 REQUEST_UPDATE / PUBLISH_STATE_NOTIFY で PAUSED を受理し、SUBSCRIBE_OK / PUBLISH_OK / REQUEST_UPDATE_OK / FETCH_OK / TRACK_STATUS_OK ではスコープ違反として拒否する。SUBSCRIBE_TRACKS の PAUSED 更新は将来の購読にだけ作用し、既存の Subscriber を変更しない。
- `SUBSCRIBE_TRACKS` の許可一覧を draft-23 §9.17 に合わせて整理した。§9.17 は SUBSCRIBER_PRIORITY / LOCATION_FILTER / FILL_PARAMETERS も許可するが、現行の `SubscribeTracksOptions` は未対応のため、対応済みの型だけを送ることを JSDoc に明記した。
- devtools の `forwardState` signal / stats / 表示を `paused` に改名し、表示を「PAUSED: 0 (unpaused) / 1 (paused)」に変更した。`FakeSubscriber` に `paused` を追加した。
- テストは PAUSED 0 / 1 / 省略の固定ワイヤ、値域外 (2 / 128 / 255)、旧 0x10 の拒否、初期停止 (PUBLISH / SUBSCRIBE)、停止・再開、REQUEST_UPDATE の型付き・raw 経路、PUBLISH_STATE_NOTIFY の反映・解除・省略、送信キュー待機中と await 中の停止、fill の paused 分岐、許可集合の拒否、SUBSCRIBE_TRACKS 更新の将来購読限定、同じ値の送受信で反転しないことを検証する。PBT では PAUSED の任意値と省略時の既定値を検証する。

### 既知の制限

- draft-23 §9.19.18 の値域外は INVALID_PARAMETER でセッションを閉じるが、現行の受信経路は SessionErrorCode への変換都合で PROTOCOL_VIOLATION として扱う。コメントで差を明記し、エラー分類の移行は別途対応する。
- 統合ブランチのため ALPN は moqt-22 のままで、PAUSED 0x11 の実ワイヤによる相互接続は移行完了後に確認する。
- README / docs の `FORWARD` / `forwardState` の記述更新は移行全体の仕上げで行う。

### 残課題 (別 issue で扱う)

- セッションエラー分類 (INVALID_PARAMETER / UNEXPECTED_MESSAGE / ROLE_VIOLATION) への移行
- EOT / END_OF_GROUP をキュー待機中に paused で見送るケースの状態管理
- SUBSCRIBE_TRACKS の未対応パラメータ (SUBSCRIBER_PRIORITY / LOCATION_FILTER / FILL_PARAMETERS など)
