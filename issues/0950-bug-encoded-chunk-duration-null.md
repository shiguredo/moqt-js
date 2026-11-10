# 復号へ渡す chunk から duration を外して復号フレームの duration を null にする

- Created: 2026-11-10
- Completed: 2026-11-10
- Branch: feature/fix-encoded-chunk-duration-null
- Polished: 2026-11-10

## 目的

`src/createMediaSubscriber.ts` は復号へ渡す `EncodedVideoChunk` に `duration: 0` を明示している。`duration` は W3C WebCodecs で任意の値であり、LOC (draft-ietf-moq-loc) は Object に長さを運ばない以上、この `0` は「長さゼロ」を意味する値であって「長さが分からない」ことを表せない。復号した `VideoFrame.duration` はこの `0` を写すため、長さ不明のフレームが長さゼロのフレームとして扱われる。chunk に `duration` を載せず、復号した `VideoFrame.duration` を未指定 (null) にする。

## 現状

- W3C WebCodecs の `EncodedVideoChunk` のコンストラクタは「If duration is present in init, assign init.duration to [[duration]]. Otherwise, assign null to [[duration]]」、`EncodedAudioChunk` のコンストラクタは「If init.duration exists, assign it to [[duration]], or assign null otherwise.」と定めており、`duration` を渡さない chunk の `duration` は `null` になる (W3C WebCodecs 8.2.2 Constructors / 8.1.2 Constructors。W3C Working Draft 2026-11-09 で確認)
- 「Output VideoFrames」は「Let timestamp and duration be the timestamp and duration from the EncodedVideoChunk associated with output」と定めており、復号した `VideoFrame` の `duration` は入力 chunk の `duration` が写る。`VideoFrame` の `duration` 属性は nullable である (同 4.6 Algorithms / 9.4.3 Attributes)
- `AudioData.duration` は chunk の `duration` を使わず、`[[number of frames]] / [[sample rate]] × 1,000,000` マイクロ秒で求める (同 9.2.3 Attributes)。したがって音声の復号結果は、chunk に `duration` を載せるかどうかで変わらない
- `src/createMediaSubscriber.ts` の `decodeVideoObject` は `this.videoDecoder.decode(obj.payload, isKeyFrame ? "key" : "delta", timestamp, 0)` と、映像の chunk に `duration: 0` を渡している。`decodeAudioObject` も `this.audioDecoder.decode(obj.payload, "key", timestampKind === "none" ? null : timestamp, 0)` と `0` を渡している
- `src/codec/VideoDecoder.ts` の `VideoDecoderWrapper.decode` と `src/codec/workers/videoDecoder.worker.ts`、`src/codec/AudioDecoder.ts` の `AudioDecoderWrapper.decode` と `src/codec/workers/audioDecoder.worker.ts` は、受け取った `duration` をそのまま `EncodedVideoChunk` / `EncodedAudioChunk` に載せる。`src/codec/workerMessages.ts` の `WorkerDecodeRequest.duration` は必須の `number` である
- その結果、復号した `VideoFrame.duration` は `0` になる。「長さが分からない」を `0` で伝えている状態であり、将来 duration を消費する経路 (表示区間の決定、MSE への供給など) を追加したときに、長さ不明のフレームを長さゼロのフレームとして扱う恐れがある
- `decode` を呼ぶ箇所は `src/createMediaSubscriber.ts` の 2 箇所だけではない。`src/testSupport/mediaSubscriberTestSupport.ts` の制御口の型 (`SubscriberInitialConfigControl` / `SubscriberVideoObjectControl` / `SubscriberPreDecodeDelayControl`) とその注入オブジェクト、`tests/e2e/codec-audio-datagram.spec.ts` の `decoder.decode(object.payload, "key", ..., 0)`、`devtools/src/hooks/useSubscriber.ts` の `audioDecoderInstance.decode(..., 0)`、`devtools/src/codec-test/video.ts` の `decoder.decode(..., VIDEO_FRAME_DURATION)` (10 箇所以上)、`devtools/src/codec-test/audio.ts` の `decoder.decode(..., chunk.duration ?? 0)` がある
- `devtools/src/utils/DecoderWrapper.ts` の Worker への送信は `duration: chunk.duration ?? 0`、`devtools/src/webcodecs-devtools/workers/decoder.worker.ts` は `WorkerDecodeRequest` を受け取って `new EncodedVideoChunk({ ..., duration: message.duration })` を作る。`devtools/src/webcodecs-devtools/signals.ts` の `sendToDecoder` は `duration: number` を受け取って `EncodedVideoChunk` と Worker メッセージの両方に載せ、`handleEncodedChunk` は符号化の出力 chunk の `chunk.duration ?? 0` を渡し、復号したフレームは `duration: frame.duration ?? 0` で `FrameLog` に記録している
- `devtools/src/codec-test/devtoolsDecoder.ts` の `createEncodedKeyChunk` は符号化の参照 chunk から `new EncodedVideoChunk({ ..., duration: reference.duration ?? 0 })` を作っている
- `tests/e2e/codec-wrappers.spec.ts` の `expectVideoDecoderContract` は復号した `VideoFrame` の寸法・形式・RGBA・timestamp を検査するが、`duration` は検査していない。`devtools/src/codec-test/support.ts` の `summarizeVideoFrame` は `duration` を返しており、`summarizeAudioData` も `AudioData.duration` を返している
- chunk の `duration` の既定値について外部から得ている情報は「最新の Playwright が導入する Chromium が `0` ではなく `null` を返すようになった」という報告だけで、一次資料 (Chromium の変更履歴・リリースノート) は確認できていない。ただし本 issue の根拠はこの報告に依存しない。本ライブラリは `duration: 0` を自分で明示しており、その値が `VideoFrame.duration` に写ること自体が仕様との食い違いである

## 設計方針

- 映像の復号へ渡す chunk には `duration` を載せない。`VideoDecoderWrapper.decode` から `duration` 引数を削り、`WorkerDecodeRequest` からも `duration` を削る。これで直接モードと Worker モードのどちらでも、復号した `VideoFrame.duration` は chunk の `duration` が未指定になった結果として `null` になる
- 音声も同じ形に揃える。`AudioData.duration` は chunk の `duration` を使わないため復号結果は変わらないが、呼び出し側が `0` を渡している限り「長さ不明を 0 と伝える」形が残る。`AudioDecoderWrapper.decode` からも `duration` 引数を削り、`AudioDecoderWorkerDecodeRequest` からも `duration` を削る
- 呼び出し側は、次のファイルをすべて追随させる
  - ライブラリ: `src/createMediaSubscriber.ts`、`src/codec/VideoDecoder.ts`、`src/codec/AudioDecoder.ts`、`src/codec/workerMessages.ts`、`src/codec/workers/videoDecoder.worker.ts`、`src/codec/workers/audioDecoder.worker.ts`、`src/testSupport/mediaSubscriberTestSupport.ts` (制御口の型と注入オブジェクトの両方) と、これを使う `src/createMediaSubscriber.*.test.ts` の比較箇所
  - テスト: `tests/e2e/codec-audio-datagram.spec.ts`
  - devtools (7 ファイル): `devtools/src/hooks/useSubscriber.ts`、`devtools/src/codec-test/video.ts`、`devtools/src/codec-test/audio.ts`、`devtools/src/codec-test/devtoolsDecoder.ts`、`devtools/src/utils/DecoderWrapper.ts`、`devtools/src/webcodecs-devtools/signals.ts`、`devtools/src/webcodecs-devtools/workers/decoder.worker.ts`
- `devtools` の復号の経路も同じ方針にする。`devtools/src/codec-test/video.ts` の `VIDEO_FRAME_DURATION` は符号化の入力 `VideoFrame` の timestamp の間隔として使い続け、復号へ渡す chunk には載せない。`devtools/src/codec-test/audio.ts` の `chunk.duration ?? 0` も載せない (参照 chunk の長さは `AudioData.duration` から得られるため、復号へ渡す必要はない)
- `devtools/src/webcodecs-devtools/signals.ts` の `FrameLog.duration` は UI (`FrameLogPanel`) が読んでいないため削除し、`processEncodedData` / `sendToDecoder` / `handleEncodedChunk` / `handleEncodedChunkFromWorker` / `handleDecodedFrame` から `duration` を受け渡さない。`FrameLog` が符号化と復号の両方のログに使われているため、片側だけ `number | null` にすると型が食い違う
- `devtools/src/webcodecs-devtools/signals.ts` の `handleEncodedChunkFromWorker` の引数型は、`src/codec/workerMessages.ts` の `VideoEncoderWorkerEncodedResponse` を正本として使い、`duration` を持たない形にする
- `tests/e2e/codec-wrappers.spec.ts` の `expectVideoDecoderContract` に、復号した `VideoFrame.duration` が `null` であることを固定するアサーションを足す。`expectAudioDecoderContract` は `AudioData.duration` が `numberOfFrames / sampleRate × 1,000,000` マイクロ秒と一致することを固定する
- `src/createMediaSubscriber.ts` が復号へ duration を渡さないことは、記録用の代役 (`installRecordingVideoDecoder` / `installRecordingAudioDecoder`) が受け取った `decode` の引数で固定する。現在の代役は `decode: (payload: Uint8Array) => {...}` と 1 引数で、戻り値も先頭バイトの配列 (`number[]`) であり、4 番目の引数が増えても観測できない。戻り値を復号 1 回につき `{ firstByte: number; argumentCount: number }` を積む配列に変え、`src/createMediaSubscriber.media.test.ts` の `decoded` の比較 8 箇所と `src/createMediaSubscriber.catalog.test.ts` の `harness.decoded` の比較 4 箇所を `map((entry) => entry.firstByte)` に置き換える (`AudioCatchUpHarness.decoded` の型注釈も追随させる)。そのうえで実際に復号させ、`argumentCount === 3` を固定する単体テストを足す。chunk に 4 番目の引数を戻すと 3 引数の `decode` への過剰な引数として型検査でも止まるが、`decode` を受け取るのが注入された代役である以上、実行時の個数でも固定する

### 対象外

- 符号化の出力の `duration`。`src/codec/VideoEncoder.ts` / `src/codec/AudioEncoder.ts` は実 `Encoder` が返す `chunk.duration` をそのまま `EncodedChunkData.duration: number | null` に写しており、これは入力 `VideoFrame.duration` に由来する実装定義の値である。この issue では変えない
- `src/createMediaPublisher.ts` の符号化出力の `duration` の扱い。実 `AudioEncoder` の出力の `duration` が `null` になった場合、`handleAudioEncodedChunk` が `AudioPublishCatchUpChunkInput.durationMicros` へ `null` を渡し、末尾 flush の統計 (`tailFlushedMs` / `tailDroppedMs`) が `(chunk.duration ?? 0)` で長さゼロとして計算される。復号側とは別の仮定を検証する必要があるため、この issue では扱わない
- `src/audioPublishCatchUp.ts` の `durationMs`。`durationMicros` が `null` でも `0` でも直前のフレームの長さを使い、`0` を長さゼロとは扱わない。符号化側の値はこの issue では変えないため、この非対称は対象外とする
- `src/playout` の再生の経路。音声は `AudioData.numberOfFrames` と `sampleRate` から長さを求め (`MediaPlayout.pushAudio`)、映像は `VideoFrame.timestamp` だけで並べており、どちらも `duration` に依存しない
- Chromium 以外の実装での `VideoFrame.duration` の値。e2e は Chromium でのみ実行する (playwright.config.ts の `chromium` プロジェクト)。他実装での確認は別途扱う

## 完了条件

- `src/createMediaSubscriber.ts` の `decodeVideoObject` と `decodeAudioObject` の両方が、復号へ `duration` を渡さないこと。`installRecordingVideoDecoder` / `installRecordingAudioDecoder` の戻り値が復号ごとの `{ firstByte, argumentCount }` になり、`src/createMediaSubscriber.media.test.ts` の 8 箇所と `src/createMediaSubscriber.catalog.test.ts` の 4 箇所の比較が `firstByte` を使う形に追随していること。そのうえで実際に復号させて引数の個数が 3 であることを固定する node の単体テストがあり、変更前の実装では 4 になって失敗すること
- `VideoDecoderWrapper.decode` / `AudioDecoderWrapper.decode` の引数と `WorkerDecodeRequest` / `AudioDecoderWorkerDecodeRequest` に `duration` が無く、直接モードと Worker モードの両方で復号へ `duration` が渡らないこと
- `tests/e2e/codec-wrappers.spec.ts` の `expectVideoDecoderContract` に `expect(frame.duration).toBeNull()` があり、変更前の実装では `null` 以外 (テストページが渡していた `VIDEO_FRAME_DURATION` = 33,333) になって失敗すること
- `tests/e2e/codec-wrappers.spec.ts` の `expectAudioDecoderContract` に `AudioData.duration` が `(numberOfFrames / sampleRate) × 1,000,000` と一致するアサーションがあること
- `devtools/src` の復号の経路 (設計方針に挙げた devtools の 7 ファイル) が chunk に `duration` を載せない形に揃っていること。`webcodecs-devtools` の `FrameLog` と復号要求 (decode) の Worker メッセージに `duration` が無く、`FrameLogPanel` が引き続き描画できること (符号化の出力の `duration` を運ぶメッセージは対象外)
- `vp check` / `vp exec tsc --noEmit` / `vp exec tsc --noEmit -p devtools` / `vp test run` が通り、`vp run e2e-test` (chromium) が通ること。ルートの `tsconfig.json` は `include` が `src/**/*` のため devtools と `tests/e2e` を型検査しない。devtools は個別に型検査する

`CHANGES.md` は MOQT RFC ドラフト中のため更新しない (`CODEBASE.md` の特別ルール)。

## 解決方法

復号へ渡す `EncodedVideoChunk` / `EncodedAudioChunk` から `duration` を外し、呼び出し側から Worker メッセージまで duration の受け渡しを削除した。

- `VideoDecoderWrapper.decode` / `AudioDecoderWrapper.decode` の引数から `duration` を削除し、直接モードで作る chunk と `WorkerDecodeRequest` / `AudioDecoderWorkerDecodeRequest` からも `duration` を削除した。映像の Worker 送信は `satisfies WorkerDecodeRequest` で型を固定し、`SharedArrayBuffer` のビューも transfer できるよう `Uint8Array.from(data).buffer` でコピーする
- `src/createMediaSubscriber.ts` の `decodeVideoObject` / `decodeAudioObject` は `duration` を渡さない。`src/codec/workers/videoDecoder.worker.ts` / `audioDecoder.worker.ts` も chunk に `duration` を載せない
- `src/testSupport/mediaSubscriberTestSupport.ts` の記録用の代役 (`installRecordingVideoDecoder` / `installRecordingAudioDecoder`) を、復号 1 回につき `{ firstByte, argumentCount }` を積む `RecordedDecodeCall[]` に変えた。重複していた復号器の生成は `createRecordingDecoder` に集約し、`firstBytesOf` で先頭バイトだけを取り出す。`src/createMediaSubscriber.media.test.ts` の 8 箇所と `src/createMediaSubscriber.catalog.test.ts` の 4 箇所の比較を追随させた
- 復号へ渡す引数が 3 個であることを固定するテストを `src/createMediaSubscriber.media.test.ts` に追加した。変更前の実装 (4 引数) では `argumentCount` が 4 になり失敗する
- `tests/e2e/codec-wrappers.spec.ts` の `expectVideoDecoderContract` に `expect(frame.duration).toBeNull()` を、`expectAudioDecoderContract` に `AudioData.duration` が `Math.trunc((numberOfFrames / sampleRate) * 1_000_000)` と一致するアサーションを追加した。`AudioData.duration` の属性型は `unsigned long long` であり整数へ切り捨てられるため、aac の 1024 フレームでも一致する
- `devtools/src` の復号経路 (`useSubscriber.ts` / `codec-test/video.ts` / `codec-test/audio.ts` / `codec-test/devtoolsDecoder.ts` / `utils/DecoderWrapper.ts` / `webcodecs-devtools/signals.ts` / `webcodecs-devtools/workers/decoder.worker.ts`) から `duration` を削除した。`FrameLog.duration` は UI が読んでいないため削除し、`handleEncodedChunkFromWorker` の引数型は `VideoEncoderWorkerEncodedResponse` を正本とする形にした。`DecoderWrapper.decode` には duration を載せない契約を JSDoc で書いた
- `scripts/playout-webrtc-comparison.mjs` の 4 引数の `decode` 呼び出しから、無視されていた duration 引数を削除した
- 検証: `vp check` / `vp exec tsc --noEmit` / `vp exec tsc --noEmit -p devtools` / `vp test run` (276 ファイル、5073 テスト) が通る。`vp run e2e-test` は手元の環境で Chromium が `libatk-1.0.so.0` を欠き起動できないため未実行であり、CI で確認する

`CHANGES.md` は MOQT RFC ドラフト中のため更新していない (`CODEBASE.md` の特別ルール)。

## 参照

- WebCodecs (W3C Working Draft 2026-11-09, https://www.w3.org/TR/webcodecs/) の 8.1.2 Constructors (EncodedAudioChunk) / 8.2.2 Constructors (EncodedVideoChunk) / 9.2.3 Attributes (AudioData.duration) / 9.4.3 Attributes (VideoFrame.duration) / 3.6 Algorithms (Output AudioData) / 4.6 Algorithms (Output VideoFrames)
- refs/moq/draft-ietf-moq-loc-05.txt (LOC は Object に長さを運ばない)
- `src/createMediaSubscriber.ts` の `decodeVideoObject` / `decodeAudioObject`
- `src/codec/VideoDecoder.ts` の `VideoDecoderWrapper.decode`、`src/codec/AudioDecoder.ts` の `AudioDecoderWrapper.decode`
- `src/codec/workers/videoDecoder.worker.ts` / `src/codec/workers/audioDecoder.worker.ts`、`src/codec/workerMessages.ts` の `WorkerDecodeRequest` / `AudioDecoderWorkerDecodeRequest` / `VideoEncoderWorkerEncodedResponse`
- `src/testSupport/mediaSubscriberTestSupport.ts` の `SubscriberInitialConfigControl` / `SubscriberVideoObjectControl` / `SubscriberPreDecodeDelayControl` / `installRecordingAudioDecoder` / `installRecordingVideoDecoder`
- `devtools/src/codec-test/video.ts` / `devtools/src/codec-test/audio.ts` / `devtools/src/codec-test/devtoolsDecoder.ts` / `devtools/src/codec-test/support.ts`
- `devtools/src/utils/DecoderWrapper.ts`、`devtools/src/hooks/useSubscriber.ts`
- `devtools/src/webcodecs-devtools/signals.ts` の `FrameLog` / `processEncodedData` / `sendToDecoder` / `handleEncodedChunk` / `handleEncodedChunkFromWorker` / `handleDecodedFrame`、`devtools/src/webcodecs-devtools/workers/decoder.worker.ts`、`devtools/src/webcodecs-devtools/components/FrameLogPanel.tsx`
- `tests/e2e/codec-wrappers.spec.ts` の `expectVideoDecoderContract` / `expectAudioDecoderContract`、`tests/e2e/codec-audio-datagram.spec.ts`
- `src/playout/mediaPlayout.ts` の `pushAudio` / `pushVideo`
- `src/createMediaPublisher.ts` の `handleAudioEncodedChunk`、`src/audioPublishCatchUp.ts` の `AudioPublishCatchUpChunkInput.durationMicros` と `durationMs`
