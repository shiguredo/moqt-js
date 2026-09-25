# moqt-devtools が、購読や配信を始めている途中でも相手側の停止で接続設定を編集できる状態に戻す

- Created: 2026-09-25
- Completed: 2026-09-25
- Branch: feature/fix-devtools-settings-enabled-while-starting
- Polished: 2026-09-25

## 目的

moqt-devtools は、Publisher か Subscriber が接続設定を使っている間、`settingsDisabled` で接続設定の入力を無効にする。closed の `0727-bug-devtools-subscriber-stop-disabled-while-connecting.md` では、購読の確立を待っている間も購読中として扱うように `isStarting` を足した。その変更履歴には「この間も購読中として扱い、Stop を有効に、Start Subscribing と接続設定を無効にする」とある。

ところが、`settingsDisabled` を false に戻すかどうかの判定は、開始の途中にある Publisher / Subscriber を数えていない。そのため 1 画面に Publisher と Subscriber、または複数の Subscriber があると、次のことが起きる。

- 一方を止めると、他方が開始の途中でまだ設定を読むのに、入力が編集できる状態に戻る
- その後、開始が済んで配信や購読が続いている間も、入力は有効のままになる

加えて、Publisher の開始が失敗したときも、購読が続いているのに入力が有効に戻る。

## 現状

- `devtools/src/signals/subscriber.ts` の `hasActiveSubscriber` は、各インスタンスの `instance.subscriber.value !== null` だけを見る。確立を待っている間を表す `instance.isStarting` は見ない
  - `devtools/src/hooks/useSubscriber.ts` の `startSubscribing` は、最初に `isStarting` を立て、`settingsDisabled` を true にする。`instance.subscriber.value` を設定するのは、映像トラックの SUBSCRIBE の応答を受けた後で、その直後に `isStarting` を下ろす
  - `startSubscribing` は `await connect(...)` の後で、`settings.trackName` / `settings.catalogSubscriptionTimeout` / `settings.useDedicatedWorker` などを読む
- `settingsDisabled` を false に戻す経路は 3 つある
  - `useSubscriber.ts` の `resetSubscriberState`
    - 判定は `if (!sub.hasActiveSubscriber.value && !isOtherPublisherActive())`
    - 自分の `isStarting` はこの判定より前に下ろす
    - `teardownSubscriber` は `isOtherPublisherActive` として `() => pub.pubSession.value !== null` を渡す。`teardownSubscriber` は `useSubscriber` の中にあり、export されていない
  - `devtools/src/hooks/usePublisher.ts` の `cleanupPublisher`: `if (!sub.hasActiveSubscriber.value)`
  - `usePublisher.ts` の `startPublishing` の `catch`: `cleanupPublisher()` の直後に、条件なしで `settings.settingsDisabled.value = false;`
- Publisher 側には開始の途中を表す signal が無い
  - `startPublishing` は try の先頭で `settingsDisabled` を true にし、`parseResolution` などで設定を読んでから `await connect(...)` する
  - `pub.pubSession.value` は `connect` の後に設定し、`pub.publisher.value` は映像トラックの `session.publish` の後に設定する
  - `settings.selectedCameraDeviceId` と `settings.useDedicatedWorker` は、`pubSession` を設定した後で読む
- `settingsDisabled` を true にするのは `startSubscribing` と `startPublishing` の開始時だけである。一度 false に戻ると、進んでいる開始が済んでも true に戻らない
- テストについて
  - `usePublisher.ts` の `usePublisher` は preact のフックを使わない普通の関数である
    - `devtools/src/hooks/usePublisher.test.ts` は `usePublisher()` を直接呼んでテストしている
    - `settings.resolution` を不正な値にすると、`startPublishing` は `parseResolution` で例外を投げて `catch` に入る。relay は要らない
    - テスト間の初期化は `resetPublisherSignals` で行う
  - `useSubscriber` は `useRef` などのフックを使うため、`teardownSubscriber` は単体テストから呼べない。`resetSubscriberState` は export されている
  - `devtools/src/signals/subscriber.test.ts` の `hasActiveSubscriber tracks instance.subscriber.value updates` は `subscriber.value` だけを見る
  - `devtools/src/hooks/useSubscriber.test.ts` の `resetSubscriberState keeps settingsDisabled when other publisher is active` は、`isOtherPublisherActive` に `() => true` を渡している
  - moqt-js の E2E (`npx vp run e2e-test`) は relay を起動しない

## 再現手順

コードの経路で確かめた。実際の relay での再現はまだ行っていない。

1. Subscriber の確立待ちと、別の Subscriber の停止 (`resetSubscriberState` の経路)
   1. Add Subscriber を押して Subscriber を 2 つにする
   2. Catalog Timeout を長め (30 sec など) にする
   3. publisher の居ない namespace で、Subscriber 1 と Subscriber 2 の Start Subscribing を押す。どちらも catalog を待つ間は「Connected, subscribing to catalog...」の表示になる
   4. Subscriber 1 の Stop を押す
   5. Subscriber 2 は catalog を待ったままなのに、Track Name などの接続設定の入力が編集できる状態になる
2. 購読の確立済みと、Publisher の開始の失敗 (`startPublishing` の `catch` の経路)
   1. サイトのカメラの許可をブロックした状態で、URL の `videoSource=camera` でページを開く。画面で Video Source を camera に切り替えると、その時点で `fetchCameraDevices` が許可を求めてしまうため
   2. 別のタブで配信している namespace を Subscriber で購読し、確立させる
   3. このタブで Publisher の Publish (`data-testid="publisher-publish-button"`) を押す。`getVideoStream` がカメラを取れずに失敗し、`catch` に入る
   4. Subscriber は購読を続けているのに、接続設定の入力が編集できる状態になる
   - 注意: このタブの Publisher は、カメラを求める前に同じ namespace へ catalog を publish する。relay が重複した PUBLISH をどう扱うかによっては、手順 4 の前に Subscriber の購読が終わることがある
3. Publisher の接続中と、Subscriber の停止 (`resetSubscriberState` の `isOtherPublisherActive` の経路)
   1. Subscriber で購読を始めておく (確立済みでも確立待ちでもよい)
   2. Publisher の Publish を押し、`connect` が返るまで (`pubSession` が null の間) に Subscriber の Stop を押す
   3. Publisher の配信が始まった後も、接続設定の入力が有効のままになる
   - この窓は `connect` の間だけで、手で押すのは難しい。この経路は単体テストで確かめる

## 設計方針

- 「接続設定を使っている」を、開始の途中を含めて判定する
  - Subscriber 側
    - `hasActiveSubscriber` は、`instance.subscriber.value !== null || instance.isStarting.value` のインスタンスが 1 つでもあれば true にする
    - `SubscriberInstance` の JSDoc にある、`hasActiveSubscriber` が追跡するフィールドの説明も合わせて直す
  - Publisher 側
    - `devtools/src/signals/publisher.ts` に、開始の途中を表す `isStarting` と、使っているかを表す computed の `hasActivePublisher` (`pubSession.value !== null || isStarting.value`) を足す
    - `teardownSubscriber` は `isOtherPublisherActive` として `() => pub.hasActivePublisher.value` を渡す
  - `pub.isStarting` の立て下ろし
    - `startPublishing` の開始で立てる
    - 下ろすのは、映像トラックの `pub.publisher.value = publisherInstance` の直後か、`cleanupPublisher` のどちらか。Subscriber の `isStarting` が `instance.subscriber.value` を設定した直後に下りるのとそろえる
    - `pubSession` を設定した後は、`pubSession !== null` でも使っていると判定する。`isStarting` が要るのは、`pubSession` が null の間を覆うためである
- `startPublishing` の `catch` にある、条件なしの `settings.settingsDisabled.value = false;` を消す。直前の `cleanupPublisher` が、Subscriber の有無を見て戻すため
- テスト (モックやスタブは使わず、実際の signal と関数を使う)
  - この issue のテストは `FakeSession` / `FakeSubscriber` を使わない
    - 確立済みの Subscriber は、既存のテストが `devtools/src/testSupport/fakes.ts` の `FakeSubscriber` で作っている
    - `pubSession` が null でない状態を作るテストは無い。他の Publisher が動いている状態は、`isOtherPublisherActive` に `() => true` を渡して表している
    - この issue で足す判定は開始の途中 (`isStarting`) なので、確立待ちの状態だけで経路を確かめられる。AGENTS.md のモック・スタブ禁止に照らし、Fake に頼るテストは増やさない
  - そのため、経路 2 の単体テストは、再現手順 2 (確立済みの Subscriber) と違い、確立を待っている Subscriber で確かめる。`catch` の条件なしの処理を消し忘れると、確立待ちの Subscriber でも `settingsDisabled` が false に戻るため、経路 2 の修正の確認としては足りる
  - `devtools/src/signals/subscriber.test.ts`: `subscriber.value` が null で `isStarting` が true のインスタンスがあるとき、`hasActiveSubscriber` が true になる
  - `devtools/src/signals/publisher.test.ts` (新規): `pubSession` が null のまま、`isStarting` が true なら `hasActivePublisher` が true、false なら false になる
  - `devtools/src/hooks/useSubscriber.test.ts`: `resetSubscriberState` が `settingsDisabled` を保つことを確かめる (経路 1 と 3)
    - `subscriberInstances` に登録した別のインスタンスが確立を待っている (`isStarting` が true) とき
    - `isOtherPublisherActive` に `() => pub.hasActivePublisher.value` を渡し、`pub.isStarting` を true (`pubSession` は null) にしたとき
  - `devtools/src/hooks/usePublisher.test.ts` (経路 2 と、`pub.isStarting` の立て下ろし)。`resetPublisherSignals` に `isStarting` の初期化を足す
    - `catch` の経路 (経路 2): `settings.resolution` を不正な値にして `startPublishing()` を呼ぶ。`parseResolution` は最初の `await` より前に例外を投げるため、`catch` から `cleanupPublisher` までが呼び出しの中で同期に終わる
      - 確立を待っている Subscriber (`subscriberInstances` に登録したインスタンスの `isStarting` を true にしたもの) があるときは、`settingsDisabled` が true のまま残り、`pub.isStarting` が false に戻る
      - Subscriber が居ないときは、`settingsDisabled` が false に戻る
    - 確立を待つ Subscriber がある間に `stopPublishing()` を呼んでも、`settingsDisabled` は true のまま残る
    - 開始の途中の `pub.isStarting`: 正しい resolution (既定値) のまま `startPublishing()` を呼ぶと、戻った直後 (await する前) に `pub.isStarting` が true になっている。await した後は false に戻っている
      - 単体テストは Node で動き、`WebTransport` が無い。async 関数の `connect` の中で `new WebTransport` が投げる例外は、同期の例外ではなく reject になり、`startPublishing` の `await connect(...)` の後の `catch` で `isStarting` が下りる。relay は要らない
- 対象外
  - `settingsDisabled` を派生値 (computed) にする作り直し
  - Publisher のボタンの可否 (開始の途中の Stop など)
  - 停止した配信の session の close / error のコールバックが、次に始めた配信を後始末すること
    - `startPublishing` が `connect` に渡すコールバックは、今の配信かどうかを見ずに `cleanupPublisher()` を呼ぶ。Subscriber 側で 0728 が `createAttemptGuard` で直したのと同じ種類の問題である
    - この問題がある間は、停止の直後に Publish を押すと、前の session のコールバックが新しい開始の `pub.isStarting` を下ろしうる
    - 別の issue で扱う
  - relay を使う確認。moqt-js の E2E は relay を起動しないため、判定は上の単体テストで確かめる

## 完了条件

- `hasActiveSubscriber` が、確立を待っているインスタンスを数える
- `pub.hasActivePublisher` が、`pubSession` が null でも `pub.isStarting` が true なら true になる。`teardownSubscriber` がこれを `resetSubscriberState` に渡す
- `startPublishing` の開始で `pub.isStarting` が立ち、映像トラックの `pub.publisher` の設定か `cleanupPublisher` で下りる
- `startPublishing` の `catch` に、条件なしで `settingsDisabled` を false にする処理が残っていない
- 設計方針のテストがすべてある。再現手順の 3 つの経路 (別の Subscriber の停止、Publisher の開始の失敗、Publisher の開始の途中での Subscriber の停止) で、`settingsDisabled` が true のまま残ることを単体テストで確かめる
- `CHANGES.md` の `## develop` に `[FIX]` で載る
- `npx vp check` / `npx vp test --run` / `npx vp run e2e-test` が通る

## 参照

- closed の `0727-bug-devtools-subscriber-stop-disabled-while-connecting.md` (`isStarting` を足した)
- closed の `0728-bug-devtools-stale-session-close-aborts-new-subscribe.md` (Subscriber 側で、停止した購読のコールバックを今の回に限った)
- `devtools/src/signals/subscriber.ts` の `hasActiveSubscriber` / `SubscriberInstance`
- `devtools/src/signals/publisher.ts`
- `devtools/src/hooks/useSubscriber.ts` の `startSubscribing` / `resetSubscriberState` / `teardownSubscriber`
- `devtools/src/hooks/usePublisher.ts` の `startPublishing` / `stopPublishing` / `cleanupPublisher`
- `devtools/src/hooks/usePublisher.test.ts` の `resetPublisherSignals` と、`usePublisher()` を直接呼ぶ既存のテスト
- `devtools/src/hooks/useSubscriber.test.ts` の `resetSubscriberState` のテスト

## 解決方法

- `devtools/src/signals/subscriber.ts` の `hasActiveSubscriber` が、`subscriber.value` に加えて `isStarting` のインスタンスも数えるようにした。`SubscriberInstance` の JSDoc と `isStarting` のコメントも合わせて直した
- `devtools/src/signals/publisher.ts` に、配信を始めている途中を表す `isStarting` と、`pubSession !== null || isStarting` の computed `hasActivePublisher` を足した
- `devtools/src/hooks/usePublisher.ts`
  - `startPublishing` の開始 (try の前) で `pub.isStarting` を立てる
  - 映像トラックの `session.publish` が返ったら、モジュール関数 `markVideoPublisherEstablished` で下ろす。この処理を `startPublishing` に直接書くと lint の `max-statements` (100) を超えるため、既存の `resetVideoPublishState` と同じくモジュールの関数に切り出した
  - `cleanupPublisher` でも下ろす
  - `catch` の条件なしの `settings.settingsDisabled.value = false;` を消した。入力を戻すかは `cleanupPublisher` が Subscriber の有無を見て決める
- `devtools/src/hooks/useSubscriber.ts` の `resetSubscriberState` は、`subscriber` と `isStarting` を下ろしてから、`!sub.hasActiveSubscriber.value && !pub.hasActivePublisher.value` のときだけ入力を戻す
- テスト
  - `devtools/src/hooks/useSubscriber.prop.ts` (新規): `resetSubscriberState` の PBT。止めるインスタンス、任意の数の他の Subscriber、Publisher がそれぞれ開始の途中かの組み合わせで、止めたインスタンス自身を数えず、他のどれかが使っている間だけ入力を無効のまま残すことを確かめる (経路 1 と 3)
  - `devtools/src/signals/subscriber.prop.ts` (新規): `hasActiveSubscriber` が任意の数のインスタンスの `isStarting` を数える PBT
  - `devtools/src/signals/publisher.test.ts` (新規): `pubSession` が null のまま `isStarting` の真偽で `hasActivePublisher` が決まる
  - `devtools/src/hooks/usePublisher.test.ts`: 開始の失敗 (不正な解像度) で、確立を待つ Subscriber が居れば入力を保ち、居なければ戻す (経路 2)。確立を待つ Subscriber が居る間の `stopPublishing` で入力を保つ。`connect` を待っている間は `pub.isStarting` が立ち、失敗の後始末で下りる
  - `devtools/src/hooks/useSubscriber.test.ts`: 既存の「resetSubscriberState resets every state signal to initial value」で、確立済みで確立待ちも立っているインスタンスを一覧に登録し、止めたインスタンス自身を数えずに入力を戻すことを確かめた
  - 各テストが守る修正は、実装を一時的に崩して失敗することで確かめた (`hasActiveSubscriber` の `isStarting`、`resetSubscriberState` の Publisher の判定、自身の `subscriber` と `isStarting` を判定の前に下ろす順序、`catch` の条件なしの処理、`pub.isStarting` の立て下ろし)
- 設計方針から変えた点
  - `resetSubscriberState` の引数 `isOtherPublisherActive` を消し、関数の中で `pub.hasActivePublisher` を直接読むようにした。引数で渡すと、テストが本番と同じ式をテストの中で書き直すことになり、`teardownSubscriber` の述語を戻してもテストが落ちなかったため。`pub.isStarting` を立てれば Fake なしに「Publisher が使っている」状態を作れるので、注入は不要になった
  - 経路 1 と 3 と `hasActiveSubscriber` は、単体テストではなく PBT で確かめた。組み合わせで表せる性質であり、PBT で書けるものを単体テストで書かない規約に従った。`resetSubscriberState` の判定の既存の単体テスト 2 件 (`() => true` / `() => false` を渡していたもの) も PBT に置き換えた
  - `pub.isStarting` の立て下ろしは、`WebTransport` が無いことに頼らず、`moqt://` で始まらない URL で確かめた。`connect` は async 関数なので URL の検証の例外は reject になり、実行環境の `WebTransport` の有無に依存しない
  - 確立済みの Subscriber を止めたときに自身を数えないことは、既に `FakeSubscriber` を使っている既存の単体テストに assert を足して固定した (新しく Fake に頼るテストは増やしていない)
- 確認: `npx vp check` / `npx vp test --run` (147 files / 2786 tests) / `npx tsc --noEmit` / `npx vp run e2e-test` (40 passed) が通る。差分レビューで、修正前の develop では経路 1〜3 で入力が有効に戻り、修正後は無効のまま残ることを headless Chromium で確かめた
- 残した課題
  - `hasActivePublisher` の `pubSession !== null` の項と、`markVideoPublisherEstablished` で `isStarting` を下ろす処理は、Fake を増やさない方針のためテストで固定していない (前者は変更前の `teardownSubscriber` の述語でも未検証だった。後者は `pubSession` が同じ間を覆うため外から観測できない)
  - 停止した配信の session の close / error のコールバックや、古い `startPublishing` の `catch` が、次に始めた配信を後始末する問題 (対象外とした別 issue)
  - 開始の途中でも Publish と Preview を押せる
