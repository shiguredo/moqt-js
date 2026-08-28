# 高レベル API 仕様

## 概要

moqt-js に MediaStream ベースの高レベル API を追加する。
WebCodecs のエンコード/デコード、Worker 処理、LOC コンテナを内部で隠蔽し、
シンプルなファクトリー関数で MOQT メディア配信を実現する。

## API 階層

```
┌──────────────────────────────────────────────────────────────┐
│ 高レベル API (MediaStream)                                    │
│                                                              │
│ createMediaPublisher(url, options)                           │
│ createMediaSubscriber(url, options)                          │
│                                                              │
│ 用途: シンプルなメディア配信                                  │
│ 内部: Worker + WebCodecs + LOC を隠蔽                         │
├──────────────────────────────────────────────────────────────┤
│ 低レベル API (MoqtObject)                                     │
│                                                              │
│ connect() → session.publish() / session.subscribe()          │
│ publisher.sendObject() / subscriber.object callback          │
│                                                              │
│ 用途: MOQT プロトコル直接操作、メディア以外のデータ配信        │
└──────────────────────────────────────────────────────────────┘
```

---

## MediaPublisher

### 作成

```typescript
import { createMediaPublisher } from "moqt-js"

const publisher = await createMediaPublisher(url, options, callbacks?)
```

### オプション

```typescript
interface MediaPublisherOptions {
  namespace: string[];
  audio?: {
    trackName?: string; // default: "audio"
    codec: "opus" | "aac";
    bitrate: number;
    sampleRate?: number; // default: 48000
    channels?: number; // default: 2
  };
  video?: {
    trackName?: string; // default: "video"
    codec: "h264" | "h265" | "vp8" | "vp9" | "av1";
    bitrate: number;
    framerate?: number; // default: 30
    keyframeInterval?: number; // default: framerate * 2
    width?: number; // optional: 指定しない場合は MediaStream から取得
    height?: number; // optional
  };
  useWorker?: boolean; // default: true
  serverCertificateHashes?: ArrayBuffer[]; // 自己署名証明書のハッシュ
}
```

### コールバック

```typescript
interface MediaPublisherCallbacks {
  onStateChange?: (state: MediaPublisherState) => void;
  onError?: (error: Error) => void;
  onClose?: () => void;
}
```

### メソッド

| メソッド                         | 説明                           |
| -------------------------------- | ------------------------------ |
| `setStream(stream: MediaStream)` | MediaStream を設定             |
| `start(): Promise<void>`         | 配信開始                       |
| `pause()`                        | 配信一時停止（エンコード停止） |
| `resume()`                       | 配信再開                       |
| `stop(): Promise<void>`          | 配信停止                       |
| `requestKeyframe()`              | キーフレームを即座に送信       |
| `close(): Promise<void>`         | リソース解放                   |
| `getStats()`                     | 統計情報取得                   |

### プロパティ

| プロパティ | 型                    | 説明       |
| ---------- | --------------------- | ---------- |
| `state`    | `MediaPublisherState` | 現在の状態 |

### 状態

```typescript
type MediaPublisherState =
  | "created" // createMediaPublisher() 直後
  | "ready" // setStream() 後
  | "publishing" // start() 後
  | "paused" // pause() 後
  | "stopped" // stop() 後
  | "closed"; // close() 後
```

### 状態遷移

```
created ──setStream()──► ready ──start()──► publishing
                           ▲                    │ │
                           │                    │ │
                           └────stop()──────────┘ │
                                                  │
                           pause()◄───────────────┤
                              │                   │
                              ▼                   │
                           paused ──resume()──────┘

* → close() → closed (どの状態からでも可能)
```

### 統計情報

```typescript
interface MediaStats {
  audio: AudioStats | null;
  video: VideoStats | null;
}

interface AudioStats {
  framesSent: number;
  bytesSent: number;
  currentGroupId: number;
}

interface VideoStats {
  framesSent: number;
  keyFramesSent: number;
  bytesSent: number;
  currentGroupId: number;
}
```

---

## MediaSubscriber

### 作成

```typescript
import { createMediaSubscriber } from "moqt-js"

const subscriber = await createMediaSubscriber(url, options, callbacks?)
```

### オプション

```typescript
interface MediaSubscriberOptions {
  namespace: string[];
  audio?: {
    trackName?: string; // default: "audio"
    codec: "opus" | "aac";
  };
  video?: {
    trackName?: string; // default: "video"
    codec: "h264" | "h265" | "vp8" | "vp9" | "av1";
  };
  useWorker?: boolean; // default: true
  reorderTimeout?: number; // default: 50 (ms), 0 で無効
  joiningFetch?: boolean; // default: false
  serverCertificateHashes?: ArrayBuffer[]; // 自己署名証明書のハッシュ
}
```

### コールバック

```typescript
interface MediaSubscriberCallbacks {
  onStateChange?: (state: MediaSubscriberState) => void;
  onError?: (error: Error) => void;
  onClose?: () => void;
}
```

### メソッド

| メソッド                           | 説明                                      |
| ---------------------------------- | ----------------------------------------- |
| `start(): Promise<void>`           | 購読開始                                  |
| `stop(): Promise<void>`            | 購読停止                                  |
| `requestKeyframe(): Promise<void>` | キーフレーム要求（SUBSCRIBE_UPDATE 送信） |
| `close(): Promise<void>`           | リソース解放                              |
| `getStats()`                       | 統計情報取得                              |

### プロパティ

| プロパティ    | 型                     | 説明               |
| ------------- | ---------------------- | ------------------ |
| `state`       | `MediaSubscriberState` | 現在の状態         |
| `mediaStream` | `MediaStream \| null`  | 再生用 MediaStream |

### 状態

```typescript
type MediaSubscriberState =
  | "created" // createMediaSubscriber() 直後
  | "subscribing" // start() 後、SUBSCRIBE_OK 待ち
  | "active" // SUBSCRIBE_OK 受信後
  | "stopped" // stop() 後
  | "closed"; // close() 後
```

### 状態遷移

```
created ──start()──► subscribing ──(SUBSCRIBE_OK)──► active
                                                       │
                                       stop()◄─────────┘
                                         │
                                         ▼
                                      stopped

* → close() → closed (どの状態からでも可能)
```

### 統計情報

```typescript
interface AudioStats {
  framesReceived: number;
  bytesReceived: number;
}

interface VideoStats {
  framesReceived: number;
  keyFramesReceived: number;
  bytesReceived: number;
}
```

---

## 使用例

### 基本的な配信

```typescript
import { createMediaPublisher } from "moqt-js";

// MediaPublisher 作成
const publisher = await createMediaPublisher(
  "https://relay.example.com/moqt",
  {
    namespace: ["live", "room1"],
    audio: { codec: "opus", bitrate: 128_000 },
    video: { codec: "h264", bitrate: 3_000_000 },
  },
  {
    onStateChange: (state) => console.log("Publisher state:", state),
    onError: (error) => console.error("Publisher error:", error),
  },
);

// カメラ/マイク取得
const stream = await navigator.mediaDevices.getUserMedia({
  audio: true,
  video: true,
});

// 配信開始
publisher.setStream(stream);
await publisher.start();

// 統計情報取得
setInterval(() => {
  const stats = publisher.getStats();
  console.log("Video frames sent:", stats.video?.framesSent);
}, 1000);

// 配信停止
await publisher.stop();
await publisher.close();
```

### 基本的な視聴

```typescript
import { createMediaSubscriber } from "moqt-js";

// MediaSubscriber 作成
const subscriber = await createMediaSubscriber(
  "https://relay.example.com/moqt",
  {
    namespace: ["live", "room1"],
    audio: { codec: "opus" },
    video: { codec: "h264" },
    joiningFetch: true,
  },
  {
    onStateChange: (state) => console.log("Subscriber state:", state),
    onError: (error) => console.error("Subscriber error:", error),
  },
);

// 購読開始
await subscriber.start();

// video 要素に接続
const videoElement = document.getElementById("video") as HTMLVideoElement;
videoElement.srcObject = subscriber.mediaStream;

// 購読停止
await subscriber.stop();
await subscriber.close();
```

### カメラ切り替え

```typescript
// 配信中にカメラを切り替え
const newStream = await navigator.mediaDevices.getUserMedia({
  audio: true,
  video: { deviceId: { exact: newDeviceId } },
});

// setStream() で差し替え（内部でトラック更新）
publisher.setStream(newStream);
```

### 一時停止/再開

```typescript
// 一時停止（エンコード停止、フレーム送信停止）
publisher.pause();

// 再開
publisher.resume();
```

### キーフレーム要求

```typescript
// 品質回復などでキーフレームを要求
await subscriber.requestKeyframe();
```

---

## 内部実装

### MediaPublisher 内部構成

```
MediaStream
    │
    ├─► AudioTrack ─► MediaStreamTrackProcessor ─► AudioEncoder ─► MOQT Publisher (audio)
    │                                                    │
    │                                              LOC Properties
    │
    └─► VideoTrack ─► MediaStreamTrackProcessor ─► VideoEncoder ─► MOQT Publisher (video)
                                                         │
                                                   LOC Properties
```

### MediaSubscriber 内部構成

```
MOQT Subscriber (audio) ─► AudioDecoder ─► MediaStreamTrackGenerator ─┐
        │                       │                                      │
  LOC Properties          AudioData                                    ├─► MediaStream
        │                                                              │
MOQT Subscriber (video) ─► VideoDecoder ─► MediaStreamTrackGenerator ─┘
        │                       │
  LOC Properties          VideoFrame
```

### Worker 処理

- `useWorker: true`（デフォルト）の場合、エンコード/デコードを Worker で実行
- メインスレッドのブロッキングを回避
- VideoFrame / AudioData の transferable object を活用

### LOC コンテナ

高レベル API が自動処理する LOC Properties:

- `TIMESTAMP`: フレームのタイムスタンプ
- `VIDEO_FRAME_MARKING`: キーフレーム判定（映像のみ）
  - 単一レイヤー前提のため `temporalLayerId` / `spatialLayerId` は 0 固定
  - `isBaseLayerSync` はキーフレームで true を渡すが、`temporalLayerId=0` 固定のため RFC 9626 §3.1 の MUST に従いエンコーダがワイヤ上 B=0 に抑圧する
  - `isDiscardable` は WebCodecs が破棄可能性情報を提供しないため false 固定

LOC モジュール自体は次も対応するが、高レベル API では未配線:

- `VIDEO_CONFIG` / `AUDIO_CONFIG`: コーデック description
- `AUDIO_LEVEL`: オーディオレベル
- `TIMESCALE`: Timestamp の単位

### groupId / objectId 管理

- Audio: 一定間隔（例: 1 秒）で新しい groupId を開始
- Video: キーフレームで新しい groupId を開始、objectId はグループ内でインクリメント

### Priority

MOQT の Publisher Priority を使用して、Relay サーバーでの優先度制御を行う。
値が大きいほど優先度が高く、帯域不足時に優先的に送信される。

| トラック種別         | Priority | 説明                                     |
| -------------------- | -------- | ---------------------------------------- |
| Audio                | 192      | 音声は途切れると違和感が大きいため高優先 |
| Video キーフレーム   | 255      | 後続フレームのデコードに必須のため最高   |
| Video デルタフレーム | 128      | 破棄されても次のキーフレームで回復可能   |

帯域不足時の動作:

1. Video デルタフレームが最初に破棄される
2. Audio は維持される
3. Video キーフレームは可能な限り維持される
