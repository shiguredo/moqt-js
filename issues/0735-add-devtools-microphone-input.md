# moqt-devtools の publisher が音声をマイクから取れず、音声入力デバイスを選べない

- Created: 2026-09-25
- Completed: {YYYY-MM-DD}
- Branch: feature/add-devtools-microphone-input
- Polished: {YYYY-MM-DD}
- Reporter: @voluntas

## 目的

moqt-devtools の publisher は、音声の入力を「None」と「Dummy (440 Hz tone)」からしか選べず、マイクの音を配信できない。映像はカメラのデバイスを選べるが、音声の入力デバイスは選べない。利用者から「音声入力デバイスを選択できるようにして」と要望があった。音声の入力にマイクを足し、デバイスを選べるようにする。マイクの音にかけるブラウザの音声処理 (エコー除去、ノイズ抑制、自動ゲイン) は、接続設定で切り替えられるようにする (利用者と決めた)。

## 現状

- `devtools/src/types.ts` の `AudioSourceType` は `"none" | "dummy"` で、`devtools/src/signals/connectionSettings.ts` の `AUDIO_SOURCES` も同じ
- `devtools/src/hooks/usePublisher.ts` の `startAudioStream` は `audioSource` が `"dummy"` のときだけダミー音声のストリームを作る。`resolveAudioPublishable` も `"dummy"` のときだけ音声を配信する
- 配信に使うサンプルレートとチャンネル数は、接続設定の値 (`audioSampleRate` / `audioChannels`) で、catalog と AudioEncoder に同じ値を使う
- カメラは `fetchCameraDevices` (`connectionSettings.ts`) で一覧を取り、`selectedCameraDeviceId` を getUserMedia の `deviceId` に渡す。一覧と選択の画面は `devtools/src/components/ConnectionSettings.tsx` にある

## 設計方針

- `AudioSourceType` に `"microphone"` を足す
- 音声入力デバイスの一覧を取る `fetchMicrophoneDevices` と、選んだデバイスの `selectedMicrophoneDeviceId` を足す (カメラと同じ作り。ラベルを得るため一時的にマイクへアクセスする)
- 音声処理の 3 つの切り替え (`audioEchoCancellation` / `audioNoiseSuppression` / `audioAutoGainControl`) を足す。既定はブラウザの既定と同じ有効にする。URL の引数 (Copy URL) にも載せる
- マイクの音は getUserMedia の `audio` に、デバイス (`deviceId: exact`)、サンプルレートとチャンネル数 (設定の値を `ideal`)、3 つの音声処理を渡して取る
- マイクでは、サンプルレートとチャンネル数はデバイスが決める。実際に取れた値 (`MediaStreamTrack.getSettings()`) を catalog と AudioEncoder に使う。設定の値を使うと、実際の音と食い違って符号化できない
- 画面では、Audio Device の選択と 3 つの音声処理の切り替えを常に出し、音声の入力が microphone でない間は操作できなくする (状態で項目が出たり消えたりしないようにする)

## 完了条件

- 単体テストで、音声の入力の種類の判定と、マイクの getUserMedia の制約の組み立て (デバイス、ideal のサンプルレートとチャンネル数、3 つの音声処理) を固定する
- 手元で、Chromium の偽のデバイス (`--use-fake-device-for-media-stream`) のマイクを選んで配信し、subscriber が音声を受け取って復号することを確かめる
- `vp check` / `tsc --noEmit` / `vp test run` が通る
