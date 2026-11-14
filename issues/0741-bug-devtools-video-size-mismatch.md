# moqt-devtools の publisher で、実際に取れた映像ストリームの幅・高さ・フレームレートが encoder / catalog の設定と食い違うことがある

- Created: 2026-09-25
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-devtools-video-size-mismatch
- Polished: 2026-11-14

## 目的

moqt-devtools の publisher は、encoder と catalog の幅・高さ・フレームレートを、実際に取れた映像ストリームの値からではなく、接続設定の値から決めることがある。次の場合に、実際に取れた映像ストリームと encoder / catalog の設定が食い違う。ここでいう「送る映像の実際の値」は、符号化後の出力の寸法ではなく、実際に取れた映像ストリームの幅・高さ・フレームレートを指す。

- プレビュー中に Publish を押すと、プレビューの映像ストリームをそのまま配信に使う。プレビュー中に Resolution や Frame Rate を変えてから Publish を押すと、映像ストリームはプレビューを取ったときのまま使い回され、encoder と catalog は変えた後の値になる。encoder はプレビューのフレームを設定の寸法に変換するため、符号化後の寸法は設定の値になるが、プレビューで確かめた画角の映像が配信される。プレビュー中に Video Source や Camera を変えても、プレビューの映像のまま配信される
- カメラが要求した解像度を出さず、実際の解像度が違った場合 (設定を変えていなくても起きる)。catalog は常に設定の値になり、プレビューを流用したときは encoder も設定の値になる。プレビューを流用したときは、encoder はカメラの実際の寸法のフレームを設定の寸法に変換する

## 現状

- `devtools/src/hooks/usePublisher.ts` の `startPreview` は、その時点の `resolution` / `framerate` / `videoSource` / `selectedCameraDeviceId` で `getVideoStream` を呼び、`pub.mediaStream` と `pub.videoStreamCleanup` に置く。プレビューは `settingsDisabled` を立てないため、Publisher だけを使っている間はプレビュー中も接続設定を変えられる
- `getVideoStream` は、カメラのときは `videoTrack.getSettings()` の実際の幅と高さを返す (取れないときは要求した値)。フレームレートは返さない。ダミーのときは要求した値を返す
- `startPublishing` が呼ぶ `prepareVideoForPublishing` は、`hadPreview = pub.isPreviewActive.value && pub.mediaStream.value !== null` のとき映像ストリームを取り直さず、`actualWidth = width` / `actualHeight = height` とする。`width` / `height` は Publish を押した時点の `settings.resolution` から読んだ値で、プレビューを取ったときの値でも、カメラの実際の値でもない
  - encoder の設定 (`getEncoderConfig`) の幅と高さと `pubCodec` の表示には `actualWidth` / `actualHeight` を使う。encoder のフレームレートには `startVideoPublishing` の `options.framerate` (Publish を押した時点の `settings.framerate`) を使う。`prepareVideoForPublishing` の返り値 (`VideoInput`) は幅と高さだけで、フレームレートを持たない
- catalog (`buildPublisherCatalog`) は、catalog トラックの publish の後、映像ストリームを取る前に作って送る。幅と高さと framerate には、Publish を押した時点の設定の値 (`width` / `height` / `framerateValue`) を使う。プレビューの有無にかかわらず、カメラの実際の値ではない
- 同じ関数 `buildPublisherCatalogOptionsFromSettings` は、Tracks カード (`devtools/src/components/ConnectionSettings.tsx`) が catalog の宣言を表示するのにも使う。映像の値は設定から読むため、実際に取れた値とは限らない
- 音声は、`startPublishing` の `prepareAudioForPublishing` が Publish を押した時点の設定で取り直し、実際に取れた形式を catalog と encoder に使うため、この食い違いは起きない

## 再現手順

コードの経路で確かめた。実際の relay での再現はまだ行っていない。

1. Resolution を 1280x720 にして Preview を押す
2. プレビュー中に Resolution を 640x360 に変える
3. Publish を押す。映像ストリームはプレビューで取った 1280x720 のまま使い回され、encoder と catalog は 640x360 になる。encoder は 1280x720 のフレームを 640x360 に縮小するため符号化後の寸法は 640x360 になるが、プレビューで確かめた画角の映像が配信される

- Frame Rate だけを変えた場合も同じで、映像ストリームはプレビューを取ったときのフレームレートのまま使い回され、encoder と catalog は変えた後の値になる。encoder の `framerate` は符号化の出力のフレームレートを固定しないため、フレームが落ちなければ実際のフレームレートはプレビューのままになる
- 別の経路: カメラが 1280x720 を出せず 640x480 で取れた場合、catalog は 1280x720 になる。Preview から Publish したときは encoder も 1280x720 になる。encoder は 640x480 のフレームを 1280x720 に拡大する

## 設計方針

- encoder と catalog の幅・高さ・フレームレートは、実際に取れた映像ストリームの値から決める
  - `getVideoStream` の返り値に、カメラの実際のフレームレート (`videoTrack.getSettings()` の値。取れないときは要求した値) を足す。ダミーは要求した値を返す
  - `startPreview` が `getVideoStream` に渡した値 (`videoSource`、camera のときの `selectedCameraDeviceId` / `resolution` / `framerate`) と、返された実際の幅・高さ・フレームレートを `pub.previewVideoInfo` (新設の signal) に置く。映像の入力が None のときは null にする
  - プレビューの映像を流用するときは、`pub.previewVideoInfo` の実際の幅・高さ・フレームレートを使う。`prepareVideoForPublishing` の `hadPreview` の経路では、Publish を押した時点の設定の値 (`width` / `height`) を `actualWidth` / `actualHeight` にしない
  - `prepareVideoForPublishing` の返り値 (`VideoInput`) に実際のフレームレートを足し、`startVideoPublishing` の `getEncoderConfig` には `options.framerate` ではなくその値を使う
  - `buildPublisherCatalogOptionsFromSettings` は、音声と同じく実際に取れた映像の値 (幅・高さ・フレームレート) を引数で受け取り、catalog に使う。映像を送らないときは null を渡す
  - Tracks カード (`devtools/src/components/ConnectionSettings.tsx` の呼び出し) も同じ関数を使うため、プレビュー中は `pub.previewVideoInfo` の実際の値、配信中は `pub.catalog.value` の宣言、それ以外は設定の値を使う (音声の `resolveDeclarationAudioFormat` と同じ扱い)
  - `pub.previewVideoInfo` は、プレビューの映像ストリームを解放するとき (stopPreview / releaseVideoStream / 後始末) に null に戻す。取り直したときは新しい値に更新する
- catalog は映像ストリームを取った後の値で作って送る。catalog トラックの publish (`session.publish`) は接続後すぐのままでよく、catalog の Object の送信を `prepareVideoForPublishing` (と音声の用意) の後に移す
  - 最初から誤った値の catalog を送ると、購読側は最初に届いた catalog でトラックの解決と decoder の組み立てを済ませる (後から届く catalog では作り直さない) ため、誤った値を一度も送らない
  - 音声も同じ順序 (catalog の前に `prepareAudioForPublishing` で実際の形式を得る) のため、流れは分けずに済む
  - catalog の送り直しの予約 (`startCatalogRepublish`) は、初回の catalog Object を送った後に置く。映像の取得を待つ間に予約が発火すると、`pub.catalog.value` がまだ null で `sendCatalogUpdate` が何も送らず、予約が消えるため
  - 注意: 映像取得 (カメラの許可の待機) の間は catalog が届かず、購読側の `catalogSubscriptionTimeout` (既定 5000 ms) を超えると購読が失敗する。音声の取得でも同じ窓が既にある
- プレビューの映像が依存する設定 (Video Source / Camera / Resolution / Frame Rate) がプレビューを取ったときから変わっている場合は、流用せずに取り直す。取り直しは `prepareVideoForPublishing` で行う。プレビュー中でもこれらの設定は変更できるままにする (設定を変えられなくする案は採用しない)
  - 取り直すときは、置き換え前に古いプレビューのストリームを解放する (取り直したストリームは既存の `prepareVideoForPublishing` と同じく `pub.mediaStream` / `pub.videoStreamCleanup` に置く)
  - 取り直すと、プレビューで確かめた映像と配信の映像が変わる点は許容する
- 判定 (流用するか、流用するときの幅・高さ・フレームレート) を純粋な関数にして単体テストで確かめる
- 対象外
  - 音声 (Publish の時点で取り直しているため食い違わない)

## 完了条件

- encoder と catalog の幅・高さ・フレームレートが、実際に取れた映像ストリームの幅・高さ・フレームレートと一致する (プレビューを流用したとき、カメラが要求と違う解像度を出したときを含む)
- プレビュー中に映像の設定を変えてから Publish したとき、取り直した映像と encoder / catalog の設定が一致する
- 判定を単体テストで確かめる
- Tracks カードの宣言も、プレビュー中は実際の映像の値、配信中は `pub.catalog.value` の宣言を表示する (音声と同じ扱い)
- `CHANGES.md` は `CODEBASE.md` の「MOQT RFC ドラフト中の特別ルール」に従い変更しない (ルールの見直しは open の `0861-update-changelog-draft-rule.md` で扱う)
- `npx vp check` / `npx vp test --run` / `npx vp run e2e-test` が通る

## 参照

- `devtools/src/hooks/usePublisher.ts` の `startPreview` / `startPublishing` / `prepareVideoForPublishing` (`hadPreview`) / `getVideoStream` / `prepareAudioForPublishing` / `startVideoPublishing` / `VideoInput` / `buildPublisherCatalogOptionsFromSettings` / `startCatalogRepublish`
- `devtools/src/signals/publisher.ts` (`pub.isPreviewActive` / `pub.mediaStream` / `pub.videoStreamCleanup`。`pub.previewVideoInfo` を新設する)
- `devtools/src/components/ConnectionSettings.tsx` の `buildPublisherCatalogOptionsFromSettings` 呼び出し (Tracks カード) と、`devtools/src/utils/publishTracks.ts` の `resolveDeclarationAudioFormat`
- `devtools/src/signals/connectionSettings.ts` (`videoSource` / `selectedCameraDeviceId` / `resolution` / `framerate`)
- `devtools/src/utils/codec.ts` の `getEncoderConfig` / `getCatalogCodec`
- `src/catalogRepublish.ts` の `catalogRepublishIntervalMs`
- `devtools/src/hooks/usePublisher.test.ts` の `buildPublisherCatalogOptionsFromSettings` のテスト
- `devtools/src/hooks/useSubscriber.ts` の catalog 購読 (`processCatalogObject` / `catalogSubscriptionTimeout`)
- closed の `0730-bug-devtools-settings-enabled-while-starting.md` (差分レビューで見つかった既存の問題として挙げた)
- `CODEBASE.md` の「MOQT RFC ドラフト中の特別ルール」と、open の `0861-update-changelog-draft-rule.md` (CHANGES.md の扱いの見直し)

## 解決方法

{未着手}
