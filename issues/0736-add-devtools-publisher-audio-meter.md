# moqt-devtools の publisher に音声のレベルメーターが無く、取っている音と送っている音の大きさが分からない

- Created: 2026-09-25
- Completed: 2026-09-25
- Branch: feature/add-devtools-publisher-audio-meter
- Polished: {YYYY-MM-DD}
- Reporter: @voluntas

## 目的

moqt-devtools の subscriber には音声のレベルメーター (peak / RMS / LOC Audio Level / 波形) があるが、publisher には無い。配信側で音を取れているか、どれくらいの大きさで送っているかが分からない。利用者から「配信側にも音声メータあるべきじゃない？」と指摘があった。publisher にも同じ形のメーターを置く。メーターは Preview 中から動かし、配信を始める前にマイクが音を拾っているかを確かめられるようにする (利用者と決めた)。

## 現状

- `devtools/src/components/AudioMeter.tsx` の `AudioMeter` は `SubscriberInstance` の signal (`audioPeakDbfs` / `audioRmsDbfs` / `audioLastLevel` / `audioWaveform`) を読んで描く。publisher からは使えない
- `devtools/src/hooks/usePublisher.ts` は音声のストリームを配信の開始時にしか作らない (`takeAudioTrackForPublishing`。Preview では作らない)
- publisher は送る Object ごとに LOC Audio Level (draft-ietf-moq-loc-04 Section 2.3.3.2) を求めているが (`handleAudioEncodedChunk`)、画面には出していない

## 設計方針

- `AudioMeter` を、描く値 (peak / RMS / LOC Audio Level / 波形) を受け取る形にし、publisher と subscriber で共通に使う
- publisher は Preview の開始で音声のストリームも作り (音声の入力が None 以外のとき)、配信の開始ではそのストリームを使う。Preview を止めたときと配信を止めたときに止める
- 取っている音の peak / RMS / 波形は、音声のストリームから Web Audio の AnalyserNode で求める (表示の周期ごと)。配信の経路 (MediaStreamTrackProcessor) とは別に読むため、符号化に影響しない
- LOC Audio Level は、配信中に直近に送った Object の値を出す。配信していない間は「-」
- メーターは publisher の映像の下に常に描き、音声を取っていない間は各値を「-」にする (状態で項目が出たり消えたりしないようにする)

## 完了条件

- 単体テストで、AnalyserNode の時間領域のサンプルから peak / RMS (dBFS) と波形を求める関数を固定する
- 手元で、Dummy の音声とマイク (Chromium の偽のデバイス) のそれぞれで、Preview 中と配信中にメーターが動き、配信中は LOC Audio Level も出ることを確かめる
- `vp check` / `tsc --noEmit` / `vp test run` が通る

## 解決方法

- `devtools/src/components/AudioMeter.tsx` の `AudioMeter` を、描く値の signal (peak / RMS / LOC Audio Level / 波形) と、表示の有無 (`active` / `levelActive`)、data-testid の接頭辞を受け取る形にし、publisher と subscriber で共通に使う。signal のまま受けるため、値が変わっても描き直すのはメーターだけである (subscriber のパネル全体を描き直さない)
- 取っている音の peak / RMS / 波形は、設計方針に書いた AnalyserNode ではなく、音声のトラックを複製して MediaStreamTrackProcessor で AudioData を読み、subscriber と同じ関数 (`readAudioSamples` / `summarizeAudioLevel` / `appendWaveform`) で求めることにした。送る側と受ける側の値をそのまま比べられ、AudioContext の自動再生の制限も受けないためである (`devtools/src/hooks/publisherAudioMeter.ts`)。配信の経路とは別のトラック (複製) で読むため、符号化に影響しない
- マイクの AudioData は 10 ms ごとに届くため、`devtools/src/utils/audioMeterAccumulator.ts` の `AudioMeterAccumulator` でサンプルを溜め、50 ms ごとに値を反映する
- `devtools/src/hooks/usePublisher.ts` は Preview の開始で音声も取り (`startPreviewAudio`)、Preview の停止で止める。音声のストリームを作るたびにメーターを動かし、止めるときにメーターも止めて値を消す。送った Object の LOC Audio Level (0737 で取った音から求めるようにした値) をメーターの signal に入れる
- `devtools/src/components/PublisherPanel.tsx` の映像の下にメーターを常に描き、音声を取っていない間は「-」にする
- テスト: `audioMeterAccumulator.test.ts` で、最初の AudioData ですぐに値を出すこと、間隔の間は出さずに溜めた分から求めること、波形の長さを固定した
- 手元の relay と devtools で確かめた (Dummy は生成した 440 Hz の音、マイクは Chromium の偽のデバイス)

| 入力   | 状態           | peak / RMS                          | LOC Audio Level |
| ------ | -------------- | ----------------------------------- | --------------- |
| Dummy  | 何もしていない | - / -                               | -               |
| Dummy  | Preview 中     | -12.2 / -15.3 dBFS                  | -               |
| Dummy  | 配信中         | -11.4 / -14.6 dBFS                  | -14 dBov        |
| Dummy  | 停止後         | - / -                               | -               |
| マイク | Preview 中     | -100 / -100 dBFS (ビープの間の無音) | -               |
| マイク | 配信中         | -37.4 / -43.7 dBFS                  | -47 dBov        |
| マイク | 停止後         | - / -                               | -               |

- `vp check` / `tsc --noEmit` / `vp test run` (2800 件) / Playwright の E2E (40 件) が通った
