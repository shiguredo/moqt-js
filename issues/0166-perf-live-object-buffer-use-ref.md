# `liveObjectBuffer` を Signal から `useRef` ベースに置き換える

Created: 2026-05-11
Model: Opus 4.7

## 概要

`useSubscriber.ts` の Subscribe ストリーム `object:` コールバックは Joining Fetch 進行中、到着オブジェクトを以下のコードでライブバッファに積む。

```typescript
// devtools/src/hooks/useSubscriber.ts:540
instance.liveObjectBuffer.value = [...instance.liveObjectBuffer.value, obj];
```

スプレッドで Signal 値を毎回再生成しているため、Joining Fetch 中に到着する N オブジェクトに対し合計 Σ\_{i=1..N} i = N(N+1)/2 のコピーが発生し、計算量は O(N²)。例えば 1000 オブジェクト溜まれば 500,500 要素分のコピー。`liveObjectBuffer` は UI 描画に使われておらず Signal にする必要がない。`useRef<MoqtObject[]>([])` に置き換えれば `push` で O(1) 追記でき、合計 O(N) になる。

## 根拠

- `useSubscriber.ts:540` の `instance.liveObjectBuffer.value = [...instance.liveObjectBuffer.value, obj]` が hot path で繰り返し呼ばれ O(N²) コピー
- `liveObjectBuffer` の `.value` 読み取り箇所は全て `useSubscriber.ts` 内 (object コールバック / `onEnd` / `onError` / `cleanupSubscriber` / `resetSubscriberStats`) に閉じている
- `SubscriberPanel.tsx` / `DebugPanel.tsx` / `testApi.ts` から `liveObjectBuffer` への参照は無し (grep 確認済み)
- 既に同フックには `chainRef = useRef<Promise<void>>(Promise.resolve())` という同パターンの前例があり、コールバック群はクロージャ経由で安全に参照できる
- Signal 化により得られる reactive 通知は本フィールドでは無価値 (購読者ゼロ)

## 関連 issue との順序

- 0164 (`SubscriberInstance` Signal 粒度再設計): 0164 は本 issue を **必ず先行マージする** 前提でスコープを縮小済み (0164 本文「0166 完了まで pending」)。本 issue → 0164 の順で実装する
- 0171 (`cleanupSubscriber` リネーム / 分割): 0171 で `cleanupSubscriber` が `teardownSubscriber` / `closeSubscriberResources` / `resetSubscriberState` に分割される。`liveObjectBuffer.value = []` (現コード l.646) は 0171 後は `resetSubscriberState` 内に移る。本 issue → 0171 の順を推奨。0171 が後に入る場合は、本 issue で導入する `liveObjectBufferRef` を `resetSubscriberState` のクロージャから参照する形に書き換える追記が 0171 で必要

## 修正方針

1. `devtools/src/signals/subscriber.ts:SubscriberInstance` から `liveObjectBuffer: Signal<MoqtObject[]>` を削除する
2. `createSubscriberInstance` から `liveObjectBuffer: signal<MoqtObject[]>([])` を削除する
3. 削除後 `MoqtObject` 型 import は `subscriber.ts` 内に他の参照が残らないため import から除去する
4. `useSubscriber` フック冒頭 (既存の `chainRef` 直下) に `const liveObjectBufferRef = useRef<MoqtObject[]>([])` を追加する
5. `useSubscriber.ts:540` の代入を `liveObjectBufferRef.current.push(obj)` に置き換える (O(1))
6. `useSubscriber.ts:461` / `:518` の `toSortedByGroupObject([...instance.liveObjectBuffer.value])` を `toSortedByGroupObject(liveObjectBufferRef.current)` に置き換える。`toSortedByGroupObject` 自体が内部で `[...objects].sort(...)` でコピーするため、呼び出し側スプレッドは冗長で削除する
7. `useSubscriber.ts:502` / `:525` / `:646` の `instance.liveObjectBuffer.value = []` を `liveObjectBufferRef.current = []` に置き換える
8. `useSubscriber.ts:83` (`resetSubscriberStats` 内の `instance.liveObjectBuffer.value = []`) は **`resetSubscriberStats` から削除し、呼び出し側 (`startSubscribing` 内の `resetSubscriberStats(...)` 呼び出し直後) に `liveObjectBufferRef.current = []` を直接書く**。`resetSubscriberStats` のシグネチャに ref を追加せず、責務を `useSubscriber` 側に移す方針で 0164 の resetSubscriberStats シグネチャ整理と素直に積み上がる
9. `onEnd` / `onError` の `batch(() => { ... })` 内の `instance.liveObjectBuffer.value = []` を batch の **外** に出し `liveObjectBufferRef.current = []` で実行する。順序は **batch の直後 (= batch 内の残り Signal 代入が完了した後) に ref リセット** を行う形に統一する。本 issue 時点では batch 内に `joiningFetchInProgress` / `joiningFetchLastLocation` / `joiningFetchStats` 等の Signal 代入が残るため batch ブロック自体は維持する (0164 適用後に batch ブロックは再評価)
10. `joiningFetchInProgress` は本 issue の対象外として Signal のまま残す (ref 化は 0164 の責務)

## 影響範囲

- `devtools/src/signals/subscriber.ts`: `liveObjectBuffer` フィールド削除、`MoqtObject` import 削除
- `devtools/src/hooks/useSubscriber.ts`: `useRef<MoqtObject[]>([])` 追加、書き込み 5 箇所 (l.83 / 502 / 525 / 540 / 646) / 読み取り 3 箇所 (l.461 / 518 / 540 RHS) の置換、`resetSubscriberStats` から `liveObjectBuffer` 行を削除し呼び出し側に移動、`onEnd` / `onError` の batch ブロック外で ref リセット
- `devtools/src/signals/subscriber.test.ts`: `assert.deepEqual(instance.liveObjectBuffer.value, [])` (l.39) を削除
- `SubscriberPanel.tsx` / `DebugPanel.tsx` / `testApi.ts`: 無変更

## テスト戦略

- `vp run test` で全テストパス
- `signals/subscriber.test.ts` の `createSubscriberInstance initializes signals with expected defaults` から `assert.deepEqual(instance.liveObjectBuffer.value, []);` (l.39) を削除する
- 新規ユニットテストは追加しない (ref はフックローカルで `createSubscriberInstance` の検証対象外)

手動確認 (タイムアウト 10 秒以内):

- Joining Fetch 有効状態で接続し、Publisher が先行している配信に対して Subscribe 開始
- Joining Fetch 完了直後にライブバッファのドレインが行われ、デコードが再開すること
- Joining Fetch `onError` 発火時もライブバッファのドレインが行われ、デコードが再開すること
- 接続 → 停止 → 再接続を 3 回繰り返し、`liveObjectBufferRef` に前回の残骸が引き継がれないこと
- Chrome DevTools の Performance タブで、Joining Fetch 中の object コールバック処理で Long Task (50ms 超) が発生しないこと (大量バッファ時の O(N²) 計算が解消されたことを間接確認)
- `vp run build:devtools` でビルド成功

## CHANGES.md 記載方針

`### misc` サブセクションに `[UPDATE]` で記載する (devtools 内部実装の性能改善)。

エントリ例:

```
- [UPDATE] devtools の Joining Fetch 中ライブオブジェクトバッファを Signal から useRef へ変更し、追記コストを O(N²) から O(N) に改善する (#0166)
  - @voluntas
```

## ブランチ命名

`feature/change-` を使う (devtools 内部 API のフィールド削除を含むため)。

## 完了条件

- `SubscriberInstance` から `liveObjectBuffer` フィールドが削除されている
- `subscriber.ts` の `MoqtObject` import が削除されている
- `useSubscriber` フック内 `useRef<MoqtObject[]>` で同等の機能が実現されている
- `object:` コールバック内の追記が `push` (O(1)) になっている
- `onEnd` / `onError` / `cleanupSubscriber` の `liveObjectBuffer` クリアが ref 経由 (batch 外) に置き換わっている
- `resetSubscriberStats` から `liveObjectBuffer` 行が削除され、呼び出し側 (`startSubscribing` 内) に `liveObjectBufferRef.current = []` が移動している
- `signals/subscriber.test.ts` から該当アサーション (l.39) が削除されている
- `vp run test` で全テストパス
- `vp run build:devtools` でビルド成功
- 手動確認シナリオ (上記 5 項目) が通過する
