# 送る音声の TIMESTAMP が壁時計から遅れていき、受信側で基準の取り直しが続く

- Created: 2026-09-25
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-audio-timestamp-drift
- Polished: {YYYY-MM-DD}
- Reporter: @voluntas

## 目的

moqt-devtools で長く配信すると、受信側で音声の「鳴らす時刻 - TIMESTAMP」が伸び続けた。音声は 1 秒に約 50 個のまま実時間どおりに届いていたため、送る側が付ける音声の TIMESTAMP が壁時計から少しずつ遅れていったとみている。LOC の TIMESTAMP (draft-ietf-moq-loc-04 Section 2.3.1.1) は壁時計の取得時刻であり、ずれると受信側の再生の基準 (`src/audioPlayout.ts`) が合わなくなって取り直しが続き、映像との時刻の対応も崩れる。

## 現状

- `devtools/src/hooks/usePublisher.ts` の `handleAudioEncodedChunk` と `src/createMediaPublisher.ts` は、LOC の TIMESTAMP を `LOC.toUnixEpochMicroseconds(BigInt(chunk.timestamp), performance.timeOrigin)` で求める。`chunk.timestamp` (AudioEncoder の出力、元は MediaStreamTrackProcessor の `AudioData.timestamp`) が `performance.now()` と同じ時計のマイクロ秒であることを前提にしている
- 実測 (2026-09-25、配備の relay、moqt-devtools、headless Chromium の偽のマイク): 受信側で測った「鳴らす時刻の壁時計 - TIMESTAMP」は、10 秒で 217 ms、200 秒で 4802 ms、336 秒で 16027 ms と伸び続けた。この間、鳴らす時刻までの余裕は 300 ms 以下で、復号した音声は 1 秒に約 50 個だった。映像の遅れ (TIMESTAMP から表示まで) は約 32 ms のままだった
- 本物のマイクで同じことが起きるかは確かめていない

## 設計方針

- まず原因を確かめる。送る側で `performance.now() * 1000 - AudioData.timestamp` の推移を、偽のマイクと本物のマイクで 10 分以上記録する
  - 伸び続けるなら、`AudioData.timestamp` は `performance.now()` の時計ではない (サンプル数から数えている、取りこぼしを数えないなど)。TIMESTAMP の求め方を見直す
  - 伸びないなら、送る側の音声の処理が実時間に追いついておらず、溜まった音を後から送っている。どこで溜まるかを調べる
- 見直すときも、LOC の TIMESTAMP は取得した時刻の壁時計 (Unix epoch マイクロ秒) のままにする

## 完了条件

- 原因を特定し、同じ条件で 10 分以上流して、受信側の「鳴らす時刻 - TIMESTAMP」が伸び続けない
- `vp check` / `tsc --noEmit` / `vp test run` / 既存の Playwright の E2E が通る
