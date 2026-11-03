# SUBSCRIBE_TRACKS_ID で受信 PUBLISH を要求に正確に関連付ける

- Created: 2026-11-03
- Completed: {YYYY-MM-DD}
- Branch: feature/change-subscribe-tracks-id
- Polished: {YYYY-MM-DD}

## 目的

draft 23 §3.6 は重なる SUBSCRIBE_TRACKS を許容し、結果の PUBLISH に SUBSCRIBE_TRACKS_ID (0x36) を持たせた。現在は namespace prefix が最初に一致した要求を選ぶため、重なる要求の callback とフィルタを取り違える。

## 現状

- `src/message/types.ts` と `src/message/parameter/messageParameter.ts` に 0x36 が無い
- `src/message/parameterScope.ts` の `PUBLISH_ALLOWED_PARAMS` は新パラメータを拒否する
- `src/session/incomingPublish.ts` の `incomingPublishMatchToSubscription` は `tracksSubscriptions` を先頭から走査し、最初の prefix 一致で返す
- 同じ Full Track Name の複数購読は `subscribersByAlias` の配列で扱えるため、対応する要求ごとに独立した購読を生成する必要がある

## 設計方針

- 0x36 を PUBLISH 専用の vi64 パラメータとして定義し、元の SUBSCRIBE_TRACKS Request ID を保持する
- ID がある PUBLISH は該当要求だけを参照し、その prefix・状態・Track Property Filter・callback に結び付ける。無効な ID を別要求の prefix 検索で救済しない
- ID の無い unsolicited PUBLISH は区別し、既存の興味判定に従って扱う。ID が無いことだけをすべての PUBLISH の形式違反にしない
- 重なる 2 要求からの同じ Track の PUBLISH を独立に処理する。元の SUBSCRIBE_TRACKS の取消しや prefix 更新で、確立済みの個別購読を取消さない
- 要求の取消しと PUBLISH 到着が競合した場合の拒否・後始末を明確にする

## 完了条件

- 0x36 の固定ワイヤと PUBLISH 以外での scope 違反を検証する
- 同じ prefix、包含関係の prefix、異なるフィルタを持つ要求へ正しい callback が届く
- 未知 / 取消し済み ID と prefix 不一致を別要求に誤配しない
- 同じ Track Alias の合法な複数購読と、異なる Track による Alias 重複違反を維持する

## 参照

- `refs/moq/draft-ietf-moq-transport-23.txt` §3.6 / §9.5.2 / §9.8 / §9.19.21
- `src/session/incomingPublish.ts` の `incomingPublishHandleBidirectionalStream` / `incomingPublishMatchToSubscription`
- `src/session/types.ts` の `TracksSubscriptionState`、`src/session/namespaces.ts`

## 解決方法

{未着手}
