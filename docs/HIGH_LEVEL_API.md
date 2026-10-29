# 高レベル API 仕様

## 概要

moqt-js の高レベル API は、MediaStream ベースの配信と視聴、復号済みフレームの再生を担う。

配信 (`createMediaPublisher`) と視聴 (`createMediaSubscriber`) は、WebCodecs の
エンコード / デコード、Worker 処理、LOC コンテナを内部で隠蔽し、シンプルなファクトリー関数で
MOQT メディアの配信と視聴を実現する。

再生 (`createMediaPlayout`) は、呼び出し側が復号した音声と映像を受け取り、共有の時間軸、
音声の予約、映像の表示、A/V 同期、計器をまとめる。復号 (WebCodecs) と Worker 処理、
受信、購読の管理は呼び出し側が持つ。

## API 階層

```
┌──────────────────────────────────────────────────────────────┐
│ 高レベル API                                                 │
│                                                              │
│ createMediaPublisher(url, options)   ← 配信                  │
│ createMediaSubscriber(url, options)  ← 視聴                  │
│ createMediaPlayout(options)          ← 再生                  │
│                                                              │
│ 用途: 配信、視聴、再生                                       │
│ 配信と視聴: Worker + WebCodecs + LOC を隠蔽                  │
│ 再生: 時間軸、音声の予約、映像の表示、計器を隠蔽             │
├──────────────────────────────────────────────────────────────┤
│ 低レベル API (MoqtObject)                                    │
│                                                              │
│ connect() → session.publish() / session.subscribe()          │
│ publisher.sendObject() / subscriber.object callback          │
│                                                              │
│ 用途: MOQT プロトコル直接操作、メディア以外のデータ配信      │
└──────────────────────────────────────────────────────────────┘
```

再生の公開 API は、復号済みの音声と映像を再生する入口 `createMediaPlayout` の 1 本である。
使い方は「再生の入口 (MediaPlayout)」を、内部の組み立ては「内部実装」の「再生の組み立て」を
参照すること。

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
    // AAC はブラウザのエンコーダーが対応するサンプルレート (44100 / 48000 Hz) と
    // ビットレートの下限を持つ。範囲外の設定では start() が
    // 「audio encoder does not support the captured format: ...」で失敗する
    // (対応の申告だけでは足りないため、開始前に無音を 1 チャンク実際に符号化して確かめる)。
    // 実測: Chrome 155 (macOS) の AAC は 48 kHz ステレオで 64000 bps を符号化できず、
    // 96000 bps では成功した (ビットレートの可否は単調ではない)
    bitrate: number;
    // 音声の取り出し経路へ要求する値。Catalog の samplerate / channelConfig と
    // AudioEncoder の sampleRate / numberOfChannels には、経路が実際に流す値を使う
    sampleRate?: number; // default: 48000
    channels?: number; // default: 2
    // 音声 Object の送り方 (draft-ietf-moq-transport-22 §11)。default: "datagram"
    // "datagram": Datagram で送る。QUIC 上の WebTransport では再送されず、経路の欠落が
    // そのまま音の欠落になる (HTTP/2 上の WebTransport では datagram も再送される。§6.2)。
    // サイズが上限を超えた Object は明示通知なく drop される (§11.2)。実測で使った 64 kbps / 20 ms
    // では上限に達しないが、ビットレートや properties が大きい場合は落ち得る。サイズ上限の
    // 事前検査は未実装である。既定の冗長度は 1 であり、損失に備えるには redundancy を
    // 2 以上にする。
    // reliability が "reliable-only" のセッションでは datagram が reliable and ordered に
    // なり「再送されない経路で送る」意味が変わるため、start() がエラーになる (黙って戻さない。
    // 省略時も同じ。ただし音声トラックを渡していない場合は拒否しない (catalog の宣言だけが
    // 残る既知の穴は別に扱う)。reliability が undefined の場合は、ブラウザが
    // WebTransport.reliability を公開していない場合であり、datagram を送れるものとして扱う。
    // Subgroup で送るには "subgroup" を明示する。
    // 送信の完了を待つ戻り値が無いため、送信のキューの計器
    // (AudioStats.catchUp.sendQueueMs / sendQueueFrames) は 0 のままになる
    delivery?: "subgroup" | "datagram";
    // 音声 Object を 1 つにつき何回送るか (1〜3 の整数)。default: 1
    // n 回送ると、datagram で全ての copy が落ちる確率が経路の損失率の n 乗になる。受信側は
    // 同じ識別子 (groupId と objectId) の 2 回目以降を捨てるため、同じ音が重なって鳴る
    // ことはない。代わりに音声の帯域と datagram の数が n 倍になる。delivery が "subgroup"
    // のときは Data Stream が FIN で閉じる限り再送されるため (RESET では欠落し得る)、
    // 2 以上を指定できない (冗長化は datagram の
    // 送信経路でしか実装しておらず、黙って無視せず start() がエラーにする)。1〜3 の整数
    // 以外も start() がエラーにする
    //
    // 実測 (実リレー、経路の損失を注入): 鳴った割合は 5 % で 94.5 % → 99.4 % (2 回)、
    // 10 % で 89.3 % → 96.9 % (2 回)、20 % で 77.6 % → 96.3 % (2 回) → 99.4 % (3 回)。
    // 損失の無い経路では品質が変わらない (欠落 0、飛ばし 0)
    redundancy?: number;
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
配信するときも同じフィールドを宣言できる。音声だけを再生するときの実装は到着基準の
50 ms の予算を優先する。A/V と映像の再生では下限として使われ、0 ms を宣言しても、購読側は
`max(targetLatency, 揺らぎから求めた再生遅延)` を使うため、音声には下限 (実リレーの実測で
決めた 50 ms) がある。音声の自動予算は直近の到着の揺らぎと出力時計の先行量から
50〜100 ms に決める。`targetLatency` はこの予算と別の明示下限であり、経路の遅れや同期の
補償を含めた実遅延の上限を保証する値ではない。publisher は `targetLatency` が有限数で
あることと `renderGroup` が有限の整数であることを検証する (非有限値は JSON で null になり
購読側が復号できなくなる)。それ以外の範囲は呼び出し側の責任になる。節番号は
draft-ietf-moq-msf-01 由来であり、将来の draft 改版で変わる可能性がある。

`keyframeInterval` はキーフレームを送る間隔 (秒) である。0 より大きい有限数を指定し、
未指定時は 2 秒になる。判定はフレームの timestamp の差で行うため、フレーム数ではなく
時間で指定し、`framerate` を変えても実際の間隔は変わらない。`0` / 負値 / `NaN` /
`±Infinity` は `createMediaPublisher()` が reject する。

`audio` / `video` を指定した場合、そのトラックを含む `MediaStream` を `start()` に渡すこと。
含まれないトラックは catalog に宣言されるが Object は送られない (購読側は待ち続ける)。

音声の `sampleRate` と `channels` は、音声の取り出し経路へ渡す要求である。Catalog の
`samplerate` / `channelConfig` と `AudioEncoder` の `sampleRate` / `numberOfChannels`
には、要求した値そのものではなく、経路が実際に流す値を使う。`samplerate` と
`channelConfig` は draft-ietf-moq-msf-01 §5.2.28 / §5.2.29 が audio codec の track に
伴わせる MUST を定める (草案の改訂で節番号と規定が変わる可能性がある)。
`MediaStreamTrackProcessor` を持つブラウザ (Chromium 系) はマイクの `AudioData` を
変換せずに流すため、マイクの形式が要求と違えば経路の値が使われる (マイクがモノラルなら
`1` になる)。Web Audio 経路 (Safari / Firefox) は `AudioContext` のサンプルレートと
要求したチャンネル数になる。要求した値のままエンコーダーを構成すると、`AudioData` の
形式と食い違い、Chromium の `AudioEncoder` がリサンプルもチャンネル変換もせずエラーに
して音声が止まる (Chromium の実装に依存する挙動であり、将来変わり得る)。`start()` は
catalog を publish する前に `AudioEncoder.isConfigSupported()` で符号化の対応を確かめ、
非対応なら configure も catalog の送信もせずにエラーになる (エラーには `codec` と
`sampleRate` と `channels` を含む)。音声トラックを含む `MediaStream` を渡した場合は、
取り出し経路 (MediaStreamTrackProcessor か Web Audio の AudioWorklet) が無いブラウザでも
同じく catalog を publish する前に失敗する。

### コールバック

```typescript
interface MediaPublisherCallbacks {
  onStateChange?: (state: MediaPublisherState) => void;
  onError?: (error: Error) => void;
  onClose?: () => void;
}
```

### メソッド

| メソッド                                    | 説明                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `start(stream: MediaStream): Promise<void>` | MediaStream を渡して配信開始（`"created"` と `"stopped"` から呼べる。`"stopped"` は `stop()` 後の再開であり、解放した資源を作り直して再接続する。失敗時は確保済みを解放し、state は変えずに再試行できる。`"closed"` からは `cannot start in state` で拒否される。実行中に `close()` またはピア起点の close が重なった場合は `"closed"` を優先して失敗する。解放 (`close()` とピア起点の close / `stop()` の解放) が進行している間は `cannot start while closing` で拒否する。音声トラックを渡している場合、音声の `delivery` が `"datagram"` (省略時の既定を含む) で、接続したセッションでは datagram が reliable and ordered になり「再送されない経路で送る」意味が変わる (`reliability` が `"reliable-only"`) 場合は拒否する。音声トラックが無い場合は拒否しない。Subgroup で送るには `"subgroup"` を明示する。音声の取り出した形式が `AudioEncoder` で符号化できない場合 (対応の申告だけでは実際に符号化できるかを保証しないため、無音を 1 チャンク実際に符号化して確かめる) と、音声トラックを渡したのに音声の取り出し経路が無い場合も、catalog を publish する前に失敗する。ピアが catalog の `PUBLISH` を cancel して catalog の Publisher が `"active"` でなくなった場合も、catalog を送らないまま media の Object を流さずに失敗する） |
| `pause()`                                   | 配信一時停止（エンコードを止め、開いている Subgroup を閉じる）。停止の末尾 flush の間は `cannot pause while stopping` で拒否する                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `resume()`                                  | 配信再開（次のフレームで新しい Group をキーフレームから始める）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `stop(): Promise<void>`                     | 配信停止（`"publishing"` と `"paused"` からのみ。停止の受付時に capture 済みの音声を flush して送り切ってから解放する（本文の「音声の末尾 flush」）。末尾を送ったときは配送方式（datagram / subgroup）にかかわらず PUBLISH_DONE の前に 50 ms の猶予を待つ。末尾 flush の間は `cannot stop while stopping` で二重停止を拒否する。`close()` と同じ解放を行い、`"stopped"` は再開可能であり終端ではない。`"stopped"` からの再 `stop()` は `cannot stop in state` で throw する。ピア起点の close の解放中は進行中の解放を共有して完了を待つ。解放の失敗時は state を変えず元のエラーを throw。`onClose` は通知しない。`close()` が解放と終端遷移を進めている間は `cannot stop while closing`）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `startNewGroup()`                           | 新しい Group を始める（次のフレームがキーフレームになる）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `close(): Promise<void>`                    | リソース解放（終端。どの状態からでも可能。音声の末尾 flush と PUBLISH_DONE 前の猶予を行ってから解放する。解放してから `"closed"` にして `onClose` を通知する。`"closed"` での再 `close()` は早期 return するため `onClose` は 1 回だけ。進行中の解放（`stop()` / ピア起点の close）は共有して完了を待ち、その成否が結果になる。解放の失敗時は state と `onClose` を変えず元のエラーを throw する。ピア起点の close の通知も解放してから通知する）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `getStats(): MediaStats`                    | 送信側の統計情報取得                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `getCatalog(): Catalog \| null`             | 配信中に生成したカタログ取得                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

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
`stop()` も同じである)。解放の前に、停止の受付時に capture 済みの音声を flush して
送り切る (datagram 配送では PUBLISH_DONE の前に 50 ms の猶予を待つ)。そのため `stop()` /
`close()` の完了は、通常の解放より 10〜60 ms (datagram では +50 ms) 遅くなる。`"stopped"` は終端ではなく再開可能であり、`start(stream)` で再び
配信を始められる。`"stopped"` からの `stop()` は `cannot stop in state` で拒否される。
`stop()` の成功時に `onClose` は通知しない (停止であり終端ではない)。

`pause()` はエンコードを止めるだけでなく、開いている Subgroup ストリームを閉じる
(draft-ietf-moq-transport-22 §11.3.2)。止めた時点で「その Subgroup に続く Object は無い」
ため FIN の MUST を満たせる。§11.3.2 は Group 境界での終了を SHOULD とするが、`pause()` は
境界を待てないため途中で閉じる。送らないと決めた Object は wire 上に存在せず
(Object ID は送信する時点で払い出す)、早期終了の MUST reset には当たらない。閉じないと、
次の Object を待つ購読側が `DATA_STREAM_TIMEOUT` (0x12) の対象になりうる (§12.2 は
STOP_SENDING か購読の終了を MAY とするが、moqt-rs の moq-sub はセッションごと閉じる)。
一度閉じた Group へは送れないため、`resume()` は次に encode するフレームをキーフレームに
して新しい Group から送り直す (`startNewGroup()` と同じ効果。音声は 1 フレーム 1 Group の
ため影響しない)。この挙動は後方互換性が無い (同じ Group の続きとして再開する挙動は
失われる)。

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
配信の開始時に `FORWARD` が 0 でも `start()` は成功し、その初期送信は完了として扱う
(開始時に確保した Group ID は送信に使われず、次の送り直しは +1 を使う)。
送り直しを送るのは catalog の `PUBLISH` が `"active"` の間だけである。ピアが cancel して
`"closed"` になった場合は送り直しを止め、予約も残さない。ただし配信の開始時の catalog を
送る時点で既に `"active"` でなければ、catalog の Object より先に media の Object を送らない
(draft-ietf-moq-msf-01 §11.2 の MUST) ため、`start()` は失敗する。送り直しの送信が失敗した
場合は `onError` で通知する。`stop()` / `close()` / ピア起点の close は送り直しの予約を
取り消す。

送り直した catalog は購読側では新しい Group の完全な catalog として届くため、購読中の
`onCatalog` は送り直しのたびに (既定では 30 秒ごとに) 呼ばれる。catalog の内容が変わらない
間も同じである。送り直しでも同じ catalog instance を送るため、`generatedAt` (§5.1.2) は
配信の開始時に組み立てた時刻のままである。

### 音声の末尾 flush (停止時)

`stop()` / `close()` は、止める前に読んだフレームと encoder の中身を送り切る。

1. 周期読み出しのループ自身に、取り込みキューに残っている分を読ませる
   (`AUDIO_TAIL_DRAIN_QUIET_MS` = 5 ms の静穏窓と `AUDIO_TAIL_DRAIN_MAX_FRAMES` = 4 ブロック
   の上限。停止の受付時に capture 済みの分だけを対象にし、停止後の新規キャプチャは
   含めない)
2. 1 フレーム先読みの保留分を encode する
3. `AudioEncoderWrapper.flush()` で encoder に残った出力を待つ (direct は WebCodecs の
   `AudioEncoder.flush`、worker は flush の出力を送ってから完了を返す順序)
4. 末尾の送信 (datagram の write / subgroup の送信) の完了を待つ
5. 末尾を送ったときは、配送方式 (datagram / subgroup) にかかわらず
   `AUDIO_TAIL_PUBLISH_DONE_GRACE_MS` = 50 ms 待ってから PUBLISH_DONE を送る
   (Object の stream / datagram と PUBLISH_DONE の control stream には順序保証が無いため)

この間は世代 (処理ループの有効性) を進めない。進めると末尾の出力が世代不一致で捨てられる。
flush と送信の完了を待つ上限は `AUDIO_TAIL_FLUSH_MAX_MS` = 150 ms で、超えた場合は
`tailFlushTimeoutCount` に残して解放へ進む (停止がハングしない)。これとは別に drain の
待ち (`AUDIO_TAIL_DRAIN_MAX_MS` + 静穏窓) が最大 55 ms あり、末尾を送ったときは 50 ms の
猶予が加わるため、停止の待ちは最大で約 255 ms、これに解放の時間が加わる。末尾を送らな
かったときは猶予が無い。通常は 50〜110 ms 程度である。`tailFlushTimeoutCount` は
drain、flush、送信のいずれかの待ちが打ち切られた停止の回数を数える。送ろうとした末尾の量は
`tailFlushedFrames` / `tailFlushedMs` (送信を試みた時点で数える)、送れなかった量は
`tailDroppedFrames` / `tailDroppedMs` で読める。

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
  // 停止時に encoder の flush で送ろうとした末尾の量 (累積。停止のたびに増える)。
  // 数は符号化の出力 (chunk) の数、長さは chunk の duration の合計 (ミリ秒)。
  // 送信を試みた時点で数えるため、write が失敗した分も含む。停止以外の経路 (pause) では
  // 増えない
  tailFlushedFrames: number;
  tailFlushedMs: number;
  // 停止時に取り込みキューから読み出したが、送れなかった入力の量 (累積)。
  // 数は取り込みブロック (10 ms) の数、長さは送信した chunk が覆わなかった範囲 (ミリ秒)。
  // 0 でも、drain の打ち切りで読まなかった取り込みキューと write の失敗は含まない
  tailDroppedFrames: number;
  tailDroppedMs: number;
  // 停止時の drain、flush、送信の待ちが上限で打ち切られた停止の回数 (累積)。
  // 1 つの停止で複数の待ちが打ち切られても 1 回と数える。1 以上なら、入力が途切れた、
  // worker が応答しなかったなどの打ち切りがあったことを示す
  tailFlushTimeoutCount: number;
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

音声の LOC TIMESTAMP (TIMESCALE を載せない Unix epoch マイクロ秒) は、
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
1 パケット分の入力を保持したまま出力を返すため、キューは 0 にはならない。記録そのものが
空になったときも再開する (追いつきの間は投入しないため符号化の出力も返らず、長さの集計が
ずれたまま残ると解除できず、音声が一切送られなくなる)。

なお、`AudioEncoder` が出力する chunk の timestamp は、投入した `AudioData.timestamp` では
なく「符号化したサンプル数」から作る連続した値になる。フレームを捨てて投入に穴が空くと、
出力の timestamp は投入より古くなる。LOC の TIMESTAMP は送るサンプルの取得時刻でなければ
ならないため、覆った最初の投入の timestamp を使う (devtools の Audio Level の参照も同じ)。

投入したフレームの同一性も順番で持つ。`AudioData.timestamp` は同じ値が続くことがあり、
timestamp を鍵にすると記録が上書きされて「キューに残っている長さ」だけが増える。増えた分は
出力が返っても減らないため、追いつきをやめる条件に永久に届かなくなる。

`"keep"` は捨てずに順に符号化して送る。音楽や効果音のように、間引くと内容が壊れる用途で
使う。キューに溜まった遅れは戻らないため、受信側の基準の遅れは増えたままになる。

配信側が足す遅れは、読み出し、符号化のキュー、送信のキューの 3 段に分けて読める。
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
  // 受信した Object を復号へ渡すまでの追加遅延 (ms)。default: 0
  // 2 秒以上も指定できる。上限は MAX_PRE_DECODE_DELAY_MS (30 秒)
  // 実際の表示遅延は、この値に経路、復号、jitter buffer の遅れが加わる。
  // catalog の targetLatency とは加算される
  preDecodeDelayMs?: number;
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

`preDecodeDelayMs` は、受信した Object を復号へ渡すまでの追加遅延 (ミリ秒) である。0 (既定) は
追加しない。2 秒以上も指定でき、上限は `MAX_PRE_DECODE_DELAY_MS` (30 秒) である。復号済みの
`VideoFrame` を保持するのではなく、圧縮済みの Object を復号前に保持するため、2 秒以上の遅延でも
フレームのメモリが遅延に比例して増えない。保持上限 (トラックごとに 64 MiB / 8,192 件) を
超えた場合は古い Object から破棄し、残りの Object の期限を保持できる時間まで前倒しする
(実際の遅延が指定値より短くなる)。上限超過は `onError` でメディアごとに購読期間あたり 1 回
通知する。

この値は受信バッファ (`dataStreamMaxBufferBytes` / `dataStreamMaxTotalBufferBytes`)、
`pendingSubgroup`、`pendingObjectQueue` とは独立している。受信バッファはメモリ保護の上限で
あり、値を大きくしても再生タイミングは変わらない。jitter buffer の遅延の上限
(`MAX_PLAYOUT_DELAY_MS` = 500 ms) も `preDecodeDelayMs` には掛からない。catalog の
`targetLatency` とは加算されるが、`targetLatency` 側は `MAX_PLAYOUT_DELAY_MS` と表示待ちの
キューの上限で切り下げられ、切り下げた分は `avSync.targetLatencyLimitedMs` に出る。実際の表示遅延は
`avSync.presentationDelayMs` などで確認すること。値は生成時に固定し、購読中の変更 API は
高レベル API には無い。moqt-devtools は共有の復号前の遅延の段 (`PreDecodeDelayStage` /
`SubscriberPreDecodeDelay`) を使い、接続中に Playback Delay を変更できる。詳細は
[再生遅延](PLAYOUT_DELAY.md) を参照すること。

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
  // 購読の失敗。低レベル API の error とは異なり、エラーを示す Status Code の PUBLISH_DONE
  // (draft-ietf-moq-transport-22 §9.9 / §12.4) でも呼ばれる。正常な PUBLISH_DONE
  // (TRACK_ENDED 等) では呼ばれず、状態も変わらない
  onError?: (error: Error) => void;
  onClose?: () => void;
}
```

### メソッド

| メソッド                           | 説明                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `start(): Promise<void>`           | 購読開始（`"created"` と `"stopped"` から呼べる。開始を取り消すには `close()` を使う。実行中にピア起点の close または `close()` が重なると `"closed"` を優先して失敗する。失敗時は解放して遷移前の state に戻る。解放 (`close()` とピア起点の close / `stop()` の解放) が進行している間は `cannot start while closing` で拒否する）                                                                                                                                                                                                                                                                                                        |
| `stop(): Promise<void>`            | 購読停止（`"active"` からのみ。`"subscribing"` を含むそれ以外は `cannot stop in state` で throw。解放して `"stopped"` にする。停止の要求後は新しい音声 Object を受け付けず、復号前の遅延の段に保持していた音声を flush して復号へ流し、予約済みの音が鳴り終わるまで待ってから `AudioContext` を閉じる（drain。最大 300 ms、`AUDIO_PLAYOUT_DRAIN_MAX_MS`）。鳴らせた量と切った量は `getStats().audio.playoutTiming.lastDrain` で読める。ピア起点の close の解放中は進行中の解放を共有して完了を待つ。解放の失敗時は state と `onClose` を変えず元のエラーを throw。`close()` が解放と終端遷移を進めている間は `cannot stop while closing`） |
| `requestNewGroup(): Promise<void>` | 新しい Group の開始を要求（REQUEST_UPDATE 送信。値は購読で受信した Object と `LARGEST_OBJECT` の大きい方の次の Group。映像は新しい Group の先頭がキーフレームになる）                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `close(): Promise<void>`           | リソース解放（終端。どの状態からでも可能。開始の取り消しもこれを使う。呼ぶと解放の完了を待たずに閉じたものとして扱い、解放の await 中に届いた Object は統計に数えず復号にも渡さない。進行中の解放（`stop()` / ピア起点の close）は共有して完了を待ち、その成否が結果になる。同時に呼んでも解放と通知は 1 回。解放の失敗時は state と `onClose` を変えず元のエラーを throw）                                                                                                                                                                                                                                                                |
| `getStats(): MediaReceiverStats`   | 受信側の統計情報取得                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

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
`stop()` は停止の要求後、新しい音声 Object の受付を止め、復号前の遅延の段
(`preDecodeDelayMs`) に保持していた音声を flush して復号へ流し、予約済みの音が鳴り終わる
まで待ってから `AudioContext` を閉じる (drain)。待ち時間は「最後に鳴り終わる予約 - 現在 +
余裕 100 ms」を 0〜300 ms にクランプした値である。flush 分の復号の出力は、投入順で対応
させて flush した Object のものだけを待ち、予約されるまで待つ。flush があるときは、予約が
無くても上限まで待つ (復号が終われば早く終わる)。上限で鳴り切れなかった
分だけが `getStats().audio.playoutTiming.missedByReason.stopped` に残り、鳴らせた量、切った量、
待った時間、flush した件数、復号の出力が届かなかった件数 (`undecodedFlushedObjects`) は
同 `lastDrain` で読める。
`close()` とピア起点の close も drain するが、後始末が長くブロックしないよう上限は 150 ms
(`AUDIO_PLAYOUT_DRAIN_CLOSE_MAX_MS`) とする。
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
  // 復号へ渡した音声 Object の数。subgroupFramesReceived と datagramFramesReceived の和
  framesReceived: number;
  // Subgroup (Data Stream) で届いた数 (draft-ietf-moq-transport-22 §11)
  subgroupFramesReceived: number;
  // Datagram で届いた数 (§11.2)。Datagram は再送されないため、経路の欠落がそのまま
  // この数の不足になる。補間と捨ての割合を経路ごとに比べるのに使う
  datagramFramesReceived: number;
  bytesReceived: number;
  // SUBSCRIBE_OK の LARGEST_OBJECT 以前の音声 Object を、relay の cache から届いた分として
  // 復号へ渡さず捨てた数 (累積)
  catchUpObjectsSkipped: number;
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
  // 音声の再生の観測値。鳴るはずの時刻 (再生予定時刻)、届いた時刻、鳴り始める時刻と、
  // 予定に対する余裕の分布 (直近 10 秒の p50 / p95 / max)、鳴らなかった量 (件数と ms) を
  // 理由ごとに出す。補間で埋まらなかった無音の穴 (回数 / ms / 最大 / 予約できなかった分)、
  // 予約を currentTime が追い越した回数、バッファ境界の段差も累積で持つ。復号フレームと
  // AudioContext のサンプルレートが違った回数 (sampleRateMismatchFrames) も持つ
  // (src/playout/audioPlayoutTimingStats.ts)
  playoutTiming: AudioPlayoutTimingSnapshot;
  // 受信側の音声の追いつきの観測値 (src/playout/audioReceiveCatchUp.ts)。復号の出力が送られた
  // TIMESTAMP から遅れ続けたときに、復号器を作り直して live へ戻した量
  playoutCatchUp: AudioReceiveCatchUpStats;
}

// 受信側の音声の追いつきの観測値 (ms)
interface AudioReceiveCatchUpStats {
  // 直近に観測した、復号の出力の遅れ (復号の出力を受け取った壁時計 - AudioData.timestamp)。
  // まだ観測していなければ null
  lagMs: number | null;
  // 直近に観測した、受信の入口の入力の遅れ (Object の到着の壁時計 - LOC TIMESTAMP)。
  // 測れなければ null
  inputLagMs: number | null;
  // 直近に観測した、復号が足している遅れ。出力の遅れ - 入力の遅れ - 意図した遅延であり、
  // 追いつきの判定 (床と上限) はこの値で行う。入力の遅れが測れないときは
  // 出力の遅れ - 意図した遅延になる
  decodeLagMs: number | null;
  // 健全時に観測した、復号が足している遅れ (床)。直近 5 秒の窓の最小値であり、経路と復号の
  // 速さという環境の値を含む (実測: 手元で 18〜19 ms、CI の runner で 116 ms 前後)。
  // まだ観測していなければ null
  floorMs: number | null;
  // 観測した最大の、復号の出力の遅れ (ms)
  maxLagMs: number | null;
  // いま使っている遅れの上限。床と AUDIO_RECEIVE_CATCH_UP_GROWTH_MS (40 ms) から決まり、
  // 床がまだ無ければ AUDIO_RECEIVE_CATCH_UP_MIN_MS (60 ms) になる
  limitMs: number;
  // いま追いつきの最中か (復号器を作り直した後、遅れが上限へ戻るまで)。この間は 1 秒ごとに
  // 作り直しを重ねる
  catchingUp: boolean;
  // 追いつきを始めた回数 (復号器を作り直した回数、累積)
  catchUpStarts: number;
  // 追いつきで飛んだ音の数と長さ (累積の推定。復号の出力の timestamp の跳びから求める)
  skippedFrames: number;
  skippedMs: number;
  lastSkippedMs: number | null;
}

// 音声の再生の観測値。時刻はすべて performance.now() と同じ軸のミリ秒であり、
// 別のマシンでは publisher の時計とのずれを含む
interface AudioPlayoutTimingSnapshot {
  // 直近に鳴らすと決めた音の、再生予定時刻 (LOC TIMESTAMP から時間軸が決めた時刻)、
  // 到着時刻 (復号の出力を受け取った時刻)、鳴り始める時刻。予定を決められなければ null
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
  // (TIMESTAMP が壁時計からずれている) ときのほか、予定を決められても使わなかった音
  // (揃える相手がいない音声だけの購読のとき) も数える。
  // 到着基準の予算は、揃える相手がいて時間軸を使うとき 50〜100 ms、それ以外は 50 ms。
  // 出力機器の先行量や既存の予約が大きいと、実際の startDelayMs は予算を超える
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
  missedByReason: Readonly<Record<AudioMissReason, AudioMissTotal>>;
  // 直近に鳴らさなかった音 (古い順、最大 30 件)
  recentMisses: readonly AudioMissEvent[];
  // 時間圧縮と補間を使えないサンプルレートで鳴らした音の数 (累積)。96 kHz などは加工せず、
  // 「操作しない」を返すため、この数で気付く。0 なら使えている
  stretchUnavailableFrames: number;
  // 復号フレーム (AudioData) のサンプルレートが AudioContext と違った回数 (累積)。0 なら
  // 両者は一致している。違うと AudioBufferSourceNode がバッファごとにリサンプルし、
  // 20 ms の境界ごとに 1 サンプルの重なり (毎秒 50 回の +6 dB スパイク) が生まれる
  // (docs/AUDIO_GLITCH_CAUSES.md の A1)。boundaryStepCount はこの重なりを数えない
  sampleRateMismatchFrames: number;
  // 直近の AudioContext と復号フレームのサンプルレート (Hz)。まだ音を渡していなければ null
  contextSampleRate: number | null;
  decodedSampleRate: number | null;
  // 補間で埋まらなかった無音の穴の回数、長さの合計 (ms)、最大 (ms) (累積)。予約できる
  // 最も早い時刻より前だった分、補間が失敗した分、補間の上限 (100 ms) を超えた分を含む
  gapCount: number;
  gapMs: number;
  gapMaxMs: number;
  // 穴のうち、予約できる最も早い時刻より前だった回数と長さの合計 (ms) (累積)。
  // 事後には埋められないため、目標遅延を増やす判断に使う
  unrecoverableGapCount: number;
  unrecoverableGapMs: number;
  // 予約した開始時刻を AudioContext.currentTime が追い越した回数と最大 (ms) (累積)
  lateStartCount: number;
  lateStartMaxMs: number;
  // 開始時刻を currentTime + 余裕へ押し直した回数と最大 (ms) (累積。追い越しの有無を問わない)
  pushStartCount: number;
  pushStartMaxMs: number;
  // バッファ境界の段差が AUDIO_PLAYOUT_BOUNDARY_STEP_THRESHOLD を超えた回数と最大
  // (0 から 1 の振幅、累積)
  boundaryStepCount: number;
  boundaryStepMax: number;
  // 直近の停止の drain の結果。停止していなければ null。形は再生の入口が返す
  // MediaPlayoutDrainStats (「再生の入口 (MediaPlayout)」の「ライフサイクル」) と同じ
  lastDrain: MediaPlayoutDrainStats | null;
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
  // 復号中の Group より古い Group の Object と、重複 / 遅着の Object として捨てたフレーム数
  staleFramesDropped: number;
  // 参照するフレームが欠けているため、キーフレームを待つ間に捨てたフレーム数
  missingReferenceFramesDropped: number;
}

interface AvSyncStats {
  // 同期ずれの推定値 (ms)。映像の表示が音声より遅れていれば正。
  // 音声は予約した時刻、映像は write した時刻の実績から求める (実際に音が出るまでの
  // 出力遅延と、映像が表示されるまでの表示周期の遅れは含まない)。
  // どちらかの実績が 1 秒より古いときは null。基準を共有できないと保持された側は到着
  // 基準で再生され、その側は実績を作らないため、解除している間も null になる
  skewMs: number | null;
  // 表示の遅れ (ms)。TIMESTAMP から表示時刻までの差。基準が未確立なら null。
  // preDecodeDelayMs を指定した場合は、その分を含む
  presentationDelayMs: number | null;
  // catalog から解決した目標遅延 (ms)。無い、または使えないときは null。
  // 実際に表示の遅れに使う値は、上限に収まらない分を切り下げた値になる
  targetLatencyMs: number | null;
  // 表示の遅れの上限に収まらず切り下げた分 (ms)
  targetLatencyLimitedMs: number;
  // AudioContext.getOutputTimestamp() を使えず currentTime で代用しているか
  audioClockFallback: boolean;
  // 遅延の内訳。音声と映像の遅れがどこで生じているかを分けて見るために使う
  delays: PlayoutDelayBreakdown;
}

interface PlayoutTrackBreakdown {
  // 基準の遅れ (ms)。受信側と送信側の時計のずれと、経路と復号の最小遅延。
  // preDecodeDelayMs を指定した場合は、その分を含む
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

interface PlayoutDelayBreakdown {
  audio: PlayoutTrackBreakdown;
  video: PlayoutTrackBreakdown;
  // AudioContext の時計で換算した予約時刻と、予約時点の目標との差 (ms)
  audioPlayoutCorrectionMs: number;
  // 基準の差「音声 - 映像」(ms)。表示時刻が使う値であり、A/V 同期はこの差を合わせる
  baseDifferenceMs: number | null;
  // 動きの判定が使う値 (直近 2 秒の窓の最小値で見た同じ差、ms)。基準との隔たりが、
  // 経路と復号の乱れの大きさになる
  baseDifferenceRecentMs: number | null;
  // 動きの判定に使っている水準 (ms)。まだ決まっていなければ null
  baseDifferenceSettledMs: number | null;
  // 水準からの隔たり (ms)。水準がまだ無ければ null
  baseDifferenceDeviationMs: number | null;
  // 2 つのトラックを同じ時計として扱えているか
  sharingBases: boolean;
  // 扱えない理由。"unobserved" (未観測)、"difference" (差が上限を超えている)、
  // "drift" (差が動き続けている = TIMESTAMP が壁時計からずれている)、
  // "hold" (直前にやめた判定を保持している)、"none"
  unsharedReason: PlayoutUnsharedReason;
  // 基準の差の動き (ms/秒)。閾値 (baseDriftLimitMs) を超えるとずれとみなす
  baseDriftMsPerSecond: number | null;
  baseDriftLimitMs: number;
  // 保持を早く解除する条件 (解除のきっかけが去り、差が戻った状態) が続いている時間 (ms)。
  // 数えていなければ null。PLAYOUT_BASE_UNSHARED_RELEASE_MS に達すると保持を解除する
  baseUnsharedReturnMs: number | null;
  presentationDelayCapMs: number;
  // 到着と実出力の時計から決めた音声の再生予算
  audioDelay: AudioPlayoutDelayStats;
}

interface AudioPlayoutDelayStats {
  // 到着の揺らぎ (ms)。直近 2 秒の分布。未観測なら null
  readonly jitterMs: number | null;
  // 到着時刻に対応する出力位置から、今予約できる最早位置までの先行量 (ms)。
  // 有効な出力時計で測った直近 1 秒の p95。未観測なら null
  readonly outputLeadMs: number | null;
  // 音声の自動予算 (ms)。catalog の明示下限と A/V 同期の補償は含まない
  readonly targetMs: number;
}
```

音声と映像の表示時刻は 1 つの式で決める。LOC の TIMESTAMP (TIMESCALE が無ければ Unix
epoch マイクロ秒の壁時計) に、基準の遅れ (送受信の時計のずれと、経路と復号の最小遅延) と
jitter buffer の遅れ (`catalog の targetLatency` を下限とする) を足した時刻が目標になる
(draft-ietf-moq-msf-01 Section 5.2.8 / Section 5.2.11)。`isLive` が false の track の
`targetLatency` は無視する (Section 5.2.8 の MUST)。

遅延の内訳 (`delays`) の各値の根拠 (何を測ってその値にしたか) と、どうなったら見直すかは
`docs/AV_SYNC_DECISIONS.md` が持つ。

jitter buffer の遅れは、音声と映像の直近 2 秒の到着から求める。基準の遅れを求める
10 秒の窓とは分け、単発の停滞で増えた待ちを長く保持しない。追いつき中と、停滞後に
まとめて復号された分は経路の分布へ混ぜない。

- 揺らぎは「復号の出力時刻 - TIMESTAMP - 基準の遅れ」の百分位で求める。百分位は
  1 秒あたり 1 フレームの遅着を予算とし、最低 95 % にする (音声 50 fps で 98 %、映像
  30 fps で約 96.7 %)
- 音声は揺らぎに実出力の先行量を足し、50〜100 ms に収める。先行量は
  `getOutputTimestamp()` と `currentTime` から測る。過去の穴、圧縮量、同期のために
  足した待ちを、別の遅延上限へ戻す制御は持たない
- 映像は揺らぎの百分位を使い、古い観測が窓から消えたら必要値へ戻す
- 音声の予算は `AvSyncStats.delays.audioDelay` に出る。実際に適用した音声の予算は
  `getStats().audio.delay.targetMs` で読む

2 つの表示時刻の差が 5 ms を超えたときは、先行する側を「後行側 - 5 ms」へ合わせる。
基準を共有できる間は、現在の到着の分布と音声の予約から補償を毎回引き直す。過去の共有の
表示時刻を下限として保持しない。窓が回復すると待ちも戻り、既存の音声キューは波形の時間
圧縮で追従する。圧縮の不感帯は開始後 2 秒まで 20 ms とし、その後は経路の揺らぎに応じて
5〜20 ms にする。揺らぎのある経路で一律に 5 ms へ下げる変更は、音切れが増えたため採らない。
計測の比較と採用しなかった案は [低遅延化の調査](AV_LOW_LATENCY_INVESTIGATION.md) を参照すること。

基準の差は「遅い側を待つ」ことでしか合わせられないため、2 つのトラックの基準を共有しない
場合がある。理由は `AvSyncStats.delays.unsharedReason` に出る。

- `difference`: 基準の差が表示の遅れの上限 (500 ms、またはキューが吸収できる長さ) を
  超えている。上限で切られる分は合わせられない
- `drift`: 基準の差が、動いていない水準から 50 ms を超えて離れたまま 6 秒続いている。これは
  経路の遅れではなく、片方の TIMESTAMP が壁時計からずれていくこと (音声のドリフトなど) を
  意味する。合わせるともう片方 (ここでは映像) の表示の遅れが上限まで伸びて戻せなくなるため、
  合わせるのをやめ、既に足した分も戻す。ずれた側は TIMESTAMP を使わず到着基準で再生する。
  離れた幅が元の水準へ戻れば (読み出しが一瞬遅れた分など) 判定は消える。待たずに判定するのは、
  1 回の記録で 150 ms を超えて離れた (段差) か、表示時刻が使う基準 (10 秒の窓の最小値) の差も
  同じ向きに動いているときだけである。動きを見る直近 2 秒の窓は経路と復号の乱れでも大きく
  動くため (実測で 1000 ms 近い往復)、どちらも満たさない動きは 6 秒の持続を待つ。購読の直後の
  過渡 (relay の cache から届いた分をまとめて復号している間) は、差が落ち着くまで判定を
  始めない
- `hold`: 直前に共有をやめた判定を保持している。閾値は「表示の遅れの上限 - そのトラックの
  遅延」で決まるため jitter buffer の目標遅延で動き、差が変わらなくても共有と解除を
  往復し得る。往復のたびに足した分を戻して (フレームを捨てる) すぐ足し直す (表示が
  止まる) ため、`PLAYOUT_BASE_UNSHARED_HOLD_MS` の間は戻さない。ただし解除のきっかけに
  なった動きが去り、差が元の水準へ戻った状態 (動きの判定が消え、差が閾値の内側で、水準から
  離れていないこと) が `PLAYOUT_BASE_UNSHARED_RELEASE_MS` 続いたら、往復の恐れが無いため
  保持を待たずに戻す。どこまで続いたかは `AvSyncStats.delays.baseUnsharedReturnMs` に出る

基準を共有できない側が音声のときは、同期の制御を止めず、映像だけを音声の到着基準の時刻へ
合わせる。音声の TIMESTAMP が信用できなくても、音声の並べ方は分かっているためである。

- 音声は「到着 + 到着基準の再生の遅れ」で鳴る。揃える相手 (映像) がいるときは
  `AUDIO_PLAYOUT_ARRIVAL_DELAY_MS` = 100 ms を上限とし、下限は 50 ms にする。この値へ映像の
  到着からの遅れ (jitter buffer の遅延) を合わせる
- 音声だけを購読しているときは、到着基準の予算を 50 ms にする。壁時計の観測が無い音声や
  `jitterBuffer: false` でも同じ予算を使う
- 足すのは映像だけである。音声を遅らせると到着から鳴るまでの時間がその分だけ増える。
  映像が音声より遅いときは戻さない (音声を遅らせないと合わせられないため、その分は
  A/V のずれとして残す)
- 足す量は `PLAYOUT_MAX_COMPENSATED_DIFFERENCE_MS` (100 ms) までとし、足すのは即座、
  戻すのは毎秒 20 ms までにする (基準を共有できないときの保護)
- 音声と映像の到着が同じ時刻であることは前提にする (同じ publisher、同じ経路の
  2 つのトラック)。実測では、この合わせを止めていたために音声が 195 ms、映像が 98 ms で
  100 ms のずれが残っていた

基準の差を補償する量は `PLAYOUT_MAX_COMPENSATED_DIFFERENCE_MS` (100 ms) までにする。
時計のずれの証拠が見える前でも適用し、片方の TIMESTAMP が大きくずれたときに相手の遅延が
際限なく伸びるのを防ぐ。自分で決めた jitter buffer の差は別に補償し、最終的な表示待ちは
キューと表示の上限に収める。catalog が明示した下限もこの範囲内で尊重する。

音声の出力時計で換算した開始時刻と予約時点の予定の差も、映像の合わせ先へ反映する。
残差は 250 ms の時定数で平滑化し、`AvSyncStats.delays.audioPlayoutCorrectionMs` に出る。
出力時計を代用している間は新しい残差を取り込まない。予約の記録と同じ呼び出し内で
同期も更新し、音声の停止では出力の残差と観測した予算を初期化する。

音声の換算は AudioContext の予約までを表す。MediaStream を HTMLAudioElement で再生する
場合、その後のバッファと選択した音声デバイスの追加遅延は計器に含まれない。

Audio Playback を有効にすると、映像は音声のバッファと出力に必要な分だけ待つ。音声の
自動予算は 50 ms から始まり、到着と出力時計の観測に適応する。入力が 180 ms 止まる条件では
途絶自体を無くせず、回復途中の媒体遅延も 100 ms を超える。自動予算の上限と、実遅延の
上限は区別する必要がある。

どちらの場合も、2 つのトラックはそれぞれの到着と jitter buffer の遅れで並ぶ。A/V のずれは
基準の差ではなく、2 つの遅れの差 (数十 ms) になる。`delays` はこの判断に使った内訳
(基準の遅れ、jitter buffer の遅延、足した分、共有できているか、差の動き) をそのまま出す
ため、音声と映像の遅れを比べて改善するときに使える。

`AudioStats` / `VideoStats` は送信側 (`MediaStats`) の型である。受信側は
`AudioReceiverStats` / `VideoReceiverStats` を使う。

`AudioReceiverStats.playoutTiming` は、音声が「鳴るはずだった時刻」と「実際に鳴り始める
時刻」の観測値である。受信した音声の再生予定時刻は LOC の TIMESTAMP から共有の時間軸が
決め、到着時刻は復号の出力を受け取った時刻、鳴り始める時刻は `AudioContext` の時計へ予約
した時刻を `performance.now()` の軸へ換算した値である (音声の出力デバイスの遅延は含まない)。
予定に対する余裕 (`slackMs` の分布) が負であれば、届いた時点ですでに予定を過ぎており、その
音は間に合っていない。

`latenessMs` / `startDelayMs` / `slackMs` は予約の結果を表す計器であり、別の遅延
上限を広げる入力には使わない。鳴らす時刻は `max(目標, 今 + 余裕, 直前の音の終わり)`
で決まるため、予算より実出力の先行量や既存の予約が大きいと予定を過ぎて鳴る。
その分は `latenessMs` に現れ、A/V 同期では予約の残差として補償する。

`AudioPlayoutTimingSnapshot` の `gapCount` / `gapMs` / `gapMaxMs` は、穴として残した回数、
長さの合計、最大である。穴は、予約できる最も早い時刻 (今 + 余裕) より前だった分、補間が
失敗した分、補間の上限 (100 ms) を超えた分からでき、無音へ落ちる側の段差がクリックとして
聞こえる (無音から戻る側は補間や次の音の先頭を 2 ms フェードインするため段差は小さい)。`gapMs` は「補間で埋まらなかった長さ」であり、補間を予約したときに生成する長さの丸め
(半サンプル以内) は穴として数えない。2 ms のフェードは補間の長さに数えるため含まない。
計器を作り直すまでの累積であり、波形を収録して数えた無音 (収録区間だけ) とは範囲が違うため
一致しない。
秒単位の長い途絶 (配信の停止、経路の断) も 1 回の穴として含む。クリックは 0 の長さではなく
境界の段差で決まるため、`boundaryStepCount` / `boundaryStepMax` と併せて読む。
`unrecoverableGapCount` / `unrecoverableGapMs` は穴のうち予約できる最も早い時刻より前だった
分 (既に過去の分と、未来でも余裕に満たない分を含む。事後には埋められない) であり、
到着と出力時計の不足を切り分けるための計器である。`lateStartCount` / `lateStartMaxMs` は、予約した
開始時刻を `source.start()` の時点の `AudioContext.currentTime` が追い越した回数と最大で
ある。追い越し (および余裕 3 ms 未満) のときは開始時刻を `currentTime + 3 ms` へ押し直し、
先頭 2 ms をフェードインするため、重なりは起きない。追い越した回数だけを数えるため、
余裕より近かっただけの押し直しは含まない。押し直した回数と最大は `pushStartCount` /
`pushStartMaxMs` で読む。
`boundaryStepCount` / `boundaryStepMax` は、バッファ境界で実際に鳴るサンプルの段差が
0.05 (`AUDIO_PLAYOUT_BOUNDARY_STEP_THRESHOLD`。440 Hz の正常な差分 p99.9 = 0.0174 の約
3 倍) を超えた回数と最大である。すべての境界を測るため、通常の音の切れ目も含む。しきい値は
440 Hz のトーン基準の絶対値であり、実音声では正常な段差が超えることがある。
`stretchUnavailableFrames` と同じく累積であり、購読をやり直しても消えない。

音声の再生に使う `AudioContext` は、復号フレームのサンプルレートに合わせて作る
(`src/codec/config.ts` の `resolveAudioContextSampleRate`)。Chromium の Opus 復号は
configure の sampleRate に関係なく常に 48 kHz を返すため、Opus では Catalog の
`samplerate` が 44100 でも 48 kHz の AudioContext を作る。AAC は Catalog の
`samplerate` を使う。devtools の再生も購読開始時に同じ値で AudioContext を作る。
`sampleRateMismatchFrames` は、この前提が崩れた (AudioContext と復号フレームのレートが
違う) フレームの累積であり、0 が正常である。レートが違うと `AudioBufferSourceNode` が
バッファごとにリサンプルする。44.1 kHz の AudioContext に 48 kHz のバッファを並べる
組み合わせでは、20 ms の境界ごとに 1 サンプルの重なり (毎秒 50 回の +6 dB スパイク) が
生まれる (`docs/AUDIO_GLITCH_CAUSES.md` の A1)。ほかの組み合わせでは重ならないことも
あるため、`sampleRateMismatchFrames` は「重なりが起きた回数」ではなく「レートが
食い違ったフレームの回数」である。`contextSampleRate` / `decodedSampleRate` は直近の値で
あり、食い違いの切り分けに使う。

`arrivalPlannedFrames` は、時間軸の再生予定時刻を使えず、到着基準の計画で鳴らした音の数で
ある。使えないのは壁時計の TIMESTAMP を持たない、jitter buffer が無効、トラックの基準が
共有されていない (TIMESTAMP が壁時計からずれている) ときである。予定を決められても、揃える
相手がいないために使わなかった音 (音声だけの購読) も数える。このときの再生の遅れは、
揃える相手がいるときは到着から 100 ms 以下 (`AUDIO_PLAYOUT_ARRIVAL_DELAY_MS`) に抑え、
音声だけのときは 50 ms にする。共有の時間軸が学習した再生の遅れは、ずれている
TIMESTAMP を揺らぎとして学習した値 (実測で 316〜500 ms) になるためである。
`unplannedFrames` は、到着基準の計画も持たないまま鳴らした音であり、通常は 0 になる。

この遅れは「実際に鳴るまで」の時間である。`AudioContext` の時計 (`currentTime`) は、既に
出力のバッファへ積まれた分だけ実際に鳴る位置より先に進む。到着基準の目標を `currentTime`
から数えると、実際に鳴るのは「到着 + 遅れ + バッファの分」になる (実測では
`startDelayMs` が 100 ms の目標に対して 195.5 ms になり、A/V のずれが約 100 ms 残っていた)。
音声の `AudioData` を復号した時刻は `AudioClockBridge` で `AudioContext` の秒へ換算し、
その位置を到着の基準にして「到着 + 遅れに鳴る」時刻を求める。`AudioContext` の対応付けが
まだ無いときは `currentTime` と同じ値を使う (この場合も従来と同じ並びになる)。

予定から離れすぎて届いた音は捨てない。鳴らすと語尾が切れるためである。到着は乱れていない
のに予定だけが過去にあるとき、ずれているのは予定の方 (TIMESTAMP が壁時計からずれている)
であり、音は遅れていない。音がまだ鳴っている (キューが空でない) 間は到着基準へ並べ直さず、
前の音の終わりに繋げて遅れたまま鳴らす。並べ直す (媒体時刻を跳ばす) のは、直前の音が既に
鳴り終わっているなど、音が本当に途切れていたときだけである。並べ直したときは到着基準の
再生の予算 (時間軸で揃える相手がいるときは 50〜100 ms、それ以外は 50 ms) だけ遅らせる。
音が途切れていないときに予約できる最も早い時刻へずらすだけの場合は、
ずらす幅が `AUDIO_PLAYOUT_RESYNC_MIN_JUMP_SECONDS` (10 ms) 未満なら並べ直しとして数えない
(媒体時刻が跳ばないため)。

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

`catchUpObjectsSkipped` は、SUBSCRIBE_OK の LARGEST_OBJECT 以前の位置の音声 Object を、
relay の cache から届いた分として復号へ渡さず捨てた数である (`framesReceived` には含めない)。
購読を始めるたびに境界を設定し直し、停止すると境界を消す。境界が無い
(LARGEST_OBJECT が省略された) 購読では捨てず、全 Object を live として扱う
(src/catchUpGate.ts)。

受信した映像は Group の順序と欠落を見て、参照するフレームを復号済みの Object だけを
復号する。Object は順不同で届きうる (draft-ietf-moq-transport-22 Section 2.1) ため、
次の Group のキーフレームを復号した後に届いた前の Group の Object は復号せず
`staleFramesDropped` に数える。Group 内で Object ID が欠けた場合は、Prior Object ID Gap
(Section 10.9) が非存在を示す分を除き欠落として扱い、次のキーフレームまでの Object を
`missingReferenceFramesDropped` に数える。1 Group を複数の Subgroup に分ける publisher の
Object ID の飛びも欠落として扱う。

---

## 再生の入口 (MediaPlayout)

`createMediaPlayout` は、復号済みの音声と映像を再生するための共通の入口である。内部では、
共有の時間軸、音声の再生の組み立て、映像の表示の組み立て、計器、復号へ渡した入力の対応表
(音声と映像で別の表) を 1 か所にまとめる。

`MediaPlayout` は型としてだけ公開しており、値 (コンストラクタ) は公開していない。生成には
`createMediaPlayout(options)` を使う。時間軸と組み立てのクラスも公開していない。公開している
型と値は「公開している型と値」に列挙する。

`createMediaSubscriber` (ライブラリ) と moqt-devtools はこの入口を使う。音声と映像の時間軸が
同じであること、目標の開始時刻を守るかどうか、音声だけを購読しているときの到着基準の下限と
いった判断は、すべて入口の中で行う。呼び出し側が持つのは、復号 (WebCodecs)、受信、購読の
管理、画面への反映である。

### アプリケーションが直接使う API

毎フレーム使う API は次の 5 つである。

- `trackAudioDecodeInput` / `trackVideoDecodeInput` — 復号へ渡す直前に入力の情報を記録する
- `pushAudio` / `pushVideo` — 復号の出力を渡す
- `getStats` — 統計情報を読む

再生の開始と停止、`AudioContext` の作り直しでは、続く「ライフサイクル」の API を使う。
`createMediaSubscriber` を使う場合は、この入口の API を直接呼ばない。moqt-devtools は入口を
直接使い、毎フレームの API とライフサイクルの API の両方を呼ぶ。

### 作成

```typescript
import { createMediaPlayout } from "moqt-js";

const audioContext = new AudioContext();
const generator = new MediaStreamTrackGenerator({ kind: "video" });
const writer = generator.writable.getWriter();

const playout = createMediaPlayout({
  // 音声の再生。AudioContext と、予約した音を繋ぐ出力を渡す
  audio: { context: audioContext, destination: audioContext.destination },
  // 映像の表示。表示すると決めたフレームの出し先を渡す
  video: {
    output: {
      isAvailable: () => true,
      present: (frame, presentationMs) => {
        // 受け取ったフレームはここで表示し、writer へ渡す。所有権は戻り値にかかわらず
        // writer へ移り、閉じるのは writer の先 (ブラウザ) である。書き込みが失敗した
        // ときは出し先が閉じないため、ここで閉じる。
        // presentationMs は時間軸が決めた表示時刻 (performance.now() と同じ軸のミリ秒)。
        // 届いた順に表示するときは null
        writer.write(frame).catch(() => {
          frame.close();
        });
        return true;
      },
    },
  },
});
```

戻り値の型は `MediaPlayout` である。`AudioContext` と映像の出し先はブラウザ依存であり、
利用側の実物を注入する。映像の出し先と表示の周期は「映像の出し先と表示の周期」を参照する
こと。

`audio` と `video` は少なくとも片方を指定する。両方を省略するか null を渡すと throw する。
省略した側は構成しないため、後から足すことはできない。

音声だけを再生する場合は `video` を省略する。

```typescript
import { createMediaPlayout } from "moqt-js";

const audioContext = new AudioContext();
// 自動再生ポリシーで suspended のまま作られることがある。利用者の操作を受けてから
// resume() する (suspended の間は currentTime が進まず、予約した音も鳴らない)
if (audioContext.state === "suspended") {
  await audioContext.resume();
}
const playout = createMediaPlayout({
  audio: { context: audioContext, destination: audioContext.destination },
});

// 受信した Object を復号へ渡す直前に呼ぶ (AudioDecoder.decode() の直前)
function onEncodedObject(decoder: AudioDecoder, chunk: EncodedAudioChunk): void {
  playout.trackAudioDecodeInput(chunk.timestamp, { timestampKind: "wallClock" });
  decoder.decode(chunk);
}

// 復号の出力で呼ぶ (AudioDecoder の output)。push だけを呼ぶ
function onDecodedFrame(data: AudioData): void {
  try {
    playout.pushAudio(data);
  } finally {
    // pushAudio は AudioData を閉じない。所有権は呼び出し側に残る
    data.close();
  }
}
```

映像だけを再生する場合は `audio` を省略する。

```typescript
import { createMediaPlayout, type Location } from "moqt-js";

const generator = new MediaStreamTrackGenerator({ kind: "video" });
const writer = generator.writable.getWriter();
const playout = createMediaPlayout({
  video: {
    output: {
      isAvailable: () => true,
      present: (frame) => {
        writer.write(frame).catch(() => {
          frame.close();
        });
        return true;
      },
    },
  },
});

// 受信した Object を復号へ渡す直前に呼ぶ (VideoDecoder.decode() の直前)。
// location は受信した Object の位置 (Group ID と Object ID)
function onEncodedObject(
  decoder: VideoDecoder,
  chunk: EncodedVideoChunk,
  location: Location,
): void {
  playout.trackVideoDecodeInput(chunk.timestamp, { timestampKind: "wallClock", location });
  decoder.decode(chunk);
}

// 復号の出力で呼ぶ (VideoDecoder の output)。push だけを呼ぶ
function onDecodedFrame(frame: VideoFrame): void {
  // present へ渡したフレームの所有権は出し先 (writer) へ移る。表示しないフレームは入口が閉じる
  playout.pushVideo(frame);
}
```

`AudioContext` は自動再生ポリシーにより `suspended` の状態で作られることがある。`suspended` の
間は `currentTime` が進まず、予約した音は鳴らない。利用者の操作 (クリックなど) を受けた時点で
`await audioContext.resume()` してから音を渡すこと。`createMediaSubscriber` は購読の開始時に
内部で `resume()` し、失敗は `onError` で通知する。

### オプション

```typescript
interface MediaPlayoutOptions {
  // 音声の再生。省略または null で音声を構成しない
  // (audio と video の両方を省略するか null を渡すと throw する)
  audio?: MediaPlayoutAudioOptions | null;
  // 映像の表示。省略または null で映像を構成しない
  video?: MediaPlayoutVideoOptions | null;
  // 共有の時間軸 (jitter buffer) を使うか。既定は true。
  // false のときは TIMESTAMP の対応付けと表示時刻の決定をせず、届いた順に鳴らし / 表示する
  // (音声は到着基準の 50 ms の予算で鳴らす。admit 用の入力記録と予約の計器は動く)
  jitterBuffer?: boolean;
  // catalog から解決した表示の遅れの目標 (ミリ秒)。既定は null。
  // 購読の途中で変わったときは setTargetLatencyMs で変える。有限数で 0 以上
  targetLatencyMs?: number | null;
  // 映像の表示待ちのキューの上限 (枚)。既定は JITTER_BUFFER_MAX_QUEUED_FRAMES (24)。
  // 時間軸が許す表示の遅れの上限もこの値から決まる。1 以上の整数
  maxQueuedFrames?: number;
  // 復号の出力で入力が引けなかったときに使う、意図した復号前の遅延 (ミリ秒)。既定は 0。
  // 復号前の遅延の段を使う呼び出し側は、その設定値を渡す。有限数で 0 以上
  intentionalDelayMs?: number;
  // 復号へ渡した入力の対応表の設定
  decodeInputs?: MediaPlayoutDecodeInputOptions;
}

interface MediaPlayoutAudioOptions {
  // AudioContext と、予約した音を繋ぐ出力。2 つ同時に指定する
  // (片方だけでは throw する)。鳴らす先が無いときは 2 つとも省略する
  context?: AudioPlayoutContext;
  destination?: AudioNode;
  // 計器。省略すると内部で作る。「鳴らなかった量」を自分の実行周期で画面へ出すときは、
  // 作ったものを渡して直接読む
  // (new AudioPlayoutTimingStats(AUDIO_PLAYOUT_TIMING_WINDOW_MS, performance.timeOrigin))
  timing?: AudioPlayoutTimingStats;
  // 鳴らすかどうかの選別。false を返すとその音は鳴らさず notAdmitted を返す。
  // 鳴らす先が無いときも呼ばれ、そのときは skipped が優先される。
  // throw しない契約であり、throw した場合は pushAudio が status: "error" を返す
  admit?: (input: MediaPlayoutAudioDecodeInput | null) => boolean;
  // 揃える相手 (映像) がいるかを返す。省略すると映像の出力が構成されているかで決める。
  // catalog に映像のトラックが無い購読では、映像の出力があっても揃える相手はいない。
  // 映像の出力を構成していない (video を省略した) ときは、この値によらず揃える相手はいない。
  // throw しない契約であり、throw した場合は pushAudio が status: "error" を返す
  hasCounterpart?: () => boolean;
}

interface MediaPlayoutVideoOptions {
  // 表示すると決めたフレームの出し先 (必須)
  output: VideoPlayoutOutput;
  // 表示の周期の進め方。省略すると MediaPlayout が
  // { drainImmediately: true, framesPerDrain: Number.POSITIVE_INFINITY } を渡す
  // (表示時刻を過ぎたフレームをすべて出す)
  pacing?: VideoPlayoutPacing;
  // 捨てたフレームの記録先 (計器)。省略すると記録しない
  timing?: VideoPlayoutTiming;
  // 表示するかどうかの選別。false を返すとそのフレームは表示せずに閉じて notAdmitted を返す。
  // admit と output.isAvailable は throw しない契約であり、throw した場合はフレームを
  // 閉じて status: "skipped" を返す (表示しない扱いにする)
  admit?: (input: MediaPlayoutVideoDecodeInput | null) => boolean;
}

interface MediaPlayoutDecodeInputOptions {
  // 覚えておく上限 (件)。既定は 256。1 以上の整数。超えたら古い方から忘れる
  maxTracked?: number;
  // 同じ TIMESTAMP の入力が重なったときに、その TIMESTAMP の分を忘れるか。既定は false
  // true は位置 (Object の位置) を選別に使うとき (どちらの位置か決められないため)。
  // false は後から来た種類で上書きする (種類しか使わないとき)
  forgetOnDuplicate?: boolean;
}
```

数値のオプションは入口で検証し、違反は throw する。`maxQueuedFrames` と
`decodeInputs.maxTracked` は 1 以上の整数、`targetLatencyMs` / `intentionalDelayMs` は
有限数で 0 以上である。範囲外の値でハングや無音を起こさないよう、構成する前に弾く。
`drainAudio` の `maxWaitMs` も呼び出し時に検証し、範囲外なら非同期の reject になる
(`drainAudio` は Promise を返す)。

`targetLatencyMs` の既定は null であり、catalog の `targetLatency`
(draft-ietf-moq-msf-01 §5.2.8) を解決した値を渡す。同じ render group と alternate group の
track が同じ値を持つことは MUST だが、音声と映像で同じ値を使うこと自体は MUST ではない。
この入口は 1 つの値しか持てないため、呼び出し側が同じ group の track に同じ値を載せて渡す
(ライブラリは catalog から解決した 1 値を渡す)。catalog の `targetLatency` が負や非有限の
ときは、宣言が無いものとして null を渡す (ライブラリはそう解決する)。

`decodeInputs.maxTracked` の既定 256 は、音声の通常の購読では足りる。relay の cache から
まとめて復号する購読では、復号へ渡してから復号の出力が届くまでの件数が数百以上に増える
ため不足し得る。moqt-devtools は 8192 を渡す。

### 音声を構成する場合と省略する場合

`audio` を省略する (または null を渡す) と音声を構成しない。`audio: {}` のように指定すると、
鳴らす先が無くても音声を構成する。違いは次のとおりである。

| 指定                              | `getStats().audio` | `pushAudio` | `setAudioOutput`       |
| --------------------------------- | ------------------ | ----------- | ---------------------- |
| `audio: { context, destination }` | 非 null            | 鳴らす      | 差し替えられる         |
| `audio: {}`                       | 非 null            | `skipped`   | 後から出力を付けられる |
| `audio` を省略、または null       | null               | `skipped`   | throw する             |

`audio: {}` の間も、復号へ渡した入力の記録と選別 (`admit`) は行う。`pushAudio` は
`status: "skipped"` を返し、時間軸へも計器へも記録しない。鳴らし始めるときに
`setAudioOutput` で出力を付ける (`context` と `destination` は 2 つ同時に指定する)。

`video` を省略する (または null を渡す) と映像を構成しない。`pushVideo` はフレームを閉じて
`status: "skipped"` を返し、`getStats().video` は null になる。

### 公開している型と値

`src/index.ts` から公開している再生の型と値は次のとおりである。

- 入口: `createMediaPlayout` (値) と `MediaPlayout` (型のみ)
- オプション: `MediaPlayoutOptions`、`MediaPlayoutAudioOptions`、`MediaPlayoutVideoOptions`、
  `MediaPlayoutDecodeInputOptions`
- 復号へ渡した入力: `MediaPlayoutAudioDecodeInput` / `MediaPlayoutVideoDecodeInput`、
  `PlayoutTimestampKind`
- 復号の出力を渡した結果: `MediaPlayoutAudioResult` / `MediaPlayoutVideoResult`
- 停止: `MediaPlayoutDrainOptions` / `MediaPlayoutDrainStats`、
  `AUDIO_PLAYOUT_DRAIN_MAX_MS` (300 ms) / `AUDIO_PLAYOUT_DRAIN_CLOSE_MAX_MS` (150 ms)
- 統計情報: `MediaPlayoutStats`、`MediaPlayoutAudioStats`、`MediaPlayoutVideoStats`、
  `AudioPlayoutTimingSnapshot`、`AudioReceiveCatchUpStats`、`AudioPlayoutDelayStats`、
  `AvSyncStats` (MediaSubscriber と共通)、`TimingSummary`、
  `PlayoutDelayBreakdown`、`PlayoutTrackBreakdown`、`PlayoutUnsharedReason`、
  `AudioMissEvent`、`AudioMissReason`、`AudioMissTotal`
- 注入する実物の型: `AudioPlayoutContext` / `AudioPlayoutOutput`、`VideoPlayoutOutput`、
  `VideoPlayoutPacing`、`VideoPlayoutTiming`
- 計器: `AudioPlayoutTimingStats` (公開クラス)、`AUDIO_PLAYOUT_TIMING_WINDOW_MS`、
  `AUDIO_PLAYOUT_BOUNDARY_STEP_THRESHOLD`、`AUDIO_MISS_REASONS`、
  `EMPTY_AUDIO_PLAYOUT_TIMING`、`formatAudioMissEvent`、`AudioPlayoutBasis`、
  `AudioPlayoutMiss`
- 受信側の追いつき: `AUDIO_RECEIVE_CATCH_UP_MIN_MS`、`AUDIO_RECEIVE_CATCH_UP_GROWTH_MS`、
  `AUDIO_RECEIVE_CATCH_UP_JUMP_MS`、`AUDIO_RECEIVE_CATCH_UP_FLOOR_WINDOW_MS`、
  `AUDIO_RECEIVE_CATCH_UP_CONFIRM_MS`、`AUDIO_RECEIVE_CATCH_UP_COOLDOWN_MS`、
  `AUDIO_RECEIVE_CATCH_UP_SKIP_MIN_MS`、`EMPTY_AUDIO_RECEIVE_CATCH_UP`
- 既定値: `JITTER_BUFFER_MAX_QUEUED_FRAMES`

`AudioPlayoutTimingStats` のメソッド引数と戻り値の型 (`AudioPlayoutBasis` /
`AudioPlayoutMiss`) も公開している。

次の型は、音声の再生に注入する実物の型である。`AudioContext` の実物は `AudioPlayoutContext`
を構造的に満たすため、そのまま渡せる。

```typescript
interface AudioPlayoutContext {
  // AudioContext.currentTime (秒)。予約の基準であり、時計の対応を作るのにも使う
  readonly currentTime: number;
  // AudioContext のサンプルレート (Hz)。復号フレームのレートと違うと、バッファごとの
  // リサンプルで 20 ms の境界ごとに 1 サンプルの重なりが生まれるため、計器へ記録する
  readonly sampleRate: number;
  // AudioContext.getOutputTimestamp()
  getOutputTimestamp(): AudioTimestamp;
  // AudioContext.createBuffer。鳴らす音と、欠落した区間の補間の両方に使う
  createBuffer(numberOfChannels: number, length: number, sampleRate: number): AudioBuffer;
  // AudioContext.createBufferSource
  createBufferSource(): AudioBufferSourceNode;
  // 途絶時の末尾フェードと、後続が届いたときの取り消しに使う
  createGain(): GainNode;
}

interface AudioPlayoutOutput {
  context: AudioPlayoutContext;
  // 予約した音を繋ぐ出力 (MediaStreamAudioDestinationNode など)
  destination: AudioNode;
}
```

`AudioPlayoutTimingStats` は「鳴るはずの時刻、鳴り始める時刻、鳴らなかった量」を記録する
計器であり、`audio.timing` に渡せる公開クラスである。渡さない場合は入口が内部で作る。
入口が記録に使う `recordPlay` / `recordMiss` / `recordDrain` などのメソッドと、
引数の型 (`AudioPlayoutBasis` / `AudioPlayoutMiss`) も import できる。
`record*` は入口が計器へ記録するために呼ぶ API である。アプリケーションが独自に再生を
組み立てて同じ計器へ記録する場合にも使える (計器へ記録する実装が呼ぶ)。
自分の実行周期で画面へ出すときは、次のように作って渡し、`snapshot(performance.now())` を
直接読む。

```typescript
import {
  AUDIO_PLAYOUT_TIMING_WINDOW_MS,
  AudioPlayoutTimingStats,
  createMediaPlayout,
} from "moqt-js";

const audioContext = new AudioContext();
const timing = new AudioPlayoutTimingStats(AUDIO_PLAYOUT_TIMING_WINDOW_MS, performance.timeOrigin);
const playout = createMediaPlayout({
  audio: { context: audioContext, destination: audioContext.destination, timing },
});

setInterval(() => {
  // 入口が記録した観測値を、自分の実行周期で読む
  const snapshot = timing.snapshot(performance.now());
  console.log(snapshot.playedFrames, snapshot.missedFrames);
}, 1_000);
```

### 映像の出し先と表示の周期

表示の出し先は `VideoPlayoutOutput` として注入する。ライブラリは `MediaStreamTrackGenerator`
の writer、moqt-devtools は canvas へ出す。`present` は true / false にかかわらず、渡された
フレームの所有権を受け取り、閉じる責任を負う。false を返したときは、同期の実績として記録
しないだけで、フレームを閉じるのは出し先である。`isAvailable` が false を返したときは、
フレームを表示せずに閉じ、表示待ちのフレームも捨てる (出せないままメモリを占め続けない
ため)。`present` と `isAvailable` は throw しない契約である。throw した場合は、入口が
フレームを閉じて表示しない扱いにする。

```typescript
interface VideoPlayoutOutput {
  // フレームを表示する。presentationMs は時間軸が決めた表示時刻
  // (performance.now() と同じ軸のミリ秒)。届いた順に表示するフレームは null。
  // true / false にかかわらずフレームの所有権を受け取り、必ず閉じる
  present(frame: VideoFrame, presentationMs: number | null): boolean;
  // 今フレームを出せるか
  isAvailable(): boolean;
}

interface VideoPlayoutPacing {
  // フレームを積んだ時点で、表示周期を待たずに表示するか
  drainImmediately: boolean;
  // 1 つの表示周期に表示する枚数の上限 (すべて表示するときは Number.POSITIVE_INFINITY)
  framesPerDrain: number;
}

interface VideoPlayoutTiming {
  // 表示待ちの上限を超えて捨てたフレーム
  recordQueueDrop(timestamp: number): void;
  // 表示時刻を過ぎて間に合わなかったフレーム (presentationMs は表示時刻。決められない
  // ときは捨てた時刻)
  recordLateDrop(timestamp: number, presentationMs: number): void;
}
```

`pacing` は出し先によって変える。`drainImmediately` が true なら、フレームを積んだ時点で
表示時刻を過ぎているフレームを出す (ライブラリ。表示の間隔は `MediaStreamTrackGenerator` の
先のブラウザが TIMESTAMP から決める)。false なら表示周期まで待つ (moqt-devtools)。
`framesPerDrain` は 1 つの表示周期に出す枚数の上限である。省略したときに `MediaPlayout` が
渡す値は `Number.POSITIVE_INFINITY` (表示できる分をすべて出す) であり、devtools は canvas へ
直接描くため 1 にする (まとめて描くと、まとまって届いたフレームが早送りに見える)。

`timing` は、捨てたフレームの記録先である。ライブラリは映像の計器を持たないため省略し、
moqt-devtools は「受信から表示までの時間」の統計へ記録する。

### 復号へ渡した入力の記録

復号の出力には TIMESTAMP の種類が無い (`AudioData`) か、Object の位置が分からない
(`VideoFrame`)。そのため、decoder へ渡す直前に `trackAudioDecodeInput` /
`trackVideoDecodeInput` で記録し、復号の出力を push したときに対応を引く。

```typescript
// TIMESTAMP の種類。音声と映像で共通 (draft-ietf-moq-loc-04 §2.3.1.1 / §2.3.1.2)
// - "wallClock": TIMESCALE が無い TIMESTAMP (Unix epoch マイクロ秒)
// - "mediaTime": TIMESCALE がある TIMESTAMP (メディア時刻)
// - "none": TIMESTAMP が無い (decoder へは 0 を渡す)
type PlayoutTimestampKind = "none" | "wallClock" | "mediaTime";

// 復号へ渡した音声 Object の情報。内部の記録型の別名であり、形は次のとおりである
interface MediaPlayoutAudioDecodeInput {
  // "none" の音は記録しない (同じ TIMESTAMP の古い記録は消す)
  timestampKind: PlayoutTimestampKind;
  // LOC の Object の位置 (Group ID と Object ID)。音声の選別 (admit) にだけ使う。省略できる
  location?: Location | null;
  // 受信の入口で測った入力の遅れ (ミリ秒)。測れないときは省略する
  inputLagMs?: number | null;
  // 復号へ渡すまで実際に保持した時間 (ミリ秒)。復号前の遅延の段を使うときは、
  // 設定値ではなく実際に保持した時間を渡す
  intentionalDelayMs?: number | null;
}

// 復号へ渡した映像 Object の情報。内部の記録型の別名であり、形は次のとおりである
interface MediaPlayoutVideoDecodeInput {
  // "none" の映像は記録しない
  timestampKind: PlayoutTimestampKind;
  // LOC の Object の位置 (Group ID と Object ID)。選別 (admit) にだけ使う
  location: Location;
}
```

```typescript
import type { Location, MediaPlayout } from "moqt-js";

// 受信した Object を復号へ渡す直前に呼ぶ。track と decode をこの関数にまとめる。
// audioLocation は音声 Object の位置 (音声の admit にだけ使う)、videoLocation は映像
// Object の位置、inputLagMs と intentionalDelayMs は受信側で測った値である
function onEncodedObject(
  playout: MediaPlayout,
  audioDecoder: AudioDecoder,
  videoDecoder: VideoDecoder,
  audioChunk: EncodedAudioChunk,
  videoChunk: EncodedVideoChunk,
  audioLocation: Location,
  videoLocation: Location,
  inputLagMs: number,
  intentionalDelayMs: number,
): void {
  playout.trackAudioDecodeInput(audioChunk.timestamp, {
    timestampKind: "wallClock",
    location: audioLocation,
    inputLagMs,
    intentionalDelayMs,
  });
  playout.trackVideoDecodeInput(videoChunk.timestamp, {
    timestampKind: "wallClock",
    location: videoLocation,
  });
  audioDecoder.decode(audioChunk);
  videoDecoder.decode(videoChunk);
}

// 復号の出力で呼ぶ。push だけを呼ぶ (track は decode の前である)。
// 音声と映像の出力が別のコールバックに来る場合は、それぞれで同じ形にする
function onDecodedFrame(playout: MediaPlayout, audioData: AudioData, videoFrame: VideoFrame): void {
  try {
    playout.pushAudio(audioData);
  } finally {
    // pushAudio は AudioData を閉じない。所有権は呼び出し側に残る
    audioData.close();
  }
  // present へ渡したフレームの所有権は出し先へ移る。表示しないフレームは入口が閉じる
  playout.pushVideo(videoFrame);
}
```

TIMESTAMP が無い音や映像 (`timestampKind: "none"`) は記録しない (同じ TIMESTAMP の古い記録は
消す)。復号へ渡した TIMESTAMP と復号の出力の TIMESTAMP は小数だけずれる。引けないときの
扱いは音声と映像で違う。

- 音声は、完全一致で引けないときも、音 1 つの長さの半分までの許容の中で最も近い記録を
  引く (実測では 100 マイクロ秒程度ずれる)。それでも引けないときは、直前に分かっている
  種類で補う (10 秒以内に記録が残っているとき)。種類は TIMESTAMP に TIMESCALE があるかで
  決まり、ストリームの途中で変わらないためである。補った音は位置と遅れを使わない
  (どの Object の値か決められないため)
- 映像は完全一致でしか引かない。引けないフレームは `timestampKind: "none"` として扱う
  (位置も分からないため、選別には null を渡す)

照合の詳細と根拠は `docs/AV_SYNC_DECISIONS.md` の「8. 復号の出力と投入の対応づけ」を参照
すること。

### pushAudio の結果

```typescript
type MediaPlayoutAudioResult =
  | {
      status: "played";
      rebased: boolean;
      catchUpStarted: boolean;
      timestampKind: PlayoutTimestampKind;
    }
  | {
      status: "dropped";
      reason: "backlog";
      rebased: boolean;
      catchUpStarted: boolean;
      timestampKind: PlayoutTimestampKind;
    }
  | {
      status: "error";
      error: Error;
      rebased: boolean;
      catchUpStarted: boolean;
      timestampKind: PlayoutTimestampKind;
    }
  | { status: "notAdmitted"; timestampKind: PlayoutTimestampKind }
  | { status: "skipped"; timestampKind: PlayoutTimestampKind };
```

`played` は鳴らすと決めて予約した音、`dropped` は並べすぎで捨てた音、`error` は鳴らす準備の
途中で失敗した音 (計器には「鳴らなかった (error)」として記録する) か、`admit` /
`hasCounterpart` が throw した音 (計器へは記録しない) である。`notAdmitted` は
`audio.admit` が false を返した音 (時間軸へも計器へも記録しない)、`skipped` は音声を構成して
いないか、鳴らす先が無い音である。`admit` は鳴らす先が無いときも呼ばれるが、戻り値は
`skipped` が優先される (`notAdmitted` より先に判定する)。`admit` と `hasCounterpart` は
throw しない契約であり、throw した場合は `status: "error"` を返す。`catchUpStarted` が true
のときは、呼び出し側が復号器を作り直す (WebCodecs の `AudioDecoder.reset()` など)。復号器の
中に溜まった音は実時間と同じ速さでしか出てこないため、鳴らす側で捨てても遅れは戻らない。
判定の条件は「内部実装」の「音声の再生の組み立て (AudioPlayoutSession)」を参照すること。

### pushVideo の結果

```typescript
type MediaPlayoutVideoResult =
  | { status: "queued"; wallClockTimestamp: number | null }
  | { status: "notAdmitted" }
  | { status: "skipped" };
```

`queued` は表示待ちへ積んだフレームである。`wallClockTimestamp` は表示時刻に使った壁時計の
TIMESTAMP であり、種類が `wallClock` で時間軸を使うときだけ入る。`notAdmitted` は
`video.admit` が false を返したフレーム (閉じている)、`skipped` は映像を構成していないか、
出し先が無いフレーム、または `video.admit` / `output.isAvailable` が throw したフレームで
ある (閉じている)。`video.admit` と `output.isAvailable` は throw しない契約である。
`output.present` は表示の周期の中で呼ばれるため戻り値に現れないが、throw しない契約であり、
throw した場合は入口がフレームを閉じて同期の実績に記録しない。表示すると決めたフレームは
出し先 (`present`) へ所有権が移り、`present` の戻り値にかかわらず閉じるのは出し先である。
表示しないと決めたフレームは入口が閉じる。

閉じた `VideoFrame` を渡してはならない。WebCodecs の仕様では閉じたフレームの `timestamp` を
読めるため、入口では検出できず、表示待ちへ積んでから `present` に渡すことになる。

閉じた `AudioData` も渡してはならない。WebCodecs の仕様では、`close()` した `AudioData` の
`sampleRate` / `numberOfFrames` / `numberOfChannels` は 0、`format` は null になり、
`timestamp` は保持される (実装によっては getter が throw することもある)。`pushAudio` は
寸法を読めない音を `status: "error"` として返す。寸法が 0 として読める実装では、計器に
鳴らなかった音として残る (getter が throw する実装では記録できない)。

### 統計情報

```typescript
interface MediaPlayoutStats {
  // 音声の再生の統計 (音声を構成していないときだけ null)
  audio: {
    rebases: number; // 鳴らす時刻の基準を取り直した回数
    drops: number; // 並べすぎなどで鳴らさなかった音の数
    concealments: number; // 補間した回数
    compressedMs: number; // 波形を詰めた合計
    concealedMs: number; // 補間した合計
    latenessMs: number; // 目標を守る並べ方で最後に並べた音の遅れ
    timing: AudioPlayoutTimingSnapshot; // 鳴るはずの時刻、鳴り始める時刻、鳴らなかった量
    catchUp: AudioReceiveCatchUpStats; // 受信側の追いつきの観測値
    delay: AudioPlayoutDelayStats; // 音声へ適用した再生予算の内訳
  } | null;
  // 映像の表示の統計 (映像を構成していないときだけ null)
  video: {
    queuedFrames: number; // 表示待ちのフレーム数
    playoutDelayMs: number | null; // 表示待ちのフレームの遅れ
  } | null;
  // 音声と映像の同期の推定値。片方を構成していないとき、時間軸を使わないときは null
  avSync: AvSyncStats | null;
}
```

`getStats().audio` / `video` は、その側を構成していないときだけ null になる。`audio: {}` で
出力を付けていない間も `audio` は非 null であり、`pushAudio` は `skipped` を返す。`avSync`
は音声と映像の両方を構成し、時間軸を使うときにだけ値を持つ。壁時計の TIMESTAMP を観測して
いるかどうかの判断は、購読しているトラックを知っている呼び出し側が行う
(`createMediaSubscriber` は音声と映像の両方で壁時計の TIMESTAMP を観測するまで null を
返す)。`AvSyncStats` の定義は「MediaSubscriber」の「統計情報」を参照すること。音声だけを
使うときは `avSync` が null のため、再生予算の内訳は
`getStats().audio.delay` (`AudioPlayoutDelayStats`) から読む。

`jitterMs` と `outputLeadMs` は観測が無ければ null であり、`targetMs` は実際に適用した
自動予算である。音声だけの購読では 50 ms にする。catalog の下限と同期の補償は別に
`avSync.delays` で読み、実際の待ちとずれは `audio.timing` と併せて読む。

### ライフサイクル

- `setAudioOutput(output: AudioPlayoutOutput | null)` — 鳴らす先を差し替える (`AudioContext`
  を作り直したとき、音声の再生を止めるとき)。null を渡すと鳴らさず、以降の `pushAudio` は
  `skipped` を返す。null を渡したときは、出力の時計の対応と直前の音も捨てる (閉じた
  `AudioContext` の時計で次の音を予約しないため)。既に予約した音は `AudioContext` を閉じる
  まで鳴り続ける。音声を構成していない
  (`audio` を省略または null にした) 場合は throw する。`AudioContext` を作り直したときは、
  新しい出力を付けたあとに `resetAudioPlayback()` を呼ぶ (予約の基準を旧 `AudioContext` の
  秒のまま残さない)
- `resetAudioPlayback()` — 音声の再生の状態 (予約の基準、出力の時計の対応、追いつきの観測)
  を取り直す (`AudioContext` を作り直したとき)。計器の累積 (鳴った量、鳴らなかった量、詰め、
  補間、基準の取り直し、捨て) は購読の統計として引き継ぐため消さない
- `resetAudioTimeline()` — 時間軸から音声の状態だけを消す (音声の再生を止めたとき)。残すと
  共有の再生遅延に音声の下限が残り、映像の表示が音声を一度も再生していない購読より遅れた
  まま固定される
- `resetPlayout()` — 時間軸の基準と学習を取り直し、映像の表示待ちと復号へ渡した映像入力の
  対応表を捨てる。音声の追いつきの観測も消す。音声の予約の基準と計器の累積は消さない
  (`preDecodeDelayMs` の設定を変えたときや、購読を始めるとき)
- `clearAll()` — 時間軸の基準と学習、復号へ渡した入力の対応表、映像の表示待ちを捨てる
  (購読の停止)。計器の累積と追いつきの観測は残す (追いつきの観測は次の
  `resetAudioPlayback()` で消える)
- `recordAudioStopped()` — 予約済みで鳴り終わっていない音を「切った量」として計器へ残す
  (出力を閉じる直前)
- `drainAudio(options)` — 予約済みの音が鳴り終わるまで待つ (停止時)。待ち時間の上限 (既定は
  `AUDIO_PLAYOUT_DRAIN_MAX_MS` = 300 ms) で鳴り終わらなかった分は「切った量」として計器へ残る
- `clearVideoQueue()` — 表示待ちの映像を捨て、予約した表示を取り消し、復号へ渡した映像入力
  の対応表も消す
- `setTargetLatencyMs(value)` — 表示の遅れの目標を変える (catalog の `targetLatency` が
  更新されたとき)。0 以上の有限数だけを受け付け、範囲外は throw する。null で目標を
  使わない。catalog の負の値はライブラリが null に正規化してから渡す
- `setIntentionalDelayMs(value)` — 復号の出力で入力が引けなかったときに使う、意図した復号
  前の遅延を変える (`preDecodeDelayMs` の設定が変わったとき)
- `getStats()` — 統計情報を読む

`drainAudio` は、flush した Object の復号の出力を待つ条件 (`isFlushSettled` など) と、flush
した件数 (`flushedObjects`) も受け取れる。待っても鳴り終わらなかった分は、計器に「切った
量」として残る。既定の上限は `AUDIO_PLAYOUT_DRAIN_MAX_MS` = 300 ms (通常の停止) であり、
終端の停止 (`close()`) では呼び出し側が `AUDIO_PLAYOUT_DRAIN_CLOSE_MAX_MS` = 150 ms を
`maxWaitMs` に渡す。`maxWaitMs` は呼び出し時に検証し、範囲外なら非同期の reject になる
(`drainAudio` は Promise を返す)。

```typescript
interface MediaPlayoutDrainOptions {
  // drain を待つ上限 (ミリ秒)。既定は AUDIO_PLAYOUT_DRAIN_MAX_MS (300 ms)。
  // 終端の停止では AUDIO_PLAYOUT_DRAIN_CLOSE_MAX_MS (150 ms) を呼び出し側が渡す。
  // 有限数で 0 以上 (違反は非同期の reject)
  maxWaitMs?: number;
  // 復号前の段から flush した Object の復号出力を待ち終えたか。
  // false の間は drain を終えない (予約が尽きていても復号の出力がまだ届いていない)
  isFlushSettled?: () => boolean;
  // flush した Object の件数 (計器に残す)
  flushedObjects?: number;
  // flush したが、まだ復号の出力が届いていない Object の数を返す
  remainingFlushedObjects?: () => number;
}

interface MediaPlayoutDrainStats {
  pendingMsAtStart: number; // drain を始めた時点で予約されていた長さ (ミリ秒)
  requestedMs: number; // drain で待つと決めた上限の時間 (ミリ秒)
  waitedMs: number; // 実際に待った時間 (ミリ秒)
  playedMs: number; // drain で鳴らすことになった合計 (ミリ秒)
  cutMs: number; // 上限で切った長さ (ミリ秒)
  flushedObjects: number; // 停止時に復号前の段から flush した Object の件数
  undecodedFlushedObjects: number; // flush したが、drain の終了までに復号の出力が届かなかった件数
}
```

```typescript
// playout は createMediaPlayout() で作った入口、audioContext は作成に使った AudioContext である

// 停止の例 (音声を鳴らし切ってから、映像は残したまま音声だけを止める)
await playout.drainAudio({ maxWaitMs: 300 });
playout.setAudioOutput(null);
playout.resetAudioTimeline();
playout.resetAudioPlayback();

// 購読を終える例 (すべてを捨てて、鳴っている音も止める)
playout.recordAudioStopped();
playout.setAudioOutput(null);
playout.clearAll();
await audioContext.close();
```

`setAudioOutput(null)` は以降の `pushAudio` を `skipped` にし、出力の時計の対応と直前の音を
捨てるが、既に `AudioContext` へ予約した音は鳴り続ける。予約済みの音を止めるには
`AudioContext` を閉じる (ブラウザが予約を破棄する)。`recordAudioStopped()` は閉じる直前の
残りを計器へ「切った量」として残すだけで、音は止めない。

```typescript
// AudioContext を作り直す例。oldAudioContext は作り直す前の AudioContext、
// sampleRate は音声トラックのサンプルレートである
// 出力を外すと、時計の対応と直前の音も捨てる (閉じる直前に外す)
playout.setAudioOutput(null);
await oldAudioContext.close();

const nextAudioContext = new AudioContext({ sampleRate });
playout.setAudioOutput({
  context: nextAudioContext,
  destination: nextAudioContext.createMediaStreamDestination(),
});
// 新しい出力を付けたあとに呼ぶ (予約の基準を新しい Context の秒で作り直す)
playout.resetAudioPlayback();
```

`createMediaSubscriber` は、購読の停止で `drainAudio` → `setAudioOutput(null)` →
`clearAll()` を呼び、購読を始めるとき (`AudioContext` を作り直すとき) に
`setAudioOutput(新しい出力)` → `resetAudioPlayback()` → `resetPlayout()` を呼ぶ。

---

## 受信の経路で使う公開 API

受信から復号へ渡すまでを自分で組み立てるときに使う公開 API である。`createMediaSubscriber`
はこの経路を内部で組み立てるため、通常は使わない。

- `VideoDecodeOrder` — Object を復号してよいかを Group の順序と参照するフレームの欠落から
  決める (`priorObjectIdGapOf` も公開する)
- `GroupSwitchGate` — 前の Group の Subgroup の stream が開いている間、次の Group の Object を
  保留する (draft-ietf-moq-transport-22 Section 2.1 の順不同の到着への対応)
- `CatchUpGate` — relay の cache から追いつく途中の Object を、SUBSCRIBE_OK の
  LARGEST_OBJECT を境界に選別する (`CatchUpDecision` も公開する。
  draft-ietf-moq-transport-22 Section 9.20.17)

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
// 一時停止（エンコード停止 + 開いている Subgroup を閉じる）
publisher.pause();

// 再開
publisher.resume();
```

### 新しい Group の要求

```typescript
// 品質回復などで新しい Group の開始を要求する (映像は Group の先頭がキーフレームになる)
await subscriber.requestNewGroup();
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

購読側は、カタログの live 更新を SUBSCRIBE (Next Object) で受けながら、既存の
カタログを FETCH で取得する。FETCH の要求には必ず Location Filter を載せる
(`LARGEST_OBJECT` が不明なときも絶対位置 `{0, 0}` を明示する)。Location Filter を
省略した FETCH は送らない。FETCH の応答が期限内に終わらない場合も、SUBSCRIBE で
届いた完全なカタログは破棄せず、受信タイムアウトの時点で適用して開始する。
カタログを受け取れないまま受信タイムアウト (5000 ms) を過ぎると `start()` は
`catalog receive timeout` で失敗する。

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
    ├─► AudioTrack ─► AudioFrameSource ─► AudioEncoder ─► MOQT Publisher (audio)
    │                       │                   │
    │                       │             LOC Properties
    │                       │
    │                       └─ MediaStreamTrackProcessor があればそれを使い、無ければ
    │                          Web Audio の AudioWorklet で AudioData を組み立てる
    │
    └─► VideoTrack ─► VideoFrameSource ─► VideoEncoder ─► MOQT Publisher (video)
                             │                   │
                             │             LOC Properties
                             │
                             └─ MediaStreamTrackProcessor があればそれを使い、無ければ
                                requestVideoFrameCallback で代替する
```

音声の取り出し方が 2 つあるのは、ブラウザの実装が揃っていないためである。Safari は
`MediaStreamTrackProcessor` を DedicatedWorker にしか公開しておらず (WebKit の IDL は
`Exposed=DedicatedWorker`)、Worker へ `MediaStreamTrack` も渡せない。さらに WebKit の実装は
映像トラック専用であり、音声トラックを渡すと `TypeError` になる。Firefox は実装していない。
そのため、この 2 つのブラウザでは Web Audio の `AudioWorklet` で生のサンプルを取り出し、
`AudioData` を組み立てる (`src/audioSource.ts`)。サンプルレートとチャンネル数は
`AudioContext` と `AudioWorkletNode` の設定で決まるため、マイクがモノラルでも符号器の設定と
食い違わない (Safari は `channelCount` 制約を実装しておらず、`getSettings()` も返さない)。

### MediaSubscriber 内部構成

```
MOQT Subscriber (audio) ─► AudioDecoder ─► AudioData ─┐
        │                                             │
  LOC Properties                                      ├─► 再生の入口 (MediaPlayout)
                                                      │
MOQT Subscriber (video) ─► VideoDecoder ─► VideoFrame ┘
        │
  LOC Properties
```

再生の入口は、音声を `AudioContext` とその出力 (`MediaStreamAudioDestinationNode`) へ、映像を
`MediaStreamTrackGenerator` の writer へ渡す。`createMediaSubscriber` はこの 2 つの出力から
`MediaStream` を組み立てる。

### 再生の組み立て

`MediaPlayout` の内部は、次のモジュールに分かれる。同じ組み立てを 2 か所に置くと、到着基準の
遅れ、到着と出力時計からの予算の計算、計器の修正を毎回 2 か所へ入れることになり、
片方だけを直すと音声と
映像で判断がずれて A/V 同期が崩れる。

- `AudioPlayoutSession` / `VideoPlayoutSession` — 音声 1 つを鳴らす組み立てと、映像 1 枚を
  表示する組み立て (下記)
- `PlayoutTimeline` — 音声と映像で共有する表示時刻の時間軸。同期の推定と遅延の学習を持つ
- `PlayoutBuffer` — 復号したフレームを表示時刻に合わせて選ぶキュー
  (`MAX_PRESENTATION_LAG_MS` を超えて遅れたフレームを late として返す)
- `VideoDecodeInputs` / `AudioDecodeInputs` — 復号へ渡した入力の対応表 (音声と映像で別)
- `AudioReceiveCatchUp` — 受信側の音声の追いつきの判定と観測

#### 音声の再生の組み立て (AudioPlayoutSession)

`AudioPlayoutSession` は、復号済みの音声 1 つを鳴らすまでの組み立てを 1 か所にまとめる。
`MediaPlayout` が `audio` オプションから 1 つ作る。受け取るのは、復号した音 (`AudioData`) と、
その音の TIMESTAMP の種類 (LOC の TIMESTAMP と TIMESCALE から決める。
draft-ietf-moq-loc-04 §2.3.1.1 / §2.3.1.2) である。渡すと次を行う。

- 共有の時間軸への到着の記録と、目標の開始時刻の決定
- `AudioPlayoutScheduler` での予約 (遅れて届いた音は波形を詰めて目標へ戻し、並べすぎは捨てる)
- 欠落した区間の補間 (直前に鳴らした音の末尾を伸ばす)
- 計器 (`AudioPlayoutTimingStats`) への記録 (鳴るはずの時刻、届いた時刻、鳴り始める時刻と、
  鳴らなかった量)
- 実出力の先行量の観測と予算の更新、および予約の残差を使った同期の更新
- 受信側の追いつきの判定 (`AudioReceiveCatchUp`)。復号の出力が送られた TIMESTAMP から
  遅れ続けたら、復号器を作り直す必要があることを結果 (`catchUpStarted`) で知らせる

Web Audio (`AudioContext` とその出力) は `AudioPlayoutOutput` として渡す。`AudioContext` の
時計と `performance.now()` の対応は `AudioClockBridge` が境界になる。再開直後などで
`getOutputTimestamp().performanceTime` が 0 の間は `currentTime` で代用し、出力の残差を学習
しない。代用値は現在の 2 時計から取り直す。同じ Context の停止と再開でも古い対応を持ち越さ
ず、停止していた時間を未来の予約として扱わない。

44.1 kHz の音声も時間圧縮と補間に対応する。周期を探す解析用の信号だけを 48 kHz へ変換し、
元の音声は元のレートのまま処理する。相関が足りない波形では圧縮しない。96 kHz などの非対応
レートは加工せず、`stretchUnavailableFrames` に数える。

`timestampKind` の対応付け (完全一致で引けないときは許容の中の最も近い記録を引き、引けない
ときは直前に分かっている種類で補う) は `src/playout/decodeInputTimestamps.ts` が持つ。
根拠と実測は `docs/AV_SYNC_DECISIONS.md` の「8. 復号の出力と投入の対応づけ」にある。

受信した音声は、復号器 (WebCodecs の `AudioDecoder`) の中に未処理の音が溜まると、溜まった分
だけ復号の出力が送られた TIMESTAMP から遅れたまま固定される。溜まった分は実時間と同じ速さで
しか出てこないため、待っても戻らない。鳴らす音を捨てても、捨てた分は復号器から出てきた後の
音であり、中の分は減らない。

`AudioReceiveCatchUp` は、復号の出力の遅れ (復号の出力を受け取った壁時計 -
`AudioData.timestamp`) を観測し、(1) 健全時の遅れ (床) から `AUDIO_RECEIVE_CATCH_UP_GROWTH_MS`
(40 ms) を超えたまま `AUDIO_RECEIVE_CATCH_UP_CONFIRM_MS` (100 ms) 続いたとき、または (2) 床
から `AUDIO_RECEIVE_CATCH_UP_JUMP_MS` (100 ms。A/V 同期で合わせられる量の上限と同じ) を
超えたときに、結果の `catchUpStarted` を true にする。復号器を作り直すと、中に溜まっていた
音が捨てられ、次に復号されるのは最後に届いた Object になる。

購読側が `MediaSubscriberOptions.preDecodeDelayMs` で復号を意図的に遅らせているときは、
記録する入力の `intentionalDelayMs` に、設定値ではなく復号へ渡すまで実際に保持した時間を
渡す (保持上限を超えて期限を前倒しした区間があるため、設定値と実際の保持時間は一致しない)。
追いつきは、出力の遅れから入力の遅れと意図した遅延を引いた値で判定するため、意図した遅延を
復号器の詰まりと誤判定しない。意図した遅延を超えて復号器が遅れた場合は `catchUpStarted` が
true になる。

鳴らす音は捨てない (鳴らなかった音として数えない)。復号器が捨てた音は鳴らす側へ出てこない
ため、`missedFrames` を「受信側が実時間に追いつけていない証拠」として保つためである。飛んだ
音は復号の出力の timestamp の跳びから測り、`skippedFrames` / `skippedMs` に出す。遅れが上限へ
戻るまでは `AUDIO_RECEIVE_CATCH_UP_COOLDOWN_MS` (1 秒) ごとに作り直しを重ねる (1 回で戻らない
状態があるため)。閾値と根拠は `docs/AV_SYNC_DECISIONS.md` の「10. 受信側の追いつき」にある。

`AUDIO_RECEIVE_CATCH_UP_*` の定数と `AudioReceiveCatchUpStats` は `moqt-js` から import できる
(`AudioReceiveCatchUp` のクラス自体は公開していない)。

`MediaPlayout` は、復号の出力を `handleDecodedAudio` へ渡す。停止と `AudioContext` の
作り直しの手順は「再生の入口 (MediaPlayout)」の「ライフサイクル」を参照すること。

#### 映像の表示の組み立て (VideoPlayoutSession)

`VideoPlayoutSession` は、復号済みの映像フレーム 1 枚を表示するまでの組み立てを 1 か所に
まとめる。`MediaPlayout` が `video` オプションから 1 つ作る。受け取るのは、復号したフレーム
(`VideoFrame`) と、そのフレームの TIMESTAMP の種類 (LOC の TIMESTAMP と TIMESCALE から決める。
draft-ietf-moq-loc-04 §2.3.1.1 / §2.3.1.2) である。渡すと次を行う。

- 共有の時間軸への到着の記録と、表示時刻の決定
- 表示待ちのキュー (`PlayoutBuffer`) への積み込みと、あふれた分の破棄
- 表示周期ごとの選択 (表示時刻を過ぎたフレームを順に表示する。`MediaPlayout` が既定で渡す
  `framesPerDrain: Number.POSITIVE_INFINITY` では表示できる分をすべて表示し、間に合わなかった
  分を捨てる。`framesPerDrain: 1` にすると 1 つの表示周期に 1 枚だけ表示する)
- 表示の実績 (実際に表示した時刻 - TIMESTAMP) の時間軸への記録
- 計器 (`VideoPlayoutTiming`) への記録 (あふれて捨てた分と、間に合わなかった分)

表示の出し先は `VideoPlayoutOutput` として注入する。表示周期の予約は `requestAnimationFrame`
を既定に使う。`VideoPlayoutSession` 単体は予約の関数を注入できるため、ブラウザ API の無い
環境では記録用の最小のオブジェクトで検証できる。

`VideoDecodeInputs` は、復号の出力 (`VideoFrame`) では Object の位置が分からないため、
decoder へ渡したときの TIMESTAMP で引けるように覚えておく対応表である。`remember` で覚え、
`take` で 1 回だけ引ける (引くと忘れる)。TIMESTAMP を持たない Object は覚えない (decoder へ 0
を渡すため、同じ TIMESTAMP の Object を誤って対応づける)。`forgetOnDuplicate` は位置を使う
かで決める。位置を relay の cache からの追いつきの判定 (`CatchUpGate`) に使うときは true に
して、重なった TIMESTAMP の分を忘れる (どちらの位置か決められないため)。TIMESTAMP の種類だけ
を使うときは false にして、後から来た種類で上書きする。

`MediaPlayout` は、復号の出力を `VideoPlayoutSession.handleDecodedFrame` へ渡す。

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
届く設定 / 実装で働く。

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
