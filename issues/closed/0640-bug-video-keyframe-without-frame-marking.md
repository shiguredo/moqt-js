# VIDEO_FRAME_MARKING が無い Object をキーフレームとして扱えず映像を復号できない

- Created: 2026-09-21
- Completed: 2026-09-24
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

- `src/createMediaSubscriber.ts` に純関数 `isVideoKeyFrameObject(objectId, frameMarking)` を切り出し、`handleVideoObject` がこれを使ってキーフレーム判定するようにした
  - frameMarking がある場合は従来どおり `isIndependent` を優先する
  - frameMarking が無い場合は Group 先頭の Object ID 0 をキーフレームとする。Object ID 0 が Group の先頭 Object であることは draft-ietf-moq-msf-01 §6.2 が MUST で定め、同 §4.1 は同一 GOP のサンプルを同一 Group に置くことを MUST で定める。Group 先頭が IDR であることは draft-ietf-moq-loc-04 §4.2 の例 (Examples。規範要求ではない) に依拠する
- 設計方針との差: `groupId` は判定に使わないため引数に取らない。Object ID 0 が Group 内で Group 先頭を一意に表す (draft-ietf-moq-msf-01 §6.2) ため、groupId を受け取っても判定材料にならない
- 判定結果は `videoStats.keyFramesReceived` と `VideoDecoderWrapper.decode` の `"key" | "delta"` に伝わる (decoder 側は変更していない)
- `docs/HIGH_LEVEL_API.md` の LOC Properties 節に受信側の規則を追記した
- moqt-devtools は `parseLocFrameMetadata(objectId, properties)` を、受信 Object から chunk の type と timestamp を決める `buildVideoChunkPlan(obj)` に置き換え、ライブラリの `isVideoKeyFrameObject` を呼ぶ形で同じ規則を共有した (規則の二重実装をしない)
- テストは、純関数 (`isVideoKeyFrameObject`)、配線 (`handleVideoObject` を注入した VideoDecoderWrapper で駆動し、decode の type と `getStats().video` を固定)、devtools (`buildVideoChunkPlan` に MoqtObject を渡して type と timestamp を固定) の 3 層で追加した
- `CHANGES.md` の `## develop` 先頭に `[FIX]` を追記した

### 検証

- `npx vp check` / `npx vp test --run` (122 files / 2515 tests) が通る
- 変異テストで、判定を旧挙動に戻す / frameMarking 優先を逆にする / Object ID 0 判定を 1n にする / frameMarking を無視する / chunk の type を常に delta にする / devtools で objectId を 0n 固定にする / 統計の計上を外す、のいずれでも対応するテストが失敗することを確認した
- frameMarking を載せない Object 列は subgroup と datagram の両経路から同じ `handleVideoObject` に届く (fetch は catalog 専用)。机上確認の範囲で経路差は無い

## 残した課題

- `status !== ObjectStatus.NORMAL` の Object (END_OF_GROUP など、payload は空) も `handleVideoObject` に届き、判定・統計・デコードの対象になる。変更前は delta として渡っていたため `needsKeyframe` 中はスキップされていたが、今回の修正で Object ID 0 の非 NORMAL Object は key として VideoDecoder に渡るようになる。受信側が NORMAL 以外の Object を復号・統計に含める問題は映像・音声・統計に跨る既存の問題であり、別途扱う
- devtools の `handleObject` 内の `keyFramesDecoded` の計上と `buildVideoChunkPlan(obj)` の呼び出し 1 行は、ブラウザ API 依存のため node のテストで駆動できない。受信経路の E2E で扱う
- `handleVideoObject` の decoder 未構成ガード (`videoDecoderConfigured` が false なら捨てる) は既存契約であり、今回のテストでも前提として固定していない
- 実 relay での復号完走 (frameMarking を載せない publisher との結合) は本 issue の完了条件どおり確認していない
- Group 先頭以外にも IDR を置く publisher (1 Group に複数 GOP) では、その IDR はデルタ扱いになる。復号は継続するため実害は小さい
