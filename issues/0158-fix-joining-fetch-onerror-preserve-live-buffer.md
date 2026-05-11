# `joiningFetch.onError` 時にライブバッファを破棄せず処理する

Created: 2026-05-11
Model: Opus 4.7

## 概要

`useSubscriber.ts:553-564` の `joiningFetch.onError` ハンドラは、Joining Fetch (過去取得) が失敗した時に以下を実施する:

1. `decoderInstance.resetKeyframeWait()` でデコーダーをキーフレーム待ちに戻す
2. `joiningFetchInProgress.value = false`
3. **`liveObjectBuffer.value = []` でライブバッファを完全破棄**
4. `joiningFetchLastLocation.value = null`

Joining Fetch は仕様上 SUBSCRIBE と独立したストリームであり、Joining Fetch が失敗してもライブ配信 (SUBSCRIBE 経由) は継続可能。にもかかわらず、ライブバッファに溜まっていた有効なオブジェクトを Joining Fetch エラーの巻き添えで捨てているため、次のキーフレーム到着まで描画が止まる。

## 根拠

- `refs/moq/draft-ietf-moq-transport-17.txt` §9.14.2 / §9.14.2.1: Joining FETCH は SUBSCRIBE と並行する独立ストリーム
- `useSubscriber.ts:553-564` の `onError` 実装でライブバッファをクリア
- ライブ配信は SUBSCRIBE 経由の `object:` コールバック (572-585 行) で `joiningFetchInProgress.value` が true の間バッファに積まれている。`onError` 時点でバッファに有効なライブオブジェクトが溜まっている可能性が高い
- `decoderInstance.resetKeyframeWait()` を呼ぶため、次の keyframe まで描画は停止する。一方で `liveObjectBuffer` 内に keyframe を含む可能性があるため、これを捨てるのは二重に損

## 修正方針

`onError` を `onEnd` と同じドレインロジックに通す。具体的には:

1. `liveObjectBuffer` の中身を `sortByGroupObject` でソート → `joiningFetchLastLocation` ベースの重複除去フィルタ → `handleObject` で順次処理 (Joining Fetch から既に配信済みのオブジェクトは無いため、純粋に live buffer 内容のみ処理する)
2. `joiningFetchInProgress.value = false` で chainRef 経路に切り替え
3. `decoderInstance.resetKeyframeWait()` は `liveObjectBuffer` 内に keyframe が含まれていた場合に二重リセットになるため、buffer 処理後に「state がまだ unconfigured 状態か」を確認するか、もしくは buffer 内に keyframe があるかを LOC で判定してから決める

実装イメージ:

```typescript
onError: (error: Error) => {
  console.error(`[${subscriberId}] joiningFetch: error`, error);
  // Joining Fetch (過去取得) が失敗しても SUBSCRIBE 経由のライブ配信は継続。
  // バッファに溜まったライブオブジェクトを破棄せず、ドレインしてからフラグを下げる。
  const buffered = sortByGroupObject([...instance.liveObjectBuffer.value]);
  instance.liveObjectBuffer.value = [];
  instance.joiningFetchInProgress.value = false;
  instance.joiningFetchLastLocation.value = null;

  void (async () => {
    for (const obj of buffered) {
      await handleObject(obj);
    }
  })();
},
```

`decoderInstance.resetKeyframeWait()` の扱いは別途検討する。一旦削除して live buffer 内に keyframe があれば自然にデコードできるようにするのが安全。

## 影響範囲

- `devtools/src/hooks/useSubscriber.ts` の `joiningFetch.onError`

## テスト戦略

- `vp run build:devtools` でビルドが通ることを確認する
- `vp run test` で全 456 テストがパスすることを確認する
- 手動: Joining Fetch のみ失敗するシナリオ (relay が Joining Fetch を拒否する設定) でライブ配信が継続することを目視確認する

## CHANGES.md 記載方針

- `## develop` 直下に `[FIX]` で記載する (devtools の動作に影響)

## 完了条件

- `joiningFetch.onError` でライブバッファを破棄せず処理する
- `vp run build:devtools` が成功する
- `vp run test` が全テストパスする
