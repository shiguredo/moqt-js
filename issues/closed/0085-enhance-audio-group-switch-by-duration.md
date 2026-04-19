# Publisher の audio group 切替を timestamp ベースに変更する

Created: 2026-04-19
Completed: 2026-04-19
Model: Opus 4.7

## 概要

`createMediaPublisher.ts` の `handleAudioEncodedChunk` は、audio の group 切替をフレーム数固定 (50 frame) で行っている。これは Opus (20 ms frame) では 1 秒単位に一致するが、AAC (1024 samples / 48 kHz ≒ 21.33 ms) では約 46.875 frame/s となり、group 粒度が codec / sampleRate によってブレる。

encoded chunk の `timestamp` (μs) を使って時間ベースで切り替える方式に変更し、codec に依存せず一貫した group 粒度を保てるようにする。

## 該当箇所

`src/createMediaPublisher.ts:539-571` `handleAudioEncodedChunk`

```ts
// オーディオは一定間隔で新しいグループを開始（約1秒ごと）
this.audioFrameCount++;
if (this.audioFrameCount % 50 === 0) {
  this.audioGroupId++;
  this.audioObjectId = 0;
}
```

## 修正方針

1. group 切替判定を行う純粋関数 `computeAudioGroupTransition` を `src/createMediaPublisher.ts` から export する。
   - 入力: 現在の `groupId` / `objectId` / `groupStartTimestamp` (null 可)、新しい `chunkTimestamp` (μs)、`groupDurationUs`
   - 出力: 新しい `groupId` / `objectId` / `groupStartTimestamp` と「group が切り替わったか」
2. 定数 `AUDIO_GROUP_DURATION_US = 1_000_000n` (1 秒相当) を定義し、group 期間を明示する。
3. `MediaPublisherImpl` の state から `audioFrameCount` を除去し、`audioGroupStartTimestamp: bigint | null` を追加する。
4. `handleAudioEncodedChunk` で `computeAudioGroupTransition` の結果を使って `groupId` / `objectId` を更新する。

## テスト

CLAUDE.md に従い「変更前にテストを先に修正する」。

- `src/createMediaPublisher.test.ts` を新設し、`computeAudioGroupTransition` の単体テストを追加する。
  - 初回呼び出し (groupStartTimestamp=null) で group を開始すること
  - group 期間未満の連続呼び出しで objectId だけが進むこと
  - group 期間を跨いだ呼び出しで groupId が +1 され、objectId が 0 に戻ること
  - timestamp が後退した場合 (再送等) の挙動は「再同期して新 group」とすること
- `src/createMediaPublisher.prop.ts` を新設し、fast-check で
  - groupId は単調増加 (減少しない) すること
  - group 期間内の同一 groupId 呼び出しでは objectId が単調増加すること
  - を担保する。

## 検証

- `vp run build` (vite build + tsc) が通ること。
- `vitest run` で既存 + 新規テストがすべて通ること。
- e2e 動作確認は今回は対象外。

## 解決方法

- `src/createMediaPublisher.ts` に純粋関数 `computeAudioGroupTransition` と型 `AudioGroupTransitionInput` / `AudioGroupTransitionOutput` を追加した。
- 定数 `AUDIO_GROUP_DURATION_US = 1_000_000n` を追加した。
- `MediaPublisherImpl` の `audioFrameCount` を撤去し、`audioGroupStartTimestamp: bigint | null` を追加した。
- `handleAudioEncodedChunk` で `computeAudioGroupTransition` の結果を使って `groupId` / `objectId` / `groupStartTimestamp` を更新するようにした。
- `src/createMediaPublisher.test.ts` で初回 / 継続 / 超過 / 後退 / 境界ケースの単体テストを追加した。
- `src/createMediaPublisher.prop.ts` で groupId 単調非減少、継続時 / 切替時の不変条件を fast-check で検証した。
