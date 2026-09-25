# moqt-devtools の publisher に音声のレベルメーターが無く、取っている音と送っている音の大きさが分からない

- Created: 2026-09-25
- Completed: {YYYY-MM-DD}
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
