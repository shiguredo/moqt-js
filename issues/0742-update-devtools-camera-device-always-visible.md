# moqt-devtools の Camera Device の欄が Video Source で出たり消えたりし、設定の並びが動く

- Created: 2026-09-25
- Completed: {YYYY-MM-DD}
- Branch: feature/update-devtools-camera-device-always-visible
- Polished: {YYYY-MM-DD}
- Reporter: @voluntas

## 目的

moqt-devtools の接続設定の Video Settings は、Video Source が Camera のときだけ Camera Device の欄を描く。Video Source を切り替えるたびに欄が現れたり消えたりし、後ろの Resolution / Frame Rate / Bitrate / Keyframe Interval の位置が動く。利用者から「出しっぱなしが良いな、カメラデバイスも。音声デバイスに揃えて」「動きがあるのキモい」と要望があった。

Audio Settings の Audio Device の欄は、音声の入力が Microphone でない間も描き、操作できなくしている (closed の `0735-add-devtools-microphone-input.md`)。Camera Device も同じ扱いにする。

## 現状

- `devtools/src/components/ConnectionSettings.tsx` の `ConnectionSettings` は、`settings.videoSource.value === "camera"` のときだけ Camera Device の欄 (一覧が無いときは Fetch Devices のボタン、あるときは select) を描く
- Audio Device の欄は常に描き、`disabled={settings.settingsDisabled.value || !microphoneSelected}` で操作できなくする

## 設計方針

- Camera Device の欄を常に描き、Video Source が Camera でない間は操作できなくする (Audio Device と同じ判定の形)
- Fetch Devices のボタンと select は同じ高さで描く (一覧を取った後に入れ替わっても行の高さが変わらない)

## 完了条件

- Video Source を切り替えても、Video Settings の項目の数と位置が変わらない
- Video Source が Camera でない間は、Camera Device の欄を操作できない
- `vp check` / `tsc --noEmit` / `vp test run` / 既存の Playwright の E2E が通る
