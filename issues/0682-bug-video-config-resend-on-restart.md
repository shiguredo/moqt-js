# 映像の VIDEO_CONFIG が Forward State 変化と stop → start で送り直されない

- Created: 2026-09-24
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-video-config-resend-on-restart
- Polished: 2026-09-24

## 目的

`src/createMediaPublisher.ts` の音声経路は `resolveAudioConfigToSend` で「今回の Object に Audio Config を載せるか」を判定し、Forward State が 0 から 1 になった時点 (購読者の出現) に保持している値を送り直す。映像経路にはこの判定が無く、`handleVideoEncodedChunk` は `isSameCodecDescription` で同じ description の送出を抑止するだけである。

draft-ietf-moq-loc-04 §2.3.2.1 の Video Config (0x0D) は codec の extradata (avcC / hvcC など) であり、WebCodecs の `VideoDecoderConfig.description` に対応する。これが届かない購読者は映像を復号できない。映像にはキーフレームがあるため「次のキーフレームで載せ直す」余地があるが、現在は同じ値の送出を抑止しているため、その経路も塞がっている。

本 issue は closed/0629 が音声側を直した際の counterpart である。0629 の「残した課題」に「映像の `VIDEO_CONFIG` は Forward State 変化での送り直しに対応していない。あわせて `lastSentVideoConfig` は stop 後の再 start でも保持するため、再開後の購読者には `VIDEO_CONFIG` が届かない」と記録されている。本 issue はこの 2 つを扱う。

## 現状

- `src/createMediaPublisher.ts` の `handleVideoEncodedChunk` (934-1014 行目) は 977-984 行目で `chunk.description !== undefined && !isSameCodecDescription(this.lastSentVideoConfig, chunk.description)` のときだけ `videoConfig` を載せる。同じ値の description が再び来ても載らない
- `src/createMediaPublisher.ts` の `lastSentVideoConfig` (319-322 行目) は同じ値の重複送出を避けるためだけに使われ、音声側の `audioConfigResendRequested` (326-328 行目) に相当するフィールドを持たない
- `src/createMediaPublisher.ts` の `createPublishers` (605-652 行目) は音声 Publisher にだけ `onForwardStateChange` を登録し (634-638 行目)、Forward State が 1 になった時点で `audioConfigResendRequested` を立てる。映像 Publisher の `publish` 呼び出し (645-647 行目) には `error` コールバックしか渡していない
- 音声側の判定は `resolveAudioConfigToSend` (280-299 行目) に純関数として切り出され、`src/createMediaPublisher.prop.ts` の PBT と `src/createMediaPublisher.test.ts` の単体テストで固定されている。映像側に同型の関数は無く、判定が `handleVideoEncodedChunk` に埋まっている
- `src/createMediaPublisher.ts` の `disposeAllResources` (1036-1108 行目) は `lastSentAudioConfig` と `audioConfigResendRequested` を破棄する (1083-1086 行目) が、`lastSentVideoConfig` は破棄しない。JSDoc (1027-1034 行目) にも「映像の config 再送は音声とは別に扱うため、直前に送った Video Config は破棄せず再 start 後も同じ値の送出を抑止する」と書かれている
- `src/createMediaPublisher.ts` の `stop` (509-521 行目) は `disposeAllResources()` を呼び、`start` (413-456 行目) は `"stopped"` を受け付けて `setupEncoders` (734-795 行目) で `VideoEncoderWrapper` を作り直す。再 start では session も encoder も新しくなるが、`lastSentVideoConfig` は前の session の値を保持したままである。同じ codec と解像度で configure し直すと extradata が同じ値になり得るため、再開後の最初のキーフレームの description が「同じ値」として抑止される
- `src/createMediaPublisher.ts` の `publishCatalog` (664-692 行目) は `createPublishers` から毎回呼ばれる (651 行目) ため、再 start 後も catalog は送られる。届かないのは映像の description だけである
- `src/createMediaPublisher.test.ts` は `handleVideoEncodedChunk: 同じ description は再送しない` (918 行目) で重複抑止を固定している。音声側の `handleAudioEncodedChunk: stop 後の再開では同じ description でも AUDIO_CONFIG を載せる` (1113 行目) に相当する映像のテストは無い (映像側は `handleVideoEncodedChunk: publisher が active でない間は保持値を変えない` (1170 行目) だけである)
- `devtools/src/hooks/usePublisher.ts` の `buildObjectSendPlan` (216 行目) は 236 行目で `config: chunk.description` を無条件に載せ、`handleEncodedChunk` (498 行目) がそのまま `sendObject` する (522 行目)。`devtools/src/signals/publisher.ts` には `lastSentAudioConfig` (68 行目) と `audioConfigResendRequested` (71 行目) だけがあり、映像側の保持値は無い。devtools は「送り直さない」問題を持たないが、重複抑止も Forward State による送り直しも持たない
- draft-ietf-moq-loc-04 Table 1 は VIDEO_CONFIG の Scope を `Track, Object` と定めるため、後続の Object に載せ直すことは仕様上可能である

## 設計方針

- 音声と同じ形に揃える。映像 Publisher の `onForwardStateChange` で Forward State が 0 から 1 になった時点で `videoConfigResendRequested` を立て、`handleVideoEncodedChunk` が保持値を次の Object に 1 度だけ載せ直す
- 判定は音声と同じく純関数 `resolveVideoConfigToSend` に切り出す。引数と戻り値は `resolveAudioConfigToSend` と同形 (`previous` / `description` / `resendRequested` を受け取り `{ config, next, resendNext }` を返す) にし、単体テストと PBT から固定できるようにする
- 映像は description がキーフレームの metadata にしか現れない (972-976 行目のコメントと同じ前提)。要求が立っていても description を持つ chunk が来るまで要求を保留し、来た時点で保持値を載せる。description を持たない chunk に保持値を載せると購読側が GOP の途中でデコーダを再構成することになるため避ける
- 保持値が無いまま要求された場合は、音声と同じく要求だけを残す (`resolveAudioConfigToSend` の第 3 分岐と同じ)
- `disposeAllResources` で `lastSentVideoConfig` と `videoConfigResendRequested` を破棄する。再 start では新しい session と encoder になり購読者は誰も前の Object を受け取っていないため、新しい encoder の最初の description を初出として送る必要がある。1027-1034 行目の JSDoc もこの方針に合わせて書き換える
- `handleVideoEncodedChunk` の入口ガード (Publisher が `"active"` でない間は保持値も要求も変えない) は現状の形を維持する
- Forward State が 1 のまま 2 人目以降の購読者が接続した場合は変化が起きないため送り直さない。この制約は音声と同じであり、`resolveVideoConfigToSend` の JSDoc に書く (0629 と同じ整理)
- 対象は `src/createMediaPublisher.ts` / `src/createMediaPublisher.test.ts` / `src/createMediaPublisher.prop.ts` / `docs/HIGH_LEVEL_API.md` / `CHANGES.md` とする
- `src/createMediaPublisher.prop.ts` には、音声の不変条件 (送出値は保持値と一致する / 初出と変更の description は必ず載る / 要求が立っている Object では保持値がある限り必ず載る / 要求が無ければ同じ値を連続で載せない / 送り直しは 1 Object に限る) を映像の純関数にも張る
- devtools 側は対象外とする。`buildObjectSendPlan` が description を無条件に載せるため後着購読者に config が届かない問題は無く、重複送出の抑止は別の論点である
- 0681 (`disposeAllResources` の世代番号) と 0679 (`publishCatalog` の reject 通知) も `src/createMediaPublisher.ts` と `CHANGES.md` を対象にするため、同時に進めない
- `CHANGES.md` の `## develop` の先頭に `[FIX]` を追記する (セクション内は新しい順)

## 完了条件

- Forward State が 0 から 1 になったあとの最初の description 付き Object に、保持している VIDEO_CONFIG が 1 度だけ載る
- 要求が無い限り同じ値の VIDEO_CONFIG を連続で載せない (既存の `handleVideoEncodedChunk: 同じ description は再送しない` が維持される)
- description が変わったときは要求の有無にかかわらず新しい値を載せる (既存の `handleVideoEncodedChunk: description が変わったら再送する` が維持される)
- description を持たない chunk では要求を保留し、VIDEO_CONFIG を載せない
- 保持値が無いまま要求された場合は要求が残り、次の description で載る
- `stop()` のあと `start()` して同じ description が届いた場合、新しい session の最初の Object に VIDEO_CONFIG が載る
- `stop()` で `lastSentVideoConfig` と `videoConfigResendRequested` が破棄される
- `src/createMediaPublisher.test.ts` に上記を固定するテストが追加され、`createPublishers` が映像 Publisher に `onForwardStateChange` を登録することも `createPublishRecordingSession` の `callbacksByTrack` で検証される
- `resolveVideoConfigToSend` の単体テストと、`src/createMediaPublisher.prop.ts` の映像側の不変条件が追加される
- `docs/HIGH_LEVEL_API.md` の VIDEO_CONFIG の記述が実装と一致する
- `CHANGES.md` の `## develop` の先頭に `[FIX]` が入る
- `npx vp check` / `npx vp test --run` が通る

## 参照

- draft-ietf-moq-loc-04 §2.3.2.1 (Video Config) / §2.3.2 (Video Properties) / Table 1 (VIDEO_CONFIG の Scope は `Track, Object`)
- draft-ietf-moq-transport-21 §3.1 (Subscriptions。Forward State の定義) / §7.5 (Publisher Interactions。relay が Forward State を 1 に変える MUST) / §9.20.19 (FORWARD Parameter)
- closed/0629 (音声側の送り直し。本 issue はその counterpart) / 0650 (映像 encoder のバックプレッシャ) / 0680 (破棄されたフレームでキーフレーム要求が失われる件) / 0683 (Catalog の送り直し) / 0679 / 0681 (同じファイルを触る未着手 issue)
- `src/createMediaPublisher.ts` の `handleVideoEncodedChunk` / `resolveAudioConfigToSend` / `disposeAllResources` / `createPublishers`、`src/createMediaPublisher.test.ts` の `createPublishRecordingSession`、`devtools/src/hooks/usePublisher.ts` の `buildObjectSendPlan` / `handleEncodedChunk`

## 解決方法

{未着手}
