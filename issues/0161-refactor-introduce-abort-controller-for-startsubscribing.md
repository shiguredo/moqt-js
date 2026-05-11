# `startSubscribing` に `AbortController` ベースの中断機構を導入する

Created: 2026-05-11
Model: Opus 4.7

## 概要

`devtools/src/hooks/useSubscriber.ts` の `startSubscribing` は、`await connect()` / Catalog 購読の await / `await decoderInstance.configure()` / `await session.subscribe()` といった複数の非同期境界を持つが、その途中で `cleanupSubscriber` が走った場合の中断検知は現状「`instance.session.value === null` 判定」一箇所しかない。これは `cleanupSubscriber` の副作用 (session 参照を null に上書きする) に依存した暗黙の中断シグナルであり、「session の意味」と「中断フラグの意味」が混線している。

恒久的な解決として、`useSubscriber` 内に `AbortController` を導入し、`cleanupSubscriber` で `abort()` を呼び、各 await 後に `signal.aborted` を確認する設計に置き換える。

## 根拠

- `useSubscriber.ts:363` (`if (instance.session.value === null) return;`) の中断検知が「session 参照」と「中断フラグ」の責務を兼ねており、責務が混線している。
- 中断検知が Catalog 取得後の 1 箇所にしか入っていないため、`await connect()` 直後、`await decoderInstance.configure()` 後、`await session.subscribe()` 後のいずれの await ポイントでも中断が漏れうる。特に `decoderInstance.configure()` 中に close が発火した場合、続く `instance.decoder.value = decoderInstance` で「すでに close 済み instance」に対して decoder が再代入される。
- `instance.isStopping` は `stopSubscribing` の二重実行防止専用で、`cleanupSubscriber` 経路 (close / error コールバック由来) では立たないため、`startSubscribing` 側の中断検知には流用できない。
- 関連 issue: 本 issue で `AbortController` を導入すると、issue 0163 (`stopSubscribing` と close コールバックの `cleanupSubscriber` 再入レース) の根本原因 (`await unsubscribe()` 中に close が割り込む) を `signal.aborted` で検知できるようになり、0163 と統合する余地が出る。

## 前提となる API 調査結果

本 issue 着手時点 (2026-05-11) の moqt-js 公開 API の状況:

- `connect(url, callbacks?, options?)` (`src/index.ts:183`): `ConnectCallbacks` / `ConnectOptions` のいずれにも `AbortSignal` フィールドは存在しない。
- `Session.subscribe(namespace, trackName, callbacks, options?)` (`src/session.ts:607` / 実装 `:1138`): `SubscribeCallbacks` / `SubscribeOptions` のいずれにも `AbortSignal` フィールドは存在しない。
- `devtools/` 配下にも `AbortSignal` / `AbortController` の利用箇所は無い (grep 確認済み)。

したがって本 issue では moqt-js 側の API は変更せず、devtools 側の `startSubscribing` 内で `AbortController` を保持して「await 後の `signal.aborted` チェック」と「中断後の早期 return」だけを行う。moqt-js 側 API への `AbortSignal` 伝搬は別 issue (本 issue の完了後にプロトコル層で意味のある中断が可能かを再検討) として切り出す。

## 修正方針

1. `useSubscriber` フック内に `abortControllerRef = useRef<AbortController | null>(null)` を追加する。レンダリング間で参照を保持するため `useRef` を使う。
2. `startSubscribing` 冒頭で以下を行う:
   - 新しい `AbortController` を生成し `abortControllerRef.current` に代入する (既存値が残っている場合は `cleanupSubscriber` 経由で必ず `null` 化されている前提)。
   - ローカル変数 `const signal = abortControllerRef.current.signal;` を取り、関数内では常にローカル `signal` 経由で `signal.aborted` を確認する (`cleanupSubscriber` が `abortControllerRef.current = null` した後でも、ローカル参照は生存している `AbortController` の `signal` を指す)。
3. `cleanupSubscriber` で `abortControllerRef.current?.abort()` を呼んでから既存処理を実行し、最後に `abortControllerRef.current = null` で参照をクリアする。
4. 以下の各 await の直後に `if (signal.aborted) return;` を挿入する。中断は moqt-js 側 API には伝搬しないため、await が完了してから検知する点に注意 (本 issue のスコープ外、後述「制約事項」参照):
   - `await connect(...)` 直後。`signal.aborted` が立っている場合、中断時の `cleanupSubscriber` 経由で `instance.session.value` は既に `null` 化されているため、`session` 変数 (await から得た値) を `session.close()` で fire-and-forget close してから `return` する。`instance.session.value = session` は中断時には実行しない。
   - Catalog 取得の `await Promise.race([catalogPromise, timeoutPromise])` を含む try ブロック直後 (現行の `instance.session.value === null` チェックを `signal.aborted` チェックに置き換える)。中断時は既に `cleanupSubscriber` 経路で session がクローズされているため、追加処理は不要で `return` のみ。
   - `await decoderInstance.configure(...)` 直後。中断時は `decoderInstance.close()` を呼んでから `return` する (この時点で `instance.decoder.value` への代入はまだ行っていないため、自前の `decoderInstance` ローカル変数のみが対象)。
   - `await session.subscribe(...)` 直後。中断時は `subscriberInstance.unsubscribe()` を fire-and-forget で呼んでから `return` する。`instance.subscriber.value = subscriberInstance` は中断時には実行しない。
5. 既存の `if (instance.session.value === null) return;` (`useSubscriber.ts:363`) を撤去する。
6. catch 句では `signal.aborted` を最初に判定し、中断由来のエラーは `"error"` 遷移させない:
   - `if (signal.aborted) { return; }` を catch の冒頭に置く。これにより `cleanupSubscriber` 経路で確定した status (close 由来の `"disconnected"` 等) が catch 句の `"error"` で上書きされない。
   - 中断でない通常のエラーは現行どおり `"error"` 遷移と `cleanupSubscriber()` を実行する。
7. close / error コールバックは現行どおり `cleanupSubscriber()` を呼ぶ。`cleanupSubscriber` 経由で `abort()` が呼ばれるため、`startSubscribing` 側の各 await ポイントが順次中断される。

## 制約事項

- 本 issue の `AbortController` は「await 完了後に中断を検知して以降の処理をスキップする」だけで、`connect()` / `decoderInstance.configure()` / `session.subscribe()` の進行中のネットワーク I/O やデコーダ初期化そのものを中断するわけではない。これらの中断には moqt-js / WebCodecs 側 API の対応が必要であり、本 issue のスコープ外とする。
- 進行中の処理は中断できないため、最悪ケースで「中断後にも `await connect()` / `await session.subscribe()` の完了まで数秒待つ」可能性がある。完了後に得た `Session` / `Subscriber` は本 issue の修正方針 4 の fire-and-forget close により後始末する。

## 影響範囲

- `devtools/src/hooks/useSubscriber.ts` の `useSubscriber` / `startSubscribing` / `cleanupSubscriber`
- moqt-js 側 (`src/index.ts` / `src/session.ts`) は変更しない (前提となる API 調査結果セクション参照)

## テスト戦略

`devtools/src/hooks/useSubscriber.test.ts` に以下のテストを追加する。プロジェクト規約によりモック / スタブは利用しないため、`useSubscriber` 内部のロジックではなく純関数として切り出し可能な部分を検証するか、`Session` / `Subscriber` の偽実装を `signals/subscriber.ts` の `SubscriberInstance` に流し込んで動作を検証する。

- `startSubscribing` 中に外部から `cleanupSubscriber()` 相当の経路で `abort()` を起こすと、後続の `await` 直後の `signal.aborted` チェックで処理が打ち切られ、`instance.decoder.value` / `instance.subscriber.value` が「中断後に新規代入される」ことが無いこと。
- 中断後に catch 句が `status.value = "error"` を上書きしないこと (close 由来の `"disconnected"` が最終値として残ること)。

`Session.subscribe` / `connect` の偽実装は本 issue で必要な範囲のみテストファイル内に手書きする (既存テストにもこの方針が踏襲できる関数 `toSortedByGroupObject` が export されている)。

手動確認:

- `vp run build` および `vp run build:devtools` が成功すること。
- `vp run test` が全件パスすること (timeout は 10 秒以内)。
- ブラウザでサーバ未起動のまま Start Subscribing 押下 → connect 失敗時に `status` が `"error"`、`statusMessage` が `Failed: ...` で確定すること。
- 接続中にサーバを切断 → close コールバック発火後に `statusMessage` が `Disconnected: ...` で確定し、catch 句由来の `Failed: ...` で上書きされないこと。

## CHANGES.md 記載方針

`## develop` 直下 `### misc` サブセクションに以下のように記載する (devtools 内部実装のリファクタリングであり、ユーザー向け機能変更ではないため misc 扱い)。

```
- [CHANGE] devtools の `useSubscriber` の中断検知を `AbortController` ベースに置き換える
  - @voluntas
```

## 完了条件

- `useSubscriber` 内で `AbortController` が `useRef` 経由で保持され、`startSubscribing` 冒頭で生成、`cleanupSubscriber` で `abort()` される。
- `startSubscribing` の各 await 直後に `signal.aborted` チェックが入っている。
- 既存の `instance.session.value === null` チェックが撤去されている。
- catch 句で `signal.aborted` を判定し、中断由来の reject を `"error"` 状態へ遷移させない。
- `vp run test` で全テストがパスする。
- `vp run build` / `vp run build:devtools` が成功する。
