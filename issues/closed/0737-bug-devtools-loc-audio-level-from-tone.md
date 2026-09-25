# moqt-devtools の publisher が LOC Audio Level を取った音ではなく生成したトーンから求め、マイクの音と食い違う

- Created: 2026-09-25
- Completed: 2026-09-25
- Branch: feature/fix-devtools-loc-audio-level-from-samples
- Polished: {YYYY-MM-DD}

## 目的

moqt-devtools の publisher は、送る音声の Object に LOC Audio Level (draft-ietf-moq-loc-04 Section 2.3.3.2) を載せる。この値を、取った音からではなく、ダミー音声のトーンを timestamp から作り直して求めている。音声の入力がダミーだけだった間は同じ値になったが、0735 でマイクを選べるようにしたため、マイクの音を配信すると、音の大きさと無関係な (トーンの) 値を送る。RFC 6464 Section 3 は audio level を「ペイロードが符号化するサンプルの RMS」で測ると定めており、これに反する。

配信側の音声メーター (0736) に送った LOC Audio Level を出す前に直す。

## 現状

- `devtools/src/hooks/usePublisher.ts` の `handleAudioEncodedChunk` は、`resolveAudioLevelForTimestamp(sampleRate, channels, chunk.timestamp)` で LOC Audio Level を求める
- `resolveAudioLevelForTimestamp` は、`createToneSamples` (`devtools/src/webcodecs-devtools/utils/dummyAudio.ts`) で chunk の timestamp の位置のトーンを 20 ms 作り直し、`summarizeToneLevel` で RMS から -dBov を求める
- `processAudioFrames` は音声のトラックから読んだ AudioData をそのまま AudioEncoder へ渡し、サンプルを見ない

## 設計方針

- `processAudioFrames` で AudioData を符号化へ渡す前に、全チャンネルのサンプルの二乗和、数、peak を、AudioData の timestamp と duration と一緒に記録する
- 符号化された chunk の時間の範囲 (timestamp から duration の間、duration が無ければ 20 ms) に重なる記録を合わせて RMS と peak を求め、`summarizeToneLevel` と同じ規則で -dBov と voiceActivity にする (規則は共通の関数にする)
- 記録は chunk を送るたびに古い分から捨てる
- ダミー音声では、取った音がトーンそのものなので値は変わらない
- `resolveAudioLevelForTimestamp` は取り除く

## 完了条件

- 記録から chunk の範囲の LOC Audio Level を求める部分を純粋なクラスにし、単体テストで固定する (範囲に重なる記録だけを使う、無音は 127、記録が無ければ 127、古い記録を捨てる)
- 手元で、マイク (Chromium の偽のデバイス) の音を配信したとき、subscriber が受け取る LOC Audio Level が、subscriber が復号した音の RMS と対応することを確かめる
- `vp check` / `tsc --noEmit` / `vp test run` が通る

## 解決方法

- `devtools/src/utils/audioLevelTimeline.ts` に `AudioLevelTimeline` を足した。符号化へ渡す AudioData ごとに、全チャンネルのサンプルの二乗和、数、peak を timestamp と duration と一緒に記録し (`record`)、符号化された chunk の時間の範囲 (duration が無ければ 20 ms) に重なる分を足し合わせて LOC Audio Level を求める (`levelFor`)。求めた後はその chunk より前に終わる記録を捨て、記録は 500 件までにする
- `devtools/src/webcodecs-devtools/utils/dummyAudio.ts` の `summarizeToneLevel` を、集計値 (`sampleStatsOf`) から -dBov と voiceActivity を求める `levelFromSampleStats` に分けた (規則は同じ)
- `devtools/src/utils/audioLevel.ts` に、全チャンネルのサンプルを読む `readAllAudioSamples` を足した
- `devtools/src/hooks/usePublisher.ts` の `processAudioFrames` は符号化へ渡す前にサンプルを記録し、`handleAudioEncodedChunk` は記録から LOC Audio Level を求める。トーンを作り直す `resolveAudioLevelForTimestamp` とそのテストを取り除いた。記録は音声の配信を始めるたびに作り直す
- テスト: `audioLevelTimeline.test.ts` で、範囲に重なる記録だけを使うこと、無音と記録の無い範囲は 127、duration が無い chunk は 20 ms、古い記録を捨てること、記録の上限を固定した
- 手元の relay と devtools で、Chromium の偽のデバイスのマイクの音を配信し、subscriber が受け取った LOC Audio Level と、subscriber が復号した音の RMS を並べた。ビープの間は 9 (-dBov) と -6.4 dBFS、無音は 127 と -100 dBFS、減衰の途中は 62〜81 と -58〜-78 dBFS で対応した。修正前は、マイクの音に関係なくトーンの値 (13〜17) を送っていた
- 変更履歴は、まだリリースしていない 0735 の途中の状態の直しのため、[FIX] を足さず 0735 の [ADD] に書き足した
- `vp check` / `tsc --noEmit` / `vp test run` (2792 件) / Playwright の E2E (40 件) が通った
