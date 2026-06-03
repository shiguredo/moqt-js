# GOAWAY を確立済みリクエストストリーム上で受信した際にセッション全体を閉じてしまう

- Priority: Medium
- Created: 2026-06-03
- Model: DeepSeek V4 Pro
- Branch: feature/draft-18
- Polished: 2026-06-03

- Completed: 2026-06-03

## 目的

draft-ietf-moq-transport-18 Section 10.4 の動作仕様に従い、リクエストストリーム上で 1 回目の GOAWAY を受信した際にセッション全体を閉じず、当該リクエストのマイグレーションのみを行うように修正する。

## 現状

`src/session/bidi.ts:522-533` の `bidiReadRequestStreamMessages` 内で、確立済みリクエストストリーム（最初の応答が REQUEST_OK だった後）に GOAWAY が到達すると、以下のコードが実行される：

```typescript
case MessageType.GOAWAY: {
    void decodeGoawayPayload(msg.payload);
    session.closeWithError(
      new SessionError(
        `received duplicate GOAWAY on request stream ${requestId}`,
        SessionErrorCode.PROTOCOL_VIOLATION,
      ),
    );
    return;
}
```

このコードパスは「同一リクエストストリーム上で 1 回目の GOAWAY」であるにもかかわらず、`PROTOCOL_VIOLATION` でセッション全体を閉じている。

### 到達シナリオ

1. Client → PUBLISH (or SUBSCRIBE, FETCH) → Server
2. Server → REQUEST_OK → Client（`bidiReadPublishResponse` 等で処理、pending エントリが削除され `bidiReadRequestStreamMessages` が起動）
3. Server → GOAWAY（同一 bidi stream）→ Client（`bidiReadRequestStreamMessages` の switch で到達）

この時点で、GOAWAY はこのストリーム上で 1 回目であり、仕様上の重複ではない。

## 設計方針

### goawayCallback の永続化

初回応答ハンドラ (`bidiReadPublishResponse` 等) に渡される `goawayCallback` はリクエスト確立後に破棄される。後続 GOAWAY に対応するため、`PublisherImpl` / `SubscriberImpl` / `FetcherImpl` に `goawayCallback` プロパティを追加する。

```typescript
// PublisherImpl に追加
readonly goawayCallback: ((newSessionUri: string) => void) | undefined;
```

初期化は各リクエスト開始時 (`session.ts` の `publish()` / `subscribe()` / `fetch()`) で行う。

### bidiReadRequestStreamMessages の修正

```typescript
// 変更前: session.closeWithError(...)
// 変更後:
case MessageType.GOAWAY: {
    const decoded = decodeGoawayPayload(msg.payload);
    const publisher = session.publishers.get(requestId);
    if (publisher?.goawayCallback) {
      publisher.goawayCallback(decoded.newSessionUri);
    }
    const subscriber = session.subscribers.get(requestId);
    if (subscriber?.goawayCallback) {
      subscriber.goawayCallback(decoded.newSessionUri);
    }
    const fetcher = session.fetchers.get(requestId);
    if (fetcher?.goawayCallback) {
      fetcher.goawayCallback(decoded.newSessionUri);
    }
    return;
}
```

`return` によりループを抜け、その後の `finally` ブロックで reader が解放される。

### 修正対象ファイル

1. `src/session/bidi.ts`:
   - `case MessageType.GOAWAY` (L522-533) の修正
   - 重複コメント (L523-524) の削除
   - `bidi.ts:529` のエラーメッセージ文言の誤り（"duplicate" → 初回）も解消

2. `src/publisher.ts` (`PublisherImpl`):
   - `goawayCallback` プロパティの追加

3. `src/subscriber.ts` (`SubscriberImpl`):
   - `goawayCallback` プロパティの追加

4. `src/fetcher.ts` (`FetcherImpl`):
   - `goawayCallback` プロパティの追加

5. `src/session.ts`:
   - `publish()`, `subscribe()`, `fetch()` で `goawayCallback` を Impl に設定

### 対象外

TRACK_STATUS は一発のリクエスト/レスポンスであり ongoing loop を持たないため、`bidiReadRequestStreamMessages` を通らない。修正対象外。

## 解決方法

コード修正は既に全適用済みであることを確認した：

1. `src/session/bidi.ts:534-546` (`bidiReadRequestStreamMessages`) の GOAWAY case が `session.closeWithError` ではなく `publisher.goawayCallback` / `subscriber.goawayCallback` / `fetcher.goawayCallback` を呼び出す
2. `src/publisher.ts:97` (`PublisherImpl`) / `src/subscriber.ts:86` (`SubscriberImpl`) / `src/fetcher.ts:64` (`FetcherImpl`) に `goawayCallback` プロパティが追加済み
3. `src/session.ts` の `publish()` / `subscribe()` / `fetch()` で `goawayCallback` を設定済み

テストを以下の 2 ファイルに追加した：

1. `src/subscriber.test.ts` - SubscriberImpl.goawayCallback 設定テストを追加
2. `src/publisher.test.ts` - PublisherImpl.goawayCallback 設定テストを追加

`CHANGES.md` の `## develop` セクションに `[FIX]` エントリを追記した。

## 完了条件

- 確立済みリクエストストリーム上で GOAWAY を受信した場合、当該リクエストの goawayCallback が呼び出されること
- セッション全体が閉じられないこと
- テストが追加されていること
- `CHANGES.md` の `## develop` セクションに `[FIX]` エントリを追記すること

## 仕様引用

draft-ietf-moq-transport-18 Section 10.4 (GOAWAY):

> An endpoint sends a GOAWAY message on its control stream to inform
> the peer it intends to close the session soon.

> A GOAWAY MAY also be sent on a request stream to initiate migration
> of that individual request. Upon receiving a GOAWAY on a request
> stream, the endpoint SHOULD re-issue that specific request on a
> session at the specified URI (or the current session if no URI is
> provided), and close the old request stream using the appropriate
> mechanism (e.g. FIN, stream reset, or PUBLISH_DONE).

> The endpoint MUST close the session with a PROTOCOL_VIOLATION if
> it receives more than one GOAWAY on the control stream or on a
> single request stream.
