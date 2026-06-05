# sendDatagram() の writer ロック競合を修正する

- Priority: High
- Created: 2026-06-04
- Completed: 2026-06-05
- Model: qwen3.7-plus
- Branch: feature/fix-send-datagram-writer-race
- Polished: 2026-06-04

## 目的

`sendDatagram()` の連続呼び出しで WebTransport datagram writer のロックが競合し、`TypeError` が発生するのを防ぐ。

## 優先度根拠

`sendDatagram` は同期的に呼ばれる (`publisher.sendDatagram` -> `SessionImpl.sendDatagram`)。メディア publisher は object datagram を高頻度で連続送信するため、前回の `releaseLock()` が完了する前に次の `getWriter()` が呼ばれると `TypeError` (`WritableStream is locked`) が発生し、送信が失敗する。datagram 送信はメディア配信の主要経路であり、高頻度送信で恒常的に踏むため High とする。

## 現状

`src/session.ts:3018` の `sendDatagram` は、呼び出しごとに `getWriter()` を取得し、`write()` の `finally` で `releaseLock()` している。

```typescript
// src/session.ts:3056-3065
// WebTransport datagram として送信
const writer = this.transport.datagrams.writable.getWriter();
writer
  .write(datagram)
  .finally(() => {
    writer.releaseLock();
  })
  .catch((err: unknown) => {
    publisher.handleError(err instanceof Error ? err : new Error(String(err)));
  });
```

`sendDatagram` は `void` を返す同期メソッドで、`write()` の完了を待たずに即座に戻る。`releaseLock()` は `write()` が解決した後の `finally` で実行されるため非同期である。前回の `write()` が解決する前に次の `sendDatagram` が呼ばれると、`getWriter()` がまだロックされた `WritableStream` に対して呼ばれ `TypeError` を同期的に throw する。この例外は `sendDatagram` の呼び出し元に伝播する。

## 設計方針

### 推奨案: datagram writer をセッションで保持して使い回す

`this.transport.datagrams.writable` は単一の `WritableStream` であり、writer は 1 つあれば足りる。最初の `sendDatagram` で取得して保持し、以降は `write()` を呼ぶだけにする。`WritableStreamDefaultWriter.write()` は複数回呼んでも内部キューに順次積まれるため、呼び出し順は保たれ、ロック競合も起きない。

```typescript
private datagramWriter: WritableStreamDefaultWriter<Uint8Array> | null = null;

private getDatagramWriter(): WritableStreamDefaultWriter<Uint8Array> {
  if (this.datagramWriter === null) {
    this.datagramWriter = this.transport.datagrams.writable.getWriter();
  }
  return this.datagramWriter;
}

private sendDatagram(publisher: PublisherImpl, params: SendDatagramParams): void {
  // ... datagram のエンコードは既存通り ...
  const writer = this.getDatagramWriter();
  writer.write(datagram).catch((err: unknown) => {
    publisher.handleError(err instanceof Error ? err : new Error(String(err)));
  });
}
```

セッションのクローズ処理で `this.datagramWriter?.releaseLock()` を呼んで後始末する。これにより呼び出しごとの `getWriter()` / `releaseLock()` の往復が無くなり、競合は構造的に消える。

### 代替案: Promise チェーンでシリアライズ

`getWriter()` / `releaseLock()` を呼び出しごとに行う構造を残す場合は、`this.datagramWriteChain` のような Promise チェーンに各送信を積んで直列化し、前回の `releaseLock()` 完了後にのみ次の `getWriter()` を呼ぶようにする。ただし送信ごとに writer を取り直すオーバーヘッドと、前回送信完了を待つレイテンシが増えるため、推奨案を優先する。

### 順序に関する注意

WebTransport datagram はトランスポート層では到達順序も到達自体も保証されない (best-effort)。本修正で保証するのは「`getWriter()` の競合で `TypeError` を起こさないこと」と「ローカルでの `write()` キュー投入順序を呼び出し順に保つこと」であり、ネットワーク到達順序の保証ではない。

## 変更対象ファイル

- `src/session.ts`: datagram writer をセッションフィールドとして保持し、`sendDatagram` とクローズ処理を修正する
- `CHANGES.md`: `[FIX]` エントリを追記する

## エッジケース

| ケース                                               | 期待動作                                                           |
| ---------------------------------------------------- | ------------------------------------------------------------------ |
| `sendDatagram` を同期的に連続呼び出し                | `TypeError` を起こさず、呼び出し順に `write()` がキューされる      |
| `write()` が失敗 (トランスポートエラー等)            | `publisher.handleError` で通知。保持した writer はクローズ時に解放 |
| セッションクローズ                                   | 保持中の writer を `releaseLock()` して後始末する                  |
| 一度も `sendDatagram` していないセッションのクローズ | writer は未取得 (null) なので何もしない                            |

## テスト方針

datagram 送信は WebTransport の `datagrams.writable` に依存するため、連続送信で `TypeError` が出ないことの検証は E2E テスト (Playwright) の対象とする。モック禁止制約下では単体テスト不可能。

## 後方互換の影響

- 内部実装の修正のみで、公開 API に変更はない
- これまで連続送信で `TypeError` を起こしていたのが、正常に連続送信できるようになる

## 完了条件

- `sendDatagram()` を連続呼び出ししても `TypeError` が発生しない
- ローカルでの送信 (write キュー投入) 順序が呼び出し順に保たれる
- セッションクローズ時に datagram writer が解放される
- 既存の全テストが PASS する
- `CHANGES.md` に `[FIX]` エントリを追記する

## 解決方法

推奨案 (datagram writer をセッションで保持して使い回す) を採用した。

### src/session.ts

- フィールド `private datagramWriter?: WritableStreamDefaultWriter<Uint8Array>` を追加した。
- `getDatagramWriter()` ヘルパーで `this.datagramWriter ??= this.transport.datagrams.writable.getWriter()` と遅延取得して保持し、以降は同じ writer を返す。これにより呼び出しごとの `getWriter()` / `releaseLock()` 往復が無くなり、ロック競合の `TypeError` が構造的に消える。
- `sendDatagram()` は保持 writer を使い、`write()` の `catch` で `publisher.handleError` に流す (旧 `finally` の `releaseLock()` を削除)。
- `close()` で保持 writer を `releaseLock()` して `undefined` にリセットする (`transport.close()` が datagram writable を所有するため `close()` ではなく `releaseLock()` が正しい)。

### review-diff-code 指摘への対応 (ハードニング)

レビューで以下の経路を検出し、あわせて修正した。

- セッションクローズ後に `sendDatagram` が呼ばれると `getDatagramWriter` が閉じた transport に対して同期的に `getWriter()` を呼んで throw しうる (本 issue が元々防ごうとした失敗モード)。`sendDatagram` 冒頭に `sessionState === "closed"` ガードを追加した。
- `close()` の `releaseLock()` (および `transport.close()`) は in-flight の `write()` を `TypeError` で reject させる。`sendObject` と異なり datagram writer は `releaseLock()` するためこの reject が `catch` -> `publisher.handleError` に流れ、正常終了時に偽のエラーコールバックが発火する。`catch` 内で `sessionState === "closed"` の場合は握り潰すようにした。

### コメントの是正

`§11.3` は datagram のワイヤ表現を規定するもので、「writable が単一 WritableStream」という writer 保持の根拠ではない (これは WebTransport / WHATWG Streams のセマンティクス)。フィールドコメントの重複を排し、`getDatagramWriter` の JSDoc に WebTransport の根拠としてまとめ直した。

### テストについて

writer 保持の状態遷移は `SessionImpl` に WebTransport を注入しないと到達できず、注入用の transport を手作りするのはスタブに該当するため (CLAUDE.md のモック・スタブ禁止)、単体テストは追加しない。連続送信で `TypeError` が出ないことの検証は E2E (Playwright) を想定する。構造的正しさは review-diff-code の複数エージェントレビューで確認した。

### スコープ外として記録する事項

peer 起点の異常クローズ経路 (`transport.closed` ハンドラ) は `sessionState` を `closed` にするのみで `publisher.markClosed()` を呼ばない。このため publisher 側のガードが効かない経路が残るが、これは `sendObject` も含む既存挙動であり本 issue のスコープ外。`sendDatagram` 冒頭の `sessionState` ガードで datagram 経路は保護される。
