# `startSubscribing` に `AbortController` ベースの中断機構を導入する

Created: 2026-05-11
Completed: 2026-05-12
Model: Opus 4.7

## 概要

`devtools/src/hooks/useSubscriber.ts` の `startSubscribing` は `await connect()` / Catalog 購読の `await` / `await decoderInstance.configure()` / `await session.subscribe()` という複数の `await` 境界を持つが、現状の中断検知は Catalog 取得直後の `if (instance.session.value === null) return;` 一箇所しかない。これは `cleanupSubscriber` の副作用 (session 参照を null に上書きする) に依存した暗黙の中断シグナルであり、「session の意味」と「中断フラグの意味」が混線している。

`useSubscriber` 内に `AbortController` を導入して中断フラグを `signal.aborted` に集約し、各 `await` 直後で `signal.aborted` を確認する設計に置き換える。

## 根拠

- 現行の `if (instance.session.value === null) return;` は「session 参照」と「中断フラグ」の責務を兼ねており、責務が混線している。
- 中断検知が Catalog 取得後の 1 箇所にしか入っていないため、`await connect()` 直後、`await decoderInstance.configure()` 後、`await session.subscribe()` 後のいずれの `await` ポイントでも中断が漏れうる。特に `decoderInstance.configure()` 中に close が発火した場合、続く `instance.decoder.value = decoderInstance` で「すでに close 済み instance」に対して decoder が再代入される。
- Catalog 取得経路では `void session.subscribe(...).then((catalogSubscriberInstance) => { instance.catalogSubscriber.value = catalogSubscriberInstance; })` が non-blocking で進むため、中断後のマイクロタスクで `catalogSubscriber.value` に値が代入されるレースも残る。
- `instance.isStopping` は `stopSubscribing` の二重実行防止専用で、close / error コールバック由来の `cleanupSubscriber` 経路では立たない。`startSubscribing` 側の中断検知には流用できない。

## 関連 issue との順序

- issue #0148 (closed): `startSubscribing` 冒頭の `isStopping` ガードと Catalog 取得後の暗黙チェックを追加。本 issue はこの暗黙チェックを `AbortController` に置き換える進化型の修正であり、0148 の reopen ではない
- issue #0163 (`stopSubscribing` と close コールバックの `statusMessage` レース): close / end / error コールバック先頭に `shouldApplyTerminalUpdate` ガードを差し込む変更で、本 issue とは作用箇所が異なる。先後どちらでも実装可能。0163 適用後はコールバックの 2 回目以降の発火が `session.value === null` で early return されるが、1 回目で既に `abort()` 済みのため abort が再度走らないことは正しい挙動 (`AbortController.abort()` は冪等)
- issue #0171 (`cleanupSubscriber` リネーム / 責務分割): 推奨順序は 0171 → 0161。0171 適用後は `cleanupSubscriber` が `teardownSubscriber` (orchestrator) + `closeSubscriberResources` + `resetSubscriberState` に分割される。本 issue の `abort()` + `null` 化は `teardownSubscriber` 冒頭 (`closeSubscriberResources` 呼び出しの前) に入れる。理由は、`closeSubscriberResources` 内で `session.value = null` が立つ「前」に abort を確定させ、進行中の `startSubscribing` が `session.value` ではなく `signal.aborted` で中断を検知する責務境界を保つため
- moqt-js 側 API (`connect` / `Session.subscribe`) への `AbortSignal` 伝搬は本 issue のスコープ外。本 issue 完了時に SEQUENCE から番号を払い出して後続 issue を起票する (完了条件参照)

## 修正方針

### 1. `abortControllerRef` の導入

`useSubscriber` フック内に `const abortControllerRef = useRef<AbortController | null>(null);` を追加する。レンダリング間で参照を保持するため `useRef` を使う。

### 2. `startSubscribing` 冒頭の controller 初期化

`startSubscribing` 冒頭の `isStopping` ガード (現存、本 issue で維持) の直後に以下を入れる。`isStopping` は二重実行防止、`AbortController` は中断シグナルで責務が異なるため両方残す。

```ts
// 古い controller が残っていれば abort してから新規生成する。
if (abortControllerRef.current) {
  abortControllerRef.current.abort();
}
abortControllerRef.current = new AbortController();
const signal = abortControllerRef.current.signal;
```

以降は関数内で常にローカル `signal` 経由で `signal.aborted` を確認する。`cleanupSubscriber` が `abortControllerRef.current = null` した後でもローカル参照経由で abort 状態を判定できる。

### 3. `cleanupSubscriber` (0171 適用後は `teardownSubscriber`) への abort 差し込み

`cleanupSubscriber` (もしくは `teardownSubscriber`) の冒頭で以下を実行する。

```ts
abortControllerRef.current?.abort();
abortControllerRef.current = null;
```

`AbortController.prototype.abort` は冪等で例外を投げない (DOM Living Standard `AbortController#abort()`)。既に abort 済みの controller への再呼び出しは無害。

### 4. `stopSubscribing` 冒頭でも abort を発火する

現行 `stopSubscribing` は `await subscriberInstance.unsubscribe()` を先に行い、`finally` で `cleanupSubscriber` を呼ぶ。この設計では `unsubscribe()` 解決まで abort が走らず、進行中の `startSubscribing` が `unsubscribe()` 完了まで中断されない。これを避けるため、`stopSubscribing` 冒頭 (`isStopping = true` 直後) に `abortControllerRef.current?.abort();` を追加する。`abortControllerRef.current = null` 化は `finally` の `cleanupSubscriber` 内で行うため、ここでは行わない。

### 5. 各 `await` 直後の中断検知

await 中の中断は moqt-js 側 API に伝搬しないため、await 完了時点で得たリソースを `startSubscribing` 側が後始末する。「中断元 (`cleanupSubscriber`) はその時点で `instance.*.value` に代入されていたリソースのみを後始末でき、await 完了後にローカル変数として手元に来たリソースは中断元から見えない」のが本設計の核。

中断検知ヘルパーとして以下を `useSubscriber.ts` から export する (テスト容易性のため切り出し)。`cleanup` が throw しても呼び出し側で `signal.aborted` 判定が成立した事実は失わないよう例外を握り潰す。

```ts
export function checkAborted(signal: AbortSignal, cleanup: () => void): boolean {
  if (signal.aborted) {
    try {
      cleanup();
    } catch {
      // 中断時の後始末で発生した例外は無視する (fire-and-forget)
    }
    return true;
  }
  return false;
}
```

各 `await` 直後に `if (checkAborted(signal, () => { /* 後始末 */ })) return;` の形で挿入する。**`instance.*.value` への代入 (例: `instance.session.value = session`、`instance.decoder.value = decoderInstance`) は必ず `checkAborted` 呼び出しの「後」に置く**。`checkAborted` が呼ばれる時点でこれらの代入は未実行であることを実装側で保証する。

| `await` ポイント                                                           | `checkAborted` の cleanup で実行する処理                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `await connect(...)` 直後                                                  | `session.close().catch(() => {})` を fire-and-forget。中断シナリオは「await 中に他経路 (`stopSubscribing` / アンマウント) で `cleanupSubscriber` が呼ばれた」場合に限られる。close コールバックは session 取得後に登録済みなので、connect 解決前の close 発火は session 自体がまだ存在せず該当しない。中断元から `instance.session.value` は見えない (未代入) ため、ローカル `session` の close は `startSubscribing` 側の責務 |
| Catalog 取得の `await Promise.race([catalogPromise, timeoutPromise])` 直後 | cleanup 無し (`return` のみ)。`session.subscribe(...).then(...)` の遅延代入レースは「方針 6」で `.then` 内側に abort 判定を入れて解消する。`finally { clearTimeout(timeoutId); }` は既存ロジックで実行済み                                                                                                                                                                                                                     |
| `await decoderInstance.configure(...)` 直後                                | `decoderInstance.close()` を呼ぶ。`DecoderWrapper.close` (`devtools/src/utils/DecoderWrapper.ts:179-192`) は同期メソッドで `state !== "closed"` ガード付き、例外を投げない設計のため try/catch は不要                                                                                                                                                                                                                          |
| `await session.subscribe(...)` 直後                                        | `void subscriberInstance.unsubscribe().catch(() => {})` を fire-and-forget で呼ぶ。`unsubscribe` (`devtools/src/signals/subscriber.ts`) は `state === "closed"` でも例外を投げず early return するため state ガードは不要                                                                                                                                                                                                      |

既存の `if (instance.session.value === null) return;` (Catalog 取得直後) は撤去し、上記表の `checkAborted` チェックに置き換える。

### 6. Catalog 取得経路の `.then` 内側で abort 判定する

Catalog の `session.subscribe(...).then((catalogSubscriberInstance) => { instance.catalogSubscriber.value = catalogSubscriberInstance; })` を以下に書き換える。これにより「`startSubscribing` 側で `signal.aborted` を見て return した後にマイクロタスクで `.then` が回り `catalogSubscriber.value` が再代入される」レースを `.then` 側で潰す。

```ts
.then((catalogSubscriberInstance) => {
  if (signal.aborted) {
    void catalogSubscriberInstance.unsubscribe().catch(() => {});
    return;
  }
  instance.catalogSubscriber.value = catalogSubscriberInstance;
})
.catch(reject)
```

既存の `.catch(reject)` (現行コード `useSubscriber.ts` Catalog 取得経路) は維持する。

### 7. `catch` 句での中断検知

`catch` 句の先頭で `if (signal.aborted) return;` を入れる。中断時は `cleanupSubscriber` (0171 適用後は `teardownSubscriber`) が既に呼ばれており `status` / `statusMessage` / `settingsDisabled` は確定済みなので、catch 句で再度 `cleanupSubscriber` や `settingsDisabled` 判定を行わない。中断でない通常のエラーは現行どおり `status = "error"` 遷移と `cleanupSubscriber()` (0171 適用後は `teardownSubscriber()`) 実行、`settingsDisabled` 再有効化判定を行う。

### 8. close / error / end コールバックは現行どおり

これらは修正方針 3 で `abort()` を含むようになった `cleanupSubscriber` (もしくは `teardownSubscriber`) を呼ぶ。

## 影響範囲

- `devtools/src/hooks/useSubscriber.ts` の `useSubscriber` / `startSubscribing` / `stopSubscribing` / `cleanupSubscriber` (0171 適用後は `teardownSubscriber`)
- `devtools/src/hooks/useSubscriber.test.ts` (テスト戦略参照)
- moqt-js 側 (`src/index.ts` / `src/session.ts`) は変更しない

## テスト戦略

CLAUDE.md 規約により Vitest の Chai API (`test` / `assert`) のみ使用、モック / スタブは使わない。`useSubscriber` フック本体は `import { connect } from "moqt-js"` をトップレベル import しているため `connect` を差し替えてフック内部を直接テストすることは規約上できない。本 issue では中断検知ロジックを `checkAborted` 純粋関数に切り出してテストする。

`useSubscriber.test.ts` に以下を追加する。

- `checkAborted` は `signal.aborted === false` のとき `cleanup` を呼ばず `false` を返す
- `checkAborted` は `signal.aborted === true` のとき `cleanup` を 1 度呼んでから `true` を返す

`startSubscribing` 本体の中断検知の正しさは目視レビュー + 手動確認で担保する。

手動確認 (タイムアウトは 10 秒以内):

- `vp run build` および `vp run build:devtools` が成功すること
- `vp run test` が全件パスすること
- サーバ未起動のまま Start Subscribing 押下 → connect 失敗時に `status` が `"error"`、`statusMessage` が `Failed: ...` で確定すること
- Subscribe 進行中に WebTransport サーバを切断 → close コールバック発火後に `statusMessage` が `Disconnected: ...` で確定し、catch 句由来の `Failed: ...` で上書きされないこと。`Catalog 取得中` / `decoder configure 中` / `subscribe await 中` の 3 タイミングで個別に確認する
- Subscribe 進行中に Stop ボタン押下 → `statusMessage` が `Ready to subscribe` で確定すること

## CHANGES.md 記載方針

`## develop` 直下 `### misc` サブセクションに `[UPDATE]` で記載する。devtools 内部実装のリファクタリングであり、ユーザー観察可能な挙動は変わらない (中断検知の網羅性向上により進行中切断時の状態遷移が少し早く確定する程度の差分のみ)。

エントリ例:

```
- [UPDATE] devtools の `useSubscriber` の `startSubscribing` 中断検知を `AbortController` ベースに統一する (#0161)
  - @voluntas
```

## ブランチ命名

`feature/change-` を使う (devtools 内部 API のシグナル経路変更を含むため)。

## 完了条件

- `checkAborted` の単体テスト 2 件がパスする
- 手動確認の 4 項目 (上記) が通過する
- 進行中切断時の `statusMessage` 最終値が `Disconnected: ...` で確定する (`Failed: ...` で上書きされない)
- 中断時に `instance.*.value` への代入が起きていない (`session.value` / `decoder.value` / `subscriber.value` / `catalogSubscriber.value` のいずれも中断元の `cleanupSubscriber` 終了状態を上書きしない)。手動確認時は DevTools の Subscriber カード表示で各 signal が初期値のままであることを目視確認する
- moqt-js 側 API への `AbortSignal` 伝搬を扱う後続 issue を SEQUENCE から番号払い出して起票する (対象は `connect` / `Session.subscribe` の `ConnectOptions` / `SubscribeOptions` に `AbortSignal` フィールドを追加する API 拡張)
- `vp run test` で全テストパス
- `vp run build` / `vp run build:devtools` で成功
