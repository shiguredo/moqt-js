# VIDEO_FRAME_MARKING が無い Object をキーフレームとして扱えず映像を復号できない

- Created: 2026-09-21
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-video-keyframe-without-frame-marking
- Polished: 2026-09-21

## 目的

Video Frame Marking は LOC の任意 Property であり、MSF も要求していない。これを載せない publisher の映像が 1 フレームも復号できないのは、仕様上必須でない Property を必須扱いしていることになる。

## 現状

- `src/createMediaSubscriber.ts` の `handleVideoObject` は `isKeyFrame = false` から始め、`locProperties.frameMarking` がある場合だけ `isIndependent` を採用する。frameMarking が無い Object は常にデルタ扱いになる
- `src/codec/VideoDecoder.ts` の `decode` は `needsKeyframe` が真の間デルタを捨て、worker 経路も `skipped` を無視する。キーフレームが 1 度も来なければ復号は始まらない
- 同じ理由で `videoStats` の `framesReceived` は増えるが `keyFramesReceived` は 0 のままになる
- 同じ判定が devtools にも独立してある。`devtools/src/hooks/useSubscriber.ts` の `parseLocFrameMetadata` も `isKeyFrame = false` から始め、frameMarking がある場合だけ `isIndependent` を採用する。`devtools/src/utils/DecoderWrapper.ts` もキーフレーム待ちでデルタを捨てるため、devtools の購読でも同じ問題が起きる

## 設計方針

- frameMarking が無い場合は Group 先頭の Object (ObjectID 0) をキーフレームとして扱う。draft-ietf-moq-loc-04 §4.2 の例が、GroupID を IDR 境界で +1 し、ObjectID を Group 先頭で 0 に戻したうえで「The first encoded video frame, MOQT Object with ObjectID 0, shall be the Independent (IDR) frame」と示すため。§4 は Examples 節で規範要求ではないため、Group 先頭が IDR であることは publisher の採番規約に依拠する前提として扱う
- frameMarking がある場合は従来どおり `isIndependent` を優先する (ObjectID 0 でも frameMarking が delta と言えば delta)
- 判定は `MoqtObject` の `groupId` / `objectId` と frameMarking から決まる純関数として `src/createMediaSubscriber.ts` に切り出して export し、`src/createMediaSubscriber.test.ts` から直接テストする (`filterPendingCatalogObjects` / `processCatalogPayload` と同じ形)
- devtools の `parseLocFrameMetadata` も同じ規則にする。`groupId` / `objectId` を受け取る形にシグネチャを変え、`devtools/src/hooks/useSubscriber.test.ts` の期待値とコメントを追随させる
- decoder 側 (`src/codec/VideoDecoder.ts` と Worker) は変更しない。key 判定が正しくなれば既存の `needsKeyframe` で復号が始まる

## 完了条件

- Video Frame Marking を載せない Object 列で、Group 先頭 (ObjectID 0) がキーフレームとして判定される (判定関数の単体テストで固定する。リポジトリ内の publisher は frameMarking を常に付けるため、実 relay での復号完走は本 issue では確認しない)
- ObjectID 0 以外の Object がデルタ、frameMarking がある場合は `isIndependent` が優先される判定がテストで固定される
- devtools の `parseLocFrameMetadata` も同じ規則になり、`devtools/src/hooks/useSubscriber.test.ts` が新しい期待値を固定する
- 追加したテストと既存テストが通る

## 参照

- draft-ietf-moq-loc-04 §2.2 (LOC の Public / Private Properties は optional metadata)
- draft-ietf-moq-loc-04 §2.3.2.2 (Video Frame Marking は ID 0x09 で 1-4 bytes。任意である根拠は §2.2)
- draft-ietf-moq-loc-04 §4.2 (Examples。Group 先頭の ObjectID 0 が Independent (IDR) フレーム)

## 解決方法

{未着手}
