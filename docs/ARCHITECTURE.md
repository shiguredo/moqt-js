# 内部構成

API の責務とソースの対応をまとめる。公開する型と呼び出し手順は各 API 文書に置く。
現在の再生方式は [音声と映像の再生](PLAYOUT.md)、測定の根拠は
[調査記録](archive/README.md) を参照すること。

## API の役割

| 層                     | 入口                                                | 呼び出し側が扱うもの                         | リファレンス                                               |
| ---------------------- | --------------------------------------------------- | -------------------------------------------- | ---------------------------------------------------------- |
| 配信と視聴             | `createMediaPublisher` / `createMediaSubscriber`    | MediaStream、設定、統計                      | [高レベル API](HIGH_LEVEL_API.md)                          |
| 復号済みフレームの再生 | `createMediaPlayout`                                | AudioData / VideoFrame、出力、復号入力の記録 | [再生 API](MEDIA_PLAYOUT.md)                               |
| Object の送受信        | `connect` → Session の各操作                        | MoqtObject、payload、properties              | [低レベル API](LOW_LEVEL_API.md)                           |
| フレーミングと codec   | `src/message/`、`controlStream.ts`、`dataStream.ts` | バイナリの符号化と復号                       | [低レベル API の処理手順](LOW_LEVEL_API.md#データ受信実装) |

## MediaPublisher 内部構成

```text
MediaStream
  ├─ 音声トラック → AudioFrameSource → AudioEncoderWrapper → LOC → Publisher
  └─ 映像トラック → VideoFrameSource → VideoEncoderWrapper → LOC → Publisher
```

`src/audioSource.ts` と `src/videoSource.ts` がフレームを取り出す。
MediaStreamTrackProcessor を使える場合は優先し、使えない音声では AudioWorklet、
映像では requestVideoFrameCallback の経路を使う。ブラウザー名だけで決めず、利用できる API を判定する。
codec wrapper は直接実行と Worker 実行の共通の入口である。

`src/createMediaPublisher.ts` が Catalog と媒体トラックを公開し、停止時の flush と世代を管理する。
状態と再開の契約は [MediaPublisher](HIGH_LEVEL_API.md#mediapublisher) を参照すること。

## MediaSubscriber 内部構成

```text
Subscriber の Object
  → 任意の復号前遅延、LOC の解釈と復号順の判定
  → AudioDecoderWrapper / VideoDecoderWrapper
  → AudioData / VideoFrame
  → MediaPlayout
  → 音声の MediaStream 出力 / 映像の MediaStreamTrackGenerator
```

`src/createMediaSubscriber.ts` は Catalog、購読、codec、出力のライフサイクルを組み立てる。
`src/catalogSubscription.ts` は Catalog の取得、`src/playout/preDecodeDelay.ts` は意図した保持を担う。
Group の到着順と参照の欠落は `VideoDecodeOrder` と `GroupSwitchGate` で扱う。
これらはパケットの受信バッファや再生の jitter buffer とは別の段である。

## 再生の組み立て

MediaSubscriber と DevTools は `MediaPlayout` を共通の入口として使う。
同じ再生判断をそれぞれに実装せず、受信と復号、表示用の状態だけを呼び出し側が持つ。

| モジュール                                                        | 責務                                                 |
| ----------------------------------------------------------------- | ---------------------------------------------------- |
| `src/playout/mediaPlayout.ts`                                     | 公開する入口、入力情報、音声と映像の組み立て、統計   |
| `src/playout/timeline.ts`                                         | 基準の時計、到着の学習、表示時刻、A/V 同期           |
| `src/playout/audioPlayoutSession.ts`                              | 音声のコピー、伸縮、予約、出力時計、停止の待機       |
| `src/playout/audioPlayout.ts`                                     | 予約時刻、圧縮と伸長の予算、時計の対応               |
| `src/playout/audioOutputRenderer.ts`                              | AudioWorklet の準備、実音の範囲、停止と graph の解放 |
| `src/playout/audioRenderProcessor.ts` / `audioRenderConcealer.ts` | 出力時計で実音と未着を選び、補間と復帰を処理         |
| `src/playout/audioExpansion.ts`                                   | 出力側の周期補間と非周期音の生成                     |
| `src/playout/audioTimeStretch.ts`                                 | 波形の周期判定と時間圧縮、時間伸長                   |
| `src/playout/audioReceiveCatchUp.ts`                              | 復号の詰まりを観測し、再構築の必要を通知             |
| `src/playout/videoPlayoutSession.ts` / `buffer.ts`                | 映像の表示待ち、選択、表示の実績                     |

### 音声の再生の組み立て (AudioPlayoutSession)

復号出力の到着を時間軸へ記録し、AudioPlayoutScheduler で開始を決める。
圧縮と伸長の実適用量、サンプルへの丸め、開始の押し直しを予約の終端へ反映する。
実音は Web Audio の標準レート変換を通し、出力側の AudioWorklet で未着と復帰を接続する。
補間のために到着側で続き音を毎フレーム生成する旧経路は持たない。

### 映像の表示の組み立て (VideoPlayoutSession)

時間軸で決めた表示時刻を PlayoutBuffer へ渡し、出力と pacing の設定に従って選ぶ。
ライブラリは MediaStreamTrackGenerator、DevTools は canvas を出し先として使う。
表示した実績、あふれ、遅れたフレームの計器を記録する。

## 復号入力と出力の対応

`AudioDecodeInputs` と `VideoDecodeInputs` は、復号前に渡した TIMESTAMP の種類と
Object の位置を、復号出力の timestamp から引くための表である。
音声は許容内の最も近い入力と直前の種類で補える。映像の同じ timestamp の複数入力は FIFO で保持する。
decoder の再構成と復旧後は、破棄された未出力の映像入力だけを消す。

raw Opus の媒体 timestamp の復元は、これとは別に
`src/codec/opusDecoderTimestamps.ts` が行う。検証した 1 パケット 1 出力の形式で投入順を使い、
直接復号と Worker 復号の両方で同じ復元と失敗通知を行う。
時刻なしの null と媒体時刻 0 は区別する。

## 低レベルセッション

| ファイル                                                  | 役割                                           |
| --------------------------------------------------------- | ---------------------------------------------- |
| `src/index.ts`                                            | 公開 API の export と connect の入口           |
| `src/session.ts`                                          | セッションの各処理を束ねる入口                 |
| `src/session/connection.ts` / `lifecycle.ts`              | 接続の確立と終了                               |
| `src/session/requests.ts` / `bidi.ts`                     | リクエストの発行、応答と REQUEST_UPDATE の処理 |
| `src/session/dataStreamIncoming.ts` / `stream.ts`         | データストリームの受信と Object の配送         |
| `src/publisher.ts` / `subscriber.ts` / `fetcher.ts`       | 各操作の状態と callback hook                   |
| `src/controlStream.ts` / `dataStream.ts` / `src/message/` | ワイヤ上のフレーミングとメッセージ codec       |

Publisher、Subscriber、Fetcher は状態と callback hook を持ち、ネットワーク I/O はセッションが担う。
制御メッセージ、データストリーム、Datagram は異なる入口から処理し、
Object の payload と properties の意味は呼び出し側へ渡す。

## Worker 処理

`useWorker: true` が既定であり、WebCodecs の処理を Worker へ移す。
AudioData / VideoFrame の所有権の転送と、構成、復旧、close の世代を codec wrapper が管理する。
Worker だけではメインスレッドでの受信や予約の停滞を解消できないため、
再生の準備と出力側の処理は別に管理する。

## LOC コンテナ

高レベル API が自動処理する LOC Properties:

- `TIMESTAMP`: フレームのタイムスタンプ
- `VIDEO_FRAME_MARKING`: キーフレーム判定（映像のみ）
  - 単一レイヤー前提のため `temporalLayerId` / `spatialLayerId` は 0 固定
  - `isBaseLayerSync` はキーフレームで true を渡すが、`temporalLayerId=0` 固定のため RFC 9626 §3.1 の MUST に従いエンコーダーがワイヤ上 B=0 に抑圧する
  - `isDiscardable` は WebCodecs が破棄可能性情報を提供しないため false 固定
  - 受信側は、この Property が無い Object では Group 先頭 (Object ID 0) をキーフレームとして扱う
  - Object ID 0 が Group 先頭であることは draft-ietf-moq-msf-01 §6.2、同一 GOP のサンプルが同一 Group に置かれることは同 §4.1 が MUST で定める。Group 先頭が IDR であることは draft-ietf-moq-loc-04 §4.2 (Examples) に依拠する
- `VIDEO_CONFIG` / `AUDIO_CONFIG`: エンコーダーの metadata が返す description (映像は SPS/PPS などの extradata、音声は AAC の AudioSpecificConfig)
  - 受信側はこれを `VideoDecoder.configure` / `AudioDecoder.configure` の `description` に使う (draft-ietf-moq-loc-04 §2.3.2.1 / §2.3.3.1)

送信は `LOC.encodeAudioProperties` / `LOC.encodeVideoProperties` を通す。TIMESTAMP は
Unix epoch マイクロ秒 (壁時計) で送り、TIMESCALE は付けない (draft-ietf-moq-loc-04 §2.3.1.1)。

LOC モジュール (`LOC` 名前空間) は次にも対応するが、高レベル API は送信しない:

- `AUDIO_LEVEL`: オーディオレベル
- `TIMESCALE`: Timestamp の単位

`VIDEO_CONFIG` / `AUDIO_CONFIG` は、同じ値を毎 Object 送らず変化したときだけ載せる。
後着の購読者のために同じ値も載せ直す (次項)。

音声にはキーフレームが無く、Chromium の `AudioEncoder` では description が configure 後の
最初の出力にしか現れない (実装依存であり将来変わり得る)。後着の購読者へ届けるために、
音声 Publisher の購読が paused でなくなった時点
(draft-ietf-moq-transport-22 §7.6) で保持している `AUDIO_CONFIG` を次の Object に
1 度だけ載せ直す。

映像の description も configure 後の最初の出力と構成変更時にしか現れない (実装依存であり
将来変わり得る)。後着の購読者へ届けるために、映像 Publisher の購読が paused でなく
なった時点 (§7.6) で保持している `VIDEO_CONFIG` の送り直しを要求し、次に届く
キーフレームの Object に 1 度だけ載せ直す。キーフレーム以外の Object に載せると購読側が
GOP の途中で復号器を再構成することになり、参照フレームも揃わないため載せない。
購読側 (`createMediaSubscriber`) は再構成の完了まで入力を止め、
成功した場合は構成を変更した最初のキーフレームも復号する。

高レベル API は H.264 / H.265 を annexb 形式で設定するため、Chromium のエンコーダーは
description を返さない (parameter sets は bitstream に含まれる)。VP8 / VP9 / AV1 は
description を使わないため、この送り直しは canonical 形式 (avc / hev1) の description が
届く設定 / 実装で働く。

paused でないまま購読者が接続した場合は変化が起きないため送り直されず、
Relay のキャッシュに依存する。購読者がいない間に Relay が購読を paused にするかは
裁量である (draft-ietf-moq-transport-22 §7.2 Paused Subscription Handling)。
stop 後に再開した場合は新しいセッションとエンコーダーになるため、保持していた
`VIDEO_CONFIG` / `AUDIO_CONFIG` と送り直し要求は破棄し、新しいエンコーダーの
description を改めて送る。

## groupId / objectId 管理

- Audio: フレームごとに新しい groupId を開始、objectId は常に 0 (draft-ietf-moq-loc-04 §4.1)
- Video: キーフレームで新しい groupId を開始、objectId は Group 内でインクリメント (draft-ietf-moq-loc-04 §4.2)
- Catalog: 開始時に初期 groupId を割り当て、送り直しのたびに +1、objectId は常に 0 (draft-ietf-moq-msf-01 §5 / §6.1 / §6.2)

## Priority

MOQT の Publisher Priority を使用して、Relay での優先度制御を行う。
値が小さいほど優先度が高く、帯域不足時に優先的に送信される。0-255 の符号無し
整数で、最高優先は 0 である (draft-ietf-moq-transport-22 §5.1.1)。高レベル API は
Subscriber Priority を指定しないため、Relay は Publisher Priority の順に
スケジューリングする (§5.1.2)。ただし §5.1.2 の選択アルゴリズムは SHOULD であり、
実際のスケジューリングは Relay の裁量である。

| トラック種別         | Priority | 説明                                         |
| -------------------- | -------- | -------------------------------------------- |
| Catalog              | 0        | 届かないと購読が始まらないため最高優先       |
| Video キーフレーム   | 0        | 後続フレームのデコードに必須のため最高優先   |
| Audio                | 64       | 音声は途切れると違和感が大きいため次に高優先 |
| Video デルタフレーム | 128      | 破棄されても次のキーフレームで回復可能       |

Video デルタフレームの 128 は DEFAULT PUBLISHER PRIORITY の既定値
(draft-ietf-moq-transport-22 §10.4) と同じ値である。

Publisher Priority は Subgroup 単位で 1 つに決まる
(draft-ietf-moq-transport-22 §5.1.1)。映像のデルタフレームはキーフレームで開いた
Group の続きとして同じ Subgroup に載るため、実際に送信される値はキーフレームの
0 になる。デルタフレームの 128 が載るのは、送信する Subgroup の先頭 Object が
デルタフレームになるときだけである (キーフレームより先にデルタフレームが届いた
場合や、paused の間にキーフレームを送らなかった場合)。

帯域不足時の動作:

1. Video キーフレームで開いた Publisher Priority 0 の Subgroup が最優先で維持される
2. Audio (64) はその次に維持される
3. Video デルタフレームは Subgroup 単位でキーフレームと同じ扱いになる (個別には破棄されない)
