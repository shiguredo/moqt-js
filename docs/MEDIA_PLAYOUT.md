# 再生 API (MediaPlayout)

再生方式と予算の概要は [音声と映像の再生](PLAYOUT.md)、MediaStream の配信と視聴は
[高レベル API](HIGH_LEVEL_API.md) を参照すること。この文書は復号済みフレームを直接渡す API を説明する。

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

## アプリケーションが直接使う API

毎フレーム使う API は次の 5 つである。

- `trackAudioDecodeInput` / `trackVideoDecodeInput` — 復号へ渡す直前に入力の情報を記録する
- `pushAudio` / `pushVideo` — 復号の出力を渡す
- `getStats` — 統計情報を読む

再生の開始と停止、`AudioContext` の作り直しでは、続く「ライフサイクル」の API を使う。
`createMediaSubscriber` を使う場合は、この入口の API を直接呼ばない。moqt-devtools は入口を
直接使い、毎フレームの API とライフサイクルの API の両方を呼ぶ。

## 作成

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
      // 書き込みの次の vsync で表示されるため 1
      presentationLatencyTicks: 1,
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
// 利用者の操作を受けてから、出力時計と出力側の処理を準備する。
await audioContext.resume();
await playout.prepareAudio();
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
await playout.prepareAudio();

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
      // 書き込みの次の vsync で表示されるため 1
      presentationLatencyTicks: 1,
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

## オプション

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
  // 表示すると決めたフレームの出し先 (必須)。presentationLatencyTicks も指定する
  output: VideoPlayoutOutput;
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
  // 音声の同じ TIMESTAMP の入力が重なったときに、その分を忘れるか。既定は false
  // true は位置 (Object の位置) を選別に使うとき (どちらの位置か決められないため)。
  // false は後から来た種類で上書きする (種類しか使わないとき)。映像は常に FIFO で対応する
  forgetOnDuplicate?: boolean;
}
```

数値のオプションは入口で検証し、違反は throw する。`maxQueuedFrames` と
`decodeInputs.maxTracked` は 1 以上の整数、`targetLatencyMs` / `intentionalDelayMs` は
有限数で 0 以上である。範囲外の値でハングや無音を起こさないよう、構成する前に弾く。
`drainAudio` の `maxWaitMs` も呼び出し時に検証し、範囲外なら非同期の reject になる
(`drainAudio` は Promise を返す)。

resume の Promise が解決しても実出力時計がまだ止まっている場合があるため、壁時計が
予定時刻を過ぎただけでは完了しない。実出力位置を予約と同じ軸へ戻して残りを確認し、
予約終端の描画も待つ。待機の上限はこの場合にも適用する。

`targetLatencyMs` の既定は null であり、catalog の `targetLatency`
(draft-ietf-moq-msf-01 §5.2.8) を解決した値を渡す。同じ render group と alternate group の
track が同じ値を持つことは MUST だが、音声と映像で同じ値を使うこと自体は MUST ではない。
この入口は 1 つの値しか持てないため、呼び出し側が同じ group の track に同じ値を載せて渡す
(ライブラリは catalog から解決した 1 値を渡す)。catalog の `targetLatency` が負や非有限の
ときは、宣言が無いものとして null を渡す (ライブラリはそう解決する)。

`decodeInputs.maxTracked` の既定 256 は、音声の通常の購読では足りる。relay の cache から
まとめて復号する購読では、復号へ渡してから復号の出力が届くまでの件数が数百以上に増える
ため不足し得る。moqt-devtools は 8192 を渡す。

## 音声を構成する場合と省略する場合

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

## 公開している型と値

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
  `VideoPlayoutTiming`
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
  // AudioContext のサンプルレート (Hz)。復号フレームのレートと違う場合は、
  // バッファごとのリサンプルが入る条件を計器へ記録する。実出力のクリックは別に検証する
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

## 映像の出し先と表示の周期

表示の出し先は `VideoPlayoutOutput` として注入する。ライブラリは `MediaStreamTrackGenerator`
の writer、moqt-devtools は canvas へ出す。`present` は true / false にかかわらず、渡された
フレームの所有権を受け取り、閉じる責任を負う。false を返したときは、同期の実績として記録
しないだけで、フレームを閉じるのは出し先である。`isAvailable` が false を返したときは、
フレームを表示せずに閉じ、表示待ちのフレームも捨てる (出せないままメモリを占め続けない
ため)。`present` と `isAvailable` は throw しない契約である。throw した場合は、入口が
フレームを閉じて表示しない扱いにする。

```typescript
interface VideoPlayoutOutput {
  // 表示先の提示遅延 (表示周期の tick 数、0〜4 の整数。実用値は 0〜2)。present() を
  // 呼んでから実際に表示されるまでの遅延を表す。canvas への描画は rAF のコールバック内で
  // その vsync に含まれるため 0、MediaStreamTrackGenerator は書き込みの次の vsync で
  // 表示されるため 1
  presentationLatencyTicks: number;
  // フレームを表示する。presentationMs は時間軸が決めた表示時刻
  // (performance.now() と同じ軸のミリ秒)。届いた順に表示するフレームは null。
  // true / false にかかわらずフレームの所有権を受け取り、必ず閉じる
  present(frame: VideoFrame, presentationMs: number | null): boolean;
  // 今フレームを出せるか
  isAvailable(): boolean;
}

interface VideoPlayoutTiming {
  // 表示待ちの上限を超えて捨てたフレーム
  recordQueueDrop(timestamp: number): void;
  // 提示しなかったフレーム (表示時刻を過ぎたフレームと、同じ表示周期に重なって
  // 提示できなかったフレーム)。presentationMs は表示時刻。決められないときは捨てた時刻
  recordLateDrop(timestamp: number, presentationMs: number): void;
}
```

表示は rAF の tick ごとに 1 枚だけ行う。書き込み tick の時刻に `presentationLatencyTicks` を
足した時刻を目標の表示時刻とし、その時刻に最も近いフレームを表示周期の半分の許容幅で選ぶ。
目標より古いフレームは原則として提示せずに捨てる (遅れて提示すると、次のフレームを早く
出して表示間隔が半分になるため)。ただし、目標に合うフレームがキューに無く、目標に最も近い
フレームの遅れが `MAX_PRESENTATION_LAG_MS` (20 ms) 以内なら、表示を止めないため 1 枚だけ
遅れて提示する。`presentationLatencyTicks` が 1 の `MediaStreamTrackGenerator` は、
書き込みの次の vsync で表示されるため、表示時刻の 1 tick 前に書き、遅れてよい上限も
1 tick の分だけ広げる。時間軸の映像の表示の遅れが 1 tick 未満のときは、書き込みの次の
vsync より前に表示できないため、最も近い vsync ではなく次の vsync に表示される
(フレームは捨てない)。

`timing` は、捨てたフレームの記録先である。ライブラリは映像の計器を持たないため省略し、
moqt-devtools は「受信から表示までの時間」の統計へ記録する。

## 復号へ渡した入力の記録

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

## pushAudio の結果

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

## pushVideo の結果

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

## 統計情報

```typescript
interface MediaPlayoutStats {
  // 音声の再生の統計 (音声を構成していないときだけ null)
  audio: {
    rebases: number; // 鳴らす時刻の基準を取り直した回数
    drops: number; // 並べすぎなどで鳴らさなかった音の数
    concealments: number; // 補間した回数
    compressedMs: number; // 波形を詰めた合計
    concealedMs: number; // 補間した合計
    latenessMs: number; // 最後の予約の目標超過。到着基準では到着 + 予算からの超過
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

## 音声出力の準備

`createMediaPlayout` へ音声の出力を渡した場合は、最初の `pushAudio` より前に
`await playout.prepareAudio()` を呼ぶ。AudioContext を作り直したときも、出力の付け替えと
`resetAudioPlayback()` の後に準備を待つ。準備前の投入は `status: "error"` を返す。
実 AudioContext は `resume()` → `prepareAudio()` の順で呼ぶと、起動時の実出力時計も確認する。
意図的に停止した Context と OfflineAudioContext では、モジュールと制御の受理を確認する。
OfflineAudioContext に予約を先行投入して描画する場合は、予約後にも prepareAudio を待ってから startRendering を呼ぶ。

CSP でスクリプトの実行を制限する場合は、AudioWorklet の読み込みと、同梱する数値カーネルの
WebAssembly コンパイルを許可する。`script-src` を指定する構成では `'wasm-unsafe-eval'` を含める
([CSP の WebAssembly 制御](https://www.w3.org/TR/CSP3/))。

欠落時の補間と実音への復帰は AudioWorklet が出力時計で判断する。
正常到着のたびに 100 ms 分の予測音を作る処理は行わない。
補間量と未補間区間は出力スレッドから非同期に通知されるため、投入直後の統計値を
再生済みの実績と同一視しない。`createMediaSubscriber` は媒体の購読前に準備を行う。

## 旧音声遅延制御からの移行

2026-10-29 の変更で、`AudioDelayEstimator` と `AudioDelayFeedback` を削除した。
過去の穴や圧縮量で上限を 160 ms へ広げる制御は行わず、到着の揺らぎと実出力時計の
先行量から予算を決める。統計を読むアプリケーションは、名前と値の意味を合わせて変更する。

| 旧 API / フィールド                                          | 現行での扱い                                                                           |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| `MediaPlayout.getStats().audio.delayFeedback`                | `audio.delay` へ変更                                                                   |
| `AvSyncStats.delays.audioDelayFeedback`                      | `delays.audioDelay` へ変更                                                             |
| `AudioDelayFeedbackSnapshot`                                 | `AudioPlayoutDelayStats` へ変更                                                        |
| `appliedMs`                                                  | `MediaPlayout` の `audio.delay.targetMs` で、実際に適用する自動予算を読む              |
| 旧 `targetMs`                                                | 閉ループの内部目標は削除。新 `targetMs` は適用する自動予算であり、意味が異なる         |
| `jitterTargetMs`                                             | 新 `jitterMs` は到着の揺らぎそのもの。旧ヒストグラムの目標や下限を含む値とは一致しない |
| `reason` / `lastChangeMs` / `adjustments`                    | 制御の理由と回数は削除。到着の `jitterMs` と出力の `outputLeadMs` を読む               |
| `ceilingMs` / `appliedCeilingMs`                             | 上限拡大の計器は削除。catalog の明示下限は `avSync.targetLatencyMs` で別に読む         |
| `compressionMsPerSecond`                                     | 削除。加工量は `audio.compressedMs` の累積で読む                                       |
| `AudioDelayFeedbackObservation` / `AudioDelayFeedbackReason` | 型を削除                                                                               |
| `AudioPlayoutTimingStats.audioDelayFeedback()`               | メソッドを削除。表示用の `snapshot()` は維持                                           |

表の `audio.delay` は `MediaPlayout` の統計である。`MediaSubscriber` の `getStats()` へ同名の
フィールドは追加していない。`MediaSubscriber` は `audio.playoutTiming` と `avSync.delays`、
devtools の表示用スナップショットは `audio.audioDelay` を使う。

`avSync.delays.audioDelay` は時間軸が推定した予算であり、`MediaPlayout` の `audio.delay` は
その音声に適用した予算を持つ。音声だけの購読では後者の `targetMs` は 50 ms になる。
両者とも `targetMs` に catalog の明示下限や同期の補償は含めず、実際の待ちは `audio.timing` と
遅延の内訳を併せて読む。

`outputLeadMs` は有効な出力時計で得た観測値である。時計を代用している間も以前の観測値が
残る場合があるため、A/V の推定があるときは `avSync.audioClockFallback` も確認する。
予算の観測を消すには `resetAudioTimeline()` または `resetPlayout()` を使う。出力先の差し替えや
`resetAudioPlayback()` だけでは時間軸の観測は消えない。時間軸を初期化した後は、再び
有効な時計を観測するまで `outputLeadMs` は null になる。

## ライフサイクル

- `prepareAudio(output?: AudioPlayoutOutput | null)` — 音声の投入前に出力側の初期化を待つ。
  引数を省略すると、現在の出力を準備する。出力を渡す場合は、音声の投入を止めた状態で準備を先行する。
  準備中に別の出力へ投入しない。出力先の付け替えは setAudioOutput で行う。
  AudioContext を作り直した場合も再度待つ。音声を構成していない場合と出力が null の場合は何もしない
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
- `clearVideoDecodeInputs()` — decoder の復旧・再構成後、未出力の映像入力の対応だけを消す。
  復号済みの表示待ちと時間軸は維持する。次の入力を渡す前に呼ぶ
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
await nextAudioContext.resume();
await playout.prepareAudio();

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
await nextAudioContext.resume();
await playout.prepareAudio();
```

`createMediaSubscriber` は、購読の停止で `drainAudio` → `setAudioOutput(null)` →
`clearAll()` を呼び、購読を始めるとき (`AudioContext` を作り直すとき) に
`setAudioOutput(新しい出力)` → `resetAudioPlayback()` → `resetPlayout()` → `prepareAudio()` を呼ぶ。

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
