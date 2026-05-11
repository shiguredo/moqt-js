# `cleanupSubscriber` をリネームして責務を分割する

Created: 2026-05-11
Model: Opus 4.7

## 概要

`devtools/src/hooks/useSubscriber.ts:604-657` の `cleanupSubscriber` には以下の問題がある。

1. `cleanup` という命名が「軽い後処理」を想起させる一方、実体は「外部リソース (`decoder` / `session`) を fire-and-forget で close し、`SubscriberInstance` の状態 signal 群を初期状態へ完全リセットし、Promise チェーンと UI ガード (`settingsDisabled`) も巻き戻す」破壊的操作で、語感と実装が乖離している。
2. 「リソース close」と「状態リセット」という 2 つの責務が 1 関数に同居しており、issue #0162 で `signals/subscriber.ts:removeSubscriber` 側に Subscriber リソースの close を集約した後は、`cleanupSubscriber` の close 部分が責務的に重複したまま残る (実害は no-op だが knowledge duplication になる)。
3. リネームと分割を同時に行うことで、`useSubscriber.ts` 内部 API の責務境界 (リソース所有権の close 経路 / 状態 signal の初期化経路) を呼び出し元から区別可能にする。

## 関連 issue との順序

本 issue は以下の順序を前提とする。

1. issue #0162 (Subscriber リソース close を `removeSubscriber` に集約) を先に実装する。これにより `signals/subscriber.ts:removeSubscriber` 内で `decoder` / `session` の fire-and-forget close が走るようになり、Map 削除契機での close は `signals/subscriber.ts` が所有する。
2. 本 issue (#0171) を実装する。`useSubscriber.ts` 側の close 経路 (現 `cleanupSubscriber` 前半) は 0162 と重複する fire-and-forget close を呼ぶが、これは `cleanupSubscriber` 経由の経路 (close コールバック / error コールバック / `stopSubscribing` finally / `startSubscribing` catch / `useEffect` cleanup) では `instance` がまだ Map 上に存在し `removeSubscriber` が呼ばれないため、close を担う主体は引き続き `useSubscriber.ts` 側にある。よって 0162 実装後も「`useSubscriber.ts` 内に close 系の責務を残す必要がある」点は変わらず、本 issue の close 系関数 (`closeSubscriberResources`) は廃止対象にならない。
3. issue #0163 (close / end / error コールバックの `statusMessage` レース) は本 issue と直交する。0163 はコールバック冒頭に `shouldApplyTerminalUpdate` ガードを差し込む変更で、本 issue のリネーム位置とは別行に作用するため、先後どちらの順でも適用できる。0171 を先に終えると 0163 でガードを挿入するコールバックの中身 (`cleanupSubscriber()` 呼び出し) が `teardownSubscriber()` に置き換わるだけで衝突しない。

issue #0150 (closed) は本 issue の前提となる修正で、`session.value = null` を `sessionInstance.close()` より先に立てる順序がすでに `cleanupSubscriber` に入っている。本 issue では `closeSubscriberResources` にその順序を引き継ぐ。

## 現 `cleanupSubscriber` の全責務 (行番号付き)

`devtools/src/hooks/useSubscriber.ts:604-657` の実装内訳。

- l.604-606: `getSubscriber(subscriberId)` で `instance` を取得。存在しなければ即 return (再入時の no-op)。
- l.608-615: `decoder.value` を取り出し、非 null なら `decoder.close()` を try/catch で fire-and-forget。**(close 系)**
- l.617-624: `canvasRef.current` から 2D コンテキストを取得し、背景色 `#1e293b` で塗りつぶす。**(UI リセット系)**
- l.626-635: `instance.session.value = null` を先に立て、その後 `sessionInstance.close()` を `.catch(() => {})` で fire-and-forget。0150 で順序を確定済み。**(close 系 + signal リセット系)**
- l.637-642: `subscriber.value = null` / `catalogSubscriber.value = null` / `catalog.value = null` / `decoder.value = null` / `decoderConfigured.value = false` / `codec.value = ""`。**(signal リセット系)**
- l.644-648: `joiningFetchInProgress.value = false` / `joiningFetchLastLocation.value = null` / `liveObjectBuffer.value = []` / `joiningFetchStats.value = null` / `largestLocation.value = null`。**(signal リセット系 / 0150 で追加)**
- l.651: `chainRef.current = Promise.resolve()` で Promise チェーンをリセット。**(クロージャ状態リセット系)**
- l.654-656: 他にアクティブな Subscriber / Publisher がなければ `settings.settingsDisabled.value = false`。**(UI ガード再有効化)**

呼び出し元 (6 箇所):

- l.237: `connect` の close コールバック内
- l.242: `connect` の error コールバック内
- l.553: `session.subscribe` の end コールバック内
- l.573: `startSubscribing` の catch 句
- l.597: `stopSubscribing` の finally 句
- l.687: `useEffect` cleanup (アンマウント時)

## リネーム名選定

候補と却下理由:

- `resetSubscriberState`: 状態リセットの語感は適合するが、リソース close という副作用を含む点を表現できない。close まで含める命名としては誤導的。後述の「状態リセット限定の関数名」として採用する。
- `cleanupSubscriber` (現状維持): 上記のとおり「軽い後処理」を想起させ、破壊的操作の主語として不適切。
- `disposeSubscriber`: `Disposable` パターン (TypeScript 5.2+ `using`) を連想させ、`SubscriberInstance` が `Symbol.dispose` を実装しているような誤解を招く。実装は `using` パターンを採らないため却下。
- `destroySubscriber`: `removeSubscriber` (Map から削除) と意味的に近接しすぎる。Map 上には残しつつ内部リソースのみ破棄する本関数とは責務が異なるため却下。
- **`teardownSubscriber` (採用)**: 「外部接続を含むランタイム状態を全て巻き戻し、再 `startSubscribing` 可能な初期状態に戻す」破壊的操作という意味で、リソース close と signal リセットの両方を覆える。テスト用語の `setUp` / `tearDown` の語感とも整合し、`SubscriberInstance` を Map から削除しない (= 同じ id で再 setup 可能) というニュアンスを保持できる。

採用名: **`teardownSubscriber`**

ただし `teardownSubscriber` は内部で 2 関数を呼び出す orchestrator として残し、責務単位の関数を別途切り出す (次節)。

## 修正方針

### 1. 2 関数への分割

`useSubscriber.ts` 内部に以下の 2 関数を定義する (どちらも `useSubscriber` フック内のクロージャ。`instance` を引数で受け取る形にして、`getSubscriber(subscriberId)` の呼び出しを呼び出し側に寄せる)。

```ts
/**
 * Subscriber が保持する外部リソース (decoder / session) を fire-and-forget で close する。
 * - decoder → session の順で close する (現 cleanupSubscriber と同順)。
 * - session.value = null を session.close() より先に書く (0150 で確定した順序)。
 * - canvas の塗りつぶしも本関数に含める (decoder が描画する canvas を初期化する責務はリソース系)。
 */
function closeSubscriberResources(instance: sub.SubscriberInstance): void {
  const decoderInstance = instance.decoder.value;
  if (decoderInstance) {
    try {
      decoderInstance.close();
    } catch {
      // 既にクローズ済みなら無視
    }
  }

  const canvas = canvasRef.current;
  if (canvas) {
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.fillStyle = "#1e293b";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
  }

  const sessionInstance = instance.session.value;
  instance.session.value = null;
  if (sessionInstance) {
    sessionInstance.close().catch(() => {
      // 既にクローズされている場合は無視
    });
  }
}

/**
 * Subscriber の状態 signal 群と Promise チェーンを初期状態へリセットする。
 * - subscriber / catalogSubscriber / catalog / decoder / decoderConfigured / codec
 * - joiningFetchInProgress / joiningFetchLastLocation / liveObjectBuffer
 *   / joiningFetchStats / largestLocation
 * - chainRef.current = Promise.resolve()
 * - 他にアクティブな Subscriber / Publisher がなければ settingsDisabled を解除する
 *
 * status / statusMessage / isStopping には触れない (0163 の責務境界に従う)。
 */
function resetSubscriberState(instance: sub.SubscriberInstance): void {
  instance.subscriber.value = null;
  instance.catalogSubscriber.value = null;
  instance.catalog.value = null;
  instance.decoder.value = null;
  instance.decoderConfigured.value = false;
  instance.codec.value = "";

  instance.joiningFetchInProgress.value = false;
  instance.joiningFetchLastLocation.value = null;
  instance.liveObjectBuffer.value = [];
  instance.joiningFetchStats.value = null;
  instance.largestLocation.value = null;

  chainRef.current = Promise.resolve();

  if (!sub.hasActiveSubscriber.value && !pub.pubSession.value) {
    settings.settingsDisabled.value = false;
  }
}
```

### 2. orchestrator `teardownSubscriber`

```ts
/**
 * Subscriber インスタンスを再 setup 可能な初期状態へ戻す。
 * リソース close → 状態リセットの順で実行する。Map (subscriberInstances) からは削除しない
 * (削除は signals/subscriber.ts:removeSubscriber の責務)。
 *
 * close コールバック経由の再入を考慮し、closeSubscriberResources 内で session.value を
 * 先行リセットしている (0150 の順序)。
 */
const teardownSubscriber = (): void => {
  const instance = sub.getSubscriber(subscriberId);
  if (!instance) return;
  closeSubscriberResources(instance);
  resetSubscriberState(instance);
};
```

### 3. 既存抽出関数 `resetSubscriberStats` との関係

`useSubscriber.ts:65-84` の `resetSubscriberStats` は **`startSubscribing` 開始時に統計カウンタ群 (framesDecoded, keyFramesDecoded, ..., joiningFetchInProgress, liveObjectBuffer, joiningFetchStats, largestLocation) を初期値にする** 関数で、責務は `resetSubscriberState` と一部重複 (`joiningFetchInProgress` / `liveObjectBuffer` / `joiningFetchStats` / `largestLocation` の 4 つ) する。

本 issue では `resetSubscriberStats` と `resetSubscriberState` を統合しない。理由は:

- `resetSubscriberStats` は `startSubscribing` 入口で「次のセッション用にカウンタをゼロ化する」開始時リセットで、`joiningFetchInProgress` の初期値が `joiningFetchEnabled` フラグに依存する (l.82)。
- `resetSubscriberState` は teardown 経路で「全フィールドを完全初期状態に戻す」終了時リセットで、`joiningFetchInProgress` は常に `false` にする。
- 統合すると `joiningFetchEnabled` を引数に取る分岐が必要になり、teardown 経路では常に false 渡しになる無意味な引数が増える。

統合議論は別 issue (本 issue では扱わない)。

### 4. 呼び出し元の書き換え

`cleanupSubscriber()` 呼び出し 6 箇所をすべて `teardownSubscriber()` に置換する。シグネチャは変えないため呼び出し側の他の変更は不要。

| 行番号 | 文脈 | 置換後 |
| --- | --- | --- |
| l.237 | `connect` の close コールバック | `teardownSubscriber()` |
| l.242 | `connect` の error コールバック | `teardownSubscriber()` |
| l.553 | `session.subscribe` の end コールバック | `teardownSubscriber()` |
| l.573 | `startSubscribing` の catch 句 | `teardownSubscriber()` |
| l.597 | `stopSubscribing` の finally 句 | `teardownSubscriber()` |
| l.687 | `useEffect` cleanup | `teardownSubscriber()` |

`startSubscribing` の catch 句 (l.573) の直後にある `settingsDisabled` の再有効化 (l.574-577) は `resetSubscriberState` 内に既に同等処理が含まれるため、catch 句の `if (!sub.hasActiveSubscriber.value && !pub.pubSession.value) { settings.settingsDisabled.value = false; }` ブロックは **削除する**。重複処理を残すと将来 `resetSubscriberState` の挙動を変更した際の挙動差分の原因になる。

l.361-363 のコメント `Catalog 取得の await 中に close コールバック → cleanupSubscriber で session.value が null 化された場合は以降の処理をスキップする。` は `cleanupSubscriber` → `teardownSubscriber` (もしくは内部の `closeSubscriberResources`) に文言更新する。

l.626-628 のコメント (close コールバック再入対策) は `closeSubscriberResources` の関数ドキュメントに移す。

### 5. `cleanupSubscriber` の旧定義 (l.604-657) は削除

旧 `cleanupSubscriber` の関数定義そのものを削除し、`teardownSubscriber` / `closeSubscriberResources` / `resetSubscriberState` の 3 つに置き換える。

## 影響範囲

- `devtools/src/hooks/useSubscriber.ts`
  - `cleanupSubscriber` (l.604-657) を削除し `teardownSubscriber` / `closeSubscriberResources` / `resetSubscriberState` に分割
  - 6 箇所の呼び出し元を `teardownSubscriber()` に置換
  - `startSubscribing` catch 句の重複 `settingsDisabled` 再有効化 (l.574-577) を削除
  - 関連コメント (l.361-363, l.626-628) の文言更新
- `devtools/src/hooks/useSubscriber.test.ts`
  - 新関数の単体テストを追加 (後述)
- 他の `.ts` / `.test.ts` ファイルへの影響: なし (`cleanupSubscriber` は `useSubscriber.ts` 内部クロージャでありエクスポートされていないことを確認済み)

## テスト戦略

CLAUDE.md 規約により Vitest の Chai API (`test` / `assert`) のみ使用し、モック / スタブは使わない。

`devtools/src/hooks/useSubscriber.test.ts` に以下を追加する。`useSubscriber` フック本体はコンポーネントツリー外から呼べないため、本 issue では `closeSubscriberResources` / `resetSubscriberState` を `useSubscriber.ts` から **export** して、`createSubscriberInstance("test-id")` で生成した実 `SubscriberInstance` を直接渡してテストする。

ただし両関数は `canvasRef` / `chainRef` / `subscriberId` のクロージャに依存している。本 issue ではクロージャ依存を切るため、両関数のシグネチャを以下に変更する。

```ts
export function closeSubscriberResources(
  instance: sub.SubscriberInstance,
  canvas: HTMLCanvasElement | null,
): void;

export function resetSubscriberState(
  instance: sub.SubscriberInstance,
  chainRef: { current: Promise<void> },
): void;
```

`teardownSubscriber` はフック内クロージャに残し、`canvasRef.current` / `chainRef` を引数として渡す形で 2 関数を呼ぶ。

追加テスト:

- `closeSubscriberResources` は `instance.decoder.value` が null のとき例外を投げず、`session.value` が null にリセットされる
- `closeSubscriberResources` は `instance.session.value` が null のときも例外を投げない
- `resetSubscriberState` 後に `instance.subscriber.value` / `catalog.value` / `decoder.value` 等の signal 群が初期値になる
- `resetSubscriberState` 後に `chainRef.current` が新しい `Promise.resolve()` に置き換わる (`!==` で別オブジェクトであることを assert)
- `resetSubscriberState` 後、他にアクティブな Subscriber / Publisher がなければ `settings.settingsDisabled.value` が `false` になる
- `resetSubscriberState` は `status` / `statusMessage` / `isStopping` を書き換えない (0163 との責務境界確認)

`vp run test` で全テストがパスすること、`vp run build:devtools` でビルドが通ることを完了条件とする。手動確認 (Subscribe → Stop → 再 Subscribe を 5 回繰り返し、状態が毎回正しく初期化されること) も行う。

## CHANGES.md 記載方針

- `### misc` サブセクションに `[CHANGE]` で記載する (devtools 内部 API のリネーム / 分割、後方互換なし)
- エントリ例:

```
- [CHANGE] devtools の `cleanupSubscriber` を `teardownSubscriber` にリネームし、`closeSubscriberResources` / `resetSubscriberState` に分割する (#0171)
```

## 完了条件

- `cleanupSubscriber` (l.604-657) が削除されている
- `teardownSubscriber` / `closeSubscriberResources` / `resetSubscriberState` が定義されている
- `closeSubscriberResources` / `resetSubscriberState` が `useSubscriber.ts` から export されている
- 6 箇所の呼び出し元が `teardownSubscriber()` に置換されている
- `startSubscribing` catch 句の重複 `settingsDisabled` 再有効化 (l.574-577) が削除されている
- 関連コメント (l.361-363, l.626-628) が新名称に追従している
- `useSubscriber.test.ts` に上記テストが追加されている
- `vp run test` で全テストパス
- `vp run build:devtools` でビルド成功
- issue #0162 が先に完了している (依存関係)
