# Joining Fetch 送信エラーで pendingFetch エントリがリークする

Created: 2026-04-29
Completed: 2026-04-29
Model: Opus 4.7

## 概要

`src/session.ts` の `sendJoiningFetch()` (line 2369) は呼び出し元で `void this.sendJoiningFetch(...)` (line 2678) として fire-and-forget される。`sendJoiningFetch` は内部で先に `this.pendingFetch.set(requestId, ...)` (line 2404-2413) を行い、その後 `this.transport.createBidirectionalStream()` を含む `sendRequestOnBidiStream()` を await する。bidi stream 作成や書き込みで例外が発生した場合、`pendingFetch` のエントリは削除されず Promise は誰にも捕捉されないため:

- `pendingFetch` のエントリが `requestId` をキーに残留する。
- セッションが close されるまでこのエントリは解放されない (close 時に `pending.reject(...)` で reject されるが、Joining Fetch の場合 reject は `options.onError?.(err)` を呼ぶだけなので副作用は小さい)。
- エラーが silent fail し、`options.onError` も呼ばれない (`pendingFetch.reject` は呼ばれずに、catch されない Promise rejection が浮かぶ)。

通常 Fetch (`fetch()` メソッド経由、line 1416 等) は `await this.sendRequestOnBidiStream(...)` の戻り値を利用するため、呼び出し元の Promise が reject されてユーザーに伝わる。Joining Fetch だけが背景送信のため、エラー処理が抜けている。

## 根拠

draft-ietf-moq-transport-17 仕様上 Joining Fetch のエラーをどう扱うかという規定はないが、moqt-js は内部 API 契約として `options.onError` を提供しており、これが呼ばれないのは moqt-js 側の実装責任。

## 該当コード

### 呼び出し元 (`src/session.ts:2675-2690`)

```typescript
// Joining Fetch が指定されている場合は送信
if (pending.joiningFetch) {
  if (largestLocation) {
    void this.sendJoiningFetch(
      requestId,
      pending.joiningFetch,
      pending.objectCallback,
      largestLocation,
    );
  } else {
    // ...
    pending.joiningFetch.onEnd?.();
  }
}
```

`void` で Promise が破棄されている。

### 関数内の登録順序 (`src/session.ts:2403-2445`)

```typescript
// FETCH_OK を待つ Promise（Joining Fetch の場合は背景で処理）
this.pendingFetch.set(requestId, {
  resolve: () => {
    this.fetchers.set(requestId, impl);
  },
  reject: (err) => {
    options.onError?.(err);
  },
  impl,
  startLocation: estimatedStartLocation,
});

// ...

const payload = encodeFetchPayload(fetchMsg);
const streamInfo = await this.sendRequestOnBidiStream(requestId, MessageType.FETCH, payload, {
  // ...
});

// 双方向ストリームからレスポンスを読み取る
void this.readFetchResponse(requestId, streamInfo.stream, streamInfo.controlReader);
```

`pendingFetch.set` は `await` の前に呼ばれているため、await が throw すれば登録はそのまま残る。

## 影響

- **メモリリーク (軽微)**: `pendingFetch` エントリ 1 つ分。セッション close で解放されるため致命的ではないが、長時間動かすアプリで Joining Fetch のエラーが繰り返し発生すると蓄積する。
- **エラー通知漏れ**: 呼び出し元 (Subscriber 作成パス) の SUBSCRIBE 自体は成功しているため、ユーザーは Joining Fetch だけが失敗したことに気付けない。`onError` も呼ばれない可能性がある (Promise rejection を catch する経路がない)。
- **`requestId` の重複利用リスク**: `nextRequestId` は `+= 2n` で単調増加するため重複は出ないが、エラーが残ったエントリが session close 時に reject されるまで `pendingFetch` に居続ける。

## 修正方針

### 方針 A (推奨): try/catch で囲む

`sendJoiningFetch` の body 全体を try/catch で囲み、catch 内で:

1. `this.pendingFetch.delete(requestId)` を呼ぶ。
2. `options.onError?.(err)` を呼んでエラーを通知する。
3. error を再 throw しない (背景処理なので Promise rejection を表面化させたくない)。

```typescript
private async sendJoiningFetch(...): Promise<void> {
  const requestId = this.nextRequestId;
  this.nextRequestId += 2n;

  try {
    // 既存の処理
  } catch (err) {
    this.pendingFetch.delete(requestId);
    const error = err instanceof Error ? err : new Error(String(err));
    options.onError?.(error);
  }
}
```

### 方針 B: 呼び出し元で catch

呼び出し元 (line 2678) で `.catch()` を付ける。

```typescript
void this.sendJoiningFetch(...).catch((err) => {
  this.pendingFetch.delete(requestId);  // ただしこの requestId は subscribe の方
  pending.joiningFetch.onError?.(err);
});
```

しかし呼び出し元では `sendJoiningFetch` 内部で生成される `requestId` を知ることができないため、`pendingFetch` のクリーンアップが難しい。方針 A の方が整合的。

### 方針 C: 登録順序を変える

`pendingFetch.set` を `sendRequestOnBidiStream` の await の後に行う。ただし「`readFetchResponse` 内で `pendingFetch` を参照する」ため、stream を開いてから登録するとレースコンディションのリスクがある。詳細な調査が必要。

→ 方針 A が最もシンプルで影響範囲が小さい。

## テスト追加方針

- WebTransport 依存のため単体テストは困難。
- 検証可能な代替: `sendJoiningFetch` を public 化せずに、`transport.createBidirectionalStream()` を実際に呼ばずに状態のみ確認するテストは難しい。
- 実機検証: `wt-devtools` 等でわざとサーバーを停止した状態で Joining Fetch を発火させ、`pendingFetch` のサイズが残らないこと、`onError` が呼ばれることを確認する。
- ベストエフォート: 既存テストが壊れないことだけ確認し、コードレビューで方針 A の正当性を確認する。

## 補足

レビュー指摘 #M1 を受けて起票。同種のリーク (`void this.xxx(...)` の fire-and-forget) が他の箇所にもないか調査する余地はあるが、本 issue では Joining Fetch のみを扱う。

## 解決方法

- `Session.sendJoiningFetch()` (`src/session.ts`) で `encodeFetchPayload` / `sendRequestOnBidiStream` / `readFetchResponse` を try/catch で囲み、catch 内で `pendingFetch.delete(requestId)` と `options.onError?.(error)` を呼ぶようにした (issue 中の方針 A)。
- これにより bidi ストリーム作成失敗時等にも `pendingFetch` がリークせず、`onError` が確実に呼ばれるようになる。
- WebTransport 依存のため自動テストはなし。実機検証 (リレー停止状態で Joining Fetch を発火) で `pendingFetch` サイズが残らないこと、`onError` が呼ばれることを確認する。
