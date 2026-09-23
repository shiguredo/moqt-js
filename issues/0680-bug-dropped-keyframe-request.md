# キュー超過で破棄したフレームのキーフレーム要求が失われる

- Created: 2026-09-23
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-dropped-keyframe-request
- Polished: {YYYY-MM-DD}

## 目的

`src/createMediaPublisher.ts` の `processVideoFrames` はキーフレーム判定と `videoFrameCount` の加算をキュー超過の判定より先に行う。キューが閾値を超えている間のフレームは `encode` されないが `videoFrameCount` は進むため、破棄されたフレームが要求していたキーフレームの要求が失われる。先頭フレームが破棄されると最初のキーフレーム要求そのものが消える。キーフレームが出ないまま購読者はデルタを捨て続け、映像を復号できない。

## 現状

- `src/createMediaPublisher.ts` の `processVideoFrames` は `shouldSendKeyFrame(this.videoFrameCount, this.keyframeInterval)` の結果を `isKeyFrame` に取り、`this.videoFrameCount++` してから `encoder.encodeQueueSize <= 2` を判定する
- 閾値を超えているときは `encode` せず `frame.close()` するだけである。`isKeyFrame` が真でも要求は送られない
- 先頭フレーム (`videoFrameCount` が 0) がキュー超過で破棄されると、最初のキーフレーム要求が失われる
- 破棄されたフレームの数は `videoStats` に無く、要求の喪失を統計から観測できない。0650 が `VideoStats` に `droppedFrames` を足すのは `src/codec` 側の契約変更として扱う
- `devtools/src/hooks/usePublisher.ts` の同じループは `encode` の成功時にだけ `pub.framesEncoded.value++` を行うため、要求の消費順序がライブラリ側と異なる
- 0655 は `keyframeInterval` の値域検証を対象とし、この要求の喪失は対象外としている

## 設計方針

- カウンタの加算とキーフレーム判定を `encode` するときにだけ行う。`shouldSendKeyFrame` には実際に `encode` したフレームの通し番号を渡し、破棄したフレームで要求を消費しない
- 判定・加算・`encode` をキュー判定の内側にまとめる。`frame.close()` は破棄時も投入時も必ず 1 回にする
- 破棄したフレームがキーフレーム要求を持っていた場合は、次に `encode` するフレームへ要求を繰り越す。加算しないだけでは要求が次の間隔まで遅れるため、繰り越し状態を持つ
- 0650 が足す `VideoStats.droppedFrames` と合わせ、破棄数と繰り越しを統計から判別できるようにする。0650 の完了後に実装する
- devtools 側は加算が `encode` 成功時だけなので、繰り越しの有無を合わせて 0678 と規則を揃える
- 0655 の `keyframeInterval` の値域検証とは独立に扱う
- `CHANGES.md` の `## develop` に `[FIX]` を追記する

## 完了条件

- キュー超過でフレームを破棄しても `videoFrameCount` が進まず、要求が消費されない
- 破棄されたフレームのキーフレーム要求が、次に `encode` するフレームへ繰り越される
- 先頭フレームが破棄されても、最初のキーフレーム要求が失われない
- 破棄したフレームが統計から判別できる
- `src/createMediaPublisher.test.ts` に、キュー超過で破棄したフレームの要求が繰り越されることを固定するテストが追加される
- `CHANGES.md` の `## develop` に `[FIX]` が入る
- `npx vp check` / `npx vp test --run` が通る

## 参照

- 0655 (keyframeInterval の値域検証。要求の喪失は対象外とされている)
- 0650 (Worker モードのバックプレッシャと `droppedFrames` の追加)
- `src/createMediaPublisher.ts` の `processVideoFrames` / `shouldSendKeyFrame`

## 解決方法

{未着手}
