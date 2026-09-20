# createMediaPublisher が後着購読者へ Audio Config を送り直さない

- Created: 2026-09-20
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-audio-config-late-subscriber
- Polished: {YYYY-MM-DD}

## 目的

draft-ietf-moq-loc-04 §2.3.3.1 (Audio Config) は Audio Config を「対応する codec 仕様で定義される音声コーデックの設定であり、WebCodecs の `EncodedAudioChunkMetadata` の `AudioDecoderConfig.description` に対応する」と定める。

AAC の復号にはこの description (AudioSpecificConfig) が必須だが、Chromium の `AudioEncoder` は configure 後の最初の出力にしか description を付けない。`src/createMediaPublisher.ts` の `handleAudioEncodedChunk` は `isSameAudioConfig` で「同じ値は送らない」ため、**配信開始後に接続した購読者には Audio Config が永久に届かない**。音声にはキーフレームが無いため、映像のように「購読開始後の最初のキーフレームで description を受け取る」経路も無い。

結果として、AAC で配信する publisher に対して後から接続した購読者は音声を復号できない。

## 現状

- `src/createMediaPublisher.ts` の `handleAudioEncodedChunk` は、encoder の metadata に description が現れ、かつ直前と異なるときだけ AUDIO_CONFIG を載せる (`isSameAudioConfig` / `lastSentAudioConfig`)
- 同じ実装は devtools にもあったが、devtools 側は Forward State が 1 になった時点で保持している Audio Config を送り直すようにした (保持値を消さずに再送要求を立てる形)
- ライブラリ側にはこの再送経路が無く、`Publisher` の Forward State 変化を使った送り直しも行っていない
- 購読側は Location Filter を渡さない SUBSCRIBE で `Largest Object` 以降しか受け取らないため (draft-ietf-moq-transport-21 §3.3.1)、relay のキャッシュに残っていない最初の Object にしか Audio Config が載っていない場合、後着購読者は設定を得られない

## 設計方針

- `AudioPublisher` の Forward State が 0 から 1 になった時点で「保持している Audio Config を次の Object に載せ直す」要求を立て、`handleAudioEncodedChunk` がその要求に従って保持値を載せる
- 保持値は消さない (消すと再送する材料が無くなる)。再送は 1 Object に限り、要求は載せた時点で解消する
- 購読側は同じ description を受け取っても再構成しない (devtools の `isSameCodecDescription` と同じ判定) ため、再送は冪等である
- 同じ問題が映像の VIDEO_CONFIG にも当てはまるかは別途確認する (映像は keyframe ごとに description が現れるため、後着購読者も最初のキーフレームで受け取れる)

## 完了条件

- 配信開始後に接続した購読者が、保持されている Audio Config を次の Object で受け取れる
- 同じ Audio Config を毎 Object 送らない (要求が無い限り再送しない)
- 再送の判断を純関数に切り出し、単体テストで固定する
- `npx vp check` / `npx vp test --run` が通る

## 参照

- draft-ietf-moq-loc-04 §2.3.3.1 (Audio Config) / §2.3.3 (Audio Properties)
- draft-ietf-moq-transport-21 §3.1 (Subscriptions) / §3.3.1 (Location Filters) / §7.5 (Publisher Interactions) / §9.20.19 (FORWARD Parameter)

## 解決方法

{未着手}
