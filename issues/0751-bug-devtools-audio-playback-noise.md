# moqt-devtools の subscriber で、受信した音声の再生がノイズっぽくなる

- Created: 2026-09-25
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-devtools-audio-playback-noise
- Polished: {YYYY-MM-DD}
- Reporter: @voluntas

## 目的

moqt-devtools の subscriber で Play Audio を有効にすると、受信した音声がノイズっぽく聞こえる。利用者から「音声の再生がノイズっぽい感じになってる」と報告があった。原因は `0750-bug-audio-playout-overlap.md` と同じで、復号した音声を届いたその場で鳴らし、前の音との重なりと隙間ができる。0750 で置く鳴らす時刻を決めるモジュールを devtools でも使う。

## 現状

- `devtools/src/hooks/useSubscriber.ts` の `handleAudioDecoded` は `AudioData` を `AudioBuffer` に写し、`source.start()` (時刻の指定なし) で鳴らす
- 実測 (2026-09-25、配備の relay、ダミー音声 440 Hz、20 秒、実際に鳴った音): 切れ目が映像と音声の配信で 1826 回、音声だけの配信で 1873 回。音が重なって足されたサンプルが 48692 個と 55240 個
- 送る側 (ダミー音声は 2 秒で 440 Hz がちょうど 880 周期になるループで途切れない)、符号化、送信、復号には問題が無い (復号した音の timestamp の抜けと逆戻りは 0)

## 設計方針

- `handleAudioDecoded` は 0750 のモジュールで鳴らす時刻を決め、`source.start(時刻)` で鳴らす。捨てると決めた音は鳴らさない
- 再生の基準は、Play Audio を有効にしたとき (AudioContext を作り直す) と、購読の後始末で作り直す
- 基準の取り直しと捨てた音の数を `window.moqtDevTools.getSubscribers()` で読めるようにする (音の途切れの原因を切り分けるため)

## 完了条件

- 配備の relay で、実際に鳴った音の切れ目と重なりが、上の実測より大きく減る (20 秒あたりの数で比べる)
- `vp check` / `tsc --noEmit` / `vp test run` / 既存の Playwright の E2E が通る
