# close 後に in-flight の reconfigure が完了すると audioDecoderConfigured / videoDecoderConfigured が true に戻る

- Created: 2026-09-24
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-media-subscriber-close-reconfigure-race
- Polished: 2026-09-24

## 目的

closed の `0649-bug-media-subscriber-track-property-config.md` で `close()` は保留分を破棄し `audioDecoderConfigured` / `videoDecoderConfigured` を false にするようにした。しかし `close()` と in-flight の `reconfigureAudioDecoder` / `reconfigureVideoDecoder` の完了は同期しておらず、購読側には閉状態を判定する材料が無い。`close()` の直後に再構成の継続が走ると、閉じた decoder に対して「configured」という状態が復活する。

Node のテストで再現できる。`videoDecoderConfigured = true` と `videoTrackInfo` を注入し、VIDEO_CONFIG の異なる Object を `handleVideoObject` に渡して再構成を開始させ (`videoDecoderConfigured` は false になる)、同じタスクで `close()` を呼ぶと、`close()` の同期部分の後に再構成の継続が走り `videoDecoderConfigured` が true、`lastAppliedVideoConfig` が新しい config になる (実測で確認した)。

状態が食い違うと、以降に届いた Object は `handleVideoObject` / `handleAudioObject` の先頭ガードを通り、統計 (`framesReceived` / `bytesReceived`) を先に進めてから `decode` を呼ぶ。wrapper 側は `configured = false` なので `decode` は警告して捨てる。復号されないフレームが統計に数えられ、フレームごとに警告が出る。閉じた後に decoder を新しく作る経路 (直接実行モード) もあり、その decoder は誰も閉じない。

既定の Worker モードでは世代無効化により再構成が reject するため true には戻らないが、`close()` の後に `onError` が通知される。

## 現状

- `src/createMediaSubscriber.ts` の `close` (497 行目) は `currentState === "closed"` なら即 return し (498-500 行目)、`audioInitialConfigPending` / `videoInitialConfigPending` を false にし (505-506 行目)、保留配列を空にし (507-508 行目)、`audioDecoderConfigured` / `videoDecoderConfigured` を false にし (509-510 行目)、wrapper の `close()` を呼ぶ (511-512 行目)
- 同 `close` の `setState("closed")` は videoWriter / audioContext / session の 3 つの await (515-531 行目) の後である (534 行目)。同期部分では `currentState` がまだ "closed" になっていない
- `reconfigureAudioDecoder` (1198 行目) / `reconfigureVideoDecoder` (1230 行目) は `await configure(...)` の成功後に `lastAppliedAudioConfig` / `lastAppliedVideoConfig` を更新し、`audioDecoderConfigured` / `videoDecoderConfigured` を true にする (1217-1218 行目 / 1249-1250 行目)。`currentState` も閉状態も見ない
- `close` は `lastAppliedVideoConfig` (342 行目) / `lastAppliedAudioConfig` (345 行目) を消さない。閉じた後も適用済み config が残り、`isSameAppliedVideoConfig` (1163 行目) / `isSameAppliedAudioConfig` (1179 行目) が古い値と比較し続ける
- 再構成の起動は `handleAudioObject` (1138-1144 行目) / `handleVideoObject` (1285-1293 行目) の fire-and-forget (`void`) と、`applyInitialAudioConfig` (1033 行目) / `applyInitialVideoConfig` (1056 行目) の await である。`applyInitial*Config` は flag も閉状態も見ないため、`await session.subscribe(...)` が `close()` の後に解決した場合は閉じた後に `reconfigure*Decoder` が走る (直接実行モードでは `configureDirect` が新しい decoder を作る。`src/codec/VideoDecoder.ts` 95-114 行目 / `src/codec/AudioDecoder.ts` 86-102 行目)
- 閉じた後の Object は先頭ガードを通る (`handleAudioObject` 1125 行目 / `handleVideoObject` 1262 行目 は flag だけを見る)。統計は decode の直前に加算される (1300-1301 行目、音声は 1151-1152 行目)
- wrapper 側の `decode` は `configured` を見て `warnCodecNotConfigured` を出して捨てる (`src/codec/VideoDecoder.ts` 127-130 行目 / `src/codec/AudioDecoder.ts` 115-118 行目)。`close()` は `configured` を false にする (`src/codec/VideoDecoder.ts` 233 行目 / `src/codec/AudioDecoder.ts` 164 行目)
- 直接実行モード (`useWorker: false`) の `configureDirect` は同期であるため、購読側の flag 更新は `await configure(...)` の継続で行われる。同じタスク内で `close()` を呼ぶと、この継続が `close()` の同期部分より後に走る
- Worker モード (既定。`setupDecoders` の `options.useWorker ?? true`、871 行目) では、wrapper の `close()` (`src/codec/VideoDecoder.ts` 221 行目 / `src/codec/AudioDecoder.ts` 152 行目) が `generationTracker.invalidateAll()` を呼び (224 行目 / 155 行目)、in-flight の `configureWrapperWorker` (`src/codec/workerConfigure.ts` 258 行目) は `isLatest` が false のため reject する (318-327 行目)。`*DecoderConfigured` は true に戻らないが、その reject は `reconfigure*Decoder` の catch で `onError` として通知される (1219-1221 行目 / 1251-1253 行目)
- 関連 (本 issue の対象外): `onSessionClose` (564-568 行目) は `currentState` を "closed" にするだけで decoder を閉じない。その状態では `close` が 498 行目で即 return するため decoder は開いたまま残り、`*DecoderConfigured` も true のままである

## 設計方針

- 購読側に閉状態の専用フラグ (`closed`) を持ち、`close` の同期部分の先頭 (保留破棄と flag の false 化と同じ位置) で true にする。`currentState` は使わない (`setState("closed")` が await の後であり、await 中の窓を覆えない)
- `reconfigureAudioDecoder` / `reconfigureVideoDecoder` は await の前後で `closed` を判定する。await の前なら WebCodecs の configure を発行せず return し (閉じた後に decoder を作らない)、await の後なら `lastApplied*Config` の更新と `*DecoderConfigured = true` を行わず return する (成功した configure の結果を捨てる)
- `applyInitialAudioConfig` / `applyInitialVideoConfig` も `closed` を判定し、閉じた後は `reconfigure*Decoder` を呼ばずに保留分の解放だけを行う
- `close` で `lastAppliedVideoConfig` / `lastAppliedAudioConfig` を null に戻す。閉じた購読で config の同一判定を続けない
- 世代管理に乗せる案 (購読側に世代カウンタを持ち、開始時の世代と完了時の世代を比較する) でもよいが、必要な判定は「閉じたか」の 1 bit で足りる。wrapper 内の `ConfigureGenerationTracker` は購読側の flag を守らないため、wrapper に任せない
- テストは `src/createMediaSubscriber.test.ts` の既存の制御口 (`SubscriberInitialConfigControl`、288-320 行目) と同じ注入で、映像と音声の両方について次を固定する
  - 再構成の await 中に `close()` した場合、`*DecoderConfigured` が true に戻らない
  - その場合に `lastApplied*Config` が更新されない
  - `close()` で `lastApplied*Config` が null に戻る
  - `close()` 後に届いた Object が統計に数えられず `decode` にも渡らない
  - `close()` の後に `applyInitial*Config` が走っても configure が発行されない
- 対象は `src/createMediaSubscriber.ts` / `src/createMediaSubscriber.test.ts` / `CHANGES.md` とする。wrapper (`src/codec/`) は変更しない (wrapper は `close` で `configured` を false にしており、残るのは購読側の flag だけである)
- 対象外: `onSessionClose` 経由の閉状態 (decoder を閉じない / `close` が即 return する)、`close()` と `start()` の並行実行時の state 遷移、publisher 側の同型である 0681

## 完了条件

- 再構成の完了前に `close()` した場合、`videoDecoderConfigured` / `audioDecoderConfigured` が true にならない (映像・音声の両方)
- `close()` の後に configure が発行されない (再構成の await 中に閉じた場合と、`close()` の後に `applyInitial*Config` が走った場合の両方)
- `close()` で `lastAppliedVideoConfig` / `lastAppliedAudioConfig` が null に戻り、その後 null のままである
- `close()` 後に届いた Object で `framesReceived` / `bytesReceived` が増えず、`decode` も呼ばれない
- 0649 で追加したテスト (保留キュー / 購読直後の初期 configure / config 同一判定) が変わらず通る
- `npx vp check` / `npx vp test --run` が通る

## 参照

- draft-ietf-moq-loc-04 §2.3.2.1 (Video Config) / §2.3.3.1 (Audio Config)
- closed の `0649-bug-media-subscriber-track-property-config.md` (`close()` の保留破棄と flag の false 化。「残した課題」に本件がある)
- 0681 (`MediaPublisher` の自己起点 stop / close と `onClose` の誤発火。閉状態の扱いの同型)
- `src/codec/workerConfigure.ts` の `ConfigureGenerationTracker` / `disposeWorker` (Worker 経路の世代無効化)
- `src/codec/VideoDecoder.ts` / `src/codec/AudioDecoder.ts` の `close` と `configureDirect` (wrapper 側の `configured` と decoder の生成)

## 解決方法

{未着手}
