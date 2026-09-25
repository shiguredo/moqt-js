# moqt-devtools の publisher で、送る映像の幅と高さが encoder / catalog の設定と食い違うことがある

- Created: 2026-09-25
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-devtools-video-size-mismatch
- Polished: {YYYY-MM-DD}

## 目的

moqt-devtools の publisher は、encoder と catalog の幅と高さを、送る映像の実際の幅と高さからではなく、接続設定の値から決めることがある。次の場合に、送る映像と encoder / catalog の設定が食い違う。

- プレビュー中に Publish を押すと、プレビューの映像ストリームをそのまま配信に使う。プレビュー中に Resolution や Frame Rate を変えてから Publish を押すと、映像はプレビューを取ったときのまま、encoder と catalog は変えた後の値になる。プレビュー中に Video Source や Camera を変えても、プレビューの映像のまま配信される
- カメラが要求した解像度を出さず、実際の解像度が違った場合 (設定を変えていなくても起きる)。catalog は常に設定の値になり、プレビューを流用したときは encoder も設定の値になる

## 現状

- `devtools/src/hooks/usePublisher.ts` の `startPreview` は、その時点の `resolution` / `framerate` / `videoSource` / `selectedCameraDeviceId` で `getVideoStream` を呼び、`pub.mediaStream` と `pub.videoStreamCleanup` に置く。プレビューは `settingsDisabled` を立てないため、プレビュー中も接続設定を変えられる
- `getVideoStream` は、カメラのときは `videoTrack.getSettings()` の実際の幅と高さを返す (取れないときは要求した値)。ダミーのときは要求した値を返す
- `startPublishing` は、`hadPreview = pub.isPreviewActive.value && pub.mediaStream.value !== null` のとき映像ストリームを取り直さず、`actualWidth = width` / `actualHeight = height` とする。`width` / `height` は Publish を押した時点の `settings.resolution` から読んだ値で、プレビューを取ったときの値でも、カメラの実際の値でもない
  - encoder の設定 (`getEncoderConfig`) の幅と高さと `pubCodec` の表示には `actualWidth` / `actualHeight` を使う
- catalog (`buildPublisherCatalog`) は、映像ストリームを取る前 (catalog の publish のとき) に作って送る。幅と高さと framerate には、Publish を押した時点の設定の値 (`width` / `height` / `framerateValue`) を使う。プレビューの有無にかかわらず、カメラの実際の値ではない
- 音声は、`startPublishing` の `prepareAudioForPublishing` が Publish を押した時点の設定で取り直すため、この食い違いは起きない

## 再現手順

コードの経路で確かめた。実際の relay での再現はまだ行っていない。

1. Resolution を 1280x720 にして Preview を押す
2. プレビュー中に Resolution を 640x360 に変える
3. Publish を押す。映像は 1280x720 のまま送られ、encoder と catalog は 640x360 になる

- 別の経路: カメラが 1280x720 を出せず 640x480 で取れた場合、catalog は 1280x720 になる。Preview から Publish したときは encoder も 1280x720 になる

## 設計方針

- encoder と catalog の幅と高さは、送る映像の実際の値から決める
  - プレビューの映像を流用するときは、プレビューを取ったときの実際の幅と高さを使う。`startPreview` で `getVideoStream` の返した幅と高さ (と framerate) を signal に置き、`startPublishing` の `hadPreview` の経路で使う
  - catalog は映像ストリームを取った後の値で作る。今は映像ストリームを取る前に catalog を送っているため、映像ストリームを取る処理を catalog の publish より前に移すか、取った後に catalog を送り直すかを実装の前に決める
- プレビューの映像が依存する設定 (Video Source / Camera / Resolution / Frame Rate) がプレビューを取ったときから変わっている場合は、流用せずに取り直す。どちらにするか (取り直す / プレビュー中はこれらの設定を変えられなくする) は実装の前に決める
  - 第一案: 取り直す。プレビュー中の設定変更は利用者の意図であり、Publish で反映されるのが自然である。取り直すと、プレビューで確かめた映像と配信の映像が変わる点は許容する
- 判定 (流用するか、流用するときの幅と高さ) を純粋な関数にして単体テストで確かめる
- 対象外
  - 音声 (Publish の時点で取り直しているため食い違わない)

## 完了条件

- encoder と catalog の幅と高さが、送る映像の実際の幅と高さと一致する (プレビューを流用したとき、カメラが要求と違う解像度を出したときを含む)
- プレビュー中に映像の設定を変えてから Publish したとき、送る映像と encoder / catalog の設定が一致する (設計方針で決めた方法で)
- 判定を単体テストで確かめる
- `CHANGES.md` の `## develop` に `[FIX]` で載る
- `npx vp check` / `npx vp test --run` / `npx vp run e2e-test` が通る

## 参照

- `devtools/src/hooks/usePublisher.ts` の `startPreview` / `startPublishing` (`hadPreview`) / `getVideoStream` / `prepareAudioForPublishing`
- closed の `0730-bug-devtools-settings-enabled-while-starting.md` (差分レビューで見つかった既存の問題として挙げた)

## 解決方法

{未着手}
