# notifyGoaway と lastGoawayUri が subscriber と publisher で重複している

- Created: 2026-11-03
- Completed: {YYYY-MM-DD}
- Branch: feature/refactor-goaway-notifier
- Polished: {YYYY-MM-DD}

## 目的

`MediaSubscriberImpl` と `MediaPublisherImpl` に、直前と同じ URI の連続通知を抑止する `notifyGoaway` と `lastGoawayUri` が一字一句同じ形で実装されている。一方を直して他方を直し忘れると、抑止の契約が 2 クラスで食い違う。接続処理 (`src/createMedia/connect.ts`) を共有している前例に合わせ、抑止付きの通知を 1 箇所に集約する。

## 現状

- `src/createMediaSubscriber.ts` の `notifyGoaway` は `lastGoawayUri` と比較して同じ URI なら捨て、違えば代入して `callbacks.onGoaway` を try/catch で呼ぶ
- `src/createMediaPublisher.ts` の `notifyGoaway` も同じ実装である
- 両クラスとも `connectToServer` の開始時に `lastGoawayUri = null` に戻す
- JSDoc もほぼ同一で、仕様引用が重複している

## 設計方針

`src/createMedia/` に抑止付き通知の小さなヘルパーを置く。

- `createGoawayNotifier(onGoaway)` のような factory が `notify(newSessionUri)` と `reset()` を返す
- 抑止の意味 (直前と同じ URI の連続通知だけを捨てる) と例外の握り潰しを 1 箇所に書く
- 両クラスは `notifyGoaway` をヘルパーへ委譲し、`connectToServer` の開始時に `reset()` を呼ぶ
- 公開 API と挙動は変えない

## 完了条件

- `notifyGoaway` / `lastGoawayUri` の重複が無くなる
- 直前と同じ URI の連続通知の抑止と、非連続の同一 URI の再通知の挙動が変わらない
- 再接続時に抑止の状態が戻る
- `vp check` と `vp test --run` が通る

`CHANGES.md` は MOQT RFC ドラフト中のため更新しない (`CODEBASE.md` の特別ルール)。

## 参照

- `src/createMediaSubscriber.ts` の `notifyGoaway` / `lastGoawayUri` / `connectToServer`
- `src/createMediaPublisher.ts` の `notifyGoaway` / `lastGoawayUri` / `connectToServer`
- `src/createMedia/connect.ts` (2 クラスが共有している接続処理の前例)
- `src/codec/types.ts` の `MediaSubscriberCallbacks.onGoaway` / `MediaPublisherCallbacks.onGoaway`
