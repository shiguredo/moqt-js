# 7 バイト varint と非最小エンコーディングを許可する

Created: 2026-05-13
Model: Opus 4.7

## 概要

draft-17 では 7 バイト長 (0xFC, 0xFD) が不正なコードポイントだったが、draft-18 で
7 バイト長 (1111110, 49 usable bits) が有効な長さとして追加され、
さらに非最小エンコーディング (値の表現に必要な最小バイト数を超える長いエンコード) も
許容されることが明示された。

moqt-js の varint デコーダは現在 0xFC / 0xFD を `ProtocolViolationError` として拒否している。
これを 7 バイト長として受理するよう変更し、非最小エンコーディングでもエラーにしない必要がある。

## RFC 参照

draft-ietf-moq-transport-18 §1.4.1 (Variable-Length Integers):

> | 1111110 | 7 | 49 | 0-562949953421311 |

draft-ietf-moq-transport-18 §1.4.1:

> Variable length integers do not need to be encoded using the minimum
> number of bytes; any encoding length that can represent the value is
> valid.

draft-ietf-moq-transport-18 A.1: (7 バイト varint の最上位ビット検証緩和に含まれる)

## 変更内容

1. `src/varint.ts` の `varintSize` に 7 バイトのしきい値 `THRESHOLD_7BYTE = 562949953421311n` を追加する
2. `src/varint.ts` の `encodeVarint` に 7 バイトのエンコード分岐を追加する (1111110, 49 usable bits)
3. `src/varint.ts` の `decodeVarint` で 0xFC (11111100) と 0xFD (11111101) を不正コードポイントではなく有効な 7 バイト長として扱うように変更する
4. `src/varint.ts` のコメント表に 7 バイト行を追加する

## 該当ファイル

| ファイル | 行番号 | 変更内容 |
| --- | --- | --- |
| `src/varint.ts` | 10-20 | エンコード表に 7 バイト行を追加する (1111110, 7, 49, 0-562949953421311) |
| `src/varint.ts` | 27-34 | `THRESHOLD_7BYTE` 定数を追加し `varintSize` の分岐に 7 バイトを追加する |
| `src/varint.ts` | 70-136 | `encodeVarint` に 7 バイトのエンコード分岐を追加する |
| `src/varint.ts` | 182-188 | 0xFC / 0xFD を有効な 7 バイト長として処理する (ProtocolViolationError を削除) |
| `src/varint.test.ts` | (全般) | 7 バイト長と非最小エンコーディングのテストを追加する |
| `src/varint.prop.ts` | (全般) | 7 バイトを含む値域のラウンドトリップ PBT を更新する |

## 期待される動作

1. 7 バイト varint (0xFC / 0xFD で始まる) を正しくデコードできる
2. 非最小エンコーディング (例: 値 37 を 0x8025 の 2 バイトで表現) をエラーにしない
3. エンコーダは 7 バイト長が必要な値 (34359738368 〜 562949953421311) を正しくエンコードする
4. 0xFC / 0xFD で始まるバイト列は ProtocolViolationError ではなく正規の varint デコードとして処理される

## テスト方針

- `src/varint.test.ts` に以下を追加する:
  - 7 バイト長の最小値/最大値のエンコード/デコードテスト
  - 非最小エンコーディングの許容テスト (例: 37 を 0x8025 でデコードできること)
  - 0xFC / 0xFD のデコード成功テスト
  - 7 バイト最大値 (562949953421311) のラウンドトリップテスト
- `src/varint.prop.ts` の値域を 7 バイトまで拡張し、非最小エンコーディングも生成できるようにする

## 影響範囲

- 実装変更あり
- 後方互換あり (0xFC / 0xFD を拒否していたのを受容するようになるのは前方互換の改善)
- エンコーダは最小エンコードを維持する (非最小エンコードの送信はしない方針)
