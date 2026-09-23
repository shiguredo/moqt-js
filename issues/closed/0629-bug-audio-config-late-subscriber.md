# createMediaPublisher が後着購読者へ Audio Config を送り直さない

- Created: 2026-09-20
- Completed: 2026-09-24
- Branch: feature/fix-audio-config-late-subscriber
- Polished: 2026-09-21

## 目的

draft-ietf-moq-loc-04 §2.3.3.1 (Audio Config) は Audio Config を「対応する codec 仕様で定義される音声コーデックの設定であり、WebCodecs の `EncodedAudioChunkMetadata` の `AudioDecoderConfig.description` に対応する」と定める。

AAC の復号にはこの description (AudioSpecificConfig) が必須だが、Chromium の `AudioEncoder` は configure 後の最初の出力にしか description を付けない。`src/createMediaPublisher.ts` の `handleAudioEncodedChunk` は `isSameAudioConfig` で「同じ値は送らない」ため、**配信開始後に接続した購読者には Audio Config が届かない** (relay が保持している過去の Object を後着購読者へ配る場合を除く)。音声にはキーフレームが無いため、keyframe を契機に description を載せ直す経路も無い。

結果として、AAC で配信する publisher に対して後から接続した購読者は音声を復号できない。

## 現状

- `src/createMediaPublisher.ts` の `handleAudioEncodedChunk` は、encoder の metadata に description が現れ、かつ直前と異なるときだけ AUDIO_CONFIG を載せる (`isSameAudioConfig` / `lastSentAudioConfig`)
- 同じ実装は devtools にもあったが、devtools 側は Forward State が 1 になった時点で保持している Audio Config を送り直すようにした (保持値を消さずに再送要求を立てる形)
- ライブラリ側にはこの再送経路が無く、`Publisher` の Forward State 変化を使った送り直しも行っていない
- 購読側の `subscribeMediaTracks` は Location Filter を渡さず、過去の Object を取得する fill (draft-ietf-moq-transport-21 §3.4) も FETCH も使わない。フィルタ無しの購読は「すべての Object が通る」と定められている (§3.3.1) が、それはフィルタ判定の話であり、publisher と relay が保持していない Object を配る仕組みではない。途中参加は「既存の Group を要求するか、将来の Group を待つ」もので (§3.5)、購読開始より前に送られた Audio Config 付きの Object は後着購読者には届かない

## 設計方針

- `src/createMediaPublisher.ts` の `MediaPublisherImpl.audioPublisher` (型 `Publisher`) に `onForwardStateChange` を登録し、Forward State が 0 から 1 になった時点で「保持している Audio Config を次の Object に載せ直す」要求を立て、`handleAudioEncodedChunk` がその要求に従って保持値を載せる
- この再送は、relay が購読者の出現を Forward State の変化 (`REQUEST_UPDATE` の `FORWARD=1`) として伝える実装であることを前提とする (draft-ietf-moq-transport-21 §7.5)。購読者が既に居て Forward State が 1 のまま 2 人目以降が接続した場合は変化が起きないため送り直されず、その購読者は relay のキャッシュに依存する (devtools 実装でも同じ制約で、リロード時は 1 → 0 → 1 が起きるため実害は限定的と整理している)
- 保持値は消さない (消すと再送する材料が無くなる)。再送は 1 Object に限り、要求は載せた時点で解消する
- 購読側は同じ description を受け取っても再構成しない (devtools の `isSameCodecDescription` と同じ判定) ため、再送は冪等である
- 映像の VIDEO_CONFIG にも同じ問題が当てはまる (`isSameVideoConfig` と `lastSentVideoConfig` が同じ値の再送を抑止し、`createMediaPublisher.test.ts` が「2 件目の同じ description の keyframe に VIDEO_CONFIG を載せない」ことを固定している)。本 issue は音声のみを対象とし、映像側は別途対応する

## 完了条件

- 購読者が居ない状態 (Forward State 0) から購読者が接続して Forward State が 1 になった後、次の Object に保持している Audio Config が載る
- 同じ Audio Config を毎 Object 送らない (要求が無い限り再送しない)
- 再送の判断を純関数に切り出し、単体テストで固定する
- `npx vp check` / `npx vp test --run` が通る

## 参照

- draft-ietf-moq-loc-04 §2.3.3.1 (Audio Config) / §2.3.3 (Audio Properties)
- draft-ietf-moq-transport-21 §3.1 (Subscriptions) / §3.3.1 (Location Filters) / §3.4 (Fill Semantics) / §3.5 (Joining an Ongoing Track) / §7.5 (Publisher Interactions) / §9.20.19 (FORWARD Parameter)

## 解決方法

- `src/createMediaPublisher.ts` の `MediaPublisherImpl` に `audioConfigResendRequested` を追加し、音声 Publisher の `onForwardStateChange` が Forward State 0 から 1 の変化で送り直し要求を立てるようにした
- 送出する Audio Config の判断を純関数 `resolveAudioConfigToSend` に切り出した。新しい description が現れたときはそれを載せ、送り直し要求があるときは保持値を次の Object に 1 度だけ載せ直し、要求が立っていても保持値が無ければ要求だけを残す。載せた時点で要求は解消し、保持値は消さない
- `stop()` / `close()` / `start()` 失敗の資源破棄で Audio Config の保持値と要求を破棄するようにした。再 start では新しい session と encoder になり購読者は誰も前の Object を受け取っていないため、最初の description を初出として送り直す (encoder と Publisher を切り離した後に破棄し、破棄中に届いた出力で再充填されないようにする)
- 長さ 0 の description は AAC の AudioSpecificConfig として成立しないため送らない
- 重複していた private の `isSameAudioConfig` / `isSameVideoConfig` を `isSameCodecDescription` に統合した
- `src/createMediaPublisher.test.ts` に、Forward State 変化での送り直し、送り直しが 1 Object に限られること、要求の保持 (0 に戻っても消さない / active でない間は消費しない)、stop 後の再開で同じ description でも載ること、破棄段階の失敗でも破棄されることを追加した
- `src/createMediaPublisher.prop.ts` を新設し、任意の chunk 列に対する不変条件 (送出値は保持値と一致する / 初出と変更の description は必ず載る / 要求が立っている Object では保持値がある限り必ず載る / 要求が無ければ同じ値を連続で載せない / 送り直しは 1 Object に限り保持値は複製する) を PBT で固定した
- `docs/HIGH_LEVEL_API.md` の「高レベル API は `VIDEO_CONFIG` / `AUDIO_CONFIG` を送信しない」という実装と逆の記述を、実際の送出と音声の送り直しの契約に合わせて修正した
- `CHANGES.md` の `## develop` に `[FIX]` を追記した

## 残した課題

- 映像の `VIDEO_CONFIG` は Forward State 変化での送り直しに対応していない。あわせて `lastSentVideoConfig` は stop 後の再 start でも保持するため、再開後の購読者には `VIDEO_CONFIG` が届かない (どちらも設計方針どおり別対応)
- Catalog Publisher も Forward State 変化での送り直しを持たない (devtools 側には実装済み)
- devtools 側の `resolveAudioConfigToSend` はライブラリ実装と重複しており、長さ 0 の description の扱いが揃っていない
