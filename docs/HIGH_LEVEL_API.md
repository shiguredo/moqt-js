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
    keyframeInterval?: number; // 秒。0 より大きい有限数。default: 2。無効値は reject
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
  // C4M のトークン (CAT、Token Type 0x01) なら、catalog の音声と映像の track に
  // authInfo を載せる (draft-ietf-moq-msf-01 §5.2.42)
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
`max(targetLatency, 揺らぎから求めた再生遅延)` を使うため、音声には NetEq と同じ規則で
求めた遅延 (観測が無い間は 80 ms) の下限がある。publisher は `targetLatency` が有限数で
あることと `renderGroup` が有限の整数であることを検証する (非有限値は JSON で null になり
購読側が復号できなくなる)。それ以外の範囲は呼び出し側の責任になる。節番号は
draft-ietf-moq-msf-01 由来であり、将来の draft 改版で変わる可能性がある。

`keyframeInterval` はキーフレームを送る間隔 (秒) である。0 より大きい有限数を指定し、
未指定時は 2 秒になる。判定はフレームの timestamp の差で行うため、フレーム数ではなく
時間で指定し、`framerate` を変えても実際の間隔は変わらない。`0` / 負値 / `NaN` /
`±Infinity` は `createMediaPublisher()` が reject する。

### コールバック

```typescript
interface MediaPublisherCallbacks {
  onStateChange?: (state: MediaPublisherState) => void;
  onError?: (error: Error) => void;
  onClose?: () => void;
}
```

### メソッド

| メソッド                                    | 説明                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `start(stream: MediaStream): Promise<void>` | MediaStream を渡して配信開始（`"created"` と `"stopped"` から呼べる。`"stopped"` は `stop()` 後の再開であり、解放した資源を作り直して再接続する。失敗時は確保済みを解放し、state は変えずに再試行できる。`"closed"` からは `cannot start in state` で拒否される。実行中に `close()` またはピア起点の close が重なった場合は `"closed"` を優先して失敗する。解放 (`close()` とピア起点の close / `stop()` の解放) が進行している間は `cannot start while closing` で拒否する） |
| `pause()`                                   | 配信一時停止（エンコード停止）                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `resume()`                                  | 配信再開                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `stop(): Promise<void>`                     | 配信停止（`"publishing"` と `"paused"` からのみ。`close()` と同じ解放を行い、`"stopped"` は再開可能であり終端ではない。`"stopped"` からの再 `stop()` は `cannot stop in state` で throw する。ピア起点の close の解放中は進行中の解放を共有して完了を待つ。解放の失敗時は state を変えず元のエラーを throw。`onClose` は通知しない。`close()` が解放と終端遷移を進めている間は `cannot stop while closing`）                                                                  |
| `requestKeyframe()`                         | キーフレームを即座に送信                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `close(): Promise<void>`                    | リソース解放（終端。どの状態からでも可能。解放してから `"closed"` にして `onClose` を通知する。`"closed"` での再 `close()` は早期 return するため `onClose` は 1 回だけ。進行中の解放（`stop()` / ピア起点の close）は共有して完了を待ち、その成否が結果になる。解放の失敗時は state と `onClose` を変えず元のエラーを throw する。ピア起点の close の通知も解放してから通知する）                                                                                            |
| `getStats(): MediaStats`                    | 送信側の統計情報取得                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `getCatalog(): Catalog \| null`             | 配信中に生成したカタログ取得                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

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
                         start(stream)
created / stopped ───────────────┬────────► publishing ───pause()───► paused
         ▲                       │          │       ▲                   │
         │  start() の失敗       │          │       └───resume()────────┘
         │                       │          │                           │
         └───────────────────────┘          │                           │
         └──── stop() ──────────────────────┴───────────────────────────┘

* ──close()──► closed (どの状態からでも可能。終端であり、以後の start() は拒否される)
```

`created` と `stopped` は同じ辺 (`start()`) を持つため 1 つにまとめている。`created / stopped`
の柱へ向かう辺は `start()` の失敗 (遷移前の state に戻る) と `stop()` の成功 (`"stopped"` に
なる) の 2 つであり、図では別の線で描いている。

`stop()` は `close()` と同じ解放を行い、state を `"stopped"` にする (`"paused"` からの
`stop()` も同じである)。`"stopped"` は終端ではなく再開可能であり、`start(stream)` で再び
配信を始められる。`"stopped"` からの `stop()` は `cannot stop in state` で拒否される。
`stop()` の成功時に `onClose` は通知しない (停止であり終端ではない)。

`close()` は終端であり、どの状態からでも呼べる。解放してから `"closed"` にして
`onClose` を通知する。`"closed"` での再 `close()` は早期 return するため、`onClose` は
1 回だけ通知される。解放の失敗時は state と `onClose` を変えず元のエラーを throw する。

ピア起点の close の通知では、解放してから `"closed"` と `onClose` を通知する (解放せずに
終端にすると `close()` の早期 return で解放経路が消え、session、フレームリーダー、
エンコーダー、`MediaStream` が残り、`stop()` も `start()` も拒否されて解放できなくなる)。
この経路で解放が失敗した場合は state を変えず `onError` で通知し、`close()` を呼べば
残りの解放を進められる。解放のあとに届く旧 session の close 通知 (新しい session を
確立したあとに届く旧 session の通知を含む) では state も `onClose` も変わらない。

解放は共有される。`stop()` またはピア起点の close の解放が進行中に `close()` を呼ぶと、
`close()` はその完了を待ってから `"closed"` へ進む。進行中の解放が失敗した場合は
`"closed"` にならず、`close()` も同じエラーを throw する (解放に相乗りした呼び出しも
失敗を検知できる)。逆に、進行中の解放に `stop()` が相乗りした場合は、解放のあとに
`stop()` が state を `"stopped"` にする。あとから解放を終えたピア起点の経路は state も
`onClose` も動かさない。`close()` を await せずに重ねて呼んだ場合も解放は 1 回であり、
`onStateChange` の `"closed"` と `onClose` は 1 回だけ通知される。`close()` が解放と
終端遷移を進めている間は `start()` / `stop()` を `cannot start while closing` /
`cannot stop while closing` で拒否する (解放中は state がまだ `"created"` などのため、
state だけでは重なりを判定できない)。

`start()` の実行中にピア起点の close または `close()` が重なった場合は `"closed"` が
優先され、`start()` は失敗する (`onError` と `onClose` が続けて呼ばれ得る)。解放が
先行した場合はそれ以上リソースを作らず、接続で受け取った session も閉じる。

### カタログの送り直し

`MediaPublisher` は catalog を配信の開始時に 1 度だけ送るのではなく、次の 2 つの契機で
新しい Group の先頭 Object として送り直す (draft-ietf-moq-msf-01 §5)。

- `FORWARD` が 0 から 1 になった時点。Relay は購読者が居ない間、upstream の購読を paused
  にしてよい (draft-ietf-moq-transport-22 §7.6 の MAY)。paused にするかは Relay の裁量で
  ある (§7.2)。paused の間は Publisher が Object を送らないため (§3.1.1)、配信の開始時に
  送った catalog は後から購読を始めた相手へ届かない
- catalog を送るたびに予約する 30 秒後の送り直し。値は `MAX_CACHE_DURATION` (この実装では
  1 時間) の半分を上限 30 秒で頭打ちにしたものであり、下限 1 秒と合わせて 1 秒以上 30 秒
  以下になる。Relay は `MAX_CACHE_DURATION` を過ぎた Object をキャッシュから配れないため
  (draft-ietf-moq-transport-22 §10.3)、配信の開始から時間が経った後に購読を始めた相手には
  この予約が catalog を届ける (draft-ietf-moq-msf-01 §5)

catalog の Group ID は送り直しのたびに +1 し、`stop()` → `start()` を跨いでも単調に
増える (draft-ietf-moq-msf-01 §6.1)。Object ID は Group の先頭の 0 に固定する (§6.2)。
送る payload はトラック構成が変わらない限り同じである。

`FORWARD` が 1 のまま 2 人目以降の購読者が接続した場合は状態が変化しないため送り直さない
(音声の `AUDIO_CONFIG` と映像の `VIDEO_CONFIG` の送り直しと同じ制約)。`pause()` は送り直しを
止めない (catalog を Relay のキャッシュに保つことが目的のため)。`FORWARD` が 0 の間は送信が
見送られるため Group ID を消費しない (予約は維持し、`FORWARD` が 1 になった時点で送り直す)。
送り直しを送るのは catalog の `PUBLISH` が `"active"` の間だけである。ピアが cancel して
`"closed"` になった場合は送り直しを止め、予約も残さない。送り直しの送信が失敗した場合は
`onError` で通知する。`stop()` / `close()` / ピア起点の close は送り直しの予約を取り消す。

送り直した catalog は購読側では新しい Group の完全な catalog として届くため、購読中の
`onCatalog` は送り直しのたびに (既定では 30 秒ごとに) 呼ばれる。catalog の内容が変わらない
間も同じである。送り直しでも同じ catalog instance を送るため、`generatedAt` (§5.1.2) は
配信の開始時に組み立てた時刻のままである。

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
  // 音声の TIMESTAMP を壁時計へ合わせるための観測。まだ音声を 1 つも読んでいなければ null
  timestampOffset: AudioTimestampOffsetStats | null;
}

interface AudioTimestampOffsetStats {
  // 直近に観測した「読み出した壁時計 - AudioData.timestamp」(ミリ秒)
  currentMs: number;
  // 観測した最小値と最大値 (ミリ秒)
  minMs: number;
  maxMs: number;
  // 直近 10 秒 / 60 秒の傾き (ミリ秒 / 秒)。一定なら 0、ドリフトなら 0 から離れる
  slope10sMsPerSecond: number | null;
  slope60sMsPerSecond: number | null;
  // TIMESTAMP に足している補正 (ミリ秒)
  appliedMs: number | null;
  // 観測した数
  samples: number;
}

interface VideoStats {
  framesSent: number;
  // エンコード能力を超えたため、または実行時エラーでエンコーダーが使えなくなったために
  // 破棄したフレーム数 (エンコーダーが閉じたときに読み取っていたフレームを含む。閉じた後は
  // 処理ループが終了するため、以後のフレームは読み取らず数えない。世代が変わった後に
  // 読んだフレームと encode が同期 throw したフレームは数えない。閉じたときに Worker へ
  // 送信済みで応答が返らなかったフレームは、framesSent とこの値のどちらにも含めない)
  droppedFrames: number;
  keyFramesSent: number;
  bytesSent: number;
  currentGroupId: number;
}
```

#### 音声の TIMESTAMP

音声の LOC TIMESTAMP (Timescale を載せない Unix epoch マイクロ秒) は、
`AudioData.timestamp` の刻み (サンプルの間隔) をそのまま使い、原点だけを配信側の壁時計へ
合わせて作る。マイクや Web Audio の `AudioData.timestamp` は `performance.now()` と同じ
時計ではなく、一定のずれのほかにドリフトや段差で動く。そのまま壁時計として
送ると、受信側は音声が数百 ms 遅れて届いたと解釈して音声の基準の遅れが動き、jitter buffer
の目標と映像の表示がそれに引きずられる。

原点は「読み出した壁時計 - `AudioData.timestamp`」である。この値は時計のずれと
「撮ってから読むまでの遅れ (0 以上)」の和であり、その最小値が時計のずれに最小の遅れを
足した推定になる。配信側は直近 2 秒の最小値を補正として TIMESTAMP に足し、音声の時計が
飛んだとみなせる動き (直近 0.5 秒の最小値が適用中の補正より 200 ms 以上大きい状態が
続く) では、古い観測を捨てて取り直す。

補正の推移は `getStats().audio.timestampOffset` で読める。一定なら傾きが 0、ドリフトなら
傾きが 0 から離れ、段差なら最小と最大の差が開く (devtools の Publisher 統計と
「Copy for LLM」にも出る)。

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
  // 初期 configure (SUBSCRIBE_OK の Track Property の VIDEO_CONFIG / AUDIO_CONFIG) の
  // 完了まで保留する Object の上限 (件数 / payload と properties の長さの合計)。
  // 未指定のフィールドは既定値 (512 件 / 1 MiB) で補完される。0 以下で上限なし
  pendingObjectQueue?: Partial<PendingObjectQueueOptions>;
}
```

MediaPublisherOptions も `audio` / `video` / `useWorker` / `serverCertificateHashes` に加えて
`authorizationToken` と `pendingSubgroup` を持つ (購読側と同じ形)。

初期 configure (`SUBSCRIBE_OK` の Track Property の `VIDEO_CONFIG` / `AUDIO_CONFIG`) を反映する
までの間に届いた Object は、到着順に保留してから復号する (draft-ietf-moq-loc-04 Table 1 /
§2.3.2.1 / §2.3.3.1)。保留は購読要求から初期 configure 完了までの短い区間に限られるが、
購読が確立しない異常時は区間が伸びるため、件数とバイト数の両方に上限を設ける。
バイト数の上限は payload と properties の長さの合計で数える (受信統計の `bytesReceived` と
同じ基準)。
上限を超えた Object は保留せず破棄し、`onError` で通知する。通知はキューごとに購読期間
あたり 1 回だけで、音声と映像が同時に溢れれば 1 購読期間に最大 2 回になる (再 start すると
新しい購読期間として再び通知される)。破棄した Object は受信統計に数えない。
音声と映像は別々のキューと上限を持ち、上限は `pendingObjectQueue` で変更できる。
`PendingObjectQueueOptions` (上限の型) と `DEFAULT_PENDING_OBJECT_QUEUE_OPTIONS` (既定値)
は `moqt-js` から import できる。

`authorizationToken` を省略した場合、接続先の MOQT URI の msf fragment に `c4m` があれば、
`connect()` がその値を復号して `SETUP` の `AUTHORIZATION TOKEN` (`0x03`) として送る
(draft-ietf-moq-msf-01 §11.1.1 / §11.4.3)。詳細は
[低レベル API](LOW_LEVEL_API.md) の「MSF URI Fragment の `c4m`」を参照すること。

`SETUP` に載せたトークンは、draft-ietf-moq-msf-01 §11.4.3 に従い次の制御メッセージへも付与する
(`SETUP` に載せていても免除されない)。

- `createMediaSubscriber` は catalog の `SUBSCRIBE` と `FETCH` に付与する
- catalog の `authInfo` (§5.2.42) を持つトラックの `SUBSCRIBE` に付与する。
  `getAuthorizationToken` を指定した場合はそちらが優先される
- `REQUEST_UPDATE` は `SUBSCRIBE` と同じトークンを `Subscriber` が保持して送る
- `createMediaPublisher` は catalog / 音声 / 映像の `PUBLISH` に付与する

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

| メソッド                           | 説明                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `start(): Promise<void>`           | 購読開始（`"created"` と `"stopped"` から呼べる。開始を取り消すには `close()` を使う。実行中にピア起点の close または `close()` が重なると `"closed"` を優先して失敗する。失敗時は解放して遷移前の state に戻る。解放 (`close()` とピア起点の close / `stop()` の解放) が進行している間は `cannot start while closing` で拒否する）                                         |
| `stop(): Promise<void>`            | 購読停止（`"active"` からのみ。`"subscribing"` を含むそれ以外は `cannot stop in state` で throw。解放して `"stopped"` にする。ピア起点の close の解放中は進行中の解放を共有して完了を待つ。解放の失敗時は state と `onClose` を変えず元のエラーを throw。`close()` が解放と終端遷移を進めている間は `cannot stop while closing`）                                           |
| `requestKeyframe(): Promise<void>` | キーフレーム要求（REQUEST_UPDATE 送信）                                                                                                                                                                                                                                                                                                                                     |
| `close(): Promise<void>`           | リソース解放（終端。どの状態からでも可能。開始の取り消しもこれを使う。呼ぶと解放の完了を待たずに閉じたものとして扱い、解放の await 中に届いた Object は統計に数えず復号にも渡さない。進行中の解放（`stop()` / ピア起点の close）は共有して完了を待ち、その成否が結果になる。同時に呼んでも解放と通知は 1 回。解放の失敗時は state と `onClose` を変えず元のエラーを throw） |
| `getStats(): MediaReceiverStats`   | 受信側の統計情報取得                                                                                                                                                                                                                                                                                                                                                        |

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

`close()` を呼ぶと、解放の完了を待たずにその時点から閉じたものとして扱う (`state` が
`"closed"` になるのは解放の完了後であり、解放の await 中は `"active"` などのままである)。
解放の await 中に届いた Object は統計に数えず復号にも渡さず、完了していない再構成
(`VIDEO_CONFIG` / `AUDIO_CONFIG` の変化による configure) が解放の後に成功しても、
復号器の構成済み状態と適用済みの config は戻らない (解放が成功して終端へ進んだ場合、
`close()` で閉じた購読が再び復号を始めることはない)。解放に伴って中止された configure の
失敗は `onError` に通知しない。`stop()` とピア起点の close の
解放中は閉じたものとして扱わないため、復号器の参照を切るまでは、その間に届いた Object を
従来どおり統計に数えて復号へ渡す。`close()` が返す Promise は
解放の完了まで解決しない。解放が失敗して `"closed"` へ進まなかった場合も閉じたままで
あるため、`state` が `"active"` のままなら `stop()` を呼んでから `start()` で作り直す
(`state` が元から `"created"` / `"stopped"` であれば `start()` だけでよい)。`state` が
`"subscribing"` のまま失敗した場合は `start()` も `stop()` も拒否されるため、`close()` を
呼び直して残りの解放と終端遷移を進める。

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
  // 再生の統計。値は購読をやり直しても消えない (今の遅れだけが 0 に戻る)
  // 目標を使わない並べ方で、基準を取り直した回数
  // (鳴らす時刻を過ぎて届いた音、timestamp が大きく飛んだ音)
  playoutRebases: number;
  // 並べすぎの音と、目標から離れすぎて到着も途切れていた音として捨てた数
  playoutDrops: number;
  // 欠落した区間や、時間軸の目標の遅延が増えたときに補間した回数
  playoutConcealments: number;
  // 波形の周期を使って詰めた合計 (ms)
  playoutCompressedMs: number;
  // 補間した合計 (ms)
  playoutConcealedMs: number;
  // 目標を守る並べ方で最後に並べた音の遅れ (ms)。基準を消すと 0 に戻る
  playoutLatenessMs: number;
  // 音声の再生の観測値。鳴るはずの時刻 (再生予定時刻)・届いた時刻・鳴り始める時刻と、
  // 予定に対する余裕の分布 (直近 10 秒の p50 / p95 / max)、鳴らなかった量 (件数と ms) を
  // 理由ごとに出す (src/audioPlayoutTimingStats.ts)
  playoutTiming: AudioPlayoutTimingSnapshot;
}

// 音声の再生の観測値。時刻はすべて performance.now() と同じ軸のミリ秒であり、
// 別のマシンでは publisher の時計とのずれを含む
interface AudioPlayoutTimingSnapshot {
  // 直近に鳴らすと決めた音の、再生予定時刻 (LOC TIMESTAMP から時間軸が決めた時刻)・
  // 到着時刻 (復号の出力を受け取った時刻)・鳴り始める時刻。予定を決められなければ null
  lastTargetMs: number | null;
  lastArrivalMs: number | null;
  lastStartMs: number | null;
  // 直近に鳴らすと決めた音の、予定に対する余裕 (予定 - 到着。負なら届いた時点で予定を
  // 過ぎている)、到着から鳴り始めるまでの時間、予定からどれだけ過ぎて鳴るか
  lastSlackMs: number | null;
  lastStartDelayMs: number | null;
  lastLatenessMs: number | null;
  // 直近の窓 (10 秒) の分布 (ms)。予定を決められない音は slackMs / latenessMs に入れない
  slackMs: TimingSummary | null;
  startDelayMs: TimingSummary | null;
  latenessMs: TimingSummary | null;
  // 鳴らすと決めた音の数と長さの合計 (累積。arrivalPlannedFrames を内数に含み、長さは詰めた後)
  playedFrames: number;
  playedMs: number;
  // 時間軸の再生予定時刻を使えず、到着基準の計画で鳴らした音の数 (累積)。壁時計の
  // TIMESTAMP を持たない、jitter buffer が無効、トラックの基準が共有されていない
  // (TIMESTAMP が壁時計からずれている) ときに起きる。このとき startDelayMs は到着から
  // 100 ms を超えない (316 ms のような遅れを作らない)
  arrivalPlannedFrames: number;
  // 到着基準の計画も持たないまま鳴らした音の数 (累積)。呼び出し側が計画を渡していない
  // 取りこぼしであり、通常は 0
  unplannedFrames: number;
  // 鳴らさなかった音の数と長さの合計 (累積)。理由ごとの和に一致する
  missedFrames: number;
  missedMs: number;
  // 理由ごとの数と長さ (累積)。backlog (並べすぎて捨てた)、catchUp (relay の cache から
  // 追いつく途中で鳴らさなかった)、error (鳴らす準備に失敗した)、stopped (予約したまま
  // 再生を止めて切り捨てられた)。鳴り遅れでは捨てない (遅れたまま鳴らすか、音が途切れて
  // いたときだけ到着基準へ並べ直す)
  missedByReason: Record<AudioMissReason, { count: number; ms: number }>;
  // 直近に鳴らさなかった音 (古い順、最大 30 件)
  recentMisses: AudioMissEvent[];
}

// 分布の要約 (ミリ秒)
interface TimingSummary {
  p50: number;
  p95: number;
  max: number;
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
  // 遅延の内訳。音声と映像の遅れがどこで生じているかを分けて見るために使う
  delays: PlaybackDelayBreakdown;
}

interface PlaybackTrackBreakdown {
  // 基準の遅れ (ms)。受信側と送信側の時計のずれと、経路と復号の最小遅延
  baseDelayMs: number | null;
  // jitter buffer の遅延 (ms)。自分の揺らぎから求めた値
  jitterDelayMs: number | null;
  // A/V 同期がこのトラックへ足した分 (ms)
  syncExtraDelayMs: number;
  // TIMESTAMP から表示時刻までの差 (ms)。このトラックが TIMESTAMP を使わない
  // (未観測、または基準がずれている) ときは null で、そのときは到着基準で再生される
  presentationDelayMs: number | null;
  // 表示の遅れの上限 (ms)。切り下げが起きているかはこの値との比較で分かる
  presentationDelayCapMs: number;
}

interface PlaybackDelayBreakdown {
  audio: PlaybackTrackBreakdown;
  video: PlaybackTrackBreakdown;
  // 基準の差「音声 - 映像」(ms)。A/V 同期はこの差を合わせる
  baseDifferenceMs: number | null;
  // 2 つのトラックを同じ時計として扱えているか
  sharingBases: boolean;
  // 扱えない理由。"unobserved" (未観測)、"difference" (差が上限を超えている)、
  // "drift" (差が動き続けている = TIMESTAMP が壁時計からずれている)、"none"
  unsharedReason: PlaybackUnsharedReason;
  // 基準の差の動き (ms/秒)。閾値 (baseDriftLimitMs) を超えるとずれとみなす
  baseDriftMsPerSecond: number | null;
  baseDriftLimitMs: number;
  presentationDelayCapMs: number;
}
```

音声と映像の表示時刻は 1 つの式で決める。`LOC Timestamp` (Timescale が無ければ Unix epoch
マイクロ秒の壁時計) に、基準の遅れ (送受信の時計のずれと、経路と復号の最小遅延) と
jitter buffer の遅れ (`catalog の targetLatency` を下限とする) を足した時刻が目標になる
(draft-ietf-moq-msf-01 Section 5.2.8 / Section 5.2.11)。`isLive` が false の track の
`targetLatency` は無視する (Section 5.2.8 の MUST)。

jitter buffer の遅れは音声と映像で別々に求める。音声は NetEq と同じ規則 (到着の遅れの
0.95 分位)、映像は揺らぎの百分位である。2 つの表示時刻の差 (A/V のずれ) は、差が 30 ms
未満の間はそのままにし、超えたときだけ先行する側の表示の遅れを「後行側 - 30 ms」まで
即座に上げて抑える。上げた分は毎秒 20 ms までで戻す。このため不感帯の中では映像の遅延は
音声の jitter buffer の遅延に引きずられず、A/V のずれは 30 ms 程度に収まる。

基準の差は「遅い側を待つ」ことでしか合わせられないため、2 つのトラックの基準を共有しない
場合がある。理由は `AvSyncStats.delays.unsharedReason` に出る。

- `difference`: 基準の差が表示の遅れの上限 (500 ms、またはキューが吸収できる長さ) を
  超えている。上限で切られる分は合わせられない
- `drift`: 基準の差が動き続けている (10 秒で 50 ms の閾値)。これは経路の遅れではなく、
  片方の TIMESTAMP が壁時計からずれていくこと (音声のドリフトなど) を意味する。合わせると
  もう片方 (ここでは映像) の表示の遅れが上限まで伸びて戻せなくなるため、合わせるのを
  やめ、既に足した分も戻す。ずれた側は TIMESTAMP を使わず到着基準で再生する
- `hold`: 直前に共有をやめた判定を保持している。閾値は「表示の遅れの上限 - そのトラックの
  遅延」で決まるため jitter buffer の目標遅延で動き、差が変わらなくても共有と解除を
  往復し得る。往復のたびに足した分を戻して (フレームを捨てる) すぐ足し直す (表示が
  止まる) ため、`PLAYOUT_BASE_UNSHARED_HOLD_MS` の間は戻さない

基準を共有できない側が音声のときは、同期の制御を止めず、映像だけを音声の到着基準の時刻へ
合わせる。音声の TIMESTAMP が信用できなくても、音声の並べ方は分かっているためである。

- 音声は「到着 + 到着基準の再生の遅れ」で鳴る (`AUDIO_PLAYOUT_ARRIVAL_DELAY_SECONDS` = 100 ms
  を上限とし、下限は 80 ms)。この値へ映像の到着からの遅れ (jitter buffer の遅延) を
  合わせる
- 足すのは映像だけである。音声を遅らせると到着から鳴るまでの時間がその分だけ増える。
  映像が音声より遅いときは戻さない (音声を遅らせないと合わせられないため、その分は
  A/V のずれとして残す)
- 足す量は `PLAYOUT_MAX_COMPENSATED_DIFFERENCE_MS` (100 ms) までとし、足すのは即座、
  戻すのは毎秒 20 ms までにする (共有できる場合と同じ規則)
- 音声と映像の到着が同じ時刻であることは前提にする (同じ publisher・同じ経路の
  2 つのトラック)。実測では、この合わせを止めていたために音声が 195 ms、映像が 98 ms で
  100 ms のずれが残っていた

合わせる量は常に `PLAYOUT_MAX_COMPENSATED_DIFFERENCE_MS` (100 ms) までにする。時計のずれの
証拠 (`drift`) を見たかどうかには依らない。同じ publisher・同じ経路の 2 つのトラックで
最小遅延がそれ以上違うことはなく、超える分は時計のずれであることが多いためである。証拠を
見る前に上限を掛けないと、音声の TIMESTAMP が 600 ms 段差でずれ、その段差を揺らぎとして
学習した音声の遅延 (jitter buffer の目標で 700 ms) へ映像を合わせて 600 ms 足し、映像の
表示待ちが 500 ms のまま数十秒戻らなくなる (実測)。上限を掛けることで、映像の表示待ちは
本来の表示の遅れ (100 ms 程度) に上限までを足した値に留まる。合わせない分は A/V のずれと
して残る (音声の基準が 313 ms・映像が 13 ms の実測では、映像へ 378 ms を足して表示の遅延が
483 ms になっていた。上限を掛けると表示の遅延は約 175 ms、実時間の A/V のずれは約 38 ms
になる)

どちらの場合も、2 つのトラックはそれぞれの到着と jitter buffer の遅れで並ぶ。A/V のずれは
基準の差ではなく、2 つの遅れの差 (数十 ms) になる。`delays` はこの判断に使った内訳
(基準の遅れ・jitter buffer の遅延・足した分・共有できているか・差の動き) をそのまま出す
ため、音声と映像の遅れを比べて改善するときに使える。

`AudioStats` / `VideoStats` は送信側 (`MediaStats`) の型である。受信側は
`AudioReceiverStats` / `VideoReceiverStats` を使う。

`AudioReceiverStats.playoutTiming` は、音声が「鳴るはずだった時刻」と「実際に鳴り始める
時刻」の観測値である。受信した音声の再生予定時刻は LOC の TIMESTAMP から `PlaybackTimeline`
が決め、到着時刻は復号の出力を受け取った時刻、鳴り始める時刻は `AudioContext` の時計へ
予約した時刻を `AudioClockBridge` で `performance.now()` の軸へ換算した値である
(音声出力の遅延は含まない)。予定に対する余裕 (`slackMs` の分布) が負であれば、届いた時点で
すでに予定を過ぎており、その音は間に合っていない。

`arrivalPlannedFrames` は、時間軸の再生予定時刻を使えず、到着基準の計画で鳴らした音の数で
ある。使えないのは壁時計の TIMESTAMP を持たない、jitter buffer が無効、トラックの基準が
共有されていない (TIMESTAMP が壁時計からずれている) ときである。このときの再生の遅れは
到着から 100 ms 以下 (`AUDIO_PLAYOUT_ARRIVAL_DELAY_SECONDS`) に抑える。共有の時間軸が学習
した再生の遅れは、ずれている TIMESTAMP を揺らぎとして学習した値 (実測で 316〜500 ms) に
なるためである。`unplannedFrames` は、到着基準の計画も持たないまま鳴らした音であり、
通常は 0 になる。

この遅れは「実際に鳴るまで」の時間である。`AudioContext` の時計 (`currentTime`) は、既に
出力のバッファへ積まれた分だけ実際に鳴る位置より先に進む。到着基準の目標を `currentTime`
から数えると、実際に鳴るのは「到着 + 100 ms + バッファの分」になる (実測では
`startDelayMs` が 100 ms の目標に対して 195.5 ms になり、A/V のずれが約 100 ms 残っていた)。
音声の `AudioData` を復号した時刻は `AudioClockBridge` で `AudioContext` の秒へ換算し、
その位置を到着の基準にして「到着 + 遅れに鳴る」時刻を求める。`AudioContext` の対応付けが
まだ無いときは `currentTime` と同じ値を使う (この場合も従来と同じ並びになる)。

予定から離れすぎて届いた音は捨てない。鳴らすと語尾が切れるためである。到着は乱れていない
のに予定だけが過去にあるとき、ずれているのは予定の方 (TIMESTAMP が壁時計からずれている)
であり、音は遅れていない。音がまだ鳴っている (キューが空でない) 間は到着基準へ並べ直さず、
前の音の終わりに繋げて遅れたまま鳴らす。並べ直す (媒体時刻を跳ばす) のは、直前の音が既に
鳴り終わっているなど、音が本当に途切れていたときだけである。並べ直したときは到着から
`AUDIO_PLAYOUT_ARRIVAL_DELAY_SECONDS` (100 ms) だけ遅らせる。音が途切れていないときに
予約できる最も早い時刻へずらすだけの場合は、ずらす幅が `AUDIO_PLAYOUT_RESYNC_MIN_JUMP_SECONDS`
(10 ms) 未満なら並べ直しとして数えない (媒体時刻が跳ばないため)。

`missedFrames` / `missedMs` は、鳴らすと決めたのに鳴らなかった音の数と長さである。
`playoutDrops` が件数だけを数えるのに対し、こちらは理由 (`missedByReason`) と長さ、
直近の一覧 (`recentMisses`) を持つ。鳴り遅れでは捨てないため、鳴らなかった理由は
「並べすぎ (backlog)」「追いつきの途中 (catchUp)」「鳴らす準備の失敗 (error)」
「再生の停止 (stopped)」の 4 つである。

`framesReceived` / `bytesReceived` は復号器へ渡す判定まで進んだ Object を数える
(`bytesReceived` は payload と properties の長さの合計)。映像は統計の加算が復号順の判定より
前にあるため、Group の順序と欠落で復号しないと決めた Object も数え、理由別に
`staleFramesDropped` / `missingReferenceFramesDropped` へ別途加算する。初期 configure の完了まで
保留している Object は保留中の間は数えず、解放後は他の Object と同じ扱いで数える。
保留キューの上限 (`pendingObjectQueue`) を超えて破棄した Object は数えない。

受信した映像は Group の順序と欠落を見て、参照するフレームを復号済みの Object だけを
復号する。Object は順不同で届きうる (draft-ietf-moq-transport-22 Section 2.1) ため、
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

`authorizationToken` が C4M のトークン (CAT、Token Type 0x01) のとき、配信側は catalog の
音声と映像の track に `"authInfo": {"cat": "%c4m%"}` を載せる。draft-ietf-moq-msf-01
§5.2.42 / §11.4.1 は、視聴側が catalog の `authInfo` を見て、その track の認可にトークンが
要るかを決めるとしている。載せないと、視聴側はトークンを付けずに SUBSCRIBE を送る。

- `cat` は §5.2.42 Table 7 の CAT のスキーム名である
- `%c4m%` は §11.1.1 の予約パラメータ `c4m` を指す変数参照 (§5.4 / §5.2.43) であり、
  視聴側は catalog を得た URI の fragment の `c4m` で置換できる
  (`resolveCatalogVariables`)。トークンそのものは catalog に載せない
- CAT 以外のトークンや、トークンが無いときは載せない

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
購読側 (`createMediaSubscriber`) は config の変化を検知した Object を復号せず、
再構成が完了した後のキーフレームから復号を始める。

高レベル API は H.264 / H.265 を annexb 形式で設定するため、Chromium のエンコーダーは
description を返さない (parameter sets は bitstream に含まれる)。VP8 / VP9 / AV1 は
description を使わないため、この送り直しは canonical 形式 (avc / hev1) の description が
届く設定・実装で働く。

paused でないまま購読者が接続した場合は変化が起きないため送り直されず、
Relay のキャッシュに依存する。購読者がいない間に Relay が購読を paused にするかは
裁量である (draft-ietf-moq-transport-22 §7.2 Paused Subscription Handling)。
stop 後に再開した場合は新しいセッションとエンコーダーになるため、保持していた
`VIDEO_CONFIG` / `AUDIO_CONFIG` と送り直し要求は破棄し、新しいエンコーダーの
description を改めて送る。

### groupId / objectId 管理

- Audio: フレームごとに新しい groupId を開始、objectId は常に 0 (draft-ietf-moq-loc-04 §4.1)
- Video: キーフレームで新しい groupId を開始、objectId は Group 内でインクリメント (draft-ietf-moq-loc-04 §4.2)
- Catalog: 開始時に初期 groupId を割り当て、送り直しのたびに +1、objectId は常に 0 (draft-ietf-moq-msf-01 §5 / §6.1 / §6.2)

### Priority

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
