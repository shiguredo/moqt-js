# moqt-devtools の subscriber が映像トラックの無い catalog を購読できない

- Created: 2026-09-25
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-devtools-subscriber-audio-only-catalog
- Polished: {YYYY-MM-DD}
- Reporter: @voluntas

## 目的

moqt-devtools の subscriber は、catalog に映像トラックが無いと「failed to get catalog: no video track in catalog」で購読をやめる。音声だけを配信する publisher (MSF の catalog は映像トラックを必須としない) を視聴できない。publisher に音声だけの配信を足す (Video Source の None) にあたり、利用者と subscriber も対応すると決めた。音声だけの catalog では音声トラックを購読し、映像の領域は空のままにする。

## 現状

- `devtools/src/hooks/useSubscriber.ts` の `startSubscribing` は、catalog を受け取ると `getVideoTracks` の先頭を取り出し、無ければ throw する。音声トラックは映像トラックの購読が確立した後に `resolveAudioTrack` で取り出し、`startAudioSubscription` で購読する。音声の購読に失敗したときは、ログを残して映像だけを続ける
- 購読の確立は映像トラックの Subscriber だけで判定する
  - `devtools/src/components/SubscriberPanel.tsx` の `subscriberControlState` に渡す `subscribed` は `instance.subscriber.value !== null`
  - `devtools/src/signals/subscriber.ts` の `hasActiveSubscriber` も `instance.subscriber.value !== null || instance.isStarting.value`
  - `instance.isStarting` は映像トラックの購読の確立で下りる
- 映像トラックの購読の `end` は、今の回の購読なら表示を「Stream ended」にして後始末する。音声トラックの購読の `end` はログを残すだけ

## 再現手順

1. 映像トラックを持たず音声トラックだけを持つ catalog を配信する publisher を用意する
2. devtools の subscriber で Start Subscribing を押す
3. 表示が「Failed: failed to get catalog: no video track in catalog」になり、音声も購読しない

## 設計方針

- catalog から購読する映像トラックと音声トラックを取り出す純粋な関数を置き、単体テストで固定する。どちらも無ければ throw する
- 映像トラックがあれば今と同じく映像を購読し、その後で音声を購読する (音声の失敗は映像を止めない)
- 映像トラックが無ければ decoder と映像の購読を作らず、音声だけを購読する
  - 音声の購読の確立で `isStarting` を下ろし、表示を「Subscribed: {namespace}/{音声トラック名}」にする
  - 音声の購読の失敗は、購読の失敗として扱う (表示を Failed にして後始末する)
  - 音声の購読の `end` は、映像の `end` と同じく今の回の購読なら「Stream ended」にして後始末する
- 購読の確立の判定 (`subscribed` と `hasActiveSubscriber`) に、音声トラックの Subscriber も含める
- 映像の canvas は、音声だけの購読でも同じ大きさのまま空で描く

## 完了条件

- 手元の relay で音声だけの catalog を購読し、音声の Object を受け取って復号する
- 音声だけの購読で Stop を押すと、音声トラックの UNSUBSCRIBE が送られる。publisher が止まると表示が「Stream ended」になる
- 映像と音声の両方を持つ catalog の購読は変わらない
- `vp check` / `tsc --noEmit` / `vp test run` / 既存の Playwright の E2E が通る
