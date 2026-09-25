# moqt-devtools の publisher で、停止した配信の後始末が次に始めた配信を後始末することがある

- Created: 2026-09-25
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-devtools-stale-publisher-cleanup
- Polished: {YYYY-MM-DD}

## 目的

moqt-devtools の publisher は、配信の後始末 (`cleanupPublisher`) を呼ぶコールバックが、どの回の配信のものかを確かめない。停止した配信の session の close は relay との往復の後に届くため、停止の直後に Publish を押すと、前の配信のコールバックが次に始めた配信の session を閉じ、状態を初期値に戻すことがある。

Subscriber 側では、closed の `0728-bug-devtools-stale-session-close-aborts-new-subscribe.md` で、コールバックが今の回の購読のときだけ後始末するようにした (`createAttemptGuard`)。Publisher 側には同じ仕組みが無い。

## 現状

- `devtools/src/hooks/usePublisher.ts` の `startPublishing` が `connect` に渡す `close` / `error` のコールバックは、表示を `disconnected` / `error` に変え、条件なしで `cleanupPublisher()` を呼ぶ
- `src/session.ts` の Session は、自分から閉じた場合も `transport.closed` の後に `callbacks.close` を呼ぶ。そのため、停止した配信の close は後から届く
- `cleanupPublisher` は、呼ばれた時点の `pub.pubSession` / `pub.publisher` / `pub.catalogPublisher` / `pub.audioPublisher` / encoder / フレームの読み出しを閉じて null にし、`pub.isStarting` を下ろす。どの配信のものかは見ない
  - `pubSession` の close も `cleanupPublisher` の中で投げっぱなし (`close().catch(...)`) で、完了を待たない
- `stopPublishing` の `finally` で `cleanupPublisher` を呼んだ後、Publish のボタンは `devtools/src/components/PublisherPanel.tsx` の `publishBtnDisabled = isPublishing || isStopping` で押せるようになる (`isPublishing = pub.publisher.value !== null`)
- 前の回の `startPublishing` の `catch` も、今の回かを見ずに `cleanupPublisher()` を呼ぶ。開始を重ねた場合 (`0739` で扱う Publish の二重押しなど)、先に失敗した回の後始末が後の回の配信を閉じる
- Subscriber 側の仕組み: `devtools/src/hooks/useSubscriber.ts` の `createAttemptGuard` は、登録した回の `AbortSignal` が今の `AbortController` のものかを判定する。`startSubscribing` はこの判定を通ったコールバックだけで表示を変えて後始末する

## 再現手順

コードの経路で確かめた。実際の relay での再現はまだ行っていない。

1. Publisher で配信を始め、配信中にする
2. Stop を押し、停止の後始末 (`cleanupPublisher`) が済んで Publish が押せるようになったら、すぐに Publish を押す
3. 前の配信の session の close のコールバックが、次の配信の `connect` の後に届く
4. そのコールバックの `cleanupPublisher` が、次の配信の `pubSession` を閉じて null にし、表示を「Disconnected: closeCode=..., reason=...」にする。次の配信は始まらないか、途中で止まる

## 設計方針

- Subscriber 側の `createAttemptGuard` と同じ考え方で、Publisher 側でも配信を始めるたびに回を識別し、コールバックと `catch` の後始末を今の回に限る
  - `startPublishing` の開始で、回を表す値 (例: `AbortController` か連番) を作り直してモジュールか hook の参照に置く
  - `connect` の `close` / `error` と、`startPublishing` の `catch` は、登録した回が今の回のときだけ表示を変えて `cleanupPublisher` を呼ぶ。今の回でないときは何もしない (前の回の session は、停止のときに `cleanupPublisher` が閉じ済み)
  - `stopPublishing` は今の回を終える (回の参照を消す)
- 判定は純粋な関数で表し、単体テストで確かめる。Subscriber 側の `createAttemptGuard` を共通にして使えるなら、そちらを使う
- 対象外
  - Publish と Preview のボタンを開始の途中に押せないようにすること (`0739`)
  - 映像や音声の publisher の `error` コールバック (表示を変えるだけで `cleanupPublisher` を呼ばない)

## 完了条件

- 停止した配信と、先に失敗した開始の回のコールバック (`connect` の `close` / `error`) と `catch` が、次に始めた配信の `pubSession` や状態を後始末しない
- 今の回の session が閉じたときは、従来どおり表示を変えて後始末する
- 判定を単体テストで確かめる (今の回、前の回、停止の後)
- `CHANGES.md` の `## develop` に `[FIX]` で載る
- `npx vp check` / `npx vp test --run` / `npx vp run e2e-test` が通る

## 参照

- closed の `0728-bug-devtools-stale-session-close-aborts-new-subscribe.md` (Subscriber 側の同じ問題)
- closed の `0730-bug-devtools-settings-enabled-while-starting.md` (「残した課題」でこの問題を別 issue とした)
- `devtools/src/hooks/usePublisher.ts` の `startPublishing` / `stopPublishing` / `cleanupPublisher`
- `devtools/src/hooks/useSubscriber.ts` の `createAttemptGuard`
- `src/session.ts` の close の通知 (`transport.closed` の後の `callbacks.close`)

## 解決方法

{未着手}
