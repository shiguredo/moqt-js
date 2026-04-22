# session.ts レベルでの統計情報の公開

## 概要

現在の統計情報は devtools の `useSubscriber.ts` でコールバック経由でカウントしているが、session.ts レベルでの受信統計やバッファ状態を公開することで、より正確なデバッグ・監視が可能になる。

## 背景

SUBSCRIBE からのライブストリームが来ていない場合、コールバックが呼ばれないため統計情報に反映されない。session.ts レベルでカウントすれば、コールバックに渡る前の状態も把握できる。

## 追加したい統計情報

### オブジェクト受信カウント

- session.ts レベルでの受信オブジェクト数（FETCH / SUBSCRIBE 別）
- 受信バイト数

### バッファ状態

- `pendingSubgroupStreams` のサイズ（SUBSCRIBE_OK 前に到着したストリーム数）
- `pendingSubgroupStreams` のバイト数
- リオーダリングバッファのサイズ・バイト数（既存だが session レベルで公開）

### ストリーム状態

- アクティブな Subgroup ストリーム数
- アクティブな Fetch ストリーム数

## 実装案

### 1. SessionStatistics インターフェース

```typescript
interface SessionStatistics {
  // オブジェクト受信
  objectsReceivedViaFetch: number;
  objectsReceivedViaSubscribe: number;
  bytesReceivedViaFetch: number;
  bytesReceivedViaSubscribe: number;

  // バッファ状態
  pendingSubgroupStreamsCount: number;
  pendingSubgroupStreamsBytes: number;

  // ストリーム状態
  activeSubgroupStreams: number;
  activeFetchStreams: number;
}
```

### 2. Session に getStatistics() メソッドを追加

```typescript
class Session {
  getStatistics(): SessionStatistics {
    // ...
  }
}
```

### 3. Subscriber にもバッファ統計を追加

```typescript
interface SubscriberStatistics {
  reorderBufferSize: number;
  reorderBufferBytes: number;
  // 既存の getReorderStats() を拡張
}
```

## 関連ファイル

- `src/session.ts` - 統計情報の収集・公開
- `src/subscriber.ts` - Subscriber 固有の統計
- `src/reorderBuffer.ts` - リオーダリングバッファの統計
