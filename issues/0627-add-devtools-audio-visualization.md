# devtools で受信した音声を可視化する

- Created: 2026-09-20
- Completed: {YYYY-MM-DD}
- Branch: feature/add-devtools-audio-visualization
- Polished: 2026-09-20

## 目的

`devtools にダミー音声の配信と購読を追加する` (0626) で devtools の subscriber が音声を
購読・復号できるようになるが、既定では音声出力デバイスへ再生しない。再生しない状態では
「音声の object が届いて復号できているか」「publisher が LOC の Audio Level を載せて
いるか」を耳以外で確かめる手段が無い。

受信した音声を画面に可視化することで、CI や手元の実測で音声経路の成否を機械的に観測
できるようにする。

## 現状

本 issue は 0626 の完了を前提とする。以下は 0626 着手前の状態であり、0626 が完了すると
音声の購読・復号・受信 signal・音声統計の箇所が変わる。

- devtools は映像を canvas に描画する (`devtools/src/components/SubscriberPanel.tsx`) が、
  音声を表示する経路が無い
- `devtools/src/hooks/useSubscriber.ts` は映像トラックだけを購読しており、音声トラックの
  購読と復号の配線が無い (音声の購読そのものは 0626 で追加する)
- LOC の Audio Level は decoder 側に実装がある (`src/loc.ts` の `AudioLevel` /
  `decodeAudioLevel` / `AudioProperties.audioLevel`。object と track の properties を
  解決する `resolveAudioProperties` があり、0626 はこれを使う)。devtools は表示も
  統計もしていない
- `window.moqtDevTools` が公開する統計は映像と object のもので、音声の項目が無い
- `src/createMediaSubscriber.ts` は復号した音声を `MediaStreamAudioDestinationNode` に
  繋いで `outputStream` に載せるだけで、`audioContext.destination` には繋がない。
  ライブラリを使うだけでは音は出ない
- 実リレーを起動して devtools を Playwright で駆動する相互運用 harness は moqt-js に無い
  (リレー実装側のリポジトリにある)。その publisher 役は映像トラックしか広告しないため、
  音声の E2E には devtools publisher と devtools subscriber を向かい合わせる変更が要る。
  0626 §テストはこの変更を harness 側の issue として起票すると定めている

## 設計方針

### 可視化は 2 系統を併記する

| 系統                 | 何を描くか                                                                                                                     | 何の証明になるか                                                                  |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| デコード信号 (主)    | 復号済み `AudioData` の peak / RMS を dBFS で求め、レベルメーターと直近 100 ms の波形を canvas に描く                          | payload が実際に復号できていること。publisher の実装に依存しない                  |
| LOC Audio Level (従) | object の `audioLevel` (level と voiceActivity) を小さなゲージと数値で表示する。載っていない object では `not reported` と出す | publisher が仕様の property を載せているか。載せていない publisher との差が分かる |

片方だけでは足りない。LOC の値だけでは payload が復号できているかは分からず、信号だけでは
publisher が property を載せているかは分からない。

### 復号信号の計算

- `AudioData` からの読み出しと、読み出したサンプル列の計算を分ける
  - `readAudioSamples(audioData: AudioData): Float32Array` — 第 1 チャンネルを
    `allocationSize` + `copyTo` の `format: "f32-planar"` で読み出す薄い関数
    (`devtools/src/codec-test/support.ts` の `summarizeAudioData` と同じ手順)。
    `devtools/src/utils/audioLevel.ts` に置く。`AudioData` はブラウザ専用 API であり
    Node の vitest では生成できないため、この関数の検証は実ブラウザで行う
    (`tests/e2e/codec-wrappers.spec.ts` が開く codec-test ページで実 `AudioData` を使い、
    読み出したサンプル数と値域を固定する)
  - `summarizeAudioLevel(samples: Float32Array): { peakDbfs: number; rmsDbfs: number }`
    — 純関数。peak は最大絶対値、rms は二乗平均平方根で、いずれも `20 * log10(value)`。
    振幅 0 (無音) と空のサンプル列は `-Infinity` / `NaN` ではなく下限 `-100` dBFS に
    丸める
  - `appendWaveform(prev: Float32Array | null, samples: Float32Array, maxSamples: number): Float32Array`
    — 直近 100 ms を保持する純関数 (48000 Hz で 4800 サンプル)。古いサンプルから捨てる
- 単体テストは Node で動く純関数 (`summarizeAudioLevel` / `appendWaveform` /
  `formatAudioLevel` / `formatDbfs`) に限る。`vite.config.ts` の `test` 設定に
  `environment` が無く jsdom / happy-dom も未導入であり、
  `src/createMediaSubscriber.test.ts` も同じ制約を明記している
- 波形用の signal は `Float32Array` を保持する。`AudioData` の `close()` は 0626 の
  decode ハンドラが行うため、読み出しは `close()` の前に済ませる

### 描画

- `devtools/src/components/AudioMeter.tsx` に分離し、`SubscriberPanel.tsx` の映像 canvas の
  下に置く
- `useSignalEffect` で signal を購読し、更新のたびに canvas を描く
  (`requestAnimationFrame` による常時再描画はしない)
- 数値は canvas ではなく DOM のテキストでも出す (Playwright から読めるようにするため)。
  `data-testid` は `audio-meter` (ルート要素) / `audio-waveform` (canvas) /
  `audio-level` / `audio-voice-activity` / `audio-peak` / `audio-rms` とする
- 音声トラックが catalog に無いとき、その購読を開始していないときは `AudioMeter` 自体を
  描画しない (`SubscriberPanel.tsx` の Catalog 節と同じ流儀。メーターだけを無効化する
  状態は作らない。`hidden` 属性で残すと要素は DOM に残るため、E2E で「無い」ことを
  固定できない)
- `AnalyserNode` は使わない。devtools の購読は `session.subscribe` と 0626 が配線する
  自前の `AudioDecoderWrapper` の経路であり、可視化のために audio graph を組む必要が
  無い。復号済み `AudioData` から直接計算すれば、再生の有無と可視化を独立に制御できる

### 尺度

- 復号信号は dBFS。0 dBFS が最大で、下限は `-100` dBFS
- LOC Audio Level は -dBov。RFC 6464 §3 により 0 が 0 dBov (最大)、127 が -127 dBov
  (デジタル無音) であり、値が大きいほど小さい音になる
- 2 系統は同じゲージに混ぜず、別々のゲージにする。目盛りは 0 dB を右端、`-100` dB を
  左端に揃える
- level は数値をそのまま -dBov として出す (例: `-42 dBov`)。文字列化は純関数
  `formatAudioLevel(level: LOC.AudioLevel | null): string` に切り出し、`null` は
  `not reported`、それ以外は `-42 dBov (voice: on)` の形式にする。peak / RMS の表示も
  純関数 (`formatDbfs(value: number | null): string`、`null` は `not measured`) にする
- `audioLastLevel` は 0626 が「直近に受信した音声 object の Audio Level」として更新する
  (`null` は持ち越しではなく、その object に載っていないことを表す)。値が無い object を
  受けた時点で `not reported` に戻る

### 統計

- `devtools/src/testApi.ts` の `SubscriberStats` interface と `getSubscribers()` /
  `getSubscriber()` の 3 箇所に `audioPeakDbfs` (number | null) / `audioRmsDbfs`
  (number | null) / `audioLastLevel` (number | null、-dBov) / `audioLastVoiceActivity`
  (boolean | null) を足す。`getPublisher()` は対象外
- 0626 が足す `audioObjectsReceived` / `audioChunksDecoded` は変更しない
- 本 issue が足す signal (`audioPeakDbfs` / `audioRmsDbfs` / `audioWaveform`) は
  `devtools/src/signals/subscriber.ts` の `SubscriberInstance` に足す。まだ復号していない
  状態は `null` にする (`audioLastLevel` は 0626 が足す signal であり、`null` の意味は
  0626 の定義どおり「その object に Audio Level が載っていない」である)

### 変更するファイル

- `devtools/src/components/AudioMeter.tsx` (新規)
- `devtools/src/utils/audioLevel.ts` (新規。`readAudioSamples` と純関数) /
  `devtools/src/utils/audioLevel.test.ts` (新規。Node で動く純関数の単体テスト)
- `devtools/src/components/SubscriberPanel.tsx` / `devtools/src/signals/subscriber.ts` /
  `devtools/src/testApi.ts`
- `devtools/src/hooks/useSubscriber.ts` (0626 が導入する音声の decode ハンドラに、
  `close()` の前の読み出しを足す)
- `devtools/src/codec-test/audio.ts` / `devtools/src/codec-test/types.ts` /
  `tests/e2e/codec-wrappers.spec.ts` (`readAudioSamples` の実ブラウザ検証)
- `tests/e2e/devtools-audio-meter.spec.ts` (新規。メインの devtools ページ
  `devtools/index.html` を開いて `audio-meter` の有無を固定する。既存の 2 本は
  codec-test と webtransport-devtools のページを開くため、メインの devtools ページを
  開く E2E は新規になる)

## 完了条件

moqt-js 側で確認する。

- `summarizeAudioLevel` / `appendWaveform` / `formatAudioLevel` / `formatDbfs` の単体
  テストが Node で通る。無音 (振幅 0)・最大振幅・空のサンプル列・`null` の表示を固定する
- `tests/e2e/codec-wrappers.spec.ts` で、codec-test ページの実 `AudioData` から
  `readAudioSamples` がサンプル列を読み出せることを固定する
- `tests/e2e/devtools-audio-meter.spec.ts` で、メインの devtools ページを開いたとき
  (リレーを起動しないため catalog 未受信の状態) に `audio-meter` が DOM に存在しないことを
  固定する
- `window.moqtDevTools` の統計に `audioPeakDbfs` / `audioRmsDbfs` / `audioLastLevel` /
  `audioLastVoiceActivity` の 4 項目が現れる (値そのものは harness 側で確認する。0626 の
  `audioObjectsReceived` / `audioChunksDecoded` はそのまま読める)
- `npx tsc --noEmit` / `npx vp check` / `npx vp test --run` / `npx vp run e2e-test` が通る

相互運用 harness 側の音声対応 issue で確認する (本 issue では harness を変更しない)。

- 音声トラックを購読しているとき、レベルメーターと波形が `audio-meter` の中に表示され、
  `audioPeakDbfs` / `audioRmsDbfs` が `-100` dBFS より大きくなる (無音ではない)
- 実リレー経由で届いた音声 object の `audio-level` / `audio-voice-activity` に値が出る
- 音声を購読していないとき・音声トラックが無い catalog のときに `audio-meter` が
  描画されず、映像の表示を妨げない

## 参照

- draft-ietf-moq-loc-04 §2.3.3.2 (Audio Level: RFC 6464 §3 の level と voice activity を
  vi64 の最下位 8 bit に符号化する。Table 1 により Object スコープのみ)
- RFC 6464 §3 (level は -dBov で、0〜127 が 0〜-127 dBov。デジタル無音は 127。level は
  payload が符号化するサンプルの RMS で測る)
- draft-ietf-moq-loc-04 §4.1 (Application with one audio track: 音声は 1 chunk =
  1 Object = 1 Group で届くため、object 単位の値と復号単位の値が同じ粒度になる)
- draft-ietf-moq-transport-21 §3.1 (Subscriptions: 描画するのは 0626 が確立する音声
  トラックの購読で受ける object)
- `devtools にダミー音声の配信と購読を追加する` (音声の購読・復号・`audioLastLevel`
  signal・音声統計の追加元)

## 解決方法

{未着手}
