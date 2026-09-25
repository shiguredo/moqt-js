# devtools の subscriber が接続の途中 (catalog の待ちなど) に Stop を押せず、Start Subscribing を押せてしまう

- Created: 2026-09-25
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-devtools-subscriber-stop-while-connecting
- Polished: {YYYY-MM-DD}

## 目的

moqt-devtools の subscriber は、Start Subscribing を押してから映像トラックの購読が確立するまでの間、Stop が無効で Start Subscribing が有効になる。この間には、WebTransport の接続、catalog の購読と待ち (Catalog Timeout、既定 5 秒、最大 30 秒)、decoder の構成、映像トラックの購読 (publisher が居なければ RENDEZVOUS_TIMEOUT の間 relay が保持する) が入る。利用者は進んでいない接続を止められず、Start Subscribing をもう一度押すしかない。

停止と購読し直しの不具合の調査 (sora-moq 0818、moqt-js 0726) で、catalog を待っている間に Stop が押せないことを確かめた。

## 現状

- `devtools/src/components/SubscriberPanel.tsx` は `isSubscribing = instance.subscriber.value !== null` とし、Start Subscribing を `isSubscribing || isStopping` で、Stop を `!isSubscribing || isStopping` で無効にする
- `devtools/src/hooks/useSubscriber.ts` の `startSubscribing` は、映像トラックの SUBSCRIBE の応答を受けた後に `instance.subscriber.value` を設定する。それまでは `null` である
- `stopSubscribing` は `abortControllerRef` を abort し、進んでいる `startSubscribing` を途中で止められる (各 await の後の `checkAborted`)。止める処理はあるが、画面から呼べない
- 途中で Start Subscribing をもう一度押すと、`startSubscribing` は前の AbortController を abort して新しい接続を始める。前の接続の後始末は前の流れの `checkAborted` に任される

## 設計方針

- subscriber のインスタンスに「購読を始めてから、購読が確立するか後始末を終えるまで」を表す signal を持たせ、`startSubscribing` の開始で立て、確立 (`instance.subscriber.value` の設定) と `teardownSubscriber` で下ろす
- SubscriberPanel は、この signal が立っている間も購読中として扱い、Stop を有効に、Start Subscribing を無効にする
- 接続の途中の Stop は既存の `stopSubscribing` (abort と後始末) をそのまま使う

## 完了条件

- コンポーネントテスト (`SubscriberPanel.ct.tsx`) で、購読を始めてから確立するまでの間、Stop が有効で Start Subscribing が無効であることを確かめる
- 単体テストで、signal が `startSubscribing` の開始で立ち、確立と後始末で下りることを確かめる
- sora-moq の相互運用 harness の E2E で、publisher の居ない relay に購読を始め、catalog を待っている間に Stop を押すと、購読が止まり Start Subscribing が押せる状態に戻ることを確かめる
- `vp check` / `tsc --noEmit` / `vp test run` が通る
