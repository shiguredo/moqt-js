# moqt-devtools の publisher で映像を送らず音声だけを配信できない

- Created: 2026-09-25
- Completed: {YYYY-MM-DD}
- Branch: feature/add-devtools-video-source-none
- Polished: {YYYY-MM-DD}
- Reporter: @voluntas

## 目的

moqt-devtools の publisher は、音声の入力には None があるが、映像の入力 (Video Source) は Dummy と Camera しか選べず、映像を必ず配信する。音声だけの配信を試せない。利用者から「映像デバイスも none を選べるようにしましょう」と要望があった。Video Source に None を足し、音声だけを配信できるようにする。受信側は `0743-bug-devtools-subscriber-audio-only-catalog.md` で対応する。

## 現状

- `devtools/src/types.ts` の `VideoSourceType` は `"dummy" | "camera"`。`devtools/src/signals/connectionSettings.ts` の URL の読み込み (`videoSource`) も 2 つだけを受け付ける
- `devtools/src/components/ConnectionSettings.tsx` の Video Source の select の `onChange` は、値を `as any` で `settings.videoSource` へ入れる
- `devtools/src/hooks/usePublisher.ts`
  - `buildPublisherCatalog` は映像トラックを必ず載せる
  - `startPublishing` は映像のストリームを取り、映像トラックを publish し、encoder とフレームの読み出しを作る。映像トラックが取れなければ throw する。`pub.isStarting` は映像トラックの PUBLISH の確立 (`markVideoPublisherEstablished`) で下りる
  - `startPreview` は映像のストリームを取る。表示の `sourceLabel` は Dummy でなければ Camera になる
  - `prepareAudioForPublishing` は、音声を取れないとき「publishing video only」のログを残して映像だけを配信する
- `devtools/src/components/PublisherPanel.tsx` は、配信中かを `pub.publisher.value !== null` (映像トラックの Publisher) で判定する

## 設計方針

- `VideoSourceType` に `"none"` を足す。音声と同じく `VIDEO_SOURCES` と `isVideoSourceType` を置き、select の `onChange` と URL の読み込みで使う (`as any` をなくす)
- `buildPublisherCatalog` の映像トラックを省略できるようにする
- `startPublishing`
  - 映像の部分 (ストリームを取る、映像トラックの publish、encoder、フレームの読み出し) を関数に切り出し、None のときは呼ばない
  - 映像が None で音声も配信できない (音声が None、取れない、codec に対応していないなど) ときは、catalog を送る前に throw する。映像と音声がどちらも None のときは接続の前に throw する
  - 音声だけのときは、音声トラックの PUBLISH の確立で `pub.isStarting` を下ろす。Forward State の行には音声トラックの Forward State を出す
  - 統計の初期化 (音声の Group の開始値など) は、音声だけのときも行う
- 配信中かの判定を `devtools/src/signals/publisher.ts` の computed 1 か所にまとめ、映像か音声のどちらかのトラックの Publisher があれば配信中とする
- Preview は、None のときは映像のストリームを取らず、音声だけを取る。表示は None と分かる文言にする
- 映像の枠は、None でも同じ大きさのまま空で描く
- Resolution などの映像の設定は、音声が None のときの音声の設定と同じく、None の間も操作できるままにする

## 完了条件

- 単体テストで、映像トラックを省いた catalog と、`VideoSourceType` の受け付け (URL の往復を含む) を固定する
- 手元の relay で Video Source を None にして音声だけを配信し、subscriber が音声を受け取って復号する。publisher の Stop で subscriber が「Stream ended」になる
- 映像と音声の両方の配信が変わらない
- `vp check` / `tsc --noEmit` / `vp test run` / 既存の Playwright の E2E が通る
