# moqt-devtools の publisher が音声をマイクから取れず、音声入力デバイスを選べない

- Created: 2026-09-25
- Completed: 2026-09-25
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

## 解決方法

- `devtools/src/types.ts` の `AudioSourceType` に `"microphone"` を足し、`AUDIO_SOURCES` にも足した
- `devtools/src/signals/connectionSettings.ts` に、音声入力デバイスの一覧 (`microphoneDevices`、`fetchMicrophoneDevices`) と選んだデバイス (`selectedMicrophoneDeviceId`)、3 つの音声処理の切り替え (`audioEchoCancellation` / `audioNoiseSuppression` / `audioAutoGainControl`、既定は有効) を足した。URL には `microphoneDeviceId` と、無効にした音声処理だけを `=0` で載せる (jitter buffer と同じ形)
- `devtools/src/utils/microphone.ts` に、getUserMedia の制約を組み立てる `buildMicrophoneConstraints` (デバイスは `exact`、サンプルレートとチャンネル数は `ideal`、3 つの音声処理) と、取れた音の形式を決める `resolveCapturedAudioFormat` (`getSettings()` の値、無い項目は要求した値) を足した
- `devtools/src/hooks/usePublisher.ts` は、配信の開始で Catalog を作る前に `prepareAudioForPublishing` で音声のストリームを取る。マイクでは実際に取れたサンプルレートとチャンネル数で AudioEncoder の対応を確かめ、Catalog と AudioEncoder に使う。マイクを取れないときは警告のログを残し、映像だけを配信する
- `devtools/src/components/ConnectionSettings.tsx` に Audio Device の選択 (一覧が無いときは Fetch Devices) と 3 つの音声処理の切り替えを足した。音声の入力が microphone でない間も描き、操作できなくする
- テスト: `microphone.test.ts` で制約の組み立てと形式の決め方を固定し、`connectionSettings.test.ts` で microphone の受理、音声処理の既定、URL の往復を固定した。`resolveAudioPublishable` のテストに microphone を足した
- 手元の relay と devtools で、Chromium の偽のデバイスのマイクを選び (一覧に 3 つ出た)、URL で自動ゲインを無効にして配信した。subscriber は音声の Object を 299 個受け取って 299 個とも復号した (peak -48 dBFS)。publisher の Catalog の音声トラックは、取れた音の形式 (48000 Hz / 2 ch) になった
- `vp check` / `tsc --noEmit` / `vp test run` (2788 件) / Playwright の E2E (40 件) が通った
