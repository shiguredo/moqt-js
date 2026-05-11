# `liveObjectBuffer` を Signal から `useRef` ベースに置き換える

Created: 2026-05-11
Model: Opus 4.7

## 概要

`useSubscriber.ts` の Subscribe ストリーム `object:` コールバックは Joining Fetch 進行中、到着オブジェクトを以下のコードでライブバッファに積む。

```typescript
// devtools/src/hooks/useSubscriber.ts:540
instance.liveObjectBuffer.value = [...instance.liveObjectBuffer.value, obj];
```

スプレッドで Signal 値を毎回再生成しているため、Joining Fetch 中に到着する N オブジェクトに対し合計 Σ_{i=1..N} i = N(N+1)/2 のコピーが発生し、計算量は O(N²)。例えば 1000 オブジェクト溜まれば 500,500 要素分のコピー。`liveObjectBuffer` は UI 描画に使われておらず Signal にする必要がない。`useRef<MoqtObject[]>([])` に置き換えれば `push` で O(1) 追記でき、合計 O(N) になる。

なお `onEnd` / `onError` でのドレインも `[...instance.liveObjectBuffer.value]` で 1 回 O(N) のコピーを行うが、これは破壊的ソートを避けるための意図的なコピーであり置き換え後も `[...ref.current]` または `ref.current.splice(0)` で同等に残る (本 issue の改善対象は object コールバック側 O(N²) → O(N))。

## 根拠

- `useSubscriber.ts:540` の `instance.liveObjectBuffer.value = [...instance.liveObjectBuffer.value, obj]` が hot path で繰り返し呼ばれる
- `liveObjectBuffer` の `.value` 読み取り箇所は全て `useSubscriber.ts` 内 (object コールバック / `onEnd` / `onError` / `cleanupSubscriber` / `resetSubscriberStats`) に閉じている
- `devtools/src/components/SubscriberPanel.tsx` / `devtools/src/components/DebugPanel.tsx` / `devtools/src/testApi.ts` から `liveObjectBuffer` への参照は無し (grep 確認済み)
- 既に同フックには `chainRef = useRef<Promise<void>>(Promise.resolve())` という同パターンの前例があり、コールバック群はクロージャ経由で安全に参照できる
- Signal 化により得られる reactive 通知は本フィールドでは無価値 (購読者ゼロ)

## 修正方針

1. `devtools/src/signals/subscriber.ts:SubscriberInstance` から `liveObjectBuffer: Signal<MoqtObject[]>` を削除する
2. `createSubscriberInstance` から `liveObjectBuffer: signal<MoqtObject[]>([])` を削除する
3. 削除後に `MoqtObject` 型 import が他で参照されていなければ import からも除去する
4. `useSubscriber` フック冒頭 (既存の `chainRef` 直下) に `const liveObjectBufferRef = useRef<MoqtObject[]>([])` を追加する
5. `useSubscriber.ts:540` の代入を `liveObjectBufferRef.current.push(obj)` に置き換える
6. `useSubscriber.ts:461` / `:518` の `toSortedByGroupObject([...instance.liveObjectBuffer.value])` を `toSortedByGroupObject([...liveObjectBufferRef.current])` に置き換える (スプレッドコピーは破壊的ソート回避のため残す)
7. `useSubscriber.ts:502` / `:525` / `:646` の `instance.liveObjectBuffer.value = []` を `liveObjectBufferRef.current = []` に置き換える
8. `useSubscriber.ts:83` (`resetSubscriberStats` 内の `instance.liveObjectBuffer.value = []`) も同様に置き換える。`resetSubscriberStats` は `instance` のみを引数に取るため、`liveObjectBufferRef` を第 3 引数として渡すか、初期化責務を `useSubscriber` 側へ移すかを実装時に選択する
9. `onEnd` / `onError` の `batch(() => { ... })` から `instance.liveObjectBuffer.value = []` を取り出し、batch の外で `liveObjectBufferRef.current = []` する (Signal ではないため batch 不要)
10. `joiningFetchInProgress` は object コールバックでのバッファ判定に使われ続けるため Signal のまま残す (本 issue の対象外)

## 0164 との関係

issue 0164 (`SubscriberInstance` の Signal 粒度再設計) は `liveObjectBuffer` を ref 化対象として明示的に列挙している (#0164 根拠セクション)。両 issue は対象フィールドが重なる。

- **0164 を先行**: 本 issue は 0164 の作業に完全に吸収される (重複作業)
- **0166 を先行**: ピンポイント修正で性能改善を独立 PR として取り込める。0164 はその後 `isStopping` / `joiningFetchLastLocation` / `decoderConfigured` / `decoderState` のみを残す
- **依存**: 双方独立に着手可能だが、後着手側は前着手側の変更を取り込んだ上で残差を実装する

推奨は **0166 を先行**。理由は範囲が狭く性能改善効果が明確で、0164 の設計議論を待たずにマージ可能なため。0164 が先行マージされた場合、本 issue は完了済みとして close する。

## 影響範囲

- `devtools/src/signals/subscriber.ts` (フィールド削除、`MoqtObject` import の整理)
- `devtools/src/hooks/useSubscriber.ts` (5 箇所の書き込み / 2 箇所の読み取り / `resetSubscriberStats` のシグネチャ調整)
- `devtools/src/signals/subscriber.test.ts` (line 39 の `liveObjectBuffer` 検証を削除)

`SubscriberPanel.tsx` / `DebugPanel.tsx` / `testApi.ts` は無変更。

## テスト戦略

- `vp run test` で全テストがパスすること
- `signals/subscriber.test.ts` の `createSubscriberInstance initializes signals with expected defaults` から `assert.deepEqual(instance.liveObjectBuffer.value, []);` を削除する
- 新規ユニットテストは追加しない (ref はフックローカルで `createSubscriberInstance` の検証対象外。フックの統合テストは既存のスコープ外)
- 手動確認:
  - Joining Fetch 有効状態で接続し、ストリームが先行している配信に対して開始する
  - Joining Fetch 完了直後 / 失敗時の両系統でデコードが再開すること
  - 接続→停止→再接続を繰り返してバッファに残骸が引き継がれないこと

## CHANGES.md 記載方針

- `### misc` サブセクションに `[UPDATE]` で記載する (devtools 内部実装の性能改善)
- 例: `- [UPDATE] devtools: Joining Fetch 中のライブオブジェクトバッファを Signal から useRef へ変更し、追記コストを O(N²) から O(N) に改善する`

## 完了条件

- `SubscriberInstance` から `liveObjectBuffer` フィールドが削除されている
- `useSubscriber` フック内 `useRef<MoqtObject[]>` で同等の機能が実現されている
- `object:` コールバック内の追記が `push` (O(1)) になっている
- `onEnd` / `onError` / `cleanupSubscriber` / `resetSubscriberStats` のクリアが ref 経由に置き換わっている
- `vp run test` が全てパスする
- 手動確認で Joining Fetch のドレイン挙動が従来と同一
