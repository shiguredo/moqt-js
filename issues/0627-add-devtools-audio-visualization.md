# devtools で受信した音声を可視化する

- Created: 2026-09-20
- Completed: {YYYY-MM-DD}
- Branch: feature/add-devtools-audio-visualization
- Polished: {YYYY-MM-DD}

## 目的

devtools の subscriber は受信した音声を音声出力デバイスで再生できるようにする予定だが、
相互運用の実測で毎回音を出すのは邪魔になる。既定を無音にしたうえで「音声の object が
届いて復号できているか」を確認する手段が要る。

耳に頼らずに判定できるようにすることで、CI や手元の実測で音声経路の成否を機械的に
観測できるようにする。あわせて、publisher が LOC の Audio Level property を載せているかを
画面で確認できるようにする。

## 現状

- devtools は映像を canvas に描画する (`devtools/src/components/SubscriberPanel.tsx`) が、
  音声を表示する経路が無い
- `devtools/src/hooks/useSubscriber.ts` は映像トラックだけを購読しており、音声トラックの
  購読と復号の配線が無い (音声の購読そのものは別 issue で追加する)
- LOC の Audio Level は decoder 側に実装がある (`src/loc.ts` の `AudioLevel` /
  `decodeAudioLevel` / `AudioProperties.audioLevel`、`decodeAudioProperties` が取り出す)。
  devtools は表示も統計もしていない
- `window.moqtDevTools` が公開する統計は映像と object のもので、音声の項目が無い
- `src/createMediaSubscriber.ts` は復号した音声を `MediaStreamAudioDestinationNode` に
  繋いで `outputStream` に載せるだけで、`audioContext.destination` には繋がない。
  ライブラリを使うだけでは音は出ない

## 設計方針

### 可視化は 2 系統を併記する

| 系統 | 何を描くか | 何の証明になるか |
| ---- | ---- | ---- |
| デコード信号 (主) | 復号済み `AudioData` の peak / RMS を計算し、レベルメーターと直近 N ms の波形を canvas に描く | payload が実際に復号できていること。publisher の実装に依存しない |
| LOC Audio Level (従) | object の `audioLevel` (level と voiceActivity) を小さなゲージで表示する。未報告なら「未報告」と出す | publisher が仕様の property を載せているか。載せていない publisher との差が分かる |

片方だけでは足りない。LOC の値だけでは payload が復号できているかは分からず、信号だけでは
publisher が property を載せているかは分からない。

### 計算と描画の分離

- `AudioData` から peak / RMS を求める処理は純関数 (`summarizeAudioLevel` を想定) として
  切り出し、実 `AudioData` を使う単体テストで形式と値を固定する (モック・スタブを使わない
  方針のため、`AudioData` は `devtools/src/codec-test/support.ts` と同じく実物を組み立てる)
- 描画は `devtools/src/components/AudioMeter.tsx` に分離し、signal の更新時に描く。
  映像 canvas と同じ流儀に揃え、`requestAnimationFrame` による常時再描画はしない
- `AnalyserNode` は使わない。devtools の購読は `session.subscribe` と自前
  `AudioDecoderWrapper` の経路であり、可視化のために audio graph を組む必要が無い。
  復号済み `AudioData` から直接計算すれば、再生の有無と可視化を独立に制御できる

### 統計

- `window.moqtDevTools` に音声の受信数・デコード数・最終レベル・最終 voice activity を
  足す。E2E はこれを見て音声経路の成否を判定する

### 依存

- 音声トラックの購読と復号は別 issue (`devtools にダミー音声の配信と購読を追加する`) で
  追加する。本 issue はその経路が作る signal を描画する側だけを扱う

## 完了条件

- 音声トラックを購読しているとき、レベルメーターと波形が canvas に表示される
- LOC の Audio Level が載っている object では level と voiceActivity が表示され、
  載っていない object では「未報告」と表示される
- 音声を購読していないとき・音声トラックが無い catalog のときは、メーターが非表示か
  無効状態になり、映像の表示を妨げない
- `window.moqtDevTools` から音声の統計が読める
- 上記を検証する単体テストと、相互運用 harness の E2E が通る
- `npx vp check` / `npx vp test --run` が通る

## 参照

- draft-ietf-moq-loc-04 §2.3.3.2 (Audio Level: RFC 6464 §3 の -dBov と voice activity を
  vi64 の最下位 8 bit に符号化する)
- draft-ietf-moq-loc-04 §4.1 (Application with one audio track)
- draft-ietf-moq-transport-21 §3.1 (Subscriptions)

## 解決方法

{未着手}
