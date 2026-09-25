# createMediaSubscriber が復号した音声を届いたその場で鳴らし、重なりと隙間でノイズになる

- Created: 2026-09-25
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-audio-playout-overlap
- Polished: {YYYY-MM-DD}
- Reporter: @voluntas

## 目的

`createMediaSubscriber` は、復号した音声 (Opus なら 20 ms ごとの `AudioData`) を、復号の出力が届いたその場で `AudioBufferSourceNode.start()` で鳴らす。復号の出力が届く間隔は経路と復号の揺らぎで 20 ms にならないため、前の音と重なって足されるか、隙間が空く。音が 1 秒に数十回飛び、ノイズに聞こえる。利用者から moqt-devtools で「音声の再生がノイズっぽい」と報告があり、devtools の subscriber と同じ鳴らし方をしている `createMediaSubscriber` にも同じ問題がある。

## 現状

- `src/createMediaSubscriber.ts` の `handleAudioDecodedData` は `AudioData` を `AudioBuffer` に写し、`source.start()` (時刻の指定なし) で鳴らす
- 実測 (2026-09-25、配備の relay、moqt-devtools の同じ鳴らし方、ダミー音声 440 Hz、Opus 48 kHz 2 ch、20 秒):
  - 音声は 1099 個届き、1099 個とも復号した。復号した音の timestamp の抜けと逆戻りは 0
  - 復号の出力の間隔は p50 19.8 ms、p95 32.6 ms、最大 162.6 ms (映像も配信しているとき)
  - 実際に鳴った音 (再生の出力) で、隣のサンプルとの差が 0.05 を超える切れ目が 1826 回、振幅が 0.31 を超える (音が重なって足された) サンプルが 48692 個あった。ダミー音声の振幅は 0.3 以下で、隣のサンプルとの差は 0.02 を超えない

## 設計方針

- 復号した音声を鳴らす時刻を決める純粋なモジュール (`src/audioPlayout.ts`) を置き、`createMediaSubscriber` と moqt-devtools の subscriber が使う
  - 最初の音で基準を決め、鳴らす時刻を「基準 + (timestamp - 基準の timestamp) + 再生の遅れ」にする。音が抜けたときはその分の無音を残す
  - timestamp が前の音より進んでいないとき (TIMESTAMP が無い、同じ値など) は、前の音のすぐ後ろに並べる。鳴らす時刻は前の音の終わりより前にしない (重ならない)
  - 鳴らす時刻を過ぎて届いた (今 + 余裕より前になる) 音で、基準を取り直す (今 + 再生の遅れに置く)
  - 遅れが上限を超えた音は捨て、基準をその音の長さだけ前に寄せる (次の音が捨てた音の時刻に入り、途切れずに遅れが縮む)
  - 時刻は `AudioContext.currentTime` (秒) で扱う。ブラウザ API に依存しない
- 再生の遅れは 80 ms、上限は 300 ms、余裕は 10 ms (描画の 1 単位 128 フレームより大きい)。上の実測の復号の出力の時刻で見積もると、映像と音声の配信で 20 秒に基準の取り直しが 1 回 (無音 78 ms)、遅れは p50 113 ms。音声だけの配信では取り直し 0 回、遅れは p50 86 ms
- 振る舞いが変わる: 音声は再生の遅れの分だけ遅れて鳴る

## 完了条件

- fast-check で、鳴らす時刻が重ならない、鳴らす時刻は今 + 余裕以上、遅れは上限以下であることを固定する。基準の取り直しと捨てる規則は単体テストで固定する
- `createMediaSubscriber` が決めた時刻で鳴らす
- `CHANGES.md` の `## develop` に `[FIX]` で載る (遅れて鳴ることも書く)
- `vp check` / `tsc --noEmit` / `vp test run` / 既存の Playwright の E2E が通る
