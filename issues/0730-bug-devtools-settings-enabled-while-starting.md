# moqt-devtools が、購読や配信を始めている途中でも相手側の停止で接続設定を編集できる状態に戻す

- Created: 2026-09-25
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-devtools-settings-enabled-while-starting
- Polished: {YYYY-MM-DD}

## 目的

moqt-devtools は、Publisher か Subscriber が接続設定を使っている間は `settingsDisabled` で接続設定の入力を無効にする。closed の `0727-bug-devtools-subscriber-stop-disabled-while-connecting.md` では、購読の確立を待っている間も購読中として扱い、接続設定を無効にするようにした。変更履歴には「この間も購読中として扱い、Stop を有効に、Start Subscribing と接続設定を無効にする」とある。

ところが、`settingsDisabled` を false に戻すかどうかの判定は、開始の途中にある Publisher / Subscriber を数えていない。1 画面に Publisher と Subscriber、または複数の Subscriber があるとき、次のことが起きる。

- 一方を止めると、開始の途中にある他方がまだ設定を読むのに、入力が編集できる状態に戻る
- その後、開始が済んで配信や購読が続いている間も、入力は有効のままになる

Publisher の開始の失敗でも、購読が続いているのに入力が有効に戻る。

## 現状

- `devtools/src/signals/subscriber.ts` の `hasActiveSubscriber` は、各インスタンスの `instance.subscriber.value !== null` だけを見る。確立を待っている間を表す `instance.isStarting` は見ない
  - `useSubscriber.ts` の `startSubscribing` は、最初に `isStarting` を立てて `settingsDisabled` を true にする。`instance.subscriber.value` は、映像トラックの SUBSCRIBE の応答を受けた後に設定する
  - `startSubscribing` は、`await connect(...)` の後で `settings.trackName` / `settings.catalogSubscriptionTimeout` / `settings.useDedicatedWorker` を読む
- `settingsDisabled` を false に戻す経路は 3 つある
  - `devtools/src/hooks/useSubscriber.ts` の `resetSubscriberState`: `if (!sub.hasActiveSubscriber.value && !isOtherPublisherActive())`。`teardownSubscriber` は `isOtherPublisherActive` に `() => pub.pubSession.value !== null` を渡す
  - `devtools/src/hooks/usePublisher.ts` の `cleanupPublisher`: `if (!sub.hasActiveSubscriber.value)`
  - `usePublisher.ts` の `startPublishing` の `catch`: `cleanupPublisher()` の直後に、条件なしで `settings.settingsDisabled.value = false;`
- Publisher 側には開始の途中を表す signal が無い
  - `startPublishing` は最初に `settingsDisabled` を true にする
  - `pub.pubSession.value` は `await connect(...)` の後に設定する
  - その後の `settings.selectedCameraDeviceId` と `settings.useDedicatedWorker` は、`pubSession` の設定より後で読む
- `settingsDisabled` を true にするのは `startSubscribing` と `startPublishing` の開始時だけである。一度 false に戻ると、進んでいる開始が済んでも true に戻らない
- 既存のテスト
  - `devtools/src/signals/subscriber.test.ts` の `hasActiveSubscriber tracks instance.subscriber.value updates` は `subscriber.value` だけを見る
  - `devtools/src/hooks/useSubscriber.test.ts` には、`resetSubscriberState` が他の Publisher の有無で `settingsDisabled` を戻す / 保つテストがある

## 再現手順

コードの経路で確かめた。実際の relay での再現はまだ行っていない。

1. Subscriber の確立待ちと、別の Subscriber の停止 (`resetSubscriberState` の経路)
   1. Add Subscriber を押して Subscriber を 2 つにする
   2. Catalog Timeout を長め (30 sec など) にする
   3. publisher の居ない namespace で、Subscriber 1 と Subscriber 2 の Start Subscribing を押す。どちらも catalog を待つ間「Connecting...」のままになる
   4. Subscriber 1 の Stop を押す
   5. Subscriber 2 は「Connecting...」のままだが、Track Name などの接続設定の入力が編集できる状態になる
2. 購読の確立済みと、Publisher の開始の失敗 (`startPublishing` の `catch` の経路)
   1. Video Source を camera にしておく
   2. 別のタブで配信している namespace を Subscriber で購読し、確立させる
   3. このタブで Start Publishing を押し、カメラの許可を拒否する
   4. Subscriber は購読を続けているが、接続設定の入力が編集できる状態になる
3. Publisher の接続中と、Subscriber の停止 (`resetSubscriberState` の `isOtherPublisherActive` の経路)
   1. Start Publishing を押し、`connect` が返るまで (`pubSession` が null の間) に Subscriber の Stop を押す
   2. Publisher の配信が始まった後も、接続設定の入力が有効のままになる

## 設計方針

- 「接続設定を使っている」を、開始の途中を含めて判定する
  - `hasActiveSubscriber` は `instance.subscriber.value !== null || instance.isStarting.value` のインスタンスがあれば true にする。`SubscriberInstance` の JSDoc にある、`hasActiveSubscriber` が追跡するフィールドの説明も合わせて直す
  - Publisher 側に、開始の途中を表す signal (例: `pub.isStarting`) を足す。`startPublishing` の開始で立て、配信の確立か `cleanupPublisher` で下ろす。`teardownSubscriber` が `resetSubscriberState` に渡す判定を `pub.pubSession.value !== null || pub.isStarting.value` にする
- `startPublishing` の `catch` の、条件なしの `settings.settingsDisabled.value = false;` を消す。直前の `cleanupPublisher` が、Subscriber の有無を見て戻すため
- 判定は純粋な関数に切り出して、単体テストで固定する。`cleanupPublisher` は `usePublisher` の中にあり、直接テストできないため。例: `shouldEnableSettings({ subscriberActive, publisherActive })`。0727 がボタンの可否を `subscriberControlState` に切り出したのと同じやり方にする
- 対象外
  - `settingsDisabled` を派生値 (computed) にする作り直し
  - Publisher のボタンの可否 (開始の途中の Stop など)

## 完了条件

- 再現手順の 3 つの経路で、他方が開始の途中か、配信・購読を続けている間は、接続設定の入力が無効のままになる
- `hasActiveSubscriber` が、確立を待っているインスタンスを数える。`devtools/src/signals/subscriber.test.ts` で確かめる
- `resetSubscriberState` が、他の Subscriber の確立待ちと Publisher の開始の途中で `settingsDisabled` を保つ。`devtools/src/hooks/useSubscriber.test.ts` で確かめる
- 切り出した判定の関数の入力の組み合わせを、単体テストで固定する
- `startPublishing` の `catch` に、条件なしで `settingsDisabled` を false にする処理が残っていない
- `CHANGES.md` の `## develop` に `[FIX]` で載る
- `npx vp check` / `npx vp test --run` / `npx vp run e2e-test` が通る

## 参照

- closed の `0727-bug-devtools-subscriber-stop-disabled-while-connecting.md` (`isStarting` を足し、確立待ちの間も接続設定を無効にするとした)
- `devtools/src/signals/subscriber.ts` の `hasActiveSubscriber` / `SubscriberInstance`
- `devtools/src/hooks/useSubscriber.ts` の `startSubscribing` / `resetSubscriberState` / `teardownSubscriber`
- `devtools/src/hooks/usePublisher.ts` の `startPublishing` / `cleanupPublisher`
- `devtools/src/utils/subscriberControls.ts` の `subscriberControlState` (判定を純粋な関数に切り出した前例)

## 解決方法

{未着手}
