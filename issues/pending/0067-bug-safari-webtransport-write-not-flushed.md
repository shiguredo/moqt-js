# Safari の WebTransport で unidirectional stream への write がフラッシュされない

Created: 2026-03-29
Model: Opus 4.6

## 概要

Safari 26.4 の WebTransport で `createUnidirectionalStream()` から取得した `WritableStreamDefaultWriter` に対して `write()` を呼ぶと、Promise は resolve するが実際にはデータが QUIC ストリームに送信されない。

## 症状

- `writer.write()` の Promise は 0-1ms で resolve する
- しかしリレーサーバーにデータが届かない
- 最初の write（subgroup header, 9 bytes）だけは相手に届く
- 約 27 回の write 後、バックプレッシャーで write が 19 秒ブロックされる
- `writer.close()` はバッファ内データの flush を待つため永遠にハングする
- catalog stream（1 回だけ write して `close()` する）は正常に届く
- Chrome では同じコードで正常動作

## 影響

- Safari から MOQT でメディアを配信できない
- `chrome -> relay -> chrome`: 動作する
- `chrome -> relay -> safari`: 動作する
- `safari -> relay -> chrome`: **動作しない**
- `safari -> relay -> safari`: **動作しない**

## 原因

WebKit の WebTransport は Apple の Network Framework (`nw_connection_send`) を使っている。

```cpp
// WebKit: NetworkTransportStreamCocoa.mm
nw_connection_send(m_connection.get(), data,
    NW_CONNECTION_DEFAULT_MESSAGE_CONTEXT,
    withFin,  // writer.write() では false、writer.close() では true
    completion_handler);
```

`NW_CONNECTION_DEFAULT_MESSAGE_CONTEXT` + `isComplete: false` の組み合わせで、Apple の Network Framework が小さな write を内部バッファに溜めてフラッシュしない。

- completion handler は「ネットワークに送信された」ではなく「内部バッファに受け入れられた」を意味する
- 最初の write はストリーム開設時なので即座に送信される
- 2 回目以降はバッファに溜まるだけ
- `close()` が `isComplete: true` で呼ばれるとフラッシュがトリガーされる

参考:

- https://github.com/WebKit/WebKit/blob/main/Source/WebKit/NetworkProcess/webtransport/cocoa/NetworkTransportStreamCocoa.mm
- https://developer.apple.com/documentation/network/nwconnection/send(content:contentcontext:iscomplete:completion:)-5ecuz
- https://developer.apple.com/forums/thread/689059

## 再現手順

1. Safari 26.4 で devtools の Publisher を開始する
2. リレーサーバーのログを確認する
3. subgroup header のみ受信され、object データは受信されない
4. moqt-js 側では `writer.write()` が 0-1ms で resolve している
5. 5 秒程度待ってから Stop を押すと `writer.close()` でハングする

## 対策案

### 案 1: write の合体

subgroup header と object data を別々に write するのではなく、1 つの `Uint8Array` にまとめて 1 回で write する。大きなチャンクにすれば Network Framework がフラッシュする可能性が高まる。

### 案 2: WebKit Bugzilla に報告

Apple の Network Framework の挙動が WebTransport の仕様と乖離している可能性があるため、WebKit にバグ報告する。

## 現在のワークアラウンド

- `closePublisherStream()` に 5 秒のタイムアウトを設けて `writer.close()` のハングを回避している
- `stopPublishing()` でフレームリーダーとエンコーダーを `done()` の前に停止するようにした

## pending 理由

WebKit (Apple の Network Framework) 側のバグであり、moqt-js 側で根本対応はできない。案 1 (subgroup header と object data を 1 回の write にまとめる) は moqt-js 内で対応可能だが、Publisher のストリーム送出経路全体に影響する大きな改修となるため、WebKit / Bugzilla への報告と修正を待つ方針とする。WebKit 側の動向次第で対応方針を再検討する。

## 状況確認 (2026-04-29)

- `src/session.ts:2396-2416` の `closePublisherStreamInternal()` で 5 秒タイムアウト workaround は維持。コメントも Safari の `WritableStreamDefaultWriter.close()` が resolve しない件をそのまま記載している。
- WebKit 側の修正情報は確認できず、根本原因 (Apple Network Framework の `nw_connection_send` バッファリング) も継続中の想定。
- 案 1 (write の合体) は未実装。Publisher の送出経路改修は未着手。
- WebKit / Bugzilla 側の動きを待つ pending 方針は変更なし。
