# `cleanupSubscriber` をリネームして責務を分割する

Created: 2026-05-11
Model: Opus 4.7

## 概要

`devtools/src/hooks/useSubscriber.ts:604-657` の `cleanupSubscriber` には以下の問題がある。

1. `cleanup` という命名が「軽い後処理」を想起させる一方、実体は「外部リソース (`decoder` / `session`) を fire-and-forget で close し、`SubscriberInstance` の状態 signal 群を初期状態へ完全リセットし、Promise チェーンと UI ガード (`settingsDisabled`) も巻き戻す」破壊的操作で、語感と実装が乖離している。
2. 「リソース close」と「状態リセット」という 2 つの責務が 1 関数に同居しており、issue #0162 で `signals/subscriber.ts:removeSubscriber` 側に Subscriber リソースの close を集約した後は、`cleanupSubscriber` の close 部分が責務的に重複したまま残る (実害は no-op だが knowledge duplication になる)。
3. リネームと分割を同時に行うことで、`useSubscriber.ts` 内部 API の責務境界 (リソース close 経路 / 状態 signal リセット経路 / UI リセット経路) を呼び出し元から区別可能にする。

## 関連 issue との順序

依存関係グラフ:

- 前提: issue #0150 (closed) で `session.value = null` を `sessionInstance.close()` より先に立てる順序が確定済み。本 issue では `closeSubscriberResources` にその順序を引き継ぐ
- 0162 (`removeSubscriber` に decoder / session の close 集約): 0162 → 0171 の順で実装する。0162 完了後も `useSubscriber.ts` 経由の close 経路では `instance` がまだ Map 上に存在し `removeSubscriber` が呼ばれないため、`useSubscriber.ts` 側に close 系の責務 (`closeSubscriberResources`) を残す必要がある
- 0166 (`liveObjectBuffer` の ref 化): 0166 → 0171 の順で実装する。0166 適用後は `liveObjectBuffer` が `SubscriberInstance` から削除され `useSubscriber` フックローカルの `liveObjectBufferRef` に移る。`resetSubscriberState` 内の `instance.liveObjectBuffer.value = []` は `liveObjectBufferRef.current = []` に書き換わる
- 0164 (`SubscriberInstance` Signal 粒度再設計): 0166 → 0171 → 0164 の順で実装する。0164 適用後は `joiningFetchInProgress` / `joiningFetchLastLocation` が `SubscriberInstance` から削除されフックローカル ref に移るため、`resetSubscriberState` 内の対応する 2 行も ref 代入に書き換わる。0164 はこの書き換えを自身のスコープとして明記済み
- 0161 (AbortController): 0171 → 0161 を推奨。0161 は `teardownSubscriber` 冒頭 (`getSubscriber` 取得後・`closeSubscriberResources` 呼び出し前) に `abortControllerRef.current?.abort(); abortControllerRef.current = null;` を差し込む
- 0163 (`statusMessage` レース): 本 issue と直交。0163 のヘルパー名は `shouldApplyStatusUpdate` (本 issue 内で参照する場合は同名で参照する)。先後どちらでも可

## 現 `cleanupSubscriber` の全責務 (行番号付き)

`devtools/src/hooks/useSubscriber.ts:604-657` の実装内訳。

- l.604-606: `getSubscriber(subscriberId)` で `instance` を取得。存在しなければ即 return (再入時の no-op)
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

`cleanupSubscriber` は `useSubscriber.ts` 内部クロージャでエクスポートされていない (`grep -r cleanupSubscriber devtools/` で確認可能)。

## リネーム名選定

採用名: **`teardownSubscriber`**。「外部接続を含むランタイム状態を全て巻き戻し、再 `startSubscribing` 可能な初期状態に戻す」破壊的操作という意味で、リソース close / UI リセット / signal リセットの全てを覆える。`SubscriberInstance` を Map から削除しない (= 同じ id で再 setup 可能) というニュアンスも保持できる。

却下した代替名:

- `resetSubscriberState`: 状態リセットの語感は適合するが、close 副作用を含む点を表現できない。後述「状態リセット限定の関数名」として個別採用
- `cleanupSubscriber` (現状維持): 軽い後処理を想起させ、破壊的操作の主語として不適切
- `disposeSubscriber`: TypeScript 5.2+ `using` パターンを連想させ、`SubscriberInstance` が `Symbol.dispose` を実装している誤解を招く
- `destroySubscriber`: `removeSubscriber` (Map から削除) と意味的に近接しすぎる

## 修正方針

### 1. 3 関数への分割と最終シグネチャ

`useSubscriber.ts` 内部に以下 3 関数を定義する。テスト容易性のため `closeSubscriberResources` / `resetSubscriberState` は `instance` および必要なフックローカル参照を **すべて引数で受け取る形** とし、`useSubscriber.ts` から **export** する。

```ts
import type { RefObject } from "preact";

export function closeSubscriberResources(
  instance: sub.SubscriberInstance,
  canvas: HTMLCanvasElement | null,
): void {
  const decoderInstance = instance.decoder.value;
  if (decoderInstance) {
    try {
      decoderInstance.close();
    } catch {
      // 既にクローズ済みなら無視
    }
  }

  // WebTransport が close コールバックを同期 dispatch する実装で
  // cleanupSubscriber が再入する可能性を 0150 の順序で対策する。
  const sessionInstance = instance.session.value;
  instance.session.value = null;
  if (sessionInstance) {
    sessionInstance.close().catch(() => {
      // 既にクローズされている場合は無視
    });
  }

  // canvas 塗り潰しは UI リセットだが、decoder の停止と一体で行うことで
  // 「停止した decoder の最終フレームが残る」表示不整合を避けるため
  // closeSubscriberResources 内に置く。
  if (canvas) {
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.fillStyle = "#1e293b";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
  }
}

export function resetSubscriberState(
  instance: sub.SubscriberInstance,
  chainRef: { current: Promise<void> },
  liveObjectBufferRef: { current: MoqtObject[] } | null,
  joiningFetchInProgressRef: { current: boolean } | null,
  joiningFetchLastLocationRef: { current: { group: bigint; object: bigint } | null } | null,
): void {
  instance.subscriber.value = null;
  instance.catalogSubscriber.value = null;
  instance.catalog.value = null;
  instance.decoder.value = null;
  instance.decoderConfigured.value = false;
  instance.codec.value = "";

  instance.joiningFetchStats.value = null;
  instance.largestLocation.value = null;

  // 0166 適用前: instance.liveObjectBuffer.value = []
  // 0166 適用後: liveObjectBufferRef.current = []
  if (liveObjectBufferRef) {
    liveObjectBufferRef.current = [];
  }
  // 0164 適用前: instance.joiningFetchInProgress.value = false / instance.joiningFetchLastLocation.value = null
  // 0164 適用後: joiningFetchInProgressRef.current = false / joiningFetchLastLocationRef.current = null
  if (joiningFetchInProgressRef) {
    joiningFetchInProgressRef.current = false;
  }
  if (joiningFetchLastLocationRef) {
    joiningFetchLastLocationRef.current = null;
  }

  chainRef.current = Promise.resolve();

  // status / statusMessage / isStopping には触れない (0163 の責務境界に従う)
  // settingsDisabled の再有効化は subscriber.value = null 後に hasActiveSubscriber
  // computed が再計算されるため、closeSubscriberResources 呼び出し有無に関係なく
  // resetSubscriberState 単独でも整合する
  if (!sub.hasActiveSubscriber.value && !pub.pubSession.value) {
    settings.settingsDisabled.value = false;
  }
}
```

`liveObjectBufferRef` / `joiningFetchInProgressRef` / `joiningFetchLastLocationRef` の引数は本 issue 単独実装時点では `null` を渡すか、`instance.liveObjectBuffer.value = []` / `instance.joiningFetchInProgress.value = false` / `instance.joiningFetchLastLocation.value = null` を関数内に残す形でいったん実装する (0166 / 0164 マージで段階的に ref 化が進む)。本 issue では「将来の ref 化に備えた引数を含むシグネチャ」を確定させ、ref 化のたびに引数追加で済むようにする。

### 2. orchestrator `teardownSubscriber`

```ts
const teardownSubscriber = (): void => {
  const instance = sub.getSubscriber(subscriberId);
  if (!instance) return;
  closeSubscriberResources(instance, canvasRef.current);
  resetSubscriberState(
    instance,
    chainRef,
    liveObjectBufferRef, // 0166 適用後はフックローカル ref、未適用なら null
    joiningFetchInProgressRef, // 0164 適用後はフックローカル ref、未適用なら null
    joiningFetchLastLocationRef,
  );
};
```

`teardownSubscriber` は `useSubscriber` フック内クロージャに残し、`canvasRef.current` / `chainRef` / ref 群を引数として渡す。

**0161 適用後** は `teardownSubscriber` 冒頭 (`getSubscriber` 取得後・`closeSubscriberResources` 呼び出し前) に以下を差し込む:

```ts
abortControllerRef.current?.abort();
abortControllerRef.current = null;
```

これは 0161 の責務で本 issue では行わない。

`teardownSubscriber` 自体は orchestrator なので単体テストは追加しない (構成要素 `closeSubscriberResources` / `resetSubscriberState` のテストでカバー)。

### 3. 既存抽出関数 `resetSubscriberStats` との関係

`useSubscriber.ts:65-84` の `resetSubscriberStats` は `startSubscribing` 開始時に統計カウンタを初期値へ戻す関数。本 issue では統合しない。`resetSubscriberStats` のシグネチャ整理 (`joiningFetchEnabled` 引数削除等) は 0164 / 0166 で行うため本 issue では触らない。

### 4. 呼び出し元の書き換え

`cleanupSubscriber()` 呼び出し 6 箇所をすべて `teardownSubscriber()` に置換する。シグネチャは変えないため呼び出し側の他の変更は不要。

| 行番号 | 文脈                                    | 置換後                 |
| ------ | --------------------------------------- | ---------------------- |
| l.237  | `connect` の close コールバック         | `teardownSubscriber()` |
| l.242  | `connect` の error コールバック         | `teardownSubscriber()` |
| l.553  | `session.subscribe` の end コールバック | `teardownSubscriber()` |
| l.573  | `startSubscribing` の catch 句          | `teardownSubscriber()` |
| l.597  | `stopSubscribing` の finally 句         | `teardownSubscriber()` |
| l.687  | `useEffect` cleanup                     | `teardownSubscriber()` |

`startSubscribing` の catch 句 (l.573) の直後にある `settingsDisabled` 再有効化 (l.574-577) は `resetSubscriberState` 内に同等処理が含まれるため **削除する**。

l.361-363 のコメント (`Catalog 取得の await 中に close コールバック → cleanupSubscriber で session.value が null 化された場合は以降の処理をスキップする。`) は `teardownSubscriber` 経由の `closeSubscriberResources` に文言更新する。

l.626-628 のコメント (close コールバック再入対策) は `closeSubscriberResources` の関数ドキュメントに移す。

### 5. `cleanupSubscriber` の旧定義 (l.604-657) は削除

旧 `cleanupSubscriber` の関数定義を削除し、`teardownSubscriber` / `closeSubscriberResources` / `resetSubscriberState` の 3 つに置き換える。

## 影響範囲

- `devtools/src/hooks/useSubscriber.ts`
  - `cleanupSubscriber` (l.604-657) を削除し `teardownSubscriber` / `closeSubscriberResources` / `resetSubscriberState` に分割
  - `closeSubscriberResources` / `resetSubscriberState` を export
  - 6 箇所の呼び出し元を `teardownSubscriber()` に置換
  - `startSubscribing` catch 句の重複 `settingsDisabled` 再有効化 (l.574-577) を削除
  - 関連コメント (l.361-363, l.626-628) の文言更新
- `devtools/src/hooks/useSubscriber.test.ts`: 新関数の単体テストを追加 (後述)
- 他の `.ts` / `.test.ts` ファイルへの影響: なし

## テスト戦略

CLAUDE.md 規約により Vitest の Chai API (`test` / `assert`) のみ使用し、モック / スタブは使わない。

`devtools/src/hooks/useSubscriber.test.ts` に以下を追加。`createSubscriberInstance("test-id")` で実 `SubscriberInstance` を生成し、引数で渡してテストする。

`closeSubscriberResources` のテスト:

- `instance.decoder.value` が null のとき例外を投げず、`session.value` が null にリセットされる
- `instance.session.value` が null のときも例外を投げない
- `canvas` 引数が null のとき例外を投げず、session / decoder の close 処理だけ実行される

`resetSubscriberState` のテスト (フィールドごとに individual assert):

- 実行後、以下の signal が初期値になることを個別に検証:
  - `instance.subscriber.value === null`
  - `instance.catalogSubscriber.value === null`
  - `instance.catalog.value === null`
  - `instance.decoder.value === null`
  - `instance.decoderConfigured.value === false`
  - `instance.codec.value === ""`
  - `instance.joiningFetchStats.value === null`
  - `instance.largestLocation.value === null`
  - (0166 適用前のみ) `instance.liveObjectBuffer.value` が空配列
  - (0164 適用前のみ) `instance.joiningFetchInProgress.value === false` / `joiningFetchLastLocation.value === null`
- 実行後に `chainRef.current` が新しい `Promise.resolve()` に置き換わる (`!==` で別オブジェクトであることを assert)
- 他にアクティブな Subscriber / Publisher がなければ `settings.settingsDisabled.value === false`
- `status` / `statusMessage` / `isStopping` を書き換えないこと (0163 との責務境界確認)

手動確認:

- `vp run test` で全テストパス
- `vp run build:devtools` でビルド成功
- Subscribe → Stop → 再 Subscribe を 5 回繰り返し、状態が毎回正しく初期化されること

## CHANGES.md 記載方針

`### misc` サブセクションに `[CHANGE]` で記載する (devtools 内部 API のリネーム / 分割、後方互換なし)。

エントリ例:

```
- [CHANGE] devtools の `cleanupSubscriber` を `teardownSubscriber` にリネームし `closeSubscriberResources` / `resetSubscriberState` に分割する (#0171)
  - @voluntas
```

## ブランチ命名

`feature/change-` を使う。

## 完了条件

- `cleanupSubscriber` (l.604-657) が削除されている
- `teardownSubscriber` / `closeSubscriberResources` / `resetSubscriberState` が定義されている
- `closeSubscriberResources` / `resetSubscriberState` が `useSubscriber.ts` から export されている
- 6 箇所の呼び出し元が `teardownSubscriber()` に置換されている
- `startSubscribing` catch 句の重複 `settingsDisabled` 再有効化 (l.574-577) が削除されている
- 関連コメント (l.361-363, l.626-628) が新名称に追従している
- `useSubscriber.test.ts` に上記テストが追加されている
- 本 issue は 0162 / 0166 完了後に着手する (依存関係)
- 0164 / 0161 / 0163 は本 issue の前後どちらでもよい (それぞれの issue で本 issue 完了後の書き換え方針を明記済み)
- `vp run test` で全テストパス
- `vp run build:devtools` でビルド成功
