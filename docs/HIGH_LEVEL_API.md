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
  // 符号化から表示までの wallclock の差 (ms)
  // 指定すると catalog の音声と映像の両方の track に同じ値を載せる
  // (同じ render group と alternate group の track は同一の値でなければならない MUST)。
  // 未指定のときは載せず、購読側が表示の遅れを選ぶ (§5.2.8 の MAY)。0 ms は有効値。
  // 宣言した値がそのまま使われるとは限らない。購読側は表示の遅れを、表示待ちのキューが
  // 吸収できる長さと上限 500 ms の小さい方へ切り下げる。60 fps の購読では 500 ms を宣言
  // しても約 333 ms になり、切り下げた分は `AvSyncStats.targetLatencyLimitedMs` で分かる
  targetLatency?: number; // draft-ietf-moq-msf-01 §5.2.8
  // 同時レンダリンググループ
  // 指定すると catalog の音声と映像の両方の track に同じ値を載せる
  // (同じ group の track は同時に描画する SHOULD)。0 は有効値
  renderGroup?: number; // draft-ietf-moq-msf-01 §5.2.11
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

`renderGroup` は同じ group の track を同時に描画する表明であり、音声と映像の両方を配信する
ときに意味を持つ (片方だけ配信するときは、同時に描画する相手が居ない)。`targetLatency` は
音声と映像で同じ値にするための宣言 (draft-ietf-moq-msf-01 §5.2.8 の MUST) であり、片方だけ
配信するときも購読側の表示の遅れの下限として使われる。0 ms を宣言しても、購読側は
`max(targetLatency, 揺らぎから求めた再生遅延)` を使うため、音声には 80 ms
(`AUDIO_PLAYOUT_DELAY_FLOOR_MS`) の下限がある。publisher は `targetLatency` が有限数で
あることと `renderGroup` が有限の整数であることを検証する (非有限値は JSON で null になり
購読側が復号できなくなる)。それ以外の範囲は呼び出し側の責任になる。節番号は
draft-ietf-moq-msf-01 由来であり、将来の draft 改版で変わる可能性がある。

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
  // エンコードが追いつかないため待たずに破棄したフレーム数
  droppedFrames: number;
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

| メソッド                           | 説明                                                                                                                                                                                                                                                                                                                              |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `start(): Promise<void>`           | 購読開始（`"created"` と `"stopped"` から呼べる。開始を取り消すには `close()` を使う。実行中にピア起点の close または `close()` が重なると `"closed"` を優先して失敗する。失敗時は解放して遷移前の state に戻る。`close()` が解放と終端遷移を進めている間は `cannot start while closing`）                                        |
| `stop(): Promise<void>`            | 購読停止（`"active"` からのみ。`"subscribing"` を含むそれ以外は `cannot stop in state` で throw。解放して `"stopped"` にする。ピア起点の close の解放中は進行中の解放を共有して完了を待つ。解放の失敗時は state と `onClose` を変えず元のエラーを throw。`close()` が解放と終端遷移を進めている間は `cannot stop while closing`） |
| `requestKeyframe(): Promise<void>` | キーフレーム要求（REQUEST_UPDATE 送信）                                                                                                                                                                                                                                                                                           |
| `close(): Promise<void>`           | リソース解放（終端。どの状態からでも可能。開始の取り消しもこれを使う。進行中の解放（`stop()` / ピア起点の close）は共有して完了を待ち、その成否が結果になる。同時に呼んでも解放と通知は 1 回。解放の失敗時は state と `onClose` を変えず元のエラーを throw）                                                                      |
| `getStats(): MediaReceiverStats`   | 受信側の統計情報取得                                                                                                                                                                                                                                                                                                              |

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
  | "subscribing" // start() 後、購読確立待ち
  | "active" // 購読確立後 (カタログ受信と各メディアトラックの購読確立)
  | "stopped" // stop() 後 (解放済み。start() で再開できる)
  | "closed"; // close() 後 (終端)
```

### 状態遷移

```
                    start()              (購読確立)
created / stopped ──────────► subscribing ─────────► active
         ▲                        │                    │
         │  start の失敗          │                    │
         └────────────────────────┘                    │
         └──────────────── stop() ─────────────────────┘

* ──(ピア起点の close)──► closed
* ──close()──► closed (どの状態からでも可能。終端)
```

`created` と `stopped` は同じ辺 (`start()`) を持つため 1 つにまとめている。
`start()` が失敗したときの戻り先は遷移前の state (`"created"` または `"stopped"`) である。
`(購読確立)` はカタログの受信と各メディアトラックの購読確立が完了した時点である
(SUBSCRIBE_OK の受信だけでは `"active"` にならない)。

`stop()` は `close()` と同じ解放を行い、`mediaStream` と `catalog` は無効になる。
再開するときは `start()` を呼び、再 start 後の新しい `mediaStream` を使う。
`close()` のあとに `start()` を呼ぶと `cannot start in state: closed` で拒否される。
`stop()` の成功時に `onClose` は通知しない (停止であり終端ではない)。

`"subscribing"` (開始の途中) の `stop()` も `cannot stop in state: subscribing` で
拒否される。`start()` はカタログの受信と各トラックの購読が確立するまで返らないため、
この間の `stop()` は要求を記録せずに拒否するだけで、購読はそのまま進む。
開始を取り消すには `close()` を使う (解放して `"closed"` の終端へ進み、`start()` は
失敗する)。停止したい場合は `"active"` になってから `stop()` を呼ぶ。

`stop()` と `close()` は、解放が失敗したときは state を変えず `onClose` も呼ばず、元の
エラーを throw する。破棄の前に参照を切り離しているため、失敗した段階はやり直されず、
呼び直しが進めるのは失敗した段階より後の解放と終端遷移である。

解放は共有される。`stop()` またはピア起点の close の解放が進行中に `close()` を呼ぶと、
`close()` はその完了を待ってから `"closed"` へ進む。進行中の解放が失敗した場合は
`"closed"` にならず、`close()` も同じエラーを throw する (解放に相乗りした呼び出しも
失敗を検知できる)。逆に、進行中の解放に `stop()` が相乗りした場合は、解放のあとに
`stop()` が state を `"stopped"` にする。あとから解放を終えたピア起点の経路は state も
`onClose` も動かさない。
`close()` を await せずに重ねて呼んだ場合も、解放は 1 回で `onStateChange` の
`"closed"` と `onClose` は 1 回だけ通知される。終端の遷移は冪等であり、解放をまたいで
終端へ進む経路が重なっても 2 回通知しない。`close()` が解放と終端遷移を進めている間は
`start()` / `stop()` を `cannot start while closing` / `cannot stop while closing` で
拒否する (解放中は state がまだ `"active"` などのため、state だけでは重なりを判定できない)。

`stop()` と `close()` が解放をまたいで重なった場合も終端の `"closed"` が残る
(`stop()` は state が `"closed"` なら `"stopped"` に戻さない)。`"closed"` のあとの
`close()` は早期 return するため、`onClose` は 1 回だけ通知される。

ピア起点の close の通知では、解放してから `"closed"` にして `onClose` を通知する。
この経路で解放が失敗した場合は state を変えず `onError` で通知し、`close()` を呼べば
解放を回収できる (同じ通知は再送されないため)。解放が進行中の間に `close()` が呼ばれて
いれば、同じ失敗が `close()` の結果としても返る。

`start()` の実行中にピア起点の close または `close()` が重なった場合は `"closed"` が
優先され、`start()` は失敗する (`onError` と `onClose` が続けて呼ばれ得る)。
解放が先行した場合はそれ以上購読も通知もリソース作成も行わず、接続で受け取った
session も閉じる。`start()` が失敗した場合は確保済みを解放し、終端 (`"closed"`) へ
進んでいなければ遷移前の state (`"created"` または `"stopped"`) に戻るため再試行できる。
解放が途中で失敗した場合も `"subscribing"` のまま取り残さない (ピア起点の close は
解放のあとに `"closed"` にするため、戻した state は上書きされる)。巻き戻しの遷移で
`onStateChange` が throw しても `onError` の通知と元のエラーは失われない。

### 統計情報

```typescript
interface MediaReceiverStats {
  audio: AudioReceiverStats | null;
  video: VideoReceiverStats | null;
  // 音声と映像の同期の推定値。片方しか購読していない、またはどちらかが壁時計の
  // TIMESTAMP を使えないときは null
  avSync: AvSyncStats | null;
}

interface AudioReceiverStats {
  framesReceived: number;
  bytesReceived: number;
}

interface VideoReceiverStats {
  framesReceived: number;
  keyFramesReceived: number;
  bytesReceived: number;
  // 復号中の Group より古い Group の Object と、重複・遅着の Object として捨てたフレーム数
  staleFramesDropped: number;
  // 参照するフレームが欠けているため、キーフレームを待つ間に捨てたフレーム数
  missingReferenceFramesDropped: number;
}

interface AvSyncStats {
  // 同期ずれの推定値 (ms)。映像の表示が音声より遅れていれば正。
  // 音声は予約した時刻、映像は write した時刻の実績から求める (実際に音が出るまでの
  // 出力遅延と、映像が表示されるまでの表示周期の遅れは含まない)。
  // どちらかの実績が 1 秒より古いときは null
  skewMs: number | null;
  // 表示の遅れ (ms)。TIMESTAMP から表示時刻までの差。基準が未確立なら null
  presentationDelayMs: number | null;
  // catalog から解決した目標遅延 (ms)。無い、または使えないときは null。
  // 実際に表示の遅れに使う値は、上限に収まらない分を切り下げた値になる
  targetLatencyMs: number | null;
  // 表示の遅れの上限に収まらず切り下げた分 (ms)
  targetLatencyLimitedMs: number;
  // AudioContext.getOutputTimestamp() を使えず currentTime で代用しているか
  audioClockFallback: boolean;
}
```

音声と映像の表示時刻は 1 つの式で決める。`LOC Timestamp` (Timescale が無ければ Unix epoch
マイクロ秒の壁時計) に、基準の遅れ (送受信の時計のずれと、経路と復号の最小遅延) と
`max(catalog の targetLatency, 揺らぎから求めた再生遅延)` を足した時刻が目標になる
(draft-ietf-moq-msf-01 Section 5.2.8 / Section 5.2.11)。同じ render group の track は
同じ `targetLatency` を持つため、同じ式を使えば音声と映像が揃う。`isLive` が false の
track の `targetLatency` は無視する (Section 5.2.8 の MUST)。`targetLatency` が無いときは
揺らぎから求めた遅れだけを使い、その場合も音声と映像で同じ値を使う。

`AudioStats` / `VideoStats` は送信側 (`MediaStats`) の型である。受信側は
`AudioReceiverStats` / `VideoReceiverStats` を使う。

受信した映像は Group の順序と欠落を見て、参照するフレームを復号済みの Object だけを
復号する。Object は順不同で届きうる (draft-ietf-moq-transport-21 Section 2.1) ため、
次の Group のキーフレームを復号した後に届いた前の Group の Object は復号せず
`staleFramesDropped` に数える。Group 内で Object ID が欠けた場合は、Prior Object ID Gap
(Section 10.9) が非存在を示す分を除き欠落として扱い、次のキーフレームまでの Object を
`missingReferenceFramesDropped` に数える。1 Group を複数の Subgroup に分ける publisher の
Object ID の飛びも欠落として扱う。

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
  - 受信側は、この Property が無い Object では Group 先頭 (Object ID 0) をキーフレームとして扱う
  - Object ID 0 が Group 先頭であることは draft-ietf-moq-msf-01 §6.2、同一 GOP のサンプルが同一 Group に置かれることは同 §4.1 が MUST で定める。Group 先頭が IDR であることは draft-ietf-moq-loc-04 §4.2 (Examples) に依拠する
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
