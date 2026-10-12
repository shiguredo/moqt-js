# moqt-devtools の subscriber が、トラック 1 本の正常終了で購読全体とセッションを閉じる

- Created: 2026-10-12
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-devtools-track-end-teardown
- Polished: 2026-10-12
- Reporter: @voluntas

## 目的

moqt-devtools の subscriber は、購読している映像 (音声だけの購読では音声) のトラックが PUBLISH_DONE で終わると、`trackCallbacks.end` から `teardownSubscriber` を呼び、catalog / audio / event の購読を解除し、subscriber 側の WebTransport セッションまで閉じる。draft-ietf-moq-transport-22 が終了を定めているのはトラック単位の購読 (§3.1 / §3.1.2 / §9.9) であり、1 本のトラックの終了でセッションを閉じることは要求していない (§6.6 はエラーの場合の MAY であり、他の購読への影響を考慮することを求めている)。

配信元が止まればそのトラックの購読が終わること自体は仕様どおりである。問題は、無関係な購読とセッションまで道連れにすることで、relay の挙動を切り分けるためのツールとして誤った結論を導く点にある。トラック単位の終了として扱い、セッションは明示的に止めるまで維持する。

## 現状

- `devtools/src/hooks/useSubscriber.ts` の `startSubscribing` が作る `trackCallbacks.end` は、表示を「Stream ended」にして `teardownSubscriber()` を呼ぶ
- `teardownSubscriber` → `closeSubscriberResources` は、decoder と audioDecoder を閉じ、catalog / audio / event の購読を解除し、`session.close()` を呼ぶ。`resetSubscriberState` は `status` / `statusMessage` / `isStopping` を除く signal を初期化する。「Ready to subscribe」を表示するのは Stop の finally だけであり、トラック終了の経路では表示は「Stream ended」のまま残る
- 購読の終了を `trackCallbacks` に渡すのは、映像があるときは映像、音声だけの購読では音声である。映像と音声の両方を購読するときは音声の `end` を `trackCallbacks` に渡さないため、音声だけが先に終わっても teardown は起きない。catalog と event の `end` はログのみである
- `trackCallbacks.error` は表示を「Subscribe error: ...」にするだけで teardown しない
- moqt-js 本体は購読単位で終わる。`src/session/bidi.ts` の `bidiHandlePublishDone` は `SubscriberImpl.handleEnd` を呼ぶだけでセッションを閉じない。`src/session.ts` のコメントも、セッションの終了は `markClosed` であり `end` コールバックは PUBLISH_DONE 専用としている
- closed の `0743-bug-devtools-subscriber-audio-only-catalog.md` は「購読し直した後に publisher を止めると「Stream ended」になり、Start Subscribing を押せる」、`0744-add-devtools-video-source-none.md` は完了条件で「publisher の Stop で subscriber が「Stream ended」になる」、`0163-fix-stop-subscribing-cleanup-reentry-race.md` は非 stop 主導の `end` で「Stream ended」を表示して後始末することを、それぞれ期待挙動として記録している。本 issue は、トラックの終了で購読とセッションまで閉じる点をこの期待から見直す

## 再現手順

利用者からの報告 (2026-10-12): moqt-devtools で publish を止めると subscribe も止まる。コードの経路で確認した。実リレーでの再現は未実施である。

1. publisher と subscriber を同じページで動かし、購読を確立する
2. publisher の Stop Publish を押す
3. publisher は各トラックに PUBLISH_DONE (TRACK_ENDED) を送ってから、publisher のセッションを閉じる
4. subscriber は映像 (または音声) のトラックについて PUBLISH_DONE を受け取り、`trackCallbacks.end` が呼ばれる
5. `teardownSubscriber` が catalog / audio / event の購読を解除し、まだ終わっていない購読もセッションごと閉じる。表示は「Stream ended」になり、購読ボタンが押せる状態に戻る

## 設計方針

- `trackCallbacks.end` では teardown せず、そのトラックの状態を「終了」にする。セッションと他のトラックの購読は維持する
- `teardownSubscriber` / `closeSubscriberResources` を呼ぶ既存の経路 (Stop ボタン、WebTransport の close と error、接続と購読の失敗、decoder の再初期化の失敗、アンマウント) は残す。パネルの削除では `removeSubscriber` がリソースを解放し、アンマウント経由で `teardownSubscriber` が呼ばれるが、Map から entry が消えているため `closeSubscriberResources` と `resetSubscriberState` には進まない
- UI はトラックごとの状態 (購読中 / 終了 / エラー) を持ち、映像の終了後も最後のフレームを保持し、音声が生きていれば再生を続ける。パネルが「購読中だが何も届かない」状態になるため、状態の表示は必ず入れる。状態は `devtools/src/signals/subscriber.ts` の `SubscriberInstance` の signal として持ち、`devtools/src/components/SubscriberPanel.tsx` が表示する。状態の遷移はフックの外に置く純粋な関数に切り出し、単体テストで固定する
- 終了の理由 (PUBLISH_DONE の status code と reasonPhrase) は `Subscriber` の終了通知から取得できないため、`0840-change-subscriber-publish-done-reason.md` に依存する。0840 は通知までの issue であり、devtools での理由の表示は本 issue が持つ。本 issue は 0840 の完了後に実装する
- Stop を押したときの既存の挙動 (表示とログ) は変えない
- 対象外
  - 自動再購読
  - publish の止め方のバリエーション (`0841-add-devtools-publish-stop-variants.md`)

## 完了条件

- 購読中のトラックが PUBLISH_DONE で正常に終わっても、他のトラックの購読と subscriber のセッションが維持される
- 終わったトラックの状態が「終了」として表示され、最後のフレームが保持される
- 終わったトラックの状態に、終了の理由 (status code と reasonPhrase) が表示される
- Stop ボタン、WebTransport の close と error、接続と購読の失敗、decoder の再初期化の失敗、アンマウントでは従来どおり後始末する
- 「トラック 1 本の終了で、他のトラックの購読とセッションが維持される」ことをテストで固定する。トラック終了の扱いは `startSubscribing` のクロージャにあるため、状態の遷移をフックの外の純粋な関数に切り出し、`devtools/src/hooks/useSubscriber.test.ts` で固定する。同ファイルが固定している `closeSubscriberResources` の解除順は変えない
- `npx vp check` / `npx vp test --run` / `npx vp run e2e-test` が通る

## 参照

- `0840-change-subscriber-publish-done-reason.md`
- `devtools/src/hooks/useSubscriber.ts` の `startSubscribing` / `trackCallbacks` / `teardownSubscriber` / `closeSubscriberResources`
- `devtools/src/hooks/useSubscriber.test.ts`
- `devtools/src/signals/subscriber.ts` の `SubscriberInstance` / `hasEstablishedSubscription`
- `devtools/src/components/SubscriberPanel.tsx` の `subscriberControlState`
- `src/session/bidi.ts` の `bidiHandlePublishDone`
- `src/subscriber.ts` の `SubscriberImpl.handleEnd`
- closed の `0163-fix-stop-subscribing-cleanup-reentry-race.md` / `0743-bug-devtools-subscriber-audio-only-catalog.md` / `0744-add-devtools-video-source-none.md`

## 解決方法

{未着手}
