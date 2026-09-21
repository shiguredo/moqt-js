# VIDEO_FRAME_MARKING が無い Object をキーフレームとして扱えず映像を復号できない

- Created: 2026-09-21
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-video-keyframe-without-frame-marking
- Polished: {YYYY-MM-DD}

## 目的

Video Frame Marking は LOC の任意 Property であり、MSF も要求していない。これを載せない publisher の映像が 1 フレームも復号できないのは、仕様上必須でない Property を必須扱いしていることになる。

## 現状

- `src/createMediaSubscriber.ts` の `handleVideoObject` は `isKeyFrame = false` から始め、`locProperties.frameMarking` がある場合だけ `isIndependent` を採用する。frameMarking が無い Object は常にデルタ扱いになる
- `src/codec/VideoDecoder.ts` の `decode` は `needsKeyframe` が真の間デルタを捨て、worker 経路も `skipped` を無視する。キーフレームが 1 度も来なければ復号は始まらない
- 同じ理由で `videoStats` の `framesReceived` は増えるが `keyFramesReceived` は 0 のままになる

## 設計方針

- frameMarking が無い場合は Group 先頭の Object (ObjectID 0) をキーフレームとして扱う。draft-ietf-moq-loc-04 §4.2 が「The first encoded video frame, MOQT Object with ObjectID 0, shall be the Independent (IDR) frame」と定めるため
- frameMarking がある場合は従来どおり `isIndependent` を優先する
- 判定は純関数として切り出し、`src/createMediaSubscriber.test.ts` で固定する。同ファイルは `filterPendingCatalogObjects` や `extractTrackInfo` のような純関数を直接テストする既存の形に揃える

## 完了条件

- Video Frame Marking を載せない publisher の映像が復号される
- ObjectID 0 の判定、ObjectID 0 以外の判定、frameMarking 優先の判定がテストで固定される
- 追加したテストと既存テストが通る

## 参照

- draft-ietf-moq-loc-04 §2.2 (LOC の Public / Private Properties は optional metadata)
- draft-ietf-moq-loc-04 §2.3.2.2 (Video Frame Marking は 1-4 bytes の任意 Property)
- draft-ietf-moq-loc-04 §4.2 (Group 先頭の ObjectID 0 が Independent (IDR) フレーム)

## 解決方法

{未着手}
