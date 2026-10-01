# 音声再生の統計を MediaReceiverStats に公開する

- Created: 2026-10-01
- Completed: 2026-10-01
- Branch: feature/change-audio-playout-stats
- Polished: 2026-10-01

## 目的

音声の再生で起きたこと (基準の取り直し、捨てた音、詰めた長さ、目標からの遅れ、0786 の補間) を、ライブラリ利用者が `getStats()` から読めるようにする。基準の取り直しと捨てた音は moqt-devtools の画面で見えるが、詰めた長さと遅れはどこにも出ておらず、`createMediaSubscriber` を使うアプリは音声の再生の劣化を検知できない。A/V 同期の推定 (`MediaReceiverStats.avSync`) は既に公開しているため、同じ考え方で再生の実測を揃える。

## 現状

- `src/audioPlayout.ts` の `AudioPlayoutScheduler` は `rebases` (基準の取り直し) / `drops` (捨てた音) / `compressed` (詰めた合計、秒) / `lateness` (目標からの遅れ、秒) を持っている
- `devtools/src/hooks/useSubscriber.ts` は `rebases` と `drops` を signal (`audioPlayoutRebases` / `audioPlayoutDrops`) へ写して画面へ出している
- `src/createMediaSubscriber.ts` の `getStats()` は `audio` と `video` と `avSync` を返す。`AudioReceiverStats` は `framesReceived` / `bytesReceived` だけで、再生の統計を返していない
- `AudioReceiverStats` は `src/index.ts` から再輸出している公開型であり、フィールドを足すと自前で構築しているコードは修正が必要になる (後方互換なし)

## 設計方針

- `AudioReceiverStats` に再生の統計を追加し、`getStats()` が `AudioPlayoutScheduler` の getter から読む。名前は devtools と揃える (`playoutRebases` / `playoutDrops`)。0786 で追加する補間の回数 (`playoutConcealments`) と長さ (`playoutConcealedMs`) も同じ形で出す
- この issue は 0786 の実装を前提にする (補間の統計は 0786 が作る getter を読む)
- 時間はミリ秒に揃える (`playoutCompressedMs` / `playoutLatenessMs` / `playoutConcealedMs`)。`AudioPlayoutScheduler` は秒を契約にしたクラスなので、公開側の `getStats()` でミリ秒へ換算する (scheduler の getter の単位は変えない)
- 値は `avSync` と同じく `getStats()` のたびに現在値を読む。カウンタ (`playoutRebases` / `playoutDrops` / `playoutConcealments` / `playoutCompressedMs` / `playoutConcealedMs`) は `framesReceived` / `bytesReceived` と同じく MediaSubscriber の寿命で累積し、購読をやり直しても消えない。`playoutLatenessMs` は今の遅れであり、`AudioPlayoutScheduler.reset()` で 0 に戻る (カウンタとは扱いが異なる)。この扱いを JSDoc に書く
- `CHANGES.md` に [CHANGE] として追記する。`docs/HIGH_LEVEL_API.md` の `MediaReceiverStats` / `AudioReceiverStats` の説明も更新する

## 完了条件

- `getStats().audio` から再生の統計 (基準の取り直し、捨てた音、詰めた合計、遅れ、補間の回数と長さ) が読めること
- 値が `AudioPlayoutScheduler` の実測とミリ秒換算を含めて一致すること (テストで固定する)
- 購読をやり直してもカウンタが消えないこと、`playoutLatenessMs` は `reset` で 0 に戻ることをテストで固定すること
- `docs/HIGH_LEVEL_API.md` と `CHANGES.md` が更新されていること
- `vp check` / `tsc --noEmit` / `vp test run` が通ること

## 解決方法

- `src/codec/types.ts` の `AudioReceiverStats` に `playoutRebases` / `playoutDrops` / `playoutConcealments` / `playoutCompressedMs` / `playoutConcealedMs` / `playoutLatenessMs` を追加した。時間はミリ秒で返す
- `src/createMediaSubscriber.ts` は `getStats()` で `AudioPlayoutScheduler` の getter を読み、秒をミリ秒へ換算して返す (`audioReceiverStats`)。受信の統計 (`audioStats`) は `Pick<AudioReceiverStats, "framesReceived" | "bytesReceived">` に絞り、再生の分は getStats のたびに読む
- 基準の取り直し / 捨てた音 / 補間の回数 / 詰めた合計 / 補間した合計は購読をやり直しても消えず、今の遅れだけが購読のやり直し (AudioContext の作り直し) で 0 に戻る。この扱いを型・docs・JSDoc に書いた
- `docs/HIGH_LEVEL_API.md` と `CHANGES.md` ([CHANGE]、6 つのフィールドの追加で後方互換なし) を更新した
- テスト: 到着基準の並べ方で補間の回数と長さを、目標を守る並べ方で詰めと遅れのミリ秒換算 (非 0) を、基準の取り直しと捨ての写像を、購読のやり直しで今の遅れだけが 0 に戻ることを固定した。`AudioPlayoutScheduler.reset()` 単体でも統計の残存を固定した
- `vp check` / `tsc --noEmit` / 全 3554 テストが通った
