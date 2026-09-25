# publisher が NEW_GROUP_REQUEST を受け取れず、後から視聴を始めた相手に新しい Group (キーフレーム) を出せない

- Created: 2026-09-25
- Completed: 2026-09-25
- Branch: feature/add-publisher-new-group-request
- Polished: {YYYY-MM-DD}

## 目的

後から視聴を始めた subscriber は、Group の先頭 (キーフレーム) を受け取るまで映像を出せない。draft-ietf-moq-transport-21 Section 9.20.20 は、subscriber が SUBSCRIBE / REQUEST_UPDATE に NEW_GROUP_REQUEST を載せて新しい Group を要求でき、dynamic Groups に対応する Original Publisher は「it SHOULD end the current Group and begin a new Group as soon as practical」とする。relay は受け取った NEW_GROUP_REQUEST を publisher へ REQUEST_UPDATE で転送する。

moqt-js の publisher は `PublishOptions.dynamicGroups` で DYNAMIC_GROUPS=1 を広告できるが、受け取った NEW_GROUP_REQUEST をアプリへ知らせる手段が無く、要求に応えられない。moqt-devtools の publisher と `createMediaPublisher` はキーフレームを keyframeInterval でしか出さず、後から視聴を始めた相手は次のキーフレームまで待つ (relay の cache が Group の先頭を持っていない場合)。

## 現状

- `src/session/publicTypes.ts` の `PublishCallbacks` は `error` / `onForwardStateChange` / `goaway` だけを持つ
- `src/session/bidi.ts` の `applyPublishRequestUpdate` は REQUEST_UPDATE の LOCATION_FILTER / FORWARD / FILL_PARAMETERS だけを反映し、NEW_GROUP_REQUEST を読まない
- `src/publisher.ts` の `PublisherImpl` は DYNAMIC_GROUPS を広告したかを保持しない
- `src/createMediaPublisher.ts` と `devtools/src/hooks/usePublisher.ts` は映像トラックを `dynamicGroups` 無しで publish する
- moqt-devtools の subscriber は SUBSCRIBE に NEW_GROUP_REQUEST を載せられ (NEW_GROUP_REQUEST 設定)、Track が DYNAMIC_GROUPS=1 のときだけ Request Keyframe ボタン (REQUEST_UPDATE) を使える

## 設計方針

- `PublishCallbacks.onNewGroupRequest(newGroupRequest: bigint)` を足す。PUBLISH 起点の購読に届いた REQUEST_UPDATE に NEW_GROUP_REQUEST があり、publisher が DYNAMIC_GROUPS=1 を広告していて、値が 0 または現在の Group ID より大きいときに呼ぶ (Section 9.20.20)。それ以外は無視する (広告していない publisher は無視してよい。現在の Group 以下の値は既に満たされている)
- NEW_GROUP_REQUEST の値の読み取りは純関数に切り出し、varint として読めない値は PROTOCOL_VIOLATION にする
- `createMediaPublisher` と moqt-devtools の publisher は映像トラックを `dynamicGroups: true` で publish し、`onNewGroupRequest` を受けたら次に符号化するフレームをキーフレームにして新しい Group を始める。次のフレームまでに届いた複数の要求は 1 つの Group にまとめる
- moqt-devtools の publisher は受け取った要求の数を統計に出す (`window.moqtDevTools.getPublisher()`)

## 完了条件

- REQUEST_UPDATE の NEW_GROUP_REQUEST で `onNewGroupRequest` が呼ばれる条件 (広告の有無、値が 0 / 現在の Group より大きい / 以下) を単体テストで固定する
- `createMediaPublisher` が要求を受けた次のフレームをキーフレームにし、新しい Group を始めることをテストで固定する
- moqt-devtools の publisher が要求を受けると新しい Group を始めることをテストで固定する
- sora-moq の E2E で、devtools の subscriber の NEW_GROUP_REQUEST が relay を経由して devtools の publisher へ届き、新しい Group が始まることを確かめる
- `vp check` と全テスト (vitest) が通る

## 解決方法

- `src/session/publicTypes.ts` の `PublishCallbacks` に `onNewGroupRequest(newGroupRequest: bigint)` を足した
- `src/session/params.ts` に `extractNewGroupRequest` (純関数) を足した。NEW_GROUP_REQUEST の値を varint 1 つとして読み、読み切れない値と余りのある値は `ProtocolViolationError` にする (受信した値は `decodeParameters` が varint として読むため、wire からは届かない防御である)
- `src/publisher.ts` の `PublisherImpl` に `dynamicGroups` と `newGroupRequestCallback` を足し、`src/session/requests.ts` が PUBLISH の送信時に `PublishOptions.dynamicGroups` とコールバックを設定する。`handleNewGroupRequest` は、DYNAMIC_GROUPS を広告していて、値が 0 か現在の Group (送った最大の Location の Group) より大きいとき (まだ何も送っていなければどの値でも) にコールバックを呼ぶ
- `src/session/bidi.ts` の `applyPublishRequestUpdate` が、状態を変える前に NEW_GROUP_REQUEST を読み、受理した更新で `handleNewGroupRequest` を呼ぶ。moqt-js の publisher は PUBLISH で始めるため、SUBSCRIBE に載った要求は relay が REQUEST_UPDATE に載せて届ける (Section 9.20.20 の Relay Handling)
- `src/createMediaPublisher.ts` は映像トラックを `VIDEO_PUBLISH_OPTIONS` (`dynamicGroups: true`) で publish し、`onNewGroupRequest` から既存の `requestKeyframe()` (フレーム番号を 0 に戻す) を呼ぶ。次のフレームまでに届いた複数の要求は 1 枚のキーフレームにまとまる
- moqt-devtools の publisher (`devtools/src/hooks/usePublisher.ts`) は映像トラックを `dynamicGroups: true` で publish し、要求を受けたら `newGroupRequested` を立てる。キーフレームの判定は純関数 `decideKeyFrame` (直前のキーフレームからのフレーム数で間隔を数え、要求があれば次に符号化するフレームをキーフレームにして数え直す) にした。encoder の待ちで捨てたフレームは要求を消費しない。受けた要求の数を画面と `getPublisher().newGroupRequests` に出し、デバッグログにも残す
- テスト: `extractNewGroupRequest` の単体テストと往復の PBT、`handleNewGroupRequest` の条件 (広告の有無、値が 0 / 現在の Group より大きい / 以下、未送信)、publish ロールの REQUEST_UPDATE の結合テスト (広告あり / なし)、`createMediaPublisher` の要求の次のフレームがキーフレームになるテスト、`decideKeyFrame` のテスト、画面と `getPublisher()` の E2E (`tests/e2e/devtools-new-group-request.spec.ts`)。`vp check` と全テスト (2768 件) が通った
- sora-moq の E2E (`test_devtools_new_group_request_reaches_devtools_publisher`): devtools の publisher (キーフレームの間隔 200 秒) と subscriber を relay で向かい合わせ、購読時の NEW_GROUP_REQUEST と Request Keyframe (REQUEST_UPDATE) のそれぞれで、publisher が要求を受けて新しい Group を始め、subscriber の `currentGroup` が進むことを確かめた。relay は 2 回とも `new_group_request=0` の REQUEST_UPDATE を publisher へ送った。sora-moq の `make browser-test-moqtjs-devtools` (19 件) が通った
- `createMediaPublisher` の経路は、`requestKeyframe()` の直後のフレームが encoder の待ちの超過で捨てられると、キーフレームの要求が消える問題 (0680) をそのまま引き継ぐ。既定の Worker モードでは `encodeQueueSize` が 0 を返すため起きず、直接モード (`useWorker: false`) で起きうる。moqt-devtools の経路は、捨てたフレームで要求を消費しない (`decideKeyFrame` を符号化するフレームでだけ評価する)
