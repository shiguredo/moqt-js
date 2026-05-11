# `SubscriberInstance` の Signal 粒度を再設計し UI 駆動 / 内部 ref を分離する

Created: 2026-05-11
Model: Opus 4.7

## 概要

`signals/subscriber.ts:SubscriberInstance` は 28 フィールド中 27 個が `Signal<T>` になっているが、これは粗雑な設計。UI 描画に使われておらず Signal 化不要なフィールドが混在しており、利用側で全 `.value` を付けるという「型噪音」も生じている。

UI 駆動 Signal / ロジック内部 ref / 不変フィールドの 3 層に分け、`createSubscriberInstance` を `createSubscriberView` + `createSubscriberRuntime` に分割する。

## 根拠

以下のフィールドは UI 描画に使われておらず Signal 化が不要:

- `isStopping`: SubscriberPanel 内部判定のみ。`useRef<boolean>` で十分
- `joiningFetchLastLocation`: コールバック内部状態のみ
- `liveObjectBuffer`: UI 非表示。Signal 化により `[...buffer.value, obj]` の O(n²) 再生成を強制している (issue #0166 と関連)
- `decoderConfigured`: UI 非表示。`DecoderWrapper.state` から導出可能
- `decoderState`: UI 描画はあるが、`DecoderWrapper` から取得できる。Signal にすると同期更新の負担が増えるだけ

## 修正方針

1. `SubscriberInstance` を 2 つに分ける:
   - `SubscriberView` (signal): UI 駆動するフィールドのみ (`status`, `statusMessage`, `subscriber`, `session`, `catalog`, `codec`, `framesDecoded`, `keyFramesDecoded`, `objectsReceived` 等)
   - `SubscriberRuntime` (ref): コールバック内部状態 (`isStopping`, `joiningFetchLastLocation`, `liveObjectBuffer`, `decoderConfigured` 等)
2. `createSubscriberInstance(id)` → `createSubscriberView(id)` + フックローカルな runtime ref
3. `useSubscriber` フック内で `useRef<SubscriberRuntime>` を保持する
4. テスト (`signals/subscriber.test.ts`) を更新する

## 影響範囲

- `devtools/src/signals/subscriber.ts` (大幅変更)
- `devtools/src/hooks/useSubscriber.ts` (runtime 状態への参照を ref 経由に変更)
- `devtools/src/components/SubscriberPanel.tsx` (UI で使う Signal のみ参照)
- `devtools/src/components/DebugPanel.tsx`
- `devtools/src/testApi.ts` (Signal vs ref の取得経路統一)
- `devtools/src/signals/subscriber.test.ts`

## テスト戦略

- `vp run test` で全テストがパスすること
- 新しい責務分離に対応するテストを `subscriber.test.ts` に追加
- 手動: Subscriber の追加・接続・停止・削除のフルサイクルを確認

## CHANGES.md 記載方針

- `## develop` 直下に `[CHANGE]` で記載する (devtools 内部 API の後方互換のない再編)

## 完了条件

- `SubscriberInstance` が `SubscriberView` (signal) / `SubscriberRuntime` (ref) に分離されている
- UI 描画に使われない signal が ref に置き換わっている
- 全テストパス
