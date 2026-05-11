# `SubscriberInstance` の Signal 粒度を再設計し UI 駆動 Signal とフックローカル ref を分離する

Created: 2026-05-11
Model: Opus 4.7

## 概要

`devtools/src/signals/subscriber.ts:SubscriberInstance` は 30 フィールド中 29 個が `Signal<T>` で保持されている (`id` のみ非 Signal)。issue 0134 の解決方法として全フィールド Signal 化したが、結果として **UI / 外部 API から `.value` 読みされていないフィールドまで Signal 化されている** 状態になっている。

本 issue では grep で全参照箇所を特定し、Signal 化が必要なフィールドと不要なフィールドを分類した上で、後者のうち **`signals/subscriber.ts` 外部から参照される必要のないフィールドのみ** を `useSubscriber` フックローカルの `useRef` に移す。

得られるもの:

- UI に寄与しない更新で reactive 通知を流さない
- `SubscriberInstance` の型シグネチャから「フック内部状態のみ」のフィールドが消える

## 関連 issue との順序

本 issue は `SubscriberInstance` の型を変更するため、以下の issue と密に絡む。

- 0162 (`removeSubscriber` に decoder / session の close 集約): `instance.decoder.value?.close()` と `instance.session.value?.close()` を `signals/subscriber.ts:removeSubscriber` 内 (= フック外) から呼ぶ。`decoder` フィールドを ref に降格するとフック外から到達不能になるため、本 issue の `decoder` フィールドは **Signal のまま残す** (UI 読みは無いが、フック外からの close 集約のために `signals/subscriber.ts` 経由でアクセス可能にする必要がある)
- 0166 (`liveObjectBuffer` の ref 化): 本 issue は `liveObjectBuffer` を扱わず、0166 を **必ず先行マージする** ことを前提とする。0166 が先に完了していない状態で本 issue に着手すると、`onEnd` / `onError` 内 batch ブロックの解体タイミングが想定と食い違うため、本 issue は 0166 完了まで pending とする
- 0171 (`cleanupSubscriber` リネーム / 分割): `closeSubscriberResources` (フック内クロージャ) と `resetSubscriberState` (フック内クロージャ) で ref のリセット責務を担う。本 issue で導入する ref のリセットは `resetSubscriberState` 内に置く。先後順序は 0171 → 0164 を推奨 (`resetSubscriberState` の責務境界が確定してから ref リセットを追加する方が衝突しにくい)
- 0161 (AbortController): `instance.decoder.value` は Signal のまま残るので 0161 の記述は変更不要。本 issue で新たに ref 化したフィールド (`joiningFetchInProgress` / `joiningFetchLastLocation`) は 0161 で参照されていないため、0161 との順序関係は無い

## 根拠

### grep による全参照箇所の特定

`devtools/src/components/SubscriberPanel.tsx` / `devtools/src/components/DebugPanel.tsx` / `devtools/src/testApi.ts` / `devtools/src/hooks/useSubscriber.ts` を対象に `.value` 読み出しを全数調査した。`SubscriberInstance` の以下のフィールドは **UI / 外部 API のいずれからも `.value` 読みされていない** ことを確認した:

- `catalogSubscriber`: フック内代入のみ。**ただし将来的に Catalog 用 Subscriber を明示的に unsubscribe する経路を追加する可能性 (`signals/subscriber.ts` 経由) を考慮して Signal のまま残す**
- `decoder`: フック内読み書きのみ。**ただし 0162 が `signals/subscriber.ts:removeSubscriber` から `instance.decoder.value?.close()` を呼ぶため Signal のまま残す**
- `joiningFetchInProgress`: フック内コールバック分岐判定のみ。フック外から触る経路なし
- `joiningFetchLastLocation`: フック内 Joining Fetch 重複除去判定のみ。フック外から触る経路なし
- `liveObjectBuffer`: フック内バッファのみ (0166 で別途 ref 化)

`isStopping` / `decoderState` / `decoderConfigured` は UI / DebugPanel で `.value` 読みされている (`SubscriberPanel.tsx` の Stop ボタン disabled / DecoderState 表示 / DebugPanel の統計表示) ため Signal のまま残す。

### スコープ確定

「UI 読みなし」だけでは ref 化の十分条件にならない。`signals/subscriber.ts` 外部 (= フック外) から参照される経路があるかで判定する。

- フック外から参照される: Signal のまま残す
- フック内のみ参照される: ref に降格可能

この基準で本 issue が ref 化する対象は **`joiningFetchInProgress` と `joiningFetchLastLocation` の 2 フィールド** (0166 を先行マージした前提)。`catalogSubscriber` / `decoder` は外部参照経路 (現状の 0162 / 将来の明示 unsubscribe 等) を考慮して Signal を維持する。

### 0134 との整合

0134 解決方法は「`hasActiveSubscriber` computed の追跡」と「`publisher.ts` との一貫性」を全 Signal 化の根拠とした。本 issue ではこの根拠を以下のように再評価する。

- `hasActiveSubscriber` は `instance.subscriber.value` を参照する (`signals/subscriber.ts:157-164`)。`subscriber` は Signal のまま残るため計算は維持できる
- 「`publisher.ts` との一貫性」はコード形状の対称性に過ぎず、`subscriber.ts` を粒度の粗いまま放置する根拠にはならない

## フィールド分類表

`SubscriberInstance` の全 30 フィールドのうち、本 issue で扱いを変えるものを示す。Signal 維持の 27 フィールド (`id` 含む) は記載省略。

| フィールド | 型 (現状) | UI 読み | フック外参照 | 本 issue 後の扱い |
| --- | --- | --- | --- | --- |
| `joiningFetchInProgress` | `Signal<boolean>` | なし | なし | **ref へ移動** |
| `joiningFetchLastLocation` | `Signal<{ group; object } \| null>` | なし | なし | **ref へ移動** |
| `liveObjectBuffer` | `Signal<MoqtObject[]>` | なし | なし | **0166 で ref 化** (本 issue の対象外、0166 先行マージ前提) |

`catalogSubscriber` / `decoder` は UI 読みは無いが、フック外参照のため Signal 維持。

## 修正方針

### `signals/subscriber.ts` の変更

`SubscriberInstance` から以下 2 フィールドを削除する:

- `joiningFetchInProgress: Signal<boolean>`
- `joiningFetchLastLocation: Signal<{ group: bigint; object: bigint } | null>`

`createSubscriberInstance` から対応する `signal(...)` 初期化を削除する。`{ group: bigint; object: bigint }` 型は本ファイル内でインライン記述されており、`joiningFetchLastLocation` 削除に伴い該当インライン型は自然に消える (`largestLocation` フィールドで同じ形の型を引き続き使うため `bigint` 関連の import 整理は発生しない)。

### `useSubscriber.ts` の変更

`useSubscriber` フック冒頭 (`chainRef` 直下) に以下の ref を追加する。

```typescript
const joiningFetchInProgressRef = useRef<boolean>(false);
const joiningFetchLastLocationRef = useRef<{ group: bigint; object: bigint } | null>(null);
```

`.value` アクセスを ref 参照に置換する (行番号は現状コードの目安):

- `instance.joiningFetchInProgress.value` の読み (l.539) → `joiningFetchInProgressRef.current`
- `instance.joiningFetchInProgress.value = ...` (l.82 / 503 / 526 / 644) → `joiningFetchInProgressRef.current = ...`
- `instance.joiningFetchLastLocation.value` の読み (l.464) → `joiningFetchLastLocationRef.current`
- `instance.joiningFetchLastLocation.value = ...` (l.442 / 504 / 527 / 645) → `joiningFetchLastLocationRef.current = ...`

### `onEnd` / `onError` の batch 解体

本 issue 適用時の前提として 0166 が完了済みであり、`liveObjectBuffer` への代入は既に `liveObjectBufferRef.current` に置換されている。0166 適用後の `onEnd` / `onError` 内 batch ブロックの内訳は以下:

- `onEnd` batch: `joiningFetchInProgress.value = false` / `joiningFetchLastLocation.value = null` / `joiningFetchStats.value = { ... }` の 3 Signal 代入
- `onError` batch: `joiningFetchInProgress.value = false` / `joiningFetchLastLocation.value = null` の 2 Signal 代入

本 issue で `joiningFetchInProgress` / `joiningFetchLastLocation` を ref 化すると:

- `onEnd`: batch 内に残る Signal 代入は `joiningFetchStats` のみ。Signal が 1 つだけなら batch は不要なため解体する
- `onError`: batch 内に残る Signal 代入が 0 になるため batch ブロック自体を解体する

ref リセットの順序は、現状 batch 内の **chainRef 投入 → ref / Signal リセット** の関係を維持する。具体的には:

1. `chainRef` 経由のドレイン投入 (`for (const bufferedObj of objectsToProcess) chainRef.current = ...`、または `onError` 側の `for (const bufferedObj of bufferedObjects) ...`) を先に実行
2. `joiningFetchInProgressRef.current = false` と `joiningFetchLastLocationRef.current = null` を実行 (`liveObjectBufferRef.current = []` も 0166 適用済みの位置で実行されている)
3. `onEnd` のみ `joiningFetchStats.value = { ... }` を直接代入

この順序を守ることで、現状コードの「ドレイン投入とフラグ立て下げを同一同期セクション内で行い、ドレイン中の `object:` 割り込みが永久に放置される race window を解消する」という意図 (現コード l.490-494 のコメント) を保持する。ref は同期書き込みのため、`chainRef` 投入の直後にフラグを下げれば Signal の batch と同等のアトミック性が得られる。

`cleanupSubscriber` (0171 適用後は `resetSubscriberState`) 内で ref を初期値にリセットする処理を追加する:

- `joiningFetchInProgressRef.current = false`
- `joiningFetchLastLocationRef.current = null`

### `resetSubscriberStats` のシグネチャ変更

`resetSubscriberStats` は現状モジュールスコープの関数 (`useSubscriber.ts` l.65) で、`joiningFetchEnabled` 引数を受け取って `instance.joiningFetchInProgress.value = joiningFetchEnabled` を実行している。本 issue では `joiningFetchInProgress` が ref になるため、`resetSubscriberStats` がモジュールスコープのまま「純粋な Signal カウンタリセット関数」として残せるよう、以下を行う:

- 0166 が先行済みのため、`resetSubscriberStats` から `liveObjectBuffer.value = []` 行は既に削除されている
- 本 issue で `resetSubscriberStats` から `joiningFetchInProgress.value = joiningFetchEnabled` 行 (現コードの l.82 相当) を削除する
- `resetSubscriberStats` の第 2 引数 `joiningFetchEnabled` を削除する
- 呼び出し側 (`startSubscribing` 内 l.400) で `resetSubscriberStats(instance);` の直後に `joiningFetchInProgressRef.current = joiningFetchEnabled;` を直接書く。`joiningFetchLastLocationRef.current = null;` も同位置で初期化する

### UI 層 / 外部 API 層への影響

- `SubscriberPanel.tsx` / `DebugPanel.tsx` / `testApi.ts`: 削除対象 2 フィールドは元々 `.value` 読みされていないため変更なし

## 影響範囲

- `devtools/src/signals/subscriber.ts`: `SubscriberInstance` から 2 フィールド削除、`createSubscriberInstance` から対応する初期化削除
- `devtools/src/hooks/useSubscriber.ts`: `useRef` 2 つ追加、`.value` 経由のアクセスを `ref.current` へ置換 (合計 10 箇所程度)、`onError` の `batch` 解体、`resetSubscriberStats` のシグネチャ整理 (案 i)、`cleanupSubscriber` / `resetSubscriberState` に ref リセット追加
- `devtools/src/signals/subscriber.test.ts`: `instance.joiningFetchInProgress.value` および `instance.joiningFetchLastLocation.value` のアサーション削除 (0166 適用後の `subscriber.test.ts` 内で該当アサーションを文字列検索して削除する)
- `devtools/src/components/SubscriberPanel.tsx` / `DebugPanel.tsx` / `testApi.ts`: 変更なし

## テスト戦略

- `vp run test` で全テストパス
- `signals/subscriber.test.ts` から ref 化したフィールドのアサーションを削除する

手動確認 (タイムアウト 10 秒以内):

- Joining Fetch 有効状態で接続し、Catalog 取得 → 本配信開始 → Joining Fetch ドレイン → ライブ配信に切り替わる一連の挙動が従来と同一であること
- Joining Fetch 失敗時 (`onError`) もライブバッファのドレインが従来通り実行されること
- 接続 → 停止 → 再接続を 3 回繰り返し、`joiningFetchInProgress` / `joiningFetchLastLocation` の状態が前回の残骸を引き継がないこと (ref が `cleanupSubscriber` / `resetSubscriberState` で初期化されていることを統計表示の挙動で間接確認する)
- 2 Subscriber 同時運用で片方の切断がもう片方の挙動に影響しないこと
- `vp run build:devtools` でビルド成功

## CHANGES.md 記載方針

`### misc` サブセクションに `[UPDATE]` で記載する (devtools 内部実装の整理、UI 層への影響なし)。

エントリ例:

```
- [UPDATE] devtools の `SubscriberInstance` から UI / 外部参照されない 2 フィールド (joiningFetchInProgress / joiningFetchLastLocation) を Signal からフックローカル useRef へ移動する (#0164)
  - @voluntas
```

## ブランチ命名

`feature/change-` を使う (devtools 内部 API のシグネチャ変更を含むため)。

## 完了条件

- `SubscriberInstance` から `joiningFetchInProgress` / `joiningFetchLastLocation` の 2 フィールドが削除されている
- `createSubscriberInstance` からも対応する `signal(...)` 初期化が削除されている
- `useSubscriber` フック内に対応する `useRef` 2 つが追加され、全 `.value` アクセスが `ref.current` 経由に置き換わっている
- `resetSubscriberStats` の第 2 引数 `joiningFetchEnabled` が削除され、`joiningFetchInProgress` の初期化が呼び出し側 (`startSubscribing` 内) に移動している
- `cleanupSubscriber` (0171 適用後は `resetSubscriberState`) 内で `joiningFetchInProgressRef.current = false` と `joiningFetchLastLocationRef.current = null` のリセットが追加されている
- `signals/subscriber.test.ts` から `joiningFetchInProgress.value` / `joiningFetchLastLocation.value` のアサーションが削除されている
- `SubscriberPanel.tsx` / `DebugPanel.tsx` / `testApi.ts` に変更が入っていない
- `vp run test` が全件パスする
- `vp run build:devtools` がエラーなく完了する
- 手動確認シナリオが通過する
