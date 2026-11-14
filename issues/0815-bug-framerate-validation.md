# framerate の値域が検証されず 0 や負値がエンコーダーと catalog に渡る

- Created: 2026-09-30
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-framerate-validation
- Polished: 2026-11-15
- Refreshed: 2026-11-14
- Reporter: @voluntas

## 目的

`VideoPublishOptions.framerate` の値域が検証されていない。0 や負値は WebCodecs の `VideoEncoder.configure` がそのまま受け付け、エンコーダーの設定と catalog の track に載る。framerate は 1 秒あたりのフレーム数であり、0 や負値は意味を持たない。非有限値 (`NaN` / `±Infinity`) は `configure` が TypeError を投げ、`start()` の途中で失敗する。キーフレーム間隔を秒にした変更で、framerate から既定値を導出する際の間接的な検証が無くなったため、明示的に検証する。

## 現状

- `src/createMedia/settings.ts` の `resolveVideoPublishSettings` は `options.framerate ?? DEFAULT_VIDEO_FRAMERATE` をそのまま使い、値域を検証しない
- `src/codec/config.ts` の `getVideoEncoderConfig` は framerate を `VideoEncoderConfig.framerate` にそのまま入れる
- `src/createMediaPublisher.ts` の `MediaPublisherImpl.createCatalogTracks` は `framerate: video.framerate` を catalog の映像トラックに載せる (draft-ietf-moq-msf-01 §5.2.20)
- `src/createMediaPublisher.ts` の `MediaPublisherImpl` のコンストラクタは `resolveKeyframeInterval(options.video)` だけを検証し、framerate は検証しない。`src/createMediaPublisher.test.ts` にも framerate の値域を検証するテストは無い
- 購読側の `src/msf/catalogTrackValidation.ts` の `pickOptionalNumber` は「数値であり有限であること」だけを確認するため、0 や負値は受理される
- `src/codec/types.ts` の `VideoPublishOptions.framerate` には値域のコメントが無く、`docs/HIGH_LEVEL_API.md` は `framerate?: number; // default: 30` とだけ書いている
- キーフレーム間隔を frames から秒に変更する前は、`src/createMediaPublisher.ts` の `resolveKeyframeInterval` が `Math.round(framerate * 2)` を既定値として導出し、1 未満または非有限なら reject していた (framerate が 0 / 負値 / 非有限の場合と、正の有限値でも 2 倍が 0.5 未満の場合を含む)。秒に変更したあとは framerate から間隔を導出しないため、この検証は無くなった
- 実測 (2026-09-30、Chromium の headless、`http://localhost:5173` のページで `new VideoEncoder(...).configure({ codec: "vp8", width: 640, height: 480, bitrate: 1000000, framerate })` を実行): `0` / `-1` / `-0.5` は configure が成功し、`NaN` / `Infinity` は `TypeError: Failed to read the 'framerate' property from 'VideoEncoderConfig': The provided double value is non-finite.` で throw した
- `examples/high-level-api` の Framerate の入力は `min="1"` だが、空にすると `Number("")` が 0 になり、そのまま `createMediaPublisher` へ渡る

## 設計方針

- framerate は `Number.isFinite(framerate)` が true かつ `framerate > 0` のときだけ受理する。整数に限らず、29.97 などの非整数も受理する。規則は `resolveKeyframeInterval` と同じにする
- 検証は `src/createMediaPublisher.ts` に `resolveKeyframeInterval` と同じ形の純関数 (`resolveVideoFramerate`) を export して置き、`MediaPublisherImpl` のコンストラクタから `resolveVideoFramerate(options.video)` を呼んで行う。`createMediaPublisher()` の時点で reject する
- `resolveVideoFramerate` は `VideoPublishOptions | undefined` を受け取り、未指定時は `DEFAULT_VIDEO_FRAMERATE` (30) を返す。テスト用に export し、`src/index.ts` の公開 API には追加しない
- `resolveVideoPublishSettings` は `start()` の途中で呼ばれるため、そこで throw すると `onError` が呼ばれない位置になる (`keyframeInterval` の検証をコンストラクタに置いているのと同じ理由)。`resolveVideoPublishSettings` は変更しない
- エラーメッセージは `framerate must be a finite number > 0, got <値>` とする
- `src/createMedia/settings.ts` / `src/codec/config.ts` / `src/msf/catalogTrackValidation.ts` は変更しない (検証はコンストラクタに集約する。`pickOptionalNumber` は framerate 以外のフィールドにも使われ、0 を有効値とするものがある)
- `src/codec/types.ts` の `VideoPublishOptions.framerate` に、値域 (0 より大きい有限数)、既定値 (30)、無効値は `createMediaPublisher()` が reject することを `//` コメントで書く。`docs/HIGH_LEVEL_API.md` の該当行と説明段落にも同じ内容を書く
- `CHANGES.md` は `CODEBASE.md` の「MOQT RFC ドラフト中の特別ルール: CHANGES.md を更新しない」に従い更新しない
- 対象は `src/createMediaPublisher.ts` / `src/createMediaPublisher.test.ts` / `src/codec/types.ts` / `docs/HIGH_LEVEL_API.md` とする。`src/index.ts` / `examples` は変更しない (`examples/high-level-api` の Framerate 入力は空にすると `Number("")` が 0 になるが、ライブラリが reject するため)
- devtools の URL `framerate` の復元の検証は open の `0816-bug-devtools-framerate-range.md` で扱う

## 完了条件

- framerate が 0 / 負値 / `NaN` / `±Infinity` のとき `createMediaPublisher()` が reject し、エラーメッセージに `framerate must be a finite number > 0, got <値>` の形で受け取った値が含まれること
- 正の有限数 (0.5 / 29.97 / 30 など) は受理すること。`framerate` 未指定時は既定の 30 を受理すること
- `src/createMediaPublisher.test.ts` に `resolveVideoFramerate` の境界テスト (0 / 負値 / `NaN` / `±Infinity` の拒否、0.5 / 29.97 / 30 / 未指定の受理) と、`createMediaPublisher()` の公開 API で reject するテストを追加すること
- `src/codec/types.ts` のコメントと `docs/HIGH_LEVEL_API.md` の記述が実装と一致すること
- `CHANGES.md` を更新しないこと
- 変更対象は `src/createMediaPublisher.ts` / `src/createMediaPublisher.test.ts` / `src/codec/types.ts` / `docs/HIGH_LEVEL_API.md` に限り、`src/createMedia/settings.ts` / `src/codec/config.ts` / `src/msf/catalogTrackValidation.ts` / `src/index.ts` / `examples` は変更しないこと
- `vp check` / `tsc --noEmit` / `vp test run` が通ること
