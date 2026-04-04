# MOQT Streaming Format (MSF)

MOQT Streaming Format (MSF) は、Media Over QUIC Transport (MOQT) 上でメディアコンテンツを配信するためのストリーミングフォーマット。

- 仕様: [draft-ietf-moq-msf](https://github.com/moq-wg/msf)
- LOC 仕様: [draft-ietf-moq-loc](https://github.com/moq-wg/loc)
- ローカル参照: `refs/moq/draft-ietf-moq-msf.md`

注意: MSF 仕様は draft-ietf-moq-transport-11 を参照しているため、一部のメッセージ名が現在の draft-15 と異なる。

## draft-15 での変更点

| draft-11 (MSF 仕様) | draft-15 (現在)      | 備考                   |
| ------------------- | -------------------- | ---------------------- |
| SUBSCRIBE_DONE      | PUBLISH_DONE         | メッセージ名のリネーム |
| Filter Type 0x01    | LatestGroup (0x01)   | 名称変更なし           |
| Filter Type 0x02    | LatestObject (0x02)  | 名称変更なし           |
| Filter Type 0x03    | AbsoluteStart (0x03) | 名称変更なし           |
| Filter Type 0x04    | AbsoluteRange (0x04) | 名称変更なし           |

draft-15 を使用する場合は、本ドキュメント内の SUBSCRIBE_DONE を PUBLISH_DONE として読み替えること。

## 概要

MSF は以下を提供する:

- LOC (Low Overhead Container) ベースのメディアパッケージング
- Catalog によるトラックメタデータの記述
- Media Timeline / Event Timeline によるシーク・同期サポート
- ABR (Adaptive Bitrate) スイッチングのサポート

## 構成要素

```
MSF = LOC (メディアパッケージング) + Catalog (メタデータ) + Timeline (オプション)
```

## Catalog

Catalog は JSON 形式の MOQT トラックで、配信可能なトラックの情報を記述する。

### Catalog トラック

- トラック名: `catalog` (固定、大文字小文字区別)
- フォーマット: JSON
- 更新: トラックの可用性が変わったときのみ発行

### Catalog フィールド

#### ルートレベル (R)

| フィールド    | 名前           | 必須 | 型      | 説明                    |
| ------------- | -------------- | ---- | ------- | ----------------------- |
| MSF version   | `version`      | Yes  | Number  | MSF バージョン (現在 1) |
| Delta update  | `deltaUpdate`  | No   | Boolean | 差分更新かどうか        |
| Add tracks    | `addTracks`    | No   | Array   | 追加するトラック        |
| Remove tracks | `removeTracks` | No   | Array   | 削除するトラック        |
| Clone tracks  | `cloneTracks`  | No   | Array   | 複製するトラック        |
| Generated at  | `generatedAt`  | No   | Number  | 生成時刻 (Unix ms)      |
| Is Complete   | `isComplete`   | No   | Boolean | 配信完了フラグ          |
| Tracks        | `tracks`       | Yes  | Array   | トラック配列            |

#### トラックレベル (T)

| フィールド          | 名前            | 必須 | 型      | 説明                                                         |
| ------------------- | --------------- | ---- | ------- | ------------------------------------------------------------ |
| Track namespace     | `namespace`     | No   | String  | トラックの名前空間                                           |
| Track name          | `name`          | Yes  | String  | トラック名                                                   |
| Packaging           | `packaging`     | Yes  | String  | パッケージング形式 (`loc`, `mediatimeline`, `eventtimeline`) |
| Is Live             | `isLive`        | Yes  | Boolean | ライブ配信かどうか                                           |
| Target latency      | `targetLatency` | No   | Number  | 目標遅延 (ms)                                                |
| Track role          | `role`          | No   | String  | トラックの役割 (`video`, `audio`, `caption`, etc.)           |
| Track label         | `label`         | No   | String  | 人間が読めるラベル                                           |
| Render group        | `renderGroup`   | No   | Number  | 同時レンダリンググループ                                     |
| Alternate group     | `altGroup`      | No   | Number  | 代替トラックグループ (ABR 用)                                |
| Initialization data | `initData`      | No   | String  | Base64 エンコードされた初期化データ                          |
| Dependencies        | `depends`       | No   | Array   | 依存トラック名の配列                                         |
| Temporal ID         | `temporalId`    | No   | Number  | テンポラルレイヤー ID                                        |
| Spatial ID          | `spatialId`     | No   | Number  | スペーシャルレイヤー ID                                      |
| Codec               | `codec`         | No   | String  | コーデック (WebCodecs 形式)                                  |
| Mime type           | `mimeType`      | No   | String  | MIME タイプ                                                  |
| Framerate           | `framerate`     | No   | Number  | フレームレート (fps)                                         |
| Bitrate             | `bitrate`       | No   | Number  | ビットレート (bps)                                           |
| Width               | `width`         | No   | Number  | 映像幅 (px)                                                  |
| Height              | `height`        | No   | Number  | 映像高さ (px)                                                |
| Audio sample rate   | `samplerate`    | No   | Number  | オーディオサンプルレート                                     |
| Channel config      | `channelConfig` | No   | String  | チャンネル構成                                               |
| Track duration      | `trackDuration` | No   | Number  | トラック長 (ms, VOD 用)                                      |

### Catalog 例

#### Audio/Video トラック

```json
{
  "version": 1,
  "generatedAt": 1746104606044,
  "tracks": [
    {
      "name": "video",
      "packaging": "loc",
      "isLive": true,
      "targetLatency": 2000,
      "role": "video",
      "renderGroup": 1,
      "codec": "av01.0.08M.10.0.110.09",
      "width": 1920,
      "height": 1080,
      "framerate": 30,
      "bitrate": 1500000
    },
    {
      "name": "audio",
      "packaging": "loc",
      "isLive": true,
      "targetLatency": 2000,
      "role": "audio",
      "renderGroup": 1,
      "codec": "opus",
      "samplerate": 48000,
      "channelConfig": "2",
      "bitrate": 32000
    }
  ]
}
```

#### ABR (Simulcast) トラック

```json
{
  "version": 1,
  "tracks": [
    {
      "name": "hd",
      "packaging": "loc",
      "isLive": true,
      "role": "video",
      "renderGroup": 1,
      "altGroup": 1,
      "codec": "av01",
      "width": 1920,
      "height": 1080,
      "bitrate": 5000000
    },
    {
      "name": "sd",
      "packaging": "loc",
      "isLive": true,
      "role": "video",
      "renderGroup": 1,
      "altGroup": 1,
      "codec": "av01",
      "width": 640,
      "height": 480,
      "bitrate": 500000
    }
  ]
}
```

## Media Timeline トラック

過去に発行されたグループとメディア時間・壁時計時間の関係を記述する。シークや VOD のランダムアクセスに使用。

### フォーマット

JSON 配列。各要素は `[mediaPts, [groupId, objectId], wallclock]` の形式。`draft-ietf-moq-msf-00` Section 7.1 に従い、ドキュメント全体を gzip 圧縮してよい。

```json
[
  [0, [0, 0], 1759924158381],
  [2002, [1, 0], 1759924160383],
  [4004, [2, 0], 1759924162385]
]
```

### Catalog での宣言

```json
{
  "name": "history",
  "packaging": "mediatimeline",
  "mimeType": "application/json",
  "depends": ["video", "audio"]
}
```

### moqt-js API

- `await encodeMediaTimeline(entries)` で非圧縮 JSON を生成する
- `await encodeMediaTimeline(entries, { gzip: true })` で gzip 圧縮 JSON を生成する
- `await decodeMediaTimeline(data)` は gzip マジック (`0x1F 0x8B`) を検出すると自動で展開する

## Event Timeline トラック

任意のイベントメタデータをブロードキャストに関連付ける。スポーツのスコア、GPS 座標、アクティブスピーカー通知など。

### フォーマット

JSON 配列。各要素にはインデックス参照 (`t`: 壁時計時間, `l`: Location, `m`: Media PTS) と `data` オブジェクトを含む。`draft-ietf-moq-msf-00` Section 8.1 に従い、ドキュメント全体を gzip 圧縮してよい。

```json
[
  {
    "t": 1756885678361,
    "data": {
      "status": "in_progress",
      "homeScore": 2,
      "awayScore": 0
    }
  }
]
```

### moqt-js API

- `await encodeEventTimeline(entries)` で非圧縮 JSON を生成する
- `await encodeEventTimeline(entries, { gzip: true })` で gzip 圧縮 JSON を生成する
- `await decodeEventTimeline(data)` は gzip マジック (`0x1F 0x8B`) を検出すると自動で展開する

## メディア伝送

### LOC パッケージング

- 各 `EncodedAudioChunk` / `EncodedVideoChunk` は個別の MOQT Object にマッピング
- 同じ GOP (Group of Pictures) に属するサンプルは同じ MOQT Group に配置

### 時間整列 (Time-alignment)

- 同じ `renderGroup` のトラックは時間整列が必須
- 同じ番号の MOQT Group の最初のオブジェクトは、デコード後に重なるプレゼンテーション時間を持つ

### Group 番号付け

- 最初の Group ID は一意な整数 (Unix エポックからのミリ秒を推奨)
- 以降の Group ID は 1 ずつ増加

## ワークフロー

### 配信開始

1. Publisher は Catalog トラックを最初に発行
2. その後、メディアトラックを発行

### 配信終了

1. すべてのアクティブトラックに `PUBLISH_DONE` (status 0x2) を送信
2. VOD 変換する場合: `isLive: false` と `trackDuration` を設定した Catalog を発行
3. 永続終了の場合: `isComplete: true` と空の `tracks` を持つ Catalog を発行

## レイテンシレベル

| レベル      | 遅延           |
| ----------- | -------------- |
| Real-time   | < 500ms        |
| Interactive | 500ms - 2500ms |
| Standard    | > 2500ms       |
| VOD         | N/A            |

## moqt-js 実装状況

### 実装済み

| 機能                               | ファイル     | 説明                                                             |
| ---------------------------------- | ------------ | ---------------------------------------------------------------- |
| LOC Header Extensions              | `src/loc.ts` | Capture Timestamp, Video Frame Marking, Audio Level, Config      |
| Catalog 型定義                     | `src/msf.ts` | 全フィールド対応                                                 |
| Catalog エンコード/デコード        | `src/msf.ts` | `encodeCatalog()`, `decodeCatalog()`                             |
| Catalog 差分更新                   | `src/msf.ts` | `applyCatalogDelta()`                                            |
| Media Timeline 型定義              | `src/msf.ts` | `MediaTimelineEntry`                                             |
| Media Timeline エンコード/デコード | `src/msf.ts` | `encodeMediaTimeline()`, `decodeMediaTimeline()`                 |
| Event Timeline 型定義              | `src/msf.ts` | `EventTimelineEntry`                                             |
| Event Timeline エンコード/デコード | `src/msf.ts` | `encodeEventTimeline()`, `decodeEventTimeline()`                 |
| ヘルパー関数                       | `src/msf.ts` | `getVideoTracks()`, `getAudioTracks()`, `getTrackByName()`, etc. |
| 配信完了 Catalog 作成              | `src/msf.ts` | `createCompleteCatalog()`                                        |
| Group 番号付け                     | `src/msf.ts` | `createInitialGroupId()`, `nextGroupId()`                        |
| ABR トラック選択                   | `src/msf.ts` | `selectTrackByMaxBitrate()`, `selectHighestBitrateTrack()`, etc. |

### 未実装

| 機能           | 説明                                            |
| -------------- | ----------------------------------------------- |
| 配信終了フロー | PUBLISH_DONE 送信のワークフロー                 |
| 時間整列の検証 | `renderGroup` 間の同期チェック                  |
| 高レベル API   | `createMsfPublisher()`, `createMsfSubscriber()` |

## moqt-js での実装方針

### Publisher

1. Catalog トラックを作成・発行
2. メディアトラック (audio/video) を LOC 形式で発行
3. トラック変更時に Catalog を更新

### Subscriber

1. Catalog トラックを購読
2. Catalog JSON をパースしてトラック情報を取得
3. `codec` フィールドからデコーダーを設定
4. メディアトラックを購読

### 期待される API

```typescript
// Publisher (MSF 対応)
const publisher = await createMsfPublisher(url, {
  namespace: ["live", "stream1"],
  catalog: {
    targetLatency: 2000,
  },
  audio: {
    trackName: "audio",
    codec: "opus",
    // ...
  },
  video: {
    trackName: "video",
    codec: "av1",
    // ...
  },
});

// Subscriber (MSF 対応)
const subscriber = await createMsfSubscriber(url, {
  namespace: ["live", "stream1"],
  // codec は Catalog から自動取得
  onCatalog: (catalog) => {
    // トラック選択ロジック
  },
});
```
