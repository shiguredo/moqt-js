# `SubscriberInstance` の Signal 粒度を再設計し UI 駆動 Signal とフックローカル ref を分離する

Created: 2026-05-11
Model: Opus 4.7

## 概要

`devtools/src/signals/subscriber.ts:SubscriberInstance` は 30 フィールド中 29 個が `Signal<T>` で保持されている (`id` のみ非 Signal)。issue 0134 の解決方法として「`publisher.ts` との一貫性」「`hasActiveSubscriber` computed の追跡性」を理由に全フィールド Signal 化したが、その結果として **UI / 外部 API から `.value` 読みされていないフィールドまで Signal 化されている** 状態になっている。

本 issue では grep で全参照箇所を特定した上で、Signal 化が必要なフィールド (UI 駆動 / computed 追跡) と不要なフィールド (フック内部状態のみ) を厳密に分類し、後者を `useSubscriber` フックローカルの `useRef` に移す。これにより以下を得る:

- UI に寄与しない更新で reactive 通知を流さない (購読者ゼロの signal を排除)
- `SubscriberInstance` の型シグネチャから「フック内部状態」が消え、UI 層が触ってはいけない状態の意図が型で表現される
- フィールド更新時の `.value` という型噪音を内部状態側から排除する

## 根拠

### grep による全参照箇所の特定

`devtools/src/components/SubscriberPanel.tsx` / `devtools/src/components/DebugPanel.tsx` / `devtools/src/testApi.ts` / `devtools/src/hooks/useSubscriber.ts` を対象に `.value` 読み出しを全数調査した。結果は下記「フィールド分類表」のとおり。

調査から、`SubscriberInstance` の以下のフィールドは **UI / 外部 API のいずれからも `.value` 読みされていない** ことが確認できた:

- `catalogSubscriber`: `useSubscriber.ts` 内で代入のみ (`SubscriberPanel` / `DebugPanel` / `testApi` から参照なし)
- `joiningFetchInProgress`: `useSubscriber.ts` 内のコールバック分岐判定のみ
- `joiningFetchLastLocation`: `useSubscriber.ts` 内の Joining Fetch 重複除去判定のみ
- `liveObjectBuffer`: `useSubscriber.ts` 内のバッファのみ (issue 0166 で別途 ref 化される)

`isStopping` / `decoderState` / `decoderConfigured` は UI / DebugPanel で `.value` 読みされている (SubscriberPanel.tsx:51 / SubscriberPanel.tsx:323 / DebugPanel.tsx:291-292) ため Signal のまま残す。当初検討では「内部判定のみ」「DecoderWrapper から導出可能」と仮置きしていたが、実際の参照箇所と整合しないため Signal のまま据え置く。

### 0134 の判断との整合

0134 解決方法は「`hasActiveSubscriber` computed の追跡」と「`publisher.ts` との一貫性」を全 Signal 化の根拠とした。本 issue ではこの根拠を以下のように再評価する。

- `hasActiveSubscriber` は `instance.subscriber.value` を参照する (`signals/subscriber.ts:157-164`)。`subscriber` は本 issue でも Signal のまま残すため計算は維持できる。
- 「`publisher.ts` との一貫性」はコード形状の対称性に過ぎず、`publisher.ts` 側に「購読者ゼロの signal」が混在しているならそちらも別途見直すべき問題で、`subscriber.ts` を粒度の粗いまま放置する根拠にはならない。
- 一貫性を保つべきは「UI 駆動状態は Signal、フック内部状態は ref」というルールの方であり、それを `subscriber.ts` で先行整備する。

### 0165 / 0166 との関係

- **0165**: 「Map → 特定 ID の instance を引き当てる際の購読粒度」が対象。本 issue が触る `SubscriberInstance` 内のフィールド構造とは独立に成立する。先後関係はどちらでもよい。
- **0166**: `liveObjectBuffer` を Signal から `useRef<MoqtObject[]>` へ置換する単独 issue。本 issue で扱う `liveObjectBuffer` の処理は完全に 0166 のスコープと重複する。

  - **0166 を先行マージする場合**: 本 issue から `liveObjectBuffer` 関連の項目をすべて削除する。残差として `catalogSubscriber` / `decoder` / `joiningFetchInProgress` / `joiningFetchLastLocation` の 4 フィールドを ref 化する。
  - **本 issue を先行マージする場合**: 0166 は完了済みとして close する。
  - 推奨は **0166 を先行**。範囲が狭く独立 PR として取り込めるため。

## フィールド分類表

`SubscriberInstance` の 30 フィールド全件について、`.value` 読み出し箇所を grep で全数調査した結果に基づき分類する。「UI 読み」列は `SubscriberPanel.tsx` / `DebugPanel.tsx` / `testApi.ts` での `.value` 読み出しの有無を示す (`useSubscriber.ts` 内の読み書きは対象外)。

| # | フィールド | 型 | UI 読み | 用途 | 本 issue 後の扱い |
| - | --- | --- | --- | --- | --- |
| 1 | `id` | `string` | 不要 | 不変識別子 | 不変 (現状のまま) |
| 2 | `session` | `Signal<Session \| null>` | あり (SubscriberPanel:47 / DebugPanel:318) | 接続セッション参照 | Signal 維持 |
| 3 | `subscriber` | `Signal<Subscriber \| null>` | あり (SubscriberPanel:50) | `hasActiveSubscriber` computed が追跡 | Signal 維持 |
| 4 | `catalogSubscriber` | `Signal<Subscriber \| null>` | **なし** | Catalog 用 Subscriber を cleanup まで保持するだけ | **ref へ移動** |
| 5 | `catalog` | `Signal<Catalog \| null>` | あり (SubscriberPanel:48 / DebugPanel:339) | Catalog 表示 | Signal 維持 |
| 6 | `decoder` | `Signal<DecoderWrapper \| null>` | なし (`useSubscriber` 内部のみ) | DecoderWrapper 参照 | **ref へ移動** |
| 7 | `decoderConfigured` | `Signal<boolean>` | あり (DebugPanel:292) | デコーダ設定完了表示 / `handleObject` 判定 | Signal 維持 |
| 8 | `status` | `Signal<StatusType>` | あり (SubscriberPanel:46 / DebugPanel:289 / testApi) | 状態バッジ駆動 | Signal 維持 |
| 9 | `statusMessage` | `Signal<string>` | あり (SubscriberPanel:128) | ステータス文言表示 | Signal 維持 |
| 10 | `codec` | `Signal<string>` | あり (SubscriberPanel:49 / DebugPanel:290) | コーデック表示 | Signal 維持 |
| 11 | `isStopping` | `Signal<boolean>` | あり (SubscriberPanel:51) | Stop ボタン disabled 制御 | Signal 維持 |
| 12 | `joiningFetchEnabled` | `Signal<boolean>` | あり (SubscriberPanel:136-138) | チェックボックス双方向バインド | Signal 維持 |
| 13 | `newGroupRequestEnabled` | `Signal<boolean>` | あり (SubscriberPanel:148-150) | チェックボックス双方向バインド | Signal 維持 |
| 14 | `framesDecoded` | `Signal<number>` | あり (SubscriberPanel:305 / DebugPanel:300 / testApi) | 統計表示 | Signal 維持 |
| 15 | `keyFramesDecoded` | `Signal<number>` | あり (SubscriberPanel:309 / DebugPanel:301 / testApi) | 統計表示 | Signal 維持 |
| 16 | `objectsReceived` | `Signal<number>` | あり (SubscriberPanel:247 / DebugPanel:293 / testApi) | 統計表示 | Signal 維持 |
| 17 | `currentGroup` | `Signal<number>` | あり (SubscriberPanel:313 / DebugPanel:296 / testApi) | 統計表示 | Signal 維持 |
| 18 | `currentSubGroup` | `Signal<number>` | あり (SubscriberPanel:317 / testApi) | 統計表示 | Signal 維持 |
| 19 | `bytesReceived` | `Signal<number>` | あり (SubscriberPanel:258 / DebugPanel:295 / testApi) | 統計表示 | Signal 維持 |
| 20 | `objectsWithExtensions` | `Signal<number>` | あり (SubscriberPanel:252 / DebugPanel:294 / testApi) | 統計表示 | Signal 維持 |
| 21 | `chunksCreated` | `Signal<number>` | あり (SubscriberPanel:285 / DebugPanel:297) | 統計表示 | Signal 維持 |
| 22 | `chunksDecoded` | `Signal<number>` | あり (SubscriberPanel:289 / DebugPanel:298) | 統計表示 | Signal 維持 |
| 23 | `chunksSkipped` | `Signal<number>` | あり (SubscriberPanel:293 / DebugPanel:299) | 統計表示 | Signal 維持 |
| 24 | `decodeErrors` | `Signal<number>` | あり (SubscriberPanel:297 / DebugPanel:302) | 統計表示 | Signal 維持 |
| 25 | `decoderState` | `Signal<string>` | あり (SubscriberPanel:323 / DebugPanel:291 / testApi) | デコーダ状態表示 | Signal 維持 |
| 26 | `joiningFetchStats` | `Signal<JoiningFetchStats \| null>` | あり (SubscriberPanel:346-352 / DebugPanel:310 / testApi) | 統計表示 | Signal 維持 |
| 27 | `largestLocation` | `Signal<{group;object} \| null>` | あり (SubscriberPanel:334-340 / DebugPanel:305 / testApi) | 統計表示 | Signal 維持 |
| 28 | `joiningFetchInProgress` | `Signal<boolean>` | **なし** | object コールバックのバッファ分岐判定 | **ref へ移動** |
| 29 | `liveObjectBuffer` | `Signal<MoqtObject[]>` | **なし** | Joining Fetch 中バッファ | **0166 で ref 化** (本 issue 単独着手時のみ対象、0166 先行マージ後は対象外) |
| 30 | `joiningFetchLastLocation` | `Signal<{group;object} \| null>` | **なし** | Joining Fetch 重複除去判定 | **ref へ移動** |

集計: Signal 維持 = 24 / ref へ移動 = 5 (0166 を含む) / 不変 = 1。

**0166 先行マージを前提とした場合、本 issue で新たに ref 化する対象は 4 フィールド** (`catalogSubscriber` / `decoder` / `joiningFetchInProgress` / `joiningFetchLastLocation`)。0166 が後着手なら 0166 側を close することで本 issue が 5 フィールドを担当する。

## 修正方針

### 採用案: 型を分割せず、ref 化対象フィールドだけを `SubscriberInstance` から外す

`SubscriberInstance` を `SubscriberView` / `SubscriberRuntime` の 2 型に分割する案も検討したが、以下の理由で **採用しない**:

- ref 化対象は 4 フィールドのみで、別型に切り出すほどの規模ではない
- `SubscriberRuntime` を生成するファクトリ (`createSubscriberRuntime`) を別途用意するなら、フックローカル `useRef` で済む話を共有ファクトリにしてしまい、責務が散る
- 0165 の `getSubscriberInstanceSignal(id)` で「ID → 1 instance」を引く API が `SubscriberInstance` を返す前提で設計されている。型を分割すると 0165 の型シグネチャを巻き込む

採用するのは「`SubscriberInstance` から ref 化対象フィールドを削除し、`useSubscriber` 側で `useRef` 群として個別に保持する」案。

### `signals/subscriber.ts` の変更

`SubscriberInstance` から以下 4 フィールドを削除する:

- `catalogSubscriber: Signal<Subscriber | null>`
- `decoder: Signal<DecoderWrapper | null>`
- `joiningFetchInProgress: Signal<boolean>`
- `joiningFetchLastLocation: Signal<{ group: bigint; object: bigint } | null>`

`createSubscriberInstance` から対応する `signal(...)` 初期化を削除する。

`DecoderWrapper` 型 import が他で使われなくなる場合は import からも除去する。`Subscriber` / `MoqtObject` 型については `liveObjectBuffer` の扱い (0166) と合わせて再評価する。

### `useSubscriber.ts` の変更

`useSubscriber` フック冒頭 (`chainRef` 直下) に以下の ref 群を追加する:

```typescript
const catalogSubscriberRef = useRef<Subscriber | null>(null);
const decoderRef = useRef<DecoderWrapper | null>(null);
const joiningFetchInProgressRef = useRef<boolean>(false);
const joiningFetchLastLocationRef = useRef<{ group: bigint; object: bigint } | null>(null);
```

ref 群は `useSubscriber` フック内で定義した全クロージャ (`renderFrame` / `handleObject` / `startSubscribing` 内の各コールバック / `stopSubscribing` / `cleanupSubscriber`) から直接参照できる。`getSubscriber(subscriberId)` 経由で `instance.*.value` を参照していたコードは、対応する `ref.current` 参照に置き換える。これにより `getSubscriber` の戻り値 (= `SubscriberInstance`) から取れるのは Signal フィールドのみとなる。

ファイル内の `.value` 読み書きを以下のとおり置換する (行番号は現状コードの目安):

- `instance.catalogSubscriber.value = ...` (line 329) → `catalogSubscriberRef.current = ...`
- `instance.catalogSubscriber.value = null` (line 638) → `catalogSubscriberRef.current = null`
- `instance.decoder.value` の読み (line 143 / 608) → `decoderRef.current`
- `instance.decoder.value = ...` (line 390 / 640) → `decoderRef.current = ...`
- `instance.joiningFetchInProgress.value` の読み (line 539) → `joiningFetchInProgressRef.current`
- `instance.joiningFetchInProgress.value = ...` (line 82 / 503 / 526 / 644) → `joiningFetchInProgressRef.current = ...`
- `instance.joiningFetchLastLocation.value` の読み (line 464) → `joiningFetchLastLocationRef.current`
- `instance.joiningFetchLastLocation.value = ...` (line 442 / 504 / 527 / 645) → `joiningFetchLastLocationRef.current = ...`

`onEnd` / `onError` 内の `batch(() => { ... })` から、Signal でなくなったフィールドへの代入 (`joiningFetchInProgress` / `joiningFetchLastLocation`) を batch ブロックの外へ移動する。batch 内に残る Signal 代入は `joiningFetchStats` のみとなるが、Signal が 1 つだけなら batch は不要なので、batch ブロック自体を解体して直接代入してよい (0166 で `liveObjectBuffer` も外へ出るため batch ブロックは最終的に空になる)。

`resetSubscriberStats(instance, joiningFetchEnabled)` は現状 `instance` を介して `joiningFetchInProgress.value = joiningFetchEnabled` を実行している。ref 化後はフック内クロージャから ref を参照する必要があるため、以下のいずれかを選ぶ:

- 案 i: `resetSubscriberStats` のシグネチャに ref を追加する
- 案 ii: `resetSubscriberStats` から「Signal でなくなったフィールド」のリセットを取り出し、フック側で直接初期化する

実装シンプルさで **案 ii** を推奨。`resetSubscriberStats` は Signal の数値カウンタ等をリセットする責務に絞り、ref のリセットは呼び出し側 (`startSubscribing` 内 / `cleanupSubscriber` 内) で個別に行う。

### `SubscriberPanel.tsx` / `DebugPanel.tsx` / `testApi.ts` の変更

- `SubscriberPanel.tsx`: 削除対象 4 フィールドは元々 `.value` 読みされていないため **変更なし**
- `DebugPanel.tsx`: 同上、**変更なし**
- `testApi.ts`: 同上、**変更なし**

つまり UI 層 / 外部 API 層は本 issue の影響範囲外。

### `signals/subscriber.test.ts` の変更

`createSubscriberInstance initializes signals with expected defaults` テスト (line 23-41) から以下のアサーションを削除する:

- (該当箇所には現状 `catalogSubscriber` / `decoder` / `joiningFetchInProgress` の検証は無いが) 仮にあれば削除

現状残っているのは `liveObjectBuffer` (line 39) と `joiningFetchLastLocation` (line 40) のアサーション。これらも本 issue で削除する。0166 が先行マージされていれば `liveObjectBuffer` は既に削除済み。

## 影響範囲

- `devtools/src/signals/subscriber.ts`: `SubscriberInstance` 型から 4 フィールド削除、`createSubscriberInstance` から対応する初期化削除、`DecoderWrapper` import の整理
- `devtools/src/hooks/useSubscriber.ts`: `useRef` 4 つ追加、`.value` 経由のアクセスを `ref.current` へ置換 (合計 17 箇所程度)、`batch` 解体、`resetSubscriberStats` のシグネチャ整理 (案 ii)
- `devtools/src/signals/subscriber.test.ts`: ref 化したフィールドのアサーション削除
- `devtools/src/components/SubscriberPanel.tsx`: 変更なし
- `devtools/src/components/DebugPanel.tsx`: 変更なし
- `devtools/src/testApi.ts`: 変更なし

## テスト戦略

- `vp run test` で全テストパス
- `signals/subscriber.test.ts` から ref 化したフィールドのアサーションを削除する。ref はフックローカルで `createSubscriberInstance` の検証対象外
- 新規ユニットテスト追加なし (ref はフック内部状態で、フックの統合テストは現状リポジトリのスコープ外)
- 手動確認:
  - Joining Fetch 有効状態で接続し、Catalog 取得 → 本配信開始 → Joining Fetch ドレイン → ライブ配信に切り替わる一連の挙動が従来と同一であること
  - Joining Fetch 失敗時 (`onError`) もライブバッファのドレインが従来通り実行されること
  - 接続 → 停止 → 再接続を 3 回繰り返し、ref に前回の残骸が引き継がれないこと (HMR は除く)
  - 2 Subscriber 同時運用で片方の切断がもう片方の挙動に影響しないこと

## 関連 issue

- 0134 (closed): 本 issue の前身。「全フィールド signal 化」を採用したが、UI 読みされない signal の発生という副作用を残した。本 issue でその副作用を解消する
- 0165: Map → ID 引き当ての購読粒度。独立に成立。先後どちらでも可
- 0166: `liveObjectBuffer` の ref 化。**0166 を先行マージ推奨**。先行マージ後は本 issue から `liveObjectBuffer` 項目を削除し、`catalogSubscriber` / `decoder` / `joiningFetchInProgress` / `joiningFetchLastLocation` の 4 フィールドのみが対象となる

## CHANGES.md 記載方針

`### misc` サブセクションに `[UPDATE]` で記載する (devtools 内部実装の整理、UI 層への影響なし)。

例:
- `[UPDATE] devtools の SubscriberInstance から UI 読みされない 4 フィールド (catalogSubscriber / decoder / joiningFetchInProgress / joiningFetchLastLocation) を Signal からフックローカル useRef へ移動する`

## 完了条件

- `SubscriberInstance` から `catalogSubscriber` / `decoder` / `joiningFetchInProgress` / `joiningFetchLastLocation` の 4 フィールドが削除されている
- `createSubscriberInstance` からも対応する `signal(...)` 初期化が削除されている
- `useSubscriber` フック内に対応する `useRef` 群が追加され、全 `.value` アクセスが `ref.current` 経由に置き換わっている
- `resetSubscriberStats` が Signal フィールドのリセットのみを担当し、ref リセットは呼び出し側で実施する形になっている
- `signals/subscriber.test.ts` の該当アサーションが削除されている
- `SubscriberPanel.tsx` / `DebugPanel.tsx` / `testApi.ts` に変更が入っていない (UI 層への影響なし)
- `vp run test` が全件パスする
- `vp run build:devtools` がエラーなく完了する
- 手動確認で Joining Fetch ドレイン挙動が従来と同一であることを確認する
