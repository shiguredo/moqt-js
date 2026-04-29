# waitForSubscriber / waitForFetcher のタイムアウトでストリームが cancel されない

Created: 2026-04-29
Completed: 2026-04-29
Model: Opus 4.7

## 概要

`src/session.ts` の `waitForSubscriber()` (line 3426) と `waitForFetcher()` (line 3463) は、対応する Subscriber / Fetcher が 5 秒以内に登録されなかった場合に `null` を resolve する (line 3451 / 3492 の `setTimeout(doResolve, 5000)`)。呼び出し元の `handleIncomingStream` (line 3561, 3586) は null を受けて単に `break` するだけで、対応する unidirectional stream の `reader` を `cancel()` しない。

`finally` 節 (line 3658-3660) で `reader.releaseLock()` だけは呼ばれるが、これは reader のロックを解放するだけで underlying QUIC stream は cancel されない。結果として:

- データストリームが peer 側からデータを送り続ける場合、QUIC レベルでは受信し続けて捨てるだけになる。
- `STOP_SENDING` フレームが peer に送信されないため、peer は無駄なデータを送り続ける可能性。
- フロー制御クレジットが恒久的に消費される (stream 単位だが、長期的には堆積する)。

タイムアウト 5 秒は spec 由来ではなく moqt-js の独自設定だが、その間に SUBSCRIBE_OK / FETCH_OK が来なければ「対応する subscription が存在しない異常状態」と判断できるため、ストリームを `cancel()` または abort して peer に通知すべき。

## 根拠

draft-ietf-moq-transport-17 Section 5.3 (Cancelling a Subscription, Fetch):

> A subscriber cancels a subscription by sending the QUIC RESET_STREAM frame on the stream associated with that request, with an Application Protocol Error Code.

つまり購読を cancel する手段は QUIC RESET_STREAM (WebTransport では `WebTransportReceiveStream.cancel()` 相当)。タイムアウトで unknown subscription だと判断した場合、これを利用すべき。

WebTransport API: `ReadableStream.cancel(reason)` は WebTransport 上で stream の `STOP_SENDING` 相当を送信する。

## 該当コード

### `waitForSubscriber()` (`src/session.ts:3426-3453`)

```typescript
private waitForSubscriber(trackAlias: bigint): Promise<SubscriberImpl | null> {
  return new Promise<SubscriberImpl | null>((resolve) => {
    // 既に登録されている場合は即座に返す
    const existing = this.subscribersByAlias.get(trackAlias);
    if (existing) {
      resolve(existing);
      return;
    }

    let resolved = false;

    const doResolve = () => {
      if (resolved) return;
      resolved = true;
      this.subscriberReadyCallbacks.delete(trackAlias);
      resolve(this.subscribersByAlias.get(trackAlias) ?? null);
    };

    const callbacks = this.subscriberReadyCallbacks.get(trackAlias) ?? [];
    callbacks.push(doResolve);
    this.subscriberReadyCallbacks.set(trackAlias, callbacks);

    // タイムアウト: 5 秒以内に登録されなければ null
    setTimeout(doResolve, 5000);
  });
}
```

### `waitForFetcher()` (`src/session.ts:3463-3494`)

同様の構造。`pendingFetch.has(requestId)` チェックがあるため未知 requestId は早期 null を返すが、登録済みでも 5 秒で timeout。

### 呼び出し元 (`src/session.ts:3559-3590`)

```typescript
fetcher = this.fetchers.get(header.requestId) ?? null;
if (!fetcher) {
  fetcher = await this.waitForFetcher(header.requestId);
  if (!fetcher) {
    break; // ← reader.cancel() しないまま break
  }
}
// ...
subscriber = this.subscribersByAlias.get(header.trackAlias) ?? null;
if (!subscriber) {
  subscriber = await this.waitForSubscriber(header.trackAlias);
  if (!subscriber) {
    break; // ← reader.cancel() しないまま break
  }
}
```

`break` 後、`finally` (line 3658-3660) で `reader.releaseLock()` のみ。

## 影響

- **フロー制御リーク**: peer が unknown subscriber 向けにデータを送り続ける場合、当該 stream のフロー制御クレジットが消費され続ける。
- **無駄な通信**: 受信した bytes は捨てるだけだが、回線帯域と CPU を消費する。
- **peer 側の状態残留**: peer (relay) は subscription を維持し続ける。subscriber が居ないことを検知できない。
- **接続性能の悪化**: 同様の状況が複数の subscription で同時発生すると、stream 上限 / フロー制御リミットに到達する可能性。

注意: 実害は MOQT に対する DoS ではなく、誤動作した自分側の実装が peer に余計な負荷をかける形。

## 修正方針

1. `handleIncomingStream` で `waitForSubscriber()` / `waitForFetcher()` が null を返した場合、`reader.cancel(reason)` を呼んで peer に STOP_SENDING を送信する。
2. cancel 理由には WebTransport API の `WebTransportError` を使うか、文字列で `"unknown subscriber"` 等を渡す。
3. cancel 後に `break` して `finally` のクリーンアップに任せる。`reader.releaseLock()` は cancel 後でも呼んでよい。
4. waitFor 関数自体には変更を加えない (タイムアウトの判断基準は維持)。
5. タイムアウト値 5 秒の妥当性は本 issue のスコープ外。必要なら別途 issue を立てる。

## 検討事項

- `reader.cancel(reason)` を呼んだ場合、`reader.read()` でブロック中の Promise はどう振る舞うか? WebTransport 仕様では cancel 後に read は終了する想定。実装側でラウンドトリップを確認する必要がある。
- cancel と releaseLock の順序: cancel 後に releaseLock を呼んで問題ないか。一般に WHATWG Streams では cancel が return する前に reader が released されるため、明示的な releaseLock は不要 or 二重呼び出しエラーになる可能性がある。実装時に WHATWG 仕様を再確認する。
- 既存の statsSubscriberStreamsActive のデクリメント (line 3659) は `finally` で行われており、cancel 経路でも正しく実行されるか確認する。

## テスト追加方針

WebTransport stream の cancel は実機依存のため単体テストは困難。

- 実機検証: `wt-devtools` で SUBSCRIBE_OK が遅延したケースを再現し、タイムアウト後に stream が cancel されること、`SessionStatistics.subscriberStreamsActive` が 0 に戻ることを確認する。
- ログ: cancel 呼び出しの前後で debug ログを出して検証可能にする。
- 既存テストが壊れないことを最低限確認する。

## 補足

レビュー指摘 #M3 を受けて起票。本 issue は `waitForSubscriber` / `waitForFetcher` のタイムアウト後処理に絞る。タイムアウト値の妥当性、WebTransport stream の reset プロトコル詳細は別途検討する。

## 解決方法

- `Session.handleIncomingStream` (`src/session.ts`) で `waitForFetcher()` / `waitForSubscriber()` が null を返した場合に `void reader.cancel(reason)` を呼んで peer に STOP_SENDING を送ってから break するように変更した。reason には `unknown fetcher: requestId=...` / `unknown subscriber: trackAlias=...` を渡す。
- `cancel()` の Promise は `void` で破棄しているため、reader の `releaseLock()` が cancel 完了より先に走る可能性があるが、`finally` 内の `releaseLock()` はそのままでも動作する (cancel が release を待つ責務はない)。
- `waitForSubscriber` / `waitForFetcher` 自体には変更を加えていない。タイムアウト値 5 秒の妥当性は本 issue のスコープ外。
- WebTransport 依存のため自動テストはなし。実機検証で SUBSCRIBE_OK が遅延した場合に stream が cancel されること、`SessionStatistics.subscriberStreamsActive` が 0 に戻ることを確認する。
