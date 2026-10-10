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

`AudioPlayoutSession` (音声の再生の組み立て) と `VideoPlayoutSession` (映像の表示の組み立て)
は高レベル API の下にある公開 API であり、`createMediaSubscriber` (ライブラリ) と
moqt-devtools が同じ実装を使う。詳細は「音声の再生の組み立て (AudioPlayoutSession)」と
「映像の表示の組み立て (VideoPlayoutSession)」を参照すること。

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
  // 音声が live から遅れたときの追いつき方。"drop" (既定) は遅れが上限を超えたら
  // 古いフレームを捨てて追いつく。"keep" は捨てずに順に送る (音楽や効果音のように、
  // 間引くと内容が壊れる用途)
  audioCatchUp?: "drop" | "keep";
}
```

`renderGroup` は同じ group の track を同時に描画する表明であり、音声と映像の両方を配信する
ときに意味を持つ (片方だけ配信するときは、同時に描画する相手が居ない)。`targetLatency` は
音声と映像で同じ値にするための宣言 (draft-ietf-moq-msf-01 §5.2.8 の MUST) であり、片方だけ
配信するときも購読側の表示の遅れの下限として使われる。0 ms を宣言しても、購読側は
`max(targetLatency, 揺らぎから求めた再生遅延)` を使うため、音声には NetEq と同じ規則で
求めた遅延 (観測が無い間は 80 ms) の下限がある。受信側で実際に観測した遅れから目標を
増やすとき (閉ループ) は、宣言した `targetLatency` を上限にするため、指定より遅らせる
ことはない。publisher は `targetLatency` が有限数で
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
  // 遅れが上限を超えたときに古いフレームを捨てて live へ追いついた量
  catchUp: AudioPublishCatchUpStats | null;
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

interface AudioPublishCatchUpStats {
  // 使っている方針 ("drop" は遅れたら捨てて追いつく、"keep" は捨てない)
  policy: AudioPublishCatchUpPolicy;
  // 遅れが上限を超えたため符号化せずに捨てたフレームの数と、その音声の長さ (ミリ秒、累積)
  droppedFrames: number;
  droppedMs: number;
  // 直近に観測した、配信側が足した遅れ (ミリ秒)
  lagMs: number | null;
  // 健全時に観測した遅れ (床、ミリ秒)。下がる方向にだけ動く
  floorMs: number | null;
  // 観測した最大の遅れ (ミリ秒)
  maxLagMs: number | null;
  // 符号化へ渡したまま出力が返っていない音声の長さ (ミリ秒) とフレームの数
  pendingMs: number;
  pendingFrames: number;
  // 直近に読んだフレームの読み出しの遅れ (ミリ秒)
  readLagMs: number;
  // 送信キューへ入れたまま送信が終わっていない音声の長さ (ミリ秒) とフレームの数
  sendQueueMs: number;
  sendQueueFrames: number;
  // 直近に送信が終わったフレームの、撮ってから送信が終わるまでの遅れ (ミリ秒) と、その最大
  sendLagMs: number | null;
  maxSendLagMs: number | null;
  // いま追いつきのために捨てているかと、追いつきを始めた回数 (累積)
  catchingUp: boolean;
  catchUpStarts: number;
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
続く) では、古い観測を捨てて取り直す。読み出しの遅れが増えただけの動き (時計のずれとして
考えられる速さを超える上昇) では、その水準が 5 秒続くまで補正を動かさない。一瞬の遅れで
TIMESTAMP が動くと、受信側がこれを時計のずれとみなして基準の共有を 30 秒解除するためで
ある。ゆっくりしたドリフト (窓の最小値が動く) は従来どおり追従する。

補正の推移は `getStats().audio.timestampOffset` で読める。一定なら傾きが 0、ドリフトなら
傾きが 0 から離れ、段差なら最小と最大の差が開く (devtools の Publisher 統計と
「Copy for LLM」にも出る)。

#### 音声の追いつき

音声は、読み出したフレームを符号化の出力を待たずに投入する。符号化が実時間に追いつかなく
なると、投入したフレームはキューに溜まり、符号化の出力が返るまでの待ちが伸びる。映像は
`encodeQueueSize` が上限を超えたフレームを捨てて待ちを伸ばさない (`VideoStats.droppedFrames`)
が、音声には同じ仕組みが無く、キューに溜まった分は実時間と同じ速さでしかはけないため、
一度遅れると遅れが固定される。遅れは受信側の基準 (復号の出力 - 送られた TIMESTAMP) を
そのまま押し上げ、音声と映像の基準の差を開かせる。

`MediaPublisherOptions.audioCatchUp` で方針を選ぶ。既定は `"drop"` であり、配信側が足した
遅れ (読み出しの遅れ + 符号化のキューに溜まっている音声) が、健全時に観測した遅れ (床)
から 40 ms を超えたら、読んだフレームを符号化せずに捨てて live へ追いつく。40 ms は
音声の 2 パケット分であり、欠けた区間は Opus の concealment が埋めるため、遅れたまま
送り続けるより聴感は良い。上限は床からの増加で測るため、健全時の遅れが環境で変わっても
(遅い runner でも) 健全な状態で捨てることはない。床が 20 ms 未満のときは 60 ms を上限に
する。読み出しの遅れが上限を超えたフレームは、キューに溜まっていなくてもその場で捨てる。

捨て始めるのは、上限を超えた状態が続いたときだけである。上限を超えた状態が
`AUDIO_PUBLISH_CATCH_UP_CONFIRM_MS` (100 ms) 続いたか、符号化のキューが単独で上限を超えた
状態が `AUDIO_PUBLISH_CATCH_UP_QUEUE_CONFIRM_FRAMES` (2 フレーム) 続いたときに始める。
読み出しがまとめて行われると (メインスレッドが止まっている間に届いたフレームを、止まった
後に続けて読む)、読み出しの遅れが 1 フレームだけ上限を超えることがある。その場で始めると、
遅れが減らないまま開始と再開が負荷の周期ごとに往復して捨てた音だけが増える。やめた後は
`AUDIO_PUBLISH_CATCH_UP_COOLDOWN_MS` (1 秒) は、遅れだけを根拠にした開始をしない。キューが
単独で上限を超え続けている場合 (実時間に追いついていない証拠) は、待つと遅れが伸びるため
クールダウン中でも始める。

捨てるのをやめるのは、キューに溜まっている音声が 1 パケット (20 ms) 以下まで減ったときで
ある。上限を少し下回ったところで再開すると、キューに残った分がはけないまま次のフレームが
入り、捨てるかどうかが 1 フレームごとに往復して音声が送られなくなる。また、符号化器は
1 パケット分の入力を保持したまま出力を返すため、キューは 0 にはならない。

なお、`AudioEncoder` が出力する chunk の timestamp は、投入した `AudioData.timestamp` では
なく「符号化したサンプル数」から作る連続した値になる。フレームを捨てて投入に穴が空くと、
出力の timestamp は投入より古くなる。LOC TIMESTAMP は送るサンプルの取得時刻でなければ
ならないため、覆った最初の投入の timestamp を使う (devtools の Audio Level の参照も同じ)。

`"keep"` は捨てずに順に符号化して送る。音楽や効果音のように、間引くと内容が壊れる用途で
使う。キューに溜まった遅れは戻らないため、受信側の基準の遅れは増えたままになる。

配信側が足す遅れは、読み出し・符号化のキュー・送信のキューの 3 段に分けて読める。
`readLagMs` が読み出し、`pendingMs` / `pendingFrames` が符号化のキュー、`sendQueueMs` /
`sendQueueFrames` が送信のキュー (1 Object = 1 Group = 1 ストリームのため、ストリームの
生成と書き込みの待ちがここに出る) である。`sendLagMs` は撮ってから送信が終わるまでの遅れで、
経路へ出る直前の値になる。実測 (手元の再現) では、健全な状態で `sendLagMs` は 10〜20 ms、
`sendQueueMs` は 0〜20 ms であり、受信側の基準の遅れが伸びた区間でもこの 2 つは動かなかった
(遅れは受信側の復号と再生にあった)。`catchUp` の上限判定そのものは、読み出しの遅れと符号化の
キューの和で行う (送信のキューは捨てても減らないため、捨てる判断には使わない)。

捨てた量と観測した遅れは `getStats().audio.catchUp` で読める (devtools の Publisher 統計と
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
  // "drift" (差が動き続けている = TIMESTAMP が壁時計からずれている)、
  // "hold" (直前にやめた判定を保持している)、"none"
  unsharedReason: PlaybackUnsharedReason;
  // 基準の差の動き (ms/秒)。閾値 (baseDriftLimitMs) を超えるとずれとみなす
  baseDriftMsPerSecond: number | null;
  baseDriftLimitMs: number;
  // 保持を早く解除する条件 (解除のきっかけが去り、差が戻った状態) が続いている時間 (ms)。
  // 数えていなければ null。PLAYOUT_BASE_UNSHARED_RELEASE_MS に達すると保持を解除する
  baseUnsharedReturnMs: number | null;
  presentationDelayCapMs: number;
  // 音声の目標遅延を閉ループで決めた状態。目標が収束しているかと、その理由を読む
  audioDelayFeedback: AudioDelayFeedbackSnapshot;
}

interface AudioDelayFeedbackSnapshot {
  // 閉ループが決めた目標遅延 (ms)。実際に使う値は jitterTargetMs との大きい方
  targetMs: number;
  // 揺らぎだけから求めた目標遅延 (NetEq、ms)
  jitterTargetMs: number;
  // 実際に使っている目標遅延 (ms)。鳴らした結果をまだ観測していない間は jitterTargetMs
  appliedMs: number;
  // 直前に目標を動かした理由。"initial" (初期値)、"backlog" (並べすぎで捨てた)、
  // "lateness" (予定を過ぎて鳴った)、"settled" (遅れが許容の中に収まった)、
  // "waiting" (動かす条件がそろっていない)
  reason: AudioDelayFeedbackReason;
  // 明示設定 (catalog の targetLatency) の上限 (ms)。無ければ null
  ceilingMs: number | null;
  // 直前の制御で動かした量 (ms)。0 なら動かしていない
  lastChangeMs: number;
  // 目標を動かした回数
  adjustments: number;
  // 直近 (1 秒) の、予定を過ぎて鳴った量・到着から鳴り始めるまでの時間・予定に対する
  // 余裕の p50 (ms)。まだ鳴らしていなければ null
  latenessP50Ms: number | null;
  startDelayP50Ms: number | null;
  slackP50Ms: number | null;
}
```

音声と映像の表示時刻は 1 つの式で決める。`LOC Timestamp` (Timescale が無ければ Unix epoch
マイクロ秒の壁時計) に、基準の遅れ (送受信の時計のずれと、経路と復号の最小遅延) と
jitter buffer の遅れ (`catalog の targetLatency` を下限とする) を足した時刻が目標になる
(draft-ietf-moq-msf-01 Section 5.2.8 / Section 5.2.11)。`isLive` が false の track の
`targetLatency` は無視する (Section 5.2.8 の MUST)。

遅延の内訳 (`delays`) の各値の根拠 (何を測ってその値にしたか) と、どうなったら見直すかは
`docs/AV_SYNC_DECISIONS.md` が持つ。

jitter buffer の遅れは音声と映像で別々に求める。音声は NetEq と同じ規則 (到着の遅れの
0.95 分位) に加えて、**実際に鳴った結果から閉ループでも目標を決める**。NetEq の規則は
「直近で最も早く届いた音との差」しか見ないため、到着から鳴り始めるまでの経路 (復号・
予約・出力のバッファ・まとめて届いた山) の分だけストリーム全体が一様に遅れていることを
見つけられない。その分を、予定をどれだけ過ぎて鳴ったか (`latenessMs`) と並べすぎで捨てた
量 (`missedByReason.backlog`) から学ぶ。

- 遅れが続くなら目標を増やし、並べすぎで捨てたなら捨てた長さぶん増やす
- 遅れが許容 (10 ms) の中に収まり、捨てが無いなら目標を減らす (毎秒 10 ms)
- 目標を動かすのは毎秒 1 回までであり、1 回の増加は 40 ms までにする。判断には直近 1 秒の
  分布を使う (表示用の 10 秒の窓は、目標を増やした結果が現れるまでに数秒かかる)
- 目標は 80 ms から 300 ms の間に収める。観測が無い間は増減せず、NetEq の値をそのまま使う
- `catalog の targetLatency` を宣言したときは、その値を自動で決める目標の上限にする
  (NetEq が求めた遅れには掛けない。既存の揺らぎの吸収を変えないため)
- いま使っている目標とその理由は `AvSyncStats.delays.audioDelayFeedback` に出る。収束して
  いれば `reason` が `settled` と `lateness` の間を行き来し、`latenessP50Ms` が許容の近くに
  留まる

映像の遅れは揺らぎの百分位である。2 つの表示時刻の差 (A/V のずれ) は、差が 30 ms
未満の間はそのままにし、超えたときだけ先行する側の表示の遅れを「後行側 - 30 ms」まで
即座に上げて抑える。上げた分は毎秒 20 ms までで戻す。このため不感帯の中では映像の遅延は
音声の jitter buffer の遅延に引きずられず、A/V のずれは 30 ms 程度に収まる。

基準の差は「遅い側を待つ」ことでしか合わせられないため、2 つのトラックの基準を共有しない
場合がある。理由は `AvSyncStats.delays.unsharedReason` に出る。

- `difference`: 基準の差が表示の遅れの上限 (500 ms、またはキューが吸収できる長さ) を
  超えている。上限で切られる分は合わせられない
- `drift`: 基準の差が、動いていない水準から 50 ms を超えて離れたまま 6 秒続いている。これは
  経路の遅れではなく、片方の TIMESTAMP が壁時計からずれていくこと (音声のドリフトなど) を
  意味する。合わせるともう片方 (ここでは映像) の表示の遅れが上限まで伸びて戻せなくなるため、
  合わせるのをやめ、既に足した分も戻す。ずれた側は TIMESTAMP を使わず到着基準で再生する。
  離れた幅が元の水準へ戻れば (読み出しが一瞬遅れただけなど) 判定は消え、200 ms を超えて
  離れた動き (段差) は待たずに判定する。購読の直後の過渡 (relay の cache から届いた分を
  まとめて復号している間) は、差が落ち着くまで判定を始めない
- `hold`: 直前に共有をやめた判定を保持している。閾値は「表示の遅れの上限 - そのトラックの
  遅延」で決まるため jitter buffer の目標遅延で動き、差が変わらなくても共有と解除を
  往復し得る。往復のたびに足した分を戻して (フレームを捨てる) すぐ足し直す (表示が
  止まる) ため、`PLAYOUT_BASE_UNSHARED_HOLD_MS` の間は戻さない。ただし解除のきっかけに
  なった動きが去り、差が元の水準へ戻った状態 (動きの判定が消え、差が閾値の内側で動かず、
  きっかけが閾値の移動だけではないこと) が `PLAYOUT_BASE_UNSHARED_RELEASE_MS` 続いたら、
  往復の恐れが無いため保持を待たずに戻す。どこまで続いたかは
  `AvSyncStats.delays.baseUnsharedReturnMs` に出る

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
(音声の出力デバイスの遅延は含まない)。予定に対する余裕 (`slackMs` の分布) が負であれば、
届いた時点ですでに予定を過ぎており、その音は間に合っていない。

`latenessMs` / `startDelayMs` / `slackMs` の分布は、音声の目標遅延を決める閉ループにも
使う (`AvSyncStats.delays.audioDelayFeedback`)。鳴らす時刻は
`max(目標, 今 + 余裕, 直前の音の終わり)` で決まるため、目標が「今 + 余裕」(出力の
バッファの分だけ先) に届いていないと、どの音も予定を過ぎて鳴る。この遅れを
`latenessMs` が示し、閉ループが目標を増やす。詳細は上の jitter buffer の説明を参照。

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

## 音声の再生の組み立て (AudioPlayoutSession)

`AudioPlayoutSession` は、復号済みの音声 1 つを「鳴らす」までの組み立てを 1 か所にまとめた
公開 API である。`createMediaSubscriber` (ライブラリ) と moqt-devtools の音声の再生は
どちらもこれを使う。同じ組み立てを 2 か所に置くと、到着基準の遅れ・目標遅延の閉ループ・
計器の修正を毎回 2 か所へ入れることになり、片方だけを直すと挙動がずれるためである。

受け取るのは、復号した音 (`AudioData`) と、その音の TIMESTAMP の種類 (LOC の TIMESTAMP と
TIMESCALE から決める。draft-ietf-moq-loc-04 §2.3.1.1 / §2.3.1.2) である。渡すと次を行う。

- 共有の時間軸 (`PlaybackTimeline`) への到着の記録と、目標の表示時刻の決定
- `AudioPlayoutScheduler` での予約 (遅れて届いた音は波形を詰めて目標へ戻し、並べすぎは捨てる)
- 欠落した区間の補間 (直前に鳴らした音の末尾を伸ばす)
- 計器 (`AudioPlayoutTimingStats`) への記録 (鳴るはずの時刻・届いた時刻・鳴り始める時刻と、
  鳴らなかった量)
- 目標遅延の閉ループへの観測の引き渡し (`audioDelayFeedback` が true のとき)

Web Audio (`AudioContext` とその出力) は `AudioPlayoutOutput` として注入する。`AudioContext`
の時計と `performance.now()` の対応は `AudioClockBridge` が境界になり、このクラス自体は
ブラウザ API の無い環境でも記録用の最小オブジェクトで検証できる。

`timestampKind` は、復号へ渡したときに覚えた記録を復号の出力の `AudioData.timestamp` で
引いて決める。WebCodecs の `AudioDecoder` は出力の timestamp を入力と完全には一致させない
(実測: Opus、48 kHz、実リレーで 100 マイクロ秒だけ大きい)。完全一致で引くと、種類を失った
音がこの組み立てへ `none` として渡り、共有の時間軸へ記録されなくなる (音声の基準の遅れが
更新されず、A/V 同期が到着基準へ落ちる)。そのため、一致する記録が無いときは最も古い記録を
1 ms 以内のときだけ引く。一致が続かなかった後も引けるよう、1 ms より古くなった記録は捨てる。
引く処理そのものは `src/decodeInputTimestamps.ts` が持ち、ライブラリと devtools が共有する。

```typescript
import { AudioPlayoutSession, AudioPlayoutTimingStats, PlaybackTimeline } from "moqt-js";

// 時間軸と計器は呼び出し側が持つ (時間軸は映像と共有し、計器は統計として読む)
const timeline = new PlaybackTimeline({
  timeOriginMs: performance.timeOrigin,
  maxQueuedFrames: 8,
});
const timing = new AudioPlayoutTimingStats();
const session = new AudioPlayoutSession({ timing });

// 復号の出力ごとに呼ぶ (output は AudioContext と MediaStreamAudioDestinationNode)
const result = session.handleDecodedAudio({
  data: audioData,
  timestampKind: "wallClock",
  timeline,
  useTimeline: true,
  enforceTarget: true,
  output: { context, destination },
});
```

### オプション

```typescript
interface AudioPlayoutSessionOptions {
  // 鳴らした音と鳴らなかった音の記録の入れ先 (計器)
  timing: AudioPlayoutTimingStats;
  // 鳴らした結果 (予定をどれだけ過ぎたか、並べすぎで捨てた量) を、目標遅延の閉ループへ
  // 渡すか (default: true)。false のときも計器への記録は行う
  audioDelayFeedback?: boolean;
}
```

### handleDecodedAudio の依頼

```typescript
interface AudioPlayoutRequest {
  // 復号した音。所有権は呼び出し側に残る (この中では close() しない)
  data: AudioData;
  // 音の TIMESTAMP の種類。wallClock のときだけ目標の時刻を決める
  timestampKind: "none" | "wallClock" | "mediaTime";
  // 音声と映像で共有する表示時刻の時間軸
  timeline: PlaybackTimeline;
  // 時間軸を使って鳴らすか (jitter buffer が有効な購読のとき)。false のときは時間軸へ
  // 記録せず、到着基準で並べる
  useTimeline: boolean;
  // 目標の時刻を守るか (揃える相手がいるとき)。false のときは、鳴らす時刻を過ぎて届いた音は
  // 基準を取り直して鳴らす
  enforceTarget: boolean;
  // 鳴らす先。null のときは鳴らさず、時間軸への記録も計器への記録もしない
  output: AudioPlayoutOutput | null;
}

interface AudioPlayoutOutput {
  context: AudioPlayoutContext; // AudioContext の実物を渡せる
  destination: AudioNode;
}
```

### handleDecodedAudio の結果

```typescript
type AudioPlayoutResult =
  | { status: "played"; rebased: boolean }
  | { status: "dropped"; rebased: boolean; reason: "backlog" }
  | { status: "error"; rebased: boolean; error: Error }
  | { status: "skipped" };
```

`rebased` は、この音の予約で鳴らす時刻の基準を取り直したかである (`AudioPlayoutScheduler.rebases`
が増えたか)。`dropped` は並べすぎで捨てた音であり、計器には理由 (`backlog`) と長さを記録済みで
ある。`error` は鳴らす準備の途中で失敗した音であり、計器には「鳴らなかった」として記録済みで
ある (このクラスは throw せず、呼び出し側が `onError` やログへ流す)。`skipped` は鳴らす先が
無いときである。

### メソッド

- `handleDecodedAudio(request)` — 復号した音を鳴らす (上の 2 節)
- `reset()` — 予約の基準・時計の対応・直前の音を消す (`AudioContext` を作り直したとき)。
  統計の累積 (基準を取り直した回数・捨てた音・詰めた合計・補間した合計) は消さない
- `releaseAudioContext()` — 時計の対応と直前の音だけを消す (`AudioContext` を閉じた後始末)。
  予約の基準は統計の `playoutLatenessMs` が読むため残す
- `recordStopped()` — 予約した音のうち、まだ鳴っていない分を鳴らなかった音として計器へ
  記録する (`AudioContext` を閉じる直前。既に鳴り始めている音は残りの長さだけを数える)

`playout` (予約。基準を取り直した回数と捨てた音の数) と `clock` (`AudioContext` の時計と
`performance.now()` の対応。`usingFallback` を同期の推定に使う) は読み取り用に公開している。

`enforceTarget` が true でも目標の時刻を決められなかったときは到着基準になる。到着基準の遅れは、
到着した音が「まだ鳴っていない位置」から数える (「統計情報」の説明を参照)。moqt-devtools は
目標遅延の閉ループを使っていないため `audioDelayFeedback: false` を渡している。

---

## 映像の表示の組み立て (VideoPlayoutSession)

`VideoPlayoutSession` は、復号済みの映像フレーム 1 枚を「表示する」までの組み立てを 1 か所に
まとめた公開 API である。`createMediaSubscriber` (ライブラリ) と moqt-devtools の映像の表示は
どちらもこれを使う。同じ組み立てを 2 か所に置くと、表示の遅れ・あふれの扱い・計器の修正を毎回
2 か所へ入れることになり、片方だけを直すと挙動がずれるためである。

受け取るのは、復号したフレーム (`VideoFrame`) と、そのフレームの TIMESTAMP の種類 (LOC の
TIMESTAMP と TIMESCALE から決める。draft-ietf-moq-loc-04 §2.3.1.1 / §2.3.1.2) である。渡すと
次を行う。

- 共有の時間軸 (`PlaybackTimeline`) への到着の記録と、表示時刻の決定
- 表示待ちのキュー (`PlayoutBuffer`) への積み込みと、あふれた分の破棄
- 表示周期ごとの選択 (表示時刻を過ぎたフレームのうち最新の 1 枚を表示し、間に合わなかった
  分を捨てる)
- 表示の実績 (実際に表示した時刻 - TIMESTAMP) の時間軸への記録
- 計器 (`VideoPlayoutTiming`) への記録 (あふれて捨てた分と、間に合わなかった分)

表示の出し先は `VideoPlayoutOutput` として注入する。ライブラリは
`MediaStreamTrackGenerator` の writer、moqt-devtools は canvas へ出す。表示周期の予約
(`requestAnimationFrame`) も注入できるため、ブラウザ API の無い環境でも記録用の最小
オブジェクトで検証できる。

```typescript
import { PlaybackTimeline, VideoDecodeInputs, VideoPlayoutSession } from "moqt-js";

// 時間軸と対応表は呼び出し側が持つ (時間軸は音声と共有する)
const timeline = new PlaybackTimeline({
  timeOriginMs: performance.timeOrigin,
  maxQueuedFrames: 24,
});
const decodeInputs = new VideoDecodeInputs({
  maxTracked: 256,
  forgetOnDuplicate: false,
});
const session = new VideoPlayoutSession({
  timeline,
  decodeInputs,
  output: {
    isAvailable: () => writer !== null,
    present: (frame, presentationMs) => {
      // presentationMs に表示時刻が入る (表示時刻を決められないときは null)
      void writer?.write(frame);
      return true;
    },
  },
  pacing: { drainImmediately: true, framesPerDrain: Number.POSITIVE_INFINITY },
});

// 復号へ渡すときに、TIMESTAMP の種類と Object の位置を覚える
decodeInputs.remember(timestamp, {
  timestampKind: "wallClock",
  location: { group: obj.groupId, object: obj.objectId },
});

// 復号の出力ごとに呼ぶ
const input = decodeInputs.take(frame.timestamp);
session.handleDecodedFrame({
  frame,
  timestampKind: input?.timestampKind ?? "none",
  useTimeline: true,
});
```

### オプション

```typescript
interface VideoPlayoutSessionOptions {
  // 音声と映像で共有する表示時刻の時間軸
  timeline: PlaybackTimeline;
  // 表示すると決めたフレームの出し先
  output: VideoPlayoutOutput;
  // 復号へ渡したフレームの情報の対応表 (呼び出し側が持ち、購読ごとに clear() する)
  decodeInputs: VideoDecodeInputs;
  // 表示の周期の進め方 (下記)
  pacing: VideoPlayoutPacing;
  // 捨てたフレームの記録先 (計器)。映像の計器を持たないときは省略する
  timing?: VideoPlayoutTiming;
  // 表示待ちのキューの上限 (枚)。既定は JITTER_BUFFER_MAX_QUEUED_FRAMES (24)
  maxQueuedFrames?: number;
  // 表示の周期の予約と取り消し。既定は requestAnimationFrame / cancelAnimationFrame
  requestFrame?: (callback: () => void) => number;
  cancelFrame?: (handle: number) => void;
}
```

`pacing` は出し先によって変える。`drainImmediately` が true なら、フレームを積んだ時点で
表示時刻を過ぎているフレームを出す (ライブラリ。表示の間隔は `MediaStreamTrackGenerator` の
先のブラウザが TIMESTAMP から決める)。false なら表示周期まで待つ (moqt-devtools)。
`framesPerDrain` は 1 つの表示周期に出す枚数の上限であり、devtools は canvas へ直接描くため
1 にする (まとめて描くと、まとまって届いたフレームが早送りに見える)。

### VideoDecodeInputs

復号の出力 (`VideoFrame`) では Object の位置が分からないため、decoder へ渡したときの
TIMESTAMP で引けるように覚えておく対応表である。

```typescript
interface VideoDecodeInput {
  timestampKind: "none" | "wallClock" | "mediaTime";
  location: Location; // Group ID と Object ID
}

interface VideoDecodeInputsOptions {
  // 覚えておく上限 (件)。超えたら古い方から忘れる
  maxTracked: number;
  // 同じ TIMESTAMP の Object が重なったときに、その TIMESTAMP の分を忘れるか
  forgetOnDuplicate: boolean;
}
```

`remember(timestamp, input)` で覚え、`take(timestamp)` で 1 回だけ引ける (引くと忘れる)。
TIMESTAMP を持たない Object は覚えない (decoder へ 0 を渡すため、同じ TIMESTAMP の Object を
誤って対応づける)。`forgetOnDuplicate` は位置を使うかで決める。位置を relay の cache からの
追いつきの判定 (`CatchUpGate`) に使うときは true にして、重なった TIMESTAMP の分を忘れる
(どちらの位置か決められないため)。TIMESTAMP の種類だけを使うときは false にして、後から来た
種類で上書きする。

### handleDecodedFrame の依頼と結果

```typescript
interface VideoPlayoutRequest {
  // 復号したフレーム。所有権は呼び出し側に残る (表示すると出し先へ移る)
  frame: VideoFrame;
  // フレームの TIMESTAMP の種類。wallClock かつ時間軸を使うときだけ表示時刻を決める
  timestampKind: "none" | "wallClock" | "mediaTime";
  // 時間軸を使って表示時刻を決めるか (jitter buffer が有効な購読のとき)。false のときは
  // 時間軸へ記録せず、届いた順に表示する
  useTimeline: boolean;
}

interface VideoPlayoutOutput {
  // フレームを表示する。実際に表示したかを返す (false のときは同期の実績を記録しない)
  present(frame: VideoFrame, presentationMs: number | null): boolean;
  // 今フレームを出せるか (購読が終わった、書く先が無いときは false)
  isAvailable(): boolean;
}

interface VideoPlayoutTiming {
  // 表示待ちの上限を超えて捨てたフレーム
  recordQueueDrop(timestamp: number): void;
  // 表示時刻を過ぎて間に合わなかったフレーム
  recordLateDrop(timestamp: number, presentationMs: number): void;
}

type VideoPlayoutResult =
  { status: "queued"; wallClockTimestamp: number | null } | { status: "skipped" };
```

`queued` は表示待ちへ積んだ (表示時刻に使った壁時計の TIMESTAMP を返す。使わなかったときは
null)。`skipped` は出し先が無いためフレームを閉じた場合である。時間軸へ記録するのは、種類が
`wallClock` で `useTimeline` が true のときだけであり、それ以外は届いた順に表示する。

### メソッド

- `handleDecodedFrame(request)` — 復号したフレームを表示待ちへ積み、表示周期へ予約する
- `clear()` — 予約を取り消し、表示待ちのフレームと対応表を捨てる (購読の停止、時間軸と
  キューを作り直す直前)
- `inputs` — 対応表 (`VideoDecodeInputs`)。呼び出し側も `remember` に使う
- `playout` — 表示待ちのキュー (`PlayoutBuffer`)。統計が `playoutDelayMs()` を読む

### 映像の受信の経路で使う公開 API

映像の受信から表示までの経路で、ライブラリと moqt-devtools が共有する残りの公開 API である。

- `PlaybackTimeline` — 音声と映像で共有する表示時刻の時間軸 (同期の推定と遅延の学習)
- `PlayoutBuffer` — 復号したフレームを表示時刻に合わせて選ぶキュー。
  `JITTER_BUFFER_MAX_QUEUED_FRAMES` と `MAX_PRESENTATION_LAG_MS` も公開する
- `VideoDecodeOrder` — Object を復号してよいかを Group の順序と参照するフレームの欠落から
  決める (`priorObjectIdGapOf` も公開する)
- `GroupSwitchGate` — 前の Group の Subgroup の stream が開いている間、次の Group の Object を
  保留する (draft-ietf-moq-transport-22 Section 2.1 の順不同の到着への対応)
- `CatchUpGate` — relay の cache から追いつく途中の Object を、SUBSCRIBE_OK の
  LARGEST_OBJECT を境界に選別する (draft-ietf-moq-transport-22 Section 9.20.17)

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
