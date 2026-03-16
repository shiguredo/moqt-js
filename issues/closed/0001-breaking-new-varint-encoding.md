# 新しい可変長整数エンコーディング

## 概要

QUIC 互換の可変長整数エンコーディングから、MOQT 独自の新しい可変長整数エンコーディングに変更する。

## 参照

- draft-ietf-moq-transport-17 Section 3
- https://github.com/moq-wg/moq-transport/pull/1016

## 変更内容

- draft-16 では RFC 9000 Section 16 の QUIC 可変長整数を使用していた
- draft-17 では新しいエンコーディング方式に変更
- エンコーディングの先頭ビットパターンとバイト長の対応が変わる

## 影響範囲

- `src/varint.ts`
- `src/varint.test.ts`
- プロトコル全体のワイヤフォーマット

## 実装方針

1. draft-17 Section 3 の新しい可変長整数エンコーディング仕様を確認する
2. `src/varint.ts` のエンコード・デコード関数を新仕様に書き換える
3. テストを新仕様に合わせて更新する
4. 全メッセージのエンコード・デコードテストを再実行して影響を確認する

## 解決方法

QUIC varint (2-bit prefix, 1/2/4/8 bytes) から MOQT varint (leading 1-bits count, 1/2/3/4/5/6/8/9 bytes) に書き換えた。1 バイトの範囲が 0-63 から 0-127 に拡大。最大値が 2^62-1 から 2^64-1 に拡大。0xFC/0xFD は無効なコードポイントとしてエラー処理。

変更ファイル:

- `src/varint.ts`: 完全書き換え
- `src/varint.test.ts`: 新エンコーディングに合わせてテスト更新
- `src/varint.prop.ts`: 新しい範囲閾値に合わせて PBT 更新
- `src/controlStream.test.ts`: 2 バイト varint のバイト列更新
