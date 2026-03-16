# CLIENT_SETUP/SERVER_SETUP を単一 SETUP に統合

## 概要

CLIENT_SETUP と SERVER_SETUP の 2 つのメッセージを、単一の SETUP メッセージに統合する。

## 参照

- draft-ietf-moq-transport-17 Section 9.4
- https://github.com/moq-wg/moq-transport/pull/1510

## 変更内容

- draft-16 では CLIENT_SETUP (0x40) と SERVER_SETUP (0x41) の 2 つのメッセージが存在した
- draft-17 では単一の SETUP メッセージに統合
- クライアントとサーバーがそれぞれの単方向制御ストリーム上で SETUP を送信する

## 影響範囲

- `src/message/setup.ts`
- `src/message/types.ts`
- `src/session.ts`

## 実装方針

1. `src/message/types.ts` から CLIENT_SETUP/SERVER_SETUP を削除し、SETUP メッセージタイプを追加する
2. `src/message/setup.ts` のエンコード・デコードを単一 SETUP メッセージに書き換える
3. `src/session.ts` のハンドシェイク処理を更新する
4. テストを更新する

## 解決方法

`CLIENT_SETUP` (0x20) と `SERVER_SETUP` (0x21) を `SETUP` (0x2F00) に統合した。`ClientSetup`/`ServerSetup` インターフェースを `Setup` に、`createClientSetup`/`createServerSetup` を `createSetup` に、encode/decode 関数も同様に統合した。
