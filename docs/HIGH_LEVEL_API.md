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
  // SETUP Option (0x03) として送出する Authorization Token
  // SETUP では DELETE / USE_ALIAS は禁止 (§9.1.4)
  authorizationToken?: AuthorizationToken;
  // Pending Subgroup Stream の buffer 設定 (§11.3.1)。
  // 未指定のフィールドは既定値で補完される
  pendingSubgroup?: Partial<PendingSubgroupBufferOptions>;
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

| メソッド                                    | 説明                           |
| ------------------------------------------- | ------------------------------ |
| `start(stream: MediaStream): Promise<void>` | MediaStream を渡して配信開始   |
| `pause()`                                   | 配信一時停止（エンコード停止） |
| `resume()`                                  | 配信再開                       |
| `stop(): Promise<void>`                     | 配信停止                       |
| `requestKeyframe()`                         | キーフレームを即座に送信       |
| `close(): Promise<void>`                    | リソース解放                   |
| `getStats(): MediaStats`                    | 送信側の統計情報取得           |
| `getCatalog(): Catalog \| null`             | 配信中に生成したカタログ取得   |

### プロパティ

| プロパティ | 型                    | 説明       |
| ---------- | --------------------- | ---------- |
| `state`    | `MediaPublisherState` | 現在の状態 |

### 状態

```typescript
type MediaPublisherState =
  | "created" // createMediaPublisher() 直後
  | "publishing" // start(stream) 後
  | "paused" // pause() 後
  | "stopped" // stop() 後
  | "closed"; // close() 後
```

### 状態遷移

```
created ──start(stream)──► publishing
                              │ │
                              │ │
                              │ └────stop()──────┐
                              │                  │
              pause()◄────────┘                  │
                 │                               │
                 ▼                               │
              paused ──resume()──► publishing    │
                                                 ▼
                                             stopped

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
    codec?: "opus" | "aac"; // 省略時は Catalog から自動取得
  };
  video?: {
    trackName?: string; // default: "video"
    codec?: "h264" | "h265" | "vp8" | "vp9" | "av1"; // 省略時は Catalog から自動取得
  };
  useWorker?: boolean; // default: true
  serverCertificateHashes?: ArrayBuffer[]; // 自己署名証明書のハッシュ
  // SETUP Option (0x03) として送出する Authorization Token
  // 受信側 (Subscriber) も送信できる。SETUP では DELETE / USE_ALIAS は禁止
  authorizationToken?: AuthorizationToken;
  // §5.2.42 authInfo を持つ track の購読時にトークンを供給するコールバック。
  // authInfo があるのに undefined を返すと購読はエラーになる
  getAuthorizationToken?: (
    authInfo: AuthInfo,
  ) => AuthorizationToken | undefined | Promise<AuthorizationToken | undefined>;
  // Pending Subgroup Stream の buffer 設定 (§11.3.1)。
  // 未指定のフィールドは既定値で補完される
  pendingSubgroup?: Partial<PendingSubgroupBufferOptions>;
}
```

MediaPublisherOptions も `audio` / `video` / `useWorker` / `serverCertificateHashes` に加えて
`authorizationToken` と `pendingSubgroup` を持つ (購読側と同じ形)。

### コールバック

```typescript
interface MediaSubscriberCallbacks {
  onStateChange?: (state: MediaSubscriberState) => void;
  // カタログを受信するたびに呼ばれる (更新時も呼ばれる)
  onCatalog?: (catalog: Catalog) => void;
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
| `getStats(): MediaReceiverStats`   | 受信側の統計情報取得                      |

### プロパティ

| プロパティ    | 型                     | 説明                   |
| ------------- | ---------------------- | ---------------------- |
| `state`       | `MediaSubscriberState` | 現在の状態             |
| `mediaStream` | `MediaStream \| null`  | 再生用 MediaStream     |
| `catalog`     | `Catalog \| null`      | 受信した最新のカタログ |

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
interface MediaReceiverStats {
  audio: AudioReceiverStats | null;
  video: VideoReceiverStats | null;
}

interface AudioReceiverStats {
  framesReceived: number;
  bytesReceived: number;
}

interface VideoReceiverStats {
  framesReceived: number;
  keyFramesReceived: number;
  bytesReceived: number;
}
```

`AudioStats` / `VideoStats` は送信側 (`MediaStats`) の型である。受信側は
`AudioReceiverStats` / `VideoReceiverStats` を使う。

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

// 配信開始 (MediaStream は start() に渡す)
await publisher.start(stream);

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

### カタログの受信

```typescript
// 購読側: コールバックで受け取る
const subscriber = await createMediaSubscriber(
  url,
  { namespace: ["live", "room1"], video: { codec: "h264" } },
  {
    onCatalog: (catalog) => {
      console.log("tracks:", catalog.tracks.length);
    },
  },
);

// 購読側: 最新のカタログをいつでも参照できる
const latest = subscriber.catalog;

// 配信側: 配信中に生成したカタログを参照できる
const published = publisher.getCatalog();
```

### 認可トークン

```typescript
// SETUP Option (0x03) として送出する
const publisher = await createMediaPublisher(url, {
  namespace: ["live", "room1"],
  video: { codec: "h264" },
  authorizationToken: { aliasType: 0x03, tokenType: 0n, tokenValue },
});

// 購読側はカタログの authInfo に応じてトークンを供給する
const subscriber = await createMediaSubscriber(url, {
  namespace: ["live", "room1"],
  video: { codec: "h264" },
  getAuthorizationToken: (authInfo) => fetchTokenFor(authInfo),
});
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
- `VIDEO_CONFIG` / `AUDIO_CONFIG`: エンコーダの metadata が返す description (映像は SPS/PPS などの extradata、音声は AAC の AudioSpecificConfig)
  - 受信側はこれを `VideoDecoder.configure` / `AudioDecoder.configure` の `description` に使う (draft-ietf-moq-loc-04 §2.3.2.1 / §2.3.3.1)

送信は `LOC.encodeAudioProperties` / `LOC.encodeVideoProperties` を通す。TIMESTAMP は
Unix epoch マイクロ秒 (壁時計) で送り、TIMESCALE は付けない (draft-ietf-moq-loc-04 §2.3.1.1)。

LOC モジュール (`LOC` 名前空間) は次にも対応するが、高レベル API は送信しない:

- `AUDIO_LEVEL`: オーディオレベル
- `TIMESCALE`: Timestamp の単位

`VIDEO_CONFIG` / `AUDIO_CONFIG` は、同じ値を毎 Object 送らず変化したときだけ載せる。
音声だけは後着の購読者のために同じ値も載せ直す (次項)。

音声にはキーフレームが無く、Chromium の `AudioEncoder` では description が configure 後の
最初の出力にしか現れない (実装依存であり将来変わり得る)。後着の購読者へ届けるために、
音声 Publisher の Forward State が 0 から 1 になった時点
(draft-ietf-moq-transport-21 §7.5) で保持している `AUDIO_CONFIG` を次の Object に
1 度だけ載せ直す。

Forward State が 1 のまま購読者が接続した場合は変化が起きないため送り直されず、
Relay のキャッシュに依存する。購読者がいない間に Relay が Forward State を
0 に戻すかは裁量である (draft-ietf-moq-transport-21 §7.2)。stop 後に再開した場合は新しい
セッションとエンコーダになるため、保持していた `AUDIO_CONFIG` は破棄し、新しい
エンコーダの description を改めて送る。

### groupId / objectId 管理

- Audio: フレームごとに新しい groupId を開始、objectId は常に 0 (draft-ietf-moq-loc-04 §4.1)
- Video: キーフレームで新しい groupId を開始、objectId は Group 内でインクリメント (draft-ietf-moq-loc-04 §4.2)

### Priority

MOQT の Publisher Priority を使用して、Relay での優先度制御を行う。
値が小さいほど優先度が高く、帯域不足時に優先的に送信される。0-255 の符号無し
整数で、最高優先は 0 である (draft-ietf-moq-transport-21 §5.1.1)。高レベル API は
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
(draft-ietf-moq-transport-21 §10.4) と同じ値である。

Publisher Priority は Subgroup 単位で 1 つに決まる
(draft-ietf-moq-transport-21 §5.1.1)。映像のデルタフレームはキーフレームで開いた
Group の続きとして同じ Subgroup に載るため、実際に送信される値はキーフレームの
0 になる。デルタフレームの 128 が載るのは、送信する Subgroup の先頭 Object が
デルタフレームになるときだけである (キーフレームより先にデルタフレームが届いた
場合や、Forward State が 0 の間にキーフレームを送らなかった場合)。

帯域不足時の動作:

1. Video キーフレームで開いた Publisher Priority 0 の Subgroup が最優先で維持される
2. Audio (64) はその次に維持される
3. Video デルタフレームは Subgroup 単位でキーフレームと同じ扱いになる (個別には破棄されない)
