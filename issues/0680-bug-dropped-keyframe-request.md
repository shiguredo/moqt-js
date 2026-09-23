# キュー超過で破棄したフレームのキーフレーム要求が失われる

- Created: 2026-09-23
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-dropped-keyframe-request
- Polished: 2026-09-23

## 目的

`src/createMediaPublisher.ts` の `processVideoFrames` はキーフレーム判定と `videoFrameCount` の加算を `encodeQueueSize` の判定より先に行う。キューが閾値を超えて `encode` されないフレームでもカウンタが進み、そのフレームが持っていたキーフレーム要求が消費される。`requestKeyframe()` が `videoFrameCount` を 0 に戻した直後のフレームが破棄されると要求は失われ、キーフレームは次の間隔 (`keyframeInterval` フレーム後) まで現れない。0655 は `keyframeInterval` の値域検証を対象とし、この要求の喪失は対象外としている。

## 現状

- `processVideoFrames` は `shouldSendKeyFrame(this.videoFrameCount, this.keyframeInterval)` で `isKeyFrame` を取り、`this.videoFrameCount++` してから `encoder.encodeQueueSize <= 2` を判定する。閾値を超えているときは `encode` せず `frame.close()` するだけなので、`isKeyFrame` が真でも要求は送られない
- `shouldSendKeyFrame(frameCount, keyframeInterval)` は `frameCount % keyframeInterval === 0` を返す。加算が `encode` の外にあるため、破棄されたフレームもカウンタを進めて要求を消費する
- `videoFrameCount` を 0 に戻すのは `requestKeyframe()` (state が `publishing` のときだけ) である。要求が実際に失われるのは、`requestKeyframe()` の直後にキューが閾値を超えていて次のフレームが破棄されたときである。配信開始直後はキューが空なので先頭フレームは破棄されない
- 既定経路 (`options.useWorker` は既定 true) では `VideoEncoderWrapper.encodeQueueSize` が Worker モードで 0 を返すため (`src/codec/VideoEncoder.ts`)、閾値判定は常に真で破棄は起きない。到達するのは直接モード (`options.useWorker: false`) である。0650 が Worker モードの値を直すと既定経路でも到達する
- 破棄したフレームの数は `videoStats` に無い。`VideoStats.droppedFrames` の追加は 0650 が `src/codec` 側の契約変更として扱う
- `devtools/src/hooks/usePublisher.ts` の同じループは `pub.framesEncoded.value++` を `encode` の成功時だけ行い、`shouldRequestKeyFrame` を `encode` の直前に評価する。この順序では破棄されたフレームが要求を消費しない
- `src/createMediaPublisher.test.ts` の記録用エンコーダーは `encodeQueueSize` を固定値 0 で持ち、`encode` の options を記録しない。閾値超過の経路を作るには `encodeQueueSize` を可変にする必要があり、それは 0650 が行う
- 0655 は `keyframeInterval` の値域検証を対象とし、この要求の喪失は対象外としている

## 設計方針

- キーフレーム判定と `videoFrameCount` の加算を `encode` する分岐の中へ移す。破棄したフレームでは判定も加算もしないため、カウンタは据え置かれ、次に `encode` するフレームが同じ通し番号で判定を受ける。要求を次の `encode` フレームへ移すために繰り越し状態は要らない (devtools 側が現在この順序で、繰り越し状態を持たずに正しく動いている)
- `isKeyFrame` の評価を `encode` の直前に置き、`frame.close()` は破棄時も投入時も必ず 1 回にする
- 記録用エンコーダーが `encode` の options (`keyFrame`) も記録するようにする。これがないと「要求が繰り越されたか」を Node のテストで観測できない
- 0650 の完了後に実装する。理由は 2 つある。`processVideoFrames` と `src/createMediaPublisher.test.ts` が 0650 の変更と重なることと、閾値超過の経路を作るために記録用エンコーダーの `encodeQueueSize` を可変にする変更 (0650 が行う) を要することである
- 破棄数の統計は 0650 の `VideoStats.droppedFrames` に委ね、0680 では統計の項目を追加しない
- `devtools/src/hooks/usePublisher.ts` は対象外とする。加算が `encode` の成功時だけで、この欠陥が無い
- 0655 の `keyframeInterval` の値域検証とは独立に扱う
- 対象は `src/createMediaPublisher.ts` の `processVideoFrames` と `src/createMediaPublisher.test.ts` と `CHANGES.md` とする
- `CHANGES.md` の `## develop` の先頭に `[FIX]` を追記する (セクション内は新しい順)

## 完了条件

- キュー超過でフレームを破棄したとき `videoFrameCount` が進まず、キーフレーム要求が消費されない
- `requestKeyframe()` の直後にキューが閾値を超えていてフレームが破棄されても、次に `encode` するフレームが `keyFrame: true` で encode される
- `shouldSendKeyFrame` に渡す通し番号が「`requestKeyframe()` のリセット以後に実際に `encode` したフレームの数」になる
- `frame.close()` が破棄時も投入時も 1 回だけ呼ばれる
- `src/createMediaPublisher.test.ts` に、0650 が可変にした記録用エンコーダーの `encodeQueueSize` と、`keyFrame` を記録する `encode` の options を使って、キュー超過で破棄したフレームの要求が次の `encode` フレームへ移ることを固定するテストが追加される
- 統計の追加は行わず、破棄数は 0650 の `VideoStats.droppedFrames` のままである
- `CHANGES.md` の `## develop` の先頭に `[FIX]` が入る
- `npx vp check` / `npx vp test --run` が通る

## 参照

- 0655 (keyframeInterval の値域検証。要求の喪失は対象外とされている)
- 0650 (Worker モードのバックプレッシャ。0650 の完了後に着手する。`VideoStats.droppedFrames` と記録用エンコーダーの `encodeQueueSize` の出所)
- `src/createMediaPublisher.ts` の `processVideoFrames` / `shouldSendKeyFrame` / `requestKeyframe`、`src/createMediaPublisher.test.ts` の記録用エンコーダー、`devtools/src/hooks/usePublisher.ts` の同じループ (正しい順序の参照元)

## 解決方法

{未着手}
