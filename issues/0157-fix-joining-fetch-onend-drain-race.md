# Joining Fetch `onEnd` ドレインループと `object:` コールバック間の race を解消する

Created: 2026-05-11
Model: Opus 4.7

## 概要

`useSubscriber.ts` の Joining Fetch `onEnd` 内ドレインループ (540-551 行) は `liveObjectBuffer.value` を読み取って `[]` でクリアするが、`joiningFetchInProgress.value = false` の代入はドレインループ脱出後 (550 行) に行われる。その間、`session.subscribe` の `object:` コールバック (572-585 行) は `joiningFetchInProgress.value` が `true` の間バッファに積み続ける。

結果として、以下の race window でライブオブジェクトが永久に放置される:

1. ドレインループが `while (instance.liveObjectBuffer.value.length > 0)` を評価 → false で脱出
2. その直前に `object:` コールバックが発火し `[...buffer.value, obj]` でバッファに積む
3. ループ脱出後に `joiningFetchInProgress.value = false` が走り、それ以降の `object:` は chainRef 経路へ流れる
4. 上記 2 で積まれた `obj` は再評価されず放置される

## 根拠

- `useSubscriber.ts:540-551` の IIFE 内 `while` 末尾で `length > 0` を再評価しているが、`object:` コールバックの発火順序は WebTransport ストリーム読み取り側に依存し、シングルスレッド JS でもマイクロタスク境界で割り込む
- コメント `598-605 行` は「ここで早期解除すると、ドレインループ実行中に到着したライブオブジェクトが直接 handleObject 経路へ流れて順序が破綻するため、解除箇所はドレイン側に一本化する」と述べているが、解除タイミングの原子性は担保していない
- `joiningFetchInProgress` を立て下げる箇所は: 立て (427 行) → 立て下げ (550 行 onEnd / 561 行 onError / cleanupSubscriber 内)

## 修正方針

1. ドレインループ脱出と `joiningFetchInProgress.value = false` をアトミックに行う。具体的には以下のいずれか:
   - **案 A**: `batch()` で `liveObjectBuffer.value = []` と `joiningFetchInProgress.value = false` を囲む。ループ末尾で残バッファが空 **かつ** その代入が同期完了するまで `object:` が割り込めない window を狭める
   - **案 B (推奨)**: ループ末尾で「次に積まれたオブジェクトをそのまま chainRef へ流す」逃げ道を提供する。具体的には `joiningFetchInProgress.value = false` を `liveObjectBuffer.value = []` より前に立てる。すると `object:` 側はバッファに積まず chainRef へ直接流す。最後にバッファを空チェックして残っていれば 1 度だけ追加処理する
2. `object:` コールバック側 (572-585 行) で「`joiningFetchInProgress` が false かつバッファに残物がある」状態を考慮しない実装になっているため、立て下げと残物処理の順序を整理する

## 推奨実装イメージ (案 B)

```typescript
// ドレインを 1 度だけ実施
const initialBuffered = sortByGroupObject([...instance.liveObjectBuffer.value]);
instance.liveObjectBuffer.value = [];
// 重複除去
const objectsToProcess = applyJoiningFetchDedupe(
  initialBuffered,
  instance.joiningFetchLastLocation.value,
);

// joiningFetchInProgress を先に立て下げる。これ以降に到着したオブジェクトは
// object: コールバック側で chainRef 経由でデコードされる。
instance.joiningFetchInProgress.value = false;
instance.joiningFetchLastLocation.value = null;

// ドレイン中に重ねて積まれた可能性のあるバッファ残物を chainRef へ流す
const residual = sortByGroupObject([...instance.liveObjectBuffer.value]);
instance.liveObjectBuffer.value = [];

void (async () => {
  for (const obj of objectsToProcess) {
    await handleObject(obj);
  }
  for (const obj of residual) {
    await handleObject(obj);
  }
})();
```

ただし「ドレインループ実行中の `await handleObject` で順序が破綻する」既存懸念は残るため、`object:` コールバック側でも chainRef 投入時に「`joiningFetchInProgress` の最後の取り回しが完了しているか」を判定するのではなく、`chainRef.current = chainRef.current.then(...)` のチェーンに統一されている事実を活用してドレインも chainRef 経由にする方が安全。

## 影響範囲

- `devtools/src/hooks/useSubscriber.ts` の `joiningFetch.onEnd` / `object:` コールバック周辺

## テスト戦略

- `vp run build:devtools` でビルドが通ることを確認する
- `vp run test` で全 456 テストがパスすることを確認する
- 手動: Catalog 取得が長引くケース (relay 経由) で Joining Fetch 完了直後にライブオブジェクトが落ちないことを目視確認する
- issue #0160 で追加する単体テストにて: 「`onEnd` 後にバッファ追加 → クリア → `joiningFetchInProgress=false`」の競合シナリオを偽 session で再現する

## CHANGES.md 記載方針

- `## develop` 直下に `[FIX]` で記載する (devtools の動作に影響するため `### misc` ではなく上位)

## 完了条件

- `joiningFetchInProgress.value = false` がドレイン完了より **前** に立て下がる、または `batch()` でアトミック化されている
- ドレインループ後にバッファに残った要素が chainRef 経由で正しく処理される
- `vp run build:devtools` が成功する
- `vp run test` が全テストパスする
