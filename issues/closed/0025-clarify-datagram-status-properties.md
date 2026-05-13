# Datagram の status と properties ケース明確化

## 概要

Datagram における status フィールドと properties の扱いを明確化する。

## 参照

- draft-ietf-moq-transport-17 Section 10.2
- https://github.com/moq-wg/moq-transport/pull/1444

## 変更内容

- draft-17 で Datagram で送信する場合の status と properties の各ケースが明確化された
- Datagram 固有の制約と処理方法が定義された

## 影響範囲

- `src/dataStream.ts`

## 実装方針

1. draft-17 Section 10.2 の Datagram 仕様を確認する
2. Datagram での status と properties の処理を仕様に沿って実装する
3. テストを追加する

## 解決方法

Datagram の status type と payload type の区別、Extensions の有無、Priority の有無、Object ID の有無は `dataStream.ts` の DatagramType で全パターン (0x00-0x0F, 0x20-0x2D) 対応済み。Non-Normal status + extensions のプロトコル違反チェックも実装済み。コード変更不要。
