# 高レベル API で Video / Audio Config を送受信する

- Created: 2026-09-06
- Completed: 2026-09-13
- Branch: feature/add-loc-config-wiring
- Polished: YYYY-MM-DD

## 目的

`VIDEO_CONFIG` / `AUDIO_CONFIG` が高レベル API で配線されず、canonical 運用や解像度変更時の再構成が成立しない。送受信とデコーダ反映が必要である。

## 現状

- `src/codec/VideoEncoder.ts` の出力は `description` を取り出すが、`src/createMediaPublisher.ts` のハンドラ型は受け取らず `VIDEO_CONFIG` を送信しない。
- `src/createMediaSubscriber.ts` の `setupDecoders` は幅・高さのみで構成し、Object / Track の `config` を使わない。カタログ更新時の再構成もない。
- `annexb` 固定のため当面動くが、`avc1` / `hvc1` の canonical 運用は成立しない。

## 設計方針

1. 送信側で `description` を `VIDEO_CONFIG` (`AUDIO_CONFIG` は encoder 対応後に) として送る。
2. 受信側で初回構成と `config` 変化時の再構成を行う。
3. 音声 encoder の `description` 取得も合わせて対応する。

## 完了条件

- `description` が送受信されデコーダ構成に反映されること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 関連

- refs/moq/draft-ietf-moq-loc-04.txt §2.1.2 / §2.3.2.1 / §2.3.3.1

## 解決方法

設計方針 1・2 を Video について実装した。設計方針 3 (音声) は後述の理由で対象外とした。

### 送信側 (`src/createMediaPublisher.ts`)

- `handleVideoEncodedChunk` の引数型に `description?: Uint8Array` を追加した。`EncodedChunkData` には既に `description` があり、encoder (`src/codec/VideoEncoder.ts`) は `metadata.decoderConfig.description` から取り出して渡していたが、publisher 側のハンドラ型が受け取っていなかった。
- `LOC.encodeVideoProperties` に `config` として渡し、`VIDEO_CONFIG` (0x0D) として送るようにした (draft-ietf-moq-loc-04 §2.3.2.1)。同節は Video Config の内容を「WebCodecs の `VideoDecoderConfig.description` にマップされる extradata」と定義している。
- `description` は keyframe の metadata にのみ現れるため、**直前と同値なら載せない** ようにした (`isSameVideoConfig` と `lastSentVideoConfig`)。全 keyframe への重複送出を避けつつ、解像度変更などで description が変わった場合は再送する。

### 受信側 (`src/createMediaSubscriber.ts`)

- `setupDecoders` で SUBSCRIBE_OK の Track Property から `LOC.resolveVideoProperties(...).config` を取り出し、`VideoDecoder.configure(codec, width, height, description)` に渡すようにした。`getVideoDecoderConfig` / `VideoDecoderWrapper.configure` は既に `description` 引数を受け取る形になっていたため、配線のみで成立した。
- `handleVideoObject` で Object Property の `config` が直前の適用値と変わったら `reconfigureVideoDecoder` を呼んでデコーダを構成し直すようにした (`lastAppliedVideoConfig` で比較)。再構成は非同期のため、完了まで `videoDecoderConfigured` を false にして decode に渡さない。失敗は error コールバックへ通知する。

### 設計方針 3 (音声) を対象外とした理由

`src/codec/AudioEncoder.ts` は `description` を取り出しておらず (`EncodedChunkData.description` を設定する箇所が無い)、`getAudioDecoderConfig` も `description` を受け取らない。opus は description 不要で動作するため、Audio Config (0x0F) の配線は AAC など encoder 側が description を返すようになってから行う。本 issue では Video に限定し、音声は対象外とする。

### テスト

`src/createMediaPublisher.test.ts` に 4 件追加した。

- `description` が `VIDEO_CONFIG` として送られる
- 同じ `description` は再送しない (2 件目の properties に config が無い)
- `description` が変わったら再送する
- `description` が無い chunk は `VIDEO_CONFIG` を載せない

## 検証

- `pnpm test run`: 70 ファイル / 2,114 テスト全通過 (追加した 4 件を含む)
- `pnpm typecheck` / `pnpm lint` / `pnpm fmt` すべて成功
- 差分: 4 ファイル、+222 / -1 行
