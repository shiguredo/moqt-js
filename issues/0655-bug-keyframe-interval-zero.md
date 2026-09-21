# keyframeInterval に 0 を渡すとキーフレームが一度も送られない

- Created: 2026-09-21
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-keyframe-interval-zero
- Polished: {YYYY-MM-DD}

## 目的

`src/createMediaPublisher.ts` の `shouldSendKeyFrame` はフレーム番号の剰余でキーフレームを判定するため、`keyframeInterval: 0` で `frameCount % 0` が NaN になり常に false になる。最初のフレームもキーフレームにならず、`requestKeyframe` も効かない。値域検証が無いため、負値や非整数も意図しない挙動になる。

## 現状

- `src/createMediaPublisher.ts` の `shouldSendKeyFrame` は `frameCount % keyframeInterval === 0` を返す
- `src/createMediaPublisher.ts` の `resolveKeyframeInterval` は `video?.keyframeInterval ?? framerate * 2` を返すだけで値域を検証せず、`MediaPublisherImpl` のコンストラクタから呼ばれる
- `src/createMediaPublisher.ts` の `requestKeyframe` は `videoFrameCount` を 0 に戻すが、間隔が 0 のときは `shouldSendKeyFrame(0, 0)` が false のままで機能しない
- `src/createMedia/settings.ts` の `resolveVideoPublishSettings` は `keyframeInterval` を解決せず、値域検証も無い
- `src/codec/types.ts` の `VideoPublishOptions.keyframeInterval` には JSDoc が無く、値域の記述が無い
- `docs/HIGH_LEVEL_API.md` は `keyframeInterval?: number; // default: framerate * 2` とのみ書いている
- `src/createMediaPublisher.test.ts` に `resolveKeyframeInterval` と `shouldSendKeyFrame` のテストがあるが、0 / 負値 / 非整数は扱っていない

## 設計方針

- `keyframeInterval: 0` の意味を決める。毎フレームをキーフレームにするか、先頭のみをキーフレームにするか
- 負値と非整数は設定検証で弾く。置き場所は `resolveKeyframeInterval` か `resolveVideoPublishSettings` のどちらかに寄せ、Catalog に載る値とエンコーダに渡る値が同じ解決結果を使う既存方針を崩さない
- 0 を拒否する設計にする場合は、0 が「無効値」であることを JSDoc と `docs/HIGH_LEVEL_API.md` に書く
- `VideoPublishOptions.keyframeInterval` の JSDoc に値域と既定値を書く

## 完了条件

- `keyframeInterval: 0` の挙動が定義され、実装とテストで固定される
- 負値と非整数が検証で拒否される
- `keyframeInterval: 0` を受理する場合、`requestKeyframe` でもキーフレームが送られる
- `npx vp check` / `npx vp test --run` が通る

## 解決方法

{未着手}
