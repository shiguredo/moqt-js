# framerate の値域が検証されず 0 や負値がエンコーダーと catalog に渡る

- Created: 2026-09-30
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-framerate-validation
- Polished: 2026-10-03
- Reporter: @voluntas

## 目的

`VideoPublishOptions.framerate` の値域が検証されていない。0 や負値は WebCodecs の `VideoEncoder.configure` がそのまま受け付け、エンコーダーの設定と catalog の track に載る。非有限値 (`NaN` / `±Infinity`) は `configure` が TypeError を投げ、`start()` の途中で失敗する。キーフレーム間隔を秒にした変更で、framerate から既定値を導出する際の間接的な検証が無くなったため、明示的に検証する。

## 現状

- `src/createMedia/settings.ts` の `resolveVideoPublishSettings` は `options.framerate ?? DEFAULT_VIDEO_FRAMERATE` をそのまま使い、値域を検証しない
- `src/codec/config.ts` の `getVideoEncoderConfig` は framerate を `VideoEncoderConfig.framerate` にそのまま入れる
- `src/createMediaPublisher.ts` の `MediaPublisherImpl.createCatalogTracks` は `framerate: video.framerate` を catalog の映像トラックに載せる (draft-ietf-moq-msf-01 §5.2.20)
- 購読側の `src/msf/catalogTrackValidation.ts` の `pickOptionalNumber` は「数値であること」だけを確認するため、0 や負値は受理される
- キーフレーム間隔を frames から秒に変更する前は、`src/createMediaPublisher.ts` の `resolveKeyframeInterval` が `Math.round(framerate * 2)` を既定値として導出し、1 未満または非有限なら reject していた (framerate が 0 / 負値 / 非有限の場合と、正の有限値でも 2 倍が 0.5 未満の場合を含む)。秒に変更したあとは framerate から間隔を導出しないため、この検証は無くなった
- 実測 (2026-09-30、Chromium の headless、`http://localhost:5173` のページで `new VideoEncoder(...).configure({ codec: "vp8", width: 640, height: 480, bitrate: 1000000, framerate })` を実行): `0` / `-1` / `-0.5` は configure が成功し、`NaN` / `Infinity` は `TypeError: Failed to read the 'framerate' property from 'VideoEncoderConfig': The provided double value is non-finite.` で throw した
- `examples/high-level-api` の Framerate の入力は `min="1"` だが、空にすると `Number("")` が 0 になり、そのまま `createMediaPublisher` へ渡る

## 設計方針

- framerate は 0 より大きい有限数のみ受理する。規則は `keyframeInterval` と同じにする
- 検証は `src/createMediaPublisher.ts` の `MediaPublisherImpl` のコンストラクタで行い、`createMediaPublisher()` の時点で reject する。`resolveVideoPublishSettings` は `start()` の途中で呼ばれるため、そこで throw すると失敗の通知経路が state に依存する (`keyframeInterval` の検証をコンストラクタに置いているのと同じ理由)
- 検証は `resolveKeyframeInterval` と同じ形の純関数 (`resolveVideoFramerate` など) にして、単体テストで境界を固定する
- エラーメッセージは `framerate must be a finite number > 0, got <値>` とする
- devtools の URL `framerate` の復元の検証は別 issue で扱う

## 完了条件

- framerate が 0 / 負値 / `NaN` / `±Infinity` のとき `createMediaPublisher()` が reject すること
- 正の有限数 (0.5 など) は受理すること
- `vp check` / `tsc --noEmit` / `vp test run` が通ること
