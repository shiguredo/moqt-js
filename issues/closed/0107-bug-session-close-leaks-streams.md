# Session.close() が WebTransport を閉じずストリームをリークする

Created: 2026-04-29
Completed: 2026-04-29
Model: Opus 4.7

## 概要

`Session.close()` (`src/session.ts:1835`) はユーザーがセッション終了を要求するための公開 API であるにもかかわらず、`this.transport.close()` を呼ばない。さらに `requestStreams` / `publisherStreams` / `namespaceSubscriptions` / `namespacePublications` が保持する WebTransport bidi/uni ストリームの `writer` を `close()` / `cancel()` していないため、これらが peer 側で open のまま放置される。結果として:

- WebTransport セッション自体が peer 側で生き続け、Section 3.5 の終了通知が行われない。
- bidi/uni ストリームに対応する QUIC ストリームのフロー制御クレジットが解放されない。
- 受信ループ (`startNamespaceStreamLoop` 等) が `streamReader.read()` でブロックし続ける可能性がある。

`closeWithError()` (`src/session.ts:1929-1936`) では `transport.close({ closeCode, reason })` が明示的に呼ばれている一方、ユーザー起点の `close()` はこれを行わないため、二つの終了経路で挙動が非対称である。

## 根拠

draft-ietf-moq-transport-17 Section 3.5 (`refs/moq/draft-ietf-moq-transport-17.txt:1367-1378`):

> The Transport Session can be terminated at any point. When native QUIC is used, the session is closed using the CONNECTION_CLOSE frame ([QUIC], Section 19.19). When WebTransport is used, the session is closed using the CLOSE_WEBTRANSPORT_SESSION capsule ([WebTransport], Section 6).
>
> When terminating the Session, the application MAY use any error message and SHOULD use a relevant code, as defined below:
>
> NO_ERROR (0x0): The session is being terminated without an error.

つまりユーザー起点の正常終了でも CLOSE_WEBTRANSPORT_SESSION 相当の通知 (`WebTransport.close()`) が必要。

draft-ietf-moq-transport-17 Section 6.1:

> A SUBSCRIBE_NAMESPACE can be cancelled by closing the stream with either a FIN or RESET_STREAM.

PUBLISH_NAMESPACE / SUBSCRIBE / FETCH 等の bidi stream も同様にストリームを閉じる責務がある。

## 該当コード

### `close()` が transport を閉じていない

`src/session.ts:1835-1919`:

```typescript
async close(): Promise<void> {
  if (this.sessionState === "closed") {
    return;
  }

  this.sessionState = "closed";

  // ...各種 Map の cleanup...

  this.requestStreams.clear();

  // close コールバックはコンストラクタの transport.closed 監視で呼ばれる
}
```

`this.transport.close({ closeCode: 0 })` の呼び出しが欠如している。

### `closeWithError()` との非対称

`src/session.ts:1929-1936`:

```typescript
private closeWithError(error: SessionError): void {
  this.callbacks.error?.(error);
  void this.close();
  this.transport.close({
    closeCode: error.code,
    reason: error.message,
  });
}
```

エラー終了では transport.close を呼ぶが、正常終了では呼ばない。

### bidi/uni ストリームの writer が close されていない

- `requestStreams` (`src/session.ts:701-708`): 各エントリが `writer: WritableStreamDefaultWriter<Uint8Array>` を保持しているが、`close()` 内では line 1916 で `this.requestStreams.clear()` するだけ。
- `publisherStreams` (`src/session.ts:781-788`): 各エントリが `writer` を保持。`close()` ではクリーンアップ対象外。
- `namespaceSubscriptions` (`src/session.ts:748-759`): line 1903-1907 で `state = "closed"` をセットするだけで `writer.close()` を呼ばない。
- `namespacePublications` (`src/session.ts:769-776`): line 1909-1913 で同様。
- `controlSendStream`: `close()` で参照されておらず writer も close されない。

## 影響

- **正常終了の通知漏れ**: ユーザーが `session.close()` を呼んでも peer は WebTransport が閉じるまで気付けない。peer 側のリレーは subscribe / publish の状態を保持し続ける。
- **ストリームリーク**: bidi/uni ストリームが FIN/RESET_STREAM されないため、QUIC レイヤでフロー制御クレジットが消費され続ける。長時間動かすアプリで顕在化する可能性。
- **受信ループの停止漏れ**: `startNamespaceStreamLoop` (`src/session.ts:1589-`) は `subscription.state === "active"` のループ条件で動作するが、`streamReader.read()` がブロック中に外部から `state = "closed"` をセットされても read は返らない。`reader.cancel()` または underlying transport の close が必要。

## 修正方針

1. `Session.close()` の末尾で `this.transport.close({ closeCode: SessionErrorCode.NO_ERROR })` を呼ぶ。
2. close 前に保持中のストリームに対して以下を行う:
   - `requestStreams` の各エントリの `writer.close()` を try/catch で呼ぶ。
   - `publisherStreams` の各エントリの `writer.close()` を try/catch で呼ぶ。
   - `namespaceSubscriptions` の各エントリの `writer.close()` を try/catch で呼ぶ (同時に `streamReader.cancel()` または release)。
   - `namespacePublications` の各エントリの `writer.close()` を try/catch で呼ぶ。
   - `controlSendStream` (`WritableStream<Uint8Array>`) の writer も close する。
3. close と transport.close の順序: 受信ループが state を見て break できるよう state を先に "closed" にしたうえで、ストリームを順に close、最後に `transport.close` を呼ぶ。
4. `closeWithError()` の `this.transport.close()` 呼び出しは引き続き残し、`close()` から transport.close を呼ぶ実装とコードパスを共通化する (例: `close()` に `closeCode` / `reason` 引数を追加し、デフォルトを `NO_ERROR` とする。`closeWithError` から呼ぶ際は error.code を渡す)。

## テスト追加方針

WebTransport は実環境依存のため単体テストは難しい。以下の代替を検討する:

- 純粋関数ではないため fast-check よりも E2E に近いテストが必要だが、CLAUDE.md の方針で「モックやスタブは利用しない」ため session.test.ts での自動検証は困難。
- 最低限、`close()` 後に `state` が "closed" になることを既存テストでカバーできるか確認する。
- 統計値 (`SessionStatistics` の `publisherStreamsOpen` 等) が close 後に 0 になることを assert するテストを追加することは検討可能。
- 実機検証: `wt-devtools` または `moqt-devtools` でセッションを close した際に WebTransport の `closed` Promise が即座に resolve することを確認する。

## 補足

レビュー指摘 #C1 / #C2 / #C3 を受けて起票。三者は「Session.close() のクリーンアップ漏れ」という同一責務に属するため 1 件にまとめる。

## 解決方法

- `Session.close()` (`src/session.ts`) の末尾で `transport.close({ closeCode, reason })` を呼んで WebTransport セッションを閉じるようにした。`close(closeCode?: number, reason?: string)` を引数化し、デフォルトは `SessionErrorCode.NO_ERROR` / 空文字列。
- `closeWithError()` を `void this.close(error.code, error.message)` 経由で実装し、正常終了 / エラー終了の両方で同じクリーンアップ経路を通るようにした。
- `requestStreams` / `publisherStreams` / `namespaceSubscriptions` / `namespacePublications` の各エントリの `writer` を `writer.close()` で閉じ、`namespaceSubscriptions` / `namespacePublications` の `streamReader` を `cancel()` するヘルパー (`closeWriterSafely` / `cancelReaderSafely`) を `close()` 内に追加。既に閉じている等の例外は無視する。
- `controlSendStream` (`WritableStream<Uint8Array>`) を `close()` で閉じるようにした。SETUP 送信時に writer は releaseLock 済みなので、underlying stream の `close()` を呼ぶ。
- WebTransport 依存のため自動テストはなし。実機検証で `session.closed` Promise が即座に resolve することを確認する。
