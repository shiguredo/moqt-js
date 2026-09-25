# moqt-devtools の publisher が LOC Audio Level を取った音ではなく生成したトーンから求め、マイクの音と食い違う

- Created: 2026-09-25
- Completed: {YYYY-MM-DD}
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
