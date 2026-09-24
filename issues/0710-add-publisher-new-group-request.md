# publisher が NEW_GROUP_REQUEST を受け取れず、後から視聴を始めた相手に新しい Group (キーフレーム) を出せない

- Created: 2026-09-25
- Completed: {YYYY-MM-DD}
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
