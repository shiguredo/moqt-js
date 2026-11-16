# devtools subscriber が PUBLISH_DONE 後に SUBSCRIBE を張り直さない

- Created: 2026-11-15
- Completed: 2026-11-16
- Branch: feature/fix-devtools-subscriber-resubscribe
- Polished: 2026-11-16

## 目的

publisher が PUBLISH_DONE で Track を終えた後、同じ Track Namespace で publisher が再び配信を始めたときに、devtools の subscriber がその Track を再び受信して表示・再生できるようにする。

## 現状

2026-11-15 の別ノード構成での観測である。

- devtools の subscriber は SUBSCRIBE_TRACKS が既定で有効である (`devtools/src/signals/subscriber.ts` の `subscribeTracksEnabled` は `signal(true)`、`devtools/src/hooks/useSubscriber.ts` の `shouldSendSubscribeTracks` は停止中でなければ送る)
- publisher が PUBLISH_DONE を送って Track を終えると、subscriber の per-track 購読は終了する (draft-ietf-moq-transport-23 §3.1 / §3.1.2 / §9.9)。`src/subscriber.ts` の `SubscriberImpl.handleEnd` は購読を `closed` にし、`src/session/bidi.ts` の `bidiHandlePublishDone` はセッションを閉じない
- `devtools/src/hooks/useSubscriber.ts` の `handleTrackEnd` は PUBLISH_DONE を受けると `videoTrackEnd` / `audioTrackEnd` を設定するだけで、新しい SUBSCRIBE を送らない
- `devtools/src/hooks/useSubscriber.ts` の `createTracksSubscriptionCallbacks` の `onPublish` は、catalog で購読済みの Track と一致する PUBLISH の Object を `duplicate` として捨てる。catalog 経由の購読が終了している場合は、PUBLISH の Object を `publishedVideoHandler` / `publishedAudioHandler` へ流して再生を戻す (closed 0957)
- したがって、relay が SUBSCRIBE_TRACKS の結果 PUBLISH を再送する構成では、PUBLISH の Object で表示・再生が戻る。再送しない構成では、devtools は通常 SUBSCRIBE を張り直さないため、表示・再生が戻らない
- relay が SUBSCRIBE_TRACKS の結果 PUBLISH を再送しない構成では、subscriber 側から能動的に取得し直す必要がある (draft-ietf-moq-transport-23 §3.6.3)
- relay が SUBSCRIBE_TRACKS の結果 PUBLISH を再送しないことを観測した (関連 issue 0962 / 0964)

## 設計方針

- 対象は catalog で購読した video / audio の Track とする。catalog 自身と event timeline の再購読は対象外とする (catalog は既に受信した内容を使い、event timeline は表示に必須ではない)
- 既存の `instance.tracksSubscription` は解除しない (SUBSCRIBE_TRACKS の要求を維持する)。再購読は、SUBSCRIBE_TRACKS の結果 PUBLISH が届かない場合の補完である
- `handleTrackEnd` は終了状態の反映だけを担当し、再購読は `startSubscribing` の購読経路が登録する video / audio の `end` コールバックで `handleTrackEnd` が true を返し、かつ `canApplyStatusUpdate(instance)` が true のときだけ開始する。停止した購読に遅れて届いた終了 (`false`) や停止中・後始末後 (`canApplyStatusUpdate` が false) では再購読しない
- `handleTrackEnd` で PUBLISH_DONE を受けた media Track について、エラーを示さない Status Code (TRACK_ENDED / GOING_AWAY / EXPIRED) のときだけ、同じ Full Track Name の通常 SUBSCRIBE を 1 回だけ送る。`isPublishDoneErrorStatus` が true の Status Code では送らない (購読の失敗であり、同じ条件で再購読しても失敗し得るため)
- 再購読は間隔を置かずに送る。`RENDEZVOUS_TIMEOUT` は再購読時点の `settings.catalogSubscriptionTimeout` と同じ値を使い、relay が publisher の出現を待てるようにする。失敗してもタイマーで再試行しない (無限リトライにしない)。同じ Track で新たに PUBLISH_DONE を受けたら、その時点でまた 1 回試す。タイマーによる再試行はせず、試行は PUBLISH_DONE を受けるたびに 1 回だけである
- 再購読は `subscribeTrack` を使い、catalog の Track の `authInfo`、`session.setupAuthorizationToken`、`newGroupRequest` を最初の購読と同じにする。`instance.subscriber` / `instance.audioSubscriber` を新しいハンドルに差し替える
- 再購読が確立したら、`videoTrackEnd` / `audioTrackEnd` を null に戻し、`applySubscribedStatus` で表示を戻す。映像は `publishedVideoResume` と同じく復号の順序と Group の保留をリセットしてキーフレームから復号する
- 再購読の試行中・確立後は、同じ Full Track Name の PUBLISH の Object を再生へ流さない (二重復号を防ぐ)。`onPublish` の `trackEnded` を固定値にせず、Object 到着時点の再購読状態で判定する
- 同じ Track に複数の PUBLISH が届いても `onPublish` / `onPublishEstablished` は PUBLISH ごとに呼ばれるため (`src/session/publicTypes.ts`)、Full Track Name で対応付けて再生に使う購読を 1 つに限る。再購読が確立した時点で、同じ Track の PUBLISH 購読は `unsubscribe()` して `publishedSubscriptions` から除く
- 再購読が確立する前に PUBLISH が確立した場合は、再購読の結果に応じて次のどちらかにする
  - 再購読が確立したら PUBLISH 購読を解除する (上記と同じ)
  - 再購読が失敗したら PUBLISH 購読を残し、以後の PUBLISH の Object を再生へ流す (フォールバック)
- 再購読の失敗は、既存の `trackCallbacks.error` と同じ経路で `status` を error、`statusMessage` を `Subscribe error: ...` にする。`teardownSubscriber` は呼ばず、セッションと他の購読は維持する。映像 / 音声のどちらの失敗かをメッセージに含める
- 停止・削除時は、進行中の再購読も既存の AbortSignal で中断し、確立した購読を解除する (`checkAborted` と同じ扱い)。`resetSubscriberState` は新しいハンドルも初期化する

## 仕様根拠

- draft-ietf-moq-transport-23 §3.1 / §3.1.2: publisher は PUBLISH_DONE を送って購読を終了し、subscriber は PUBLISH_DONE を受けるまで購読状態を保持する。PUBLISH_DONE の後は購読が終了するため、PUBLISH が再送されない場合は新しい SUBSCRIBE が必要である
- draft-ietf-moq-transport-23 §3.6.3: 「If desired, the subscriber can issue a SUBSCRIBE to establish a subscription to that track.」とあり、relay が PUBLISH を再送しない場合は subscriber が SUBSCRIBE を発行できる
- draft-ietf-moq-transport-23 §9.19.6: RENDEZVOUS_TIMEOUT がある場合、relay は publisher が現れるまで購読を保持する (SHOULD)。再購読にこの値を載せ、publisher の再出現を待つ
- draft-ietf-moq-transport-23 §9.9: PUBLISH_DONE は購読の最後のメッセージであり、購読の終了を表す

## 完了条件

- publisher の PUBLISH_DONE (TRACK_ENDED) 後に再配信された Track を、devtools の subscriber が通常 SUBSCRIBE で再購読し、受信して表示・再生できる
- 再購読は PUBLISH_DONE 1 回につき 1 回だけ送られ、失敗してもタイマーで再試行しない (無限リトライが無い)
- 再購読の試行中・確立後に同じ Track の PUBLISH が届いても、Object を二重に復号しない。再購読が確立したら PUBLISH 購読を解除する
- 再購読の失敗は購読単位のエラーとして表示され、セッションと他の購読は維持される
- エラーを示す PUBLISH_DONE、停止中、後始末後には再購読しない
- 上記を単体テストで固定する (`devtools/src/hooks/useSubscriber.test.ts`)。テストは、再購読の送信回数、同じ Full Track Name と設定、成功時の表示と復号のリセット、失敗時の表示とセッション維持、二重復号の防止、停止時の中断を含む
- 実リレーで、別ノード構成の publisher が PUBLISH_DONE → 再配信したときに、subscriber が再び受信できることを確認し、結果を解決方法に記録する (`tests/e2e/relay/devtools-publish-stop.spec.ts` を拡張するか、新しい spec を追加する。`TEST_MOQT_URIS` を使う)
- `vp check` と `vp test run` が通る

## 参照

- `devtools/src/hooks/useSubscriber.ts` (`startSubscribing` / `handleTrackEnd` / `createTracksSubscriptionCallbacks` / `sendSubscribeTracks`)
- `devtools/src/signals/subscriber.ts` (`SubscriberInstance` / `subscribeTracksEnabled` / `publishedSubscriptions` / `videoTrackEnd` / `audioTrackEnd`)
- `src/subscriber.ts` (`SubscriberImpl.handleEnd`) / `src/session/bidi.ts` (`bidiHandlePublishDone`)
- `src/session/publicTypes.ts` (`TracksSubscriptionCallbacks.onPublish` / `onPublishEstablished`) / `src/session/incomingPublish.ts` (PUBLISH の受理)
- `src/message/types.ts` (`PublishDoneStatusCode` / `isPublishDoneErrorStatus`)
- `src/mediaSubscriber/trackSubscriptions.ts` (`subscribeTrack` / `rendezvousTimeout`)
- `devtools/src/signals/connectionSettings.ts` (`catalogSubscriptionTimeout`)
- `tests/e2e/relay/devtools-publish-stop.spec.ts` / `tests/e2e/relay/support.ts` (`TEST_MOQT_URIS`)
- draft-ietf-moq-transport-23 §3.1 / §3.1.2 / §3.6 / §3.6.3 / §9.9 / §9.19.6
- 関連 issue: 0962 (relay 経由の SUBSCRIBE_TRACKS で結果 PUBLISH の Object が配送されない)、0964 (devtools publisher の PUBLISH_NAMESPACE を既定で有効にする)、closed 0957 (SUBSCRIBE_TRACKS の PUBLISH を再生に載せる)、closed 0839 (トラック終了でセッションを閉じない。自動再購読は対象外としていた)

## 解決方法

- 対応しない。自動再購読は draft-ietf-moq-transport-23 の要求ではない
- SUBSCRIBE_TRACKS が有効な構成では、publisher の PUBLISH_DONE 後に同じ Track が再公開されると、relay が §7.7 に従って既存の SUBSCRIBE_TRACKS 購読へ新しい PUBLISH を送り、devtools の subscriber がそれを受信して復号を再開することを実測した (別ノードで video PUBLISH 2 回、objects 419 → 824、errors 空)。この経路では自動再購読は不要である
- SUBSCRIBE_TRACKS を無効にした通常 SUBSCRIBE の経路は、relay が PUBLISH_DONE で購読を終了するため、再購読するかどうかはアプリの判断である。ライブラリと devtools が自動で張り直す仕様上の根拠は無く、無限リトライや二重購読の設計を抱え込む利点も無い
- 将来この経路を自動化する場合は、SUBSCRIBE_TRACKS を有効にすることを既定の解決策とし、通常 SUBSCRIBE の自動再購読はアプリ側の責務として別の要求が出たときに行う

## 2026-11-16 の追記

- SUBSCRIBE_TRACKS が有効な場合、relay は publisher の再告知・再 PUBLISH を既存の購読へ再送することを実測した (harness / devtools の両方で新しい PUBLISH と Object を確認)。そのため「relay が再送しない」ことは原因ではない
- 本 issue の対象は、SUBSCRIBE_TRACKS を使わない通常 SUBSCRIBE の購読が PUBLISH_DONE で終了した後に、devtools が能動的に張り直さない経路に限定する。SUBSCRIBE_TRACKS が有効な経路は closed 0967 / 0970 の修正で復帰する
