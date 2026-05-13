# Subgroup Header の不正タイプ値の検証がない

Created: 2026-03-29
Model: Claude Opus 4.6

## 問題

`src/dataStream.ts` の `decodeSubgroupHeader()` で不正なタイプ値 (SUBGROUP_ID_MODE = 0b11 の 0x16, 0x17, 0x1E, 0x1F, 0x36, 0x37, 0x3E, 0x3F) を検証していない。

## 根拠

refs/moq/draft-ietf-moq-transport-17.txt Section 10.4.2 (line 4803-4809):

> Type values with SUBGROUP_ID_MODE set to 0b11: 0x16, 0x17, 0x1E,
> 0x1F, 0x36, 0x37, 0x3E, 0x3F. This mode is reserved for future
> use.
>
> Type values that do not match the form 0b00X1XXXX (i.e., Type
> values outside the ranges 0x10..0x1F and 0x30..0x3F, or values
> where bit 4 is not set).

## 該当箇所

- `src/dataStream.ts` `decodeSubgroupHeader()` (line 198-244)

## 期待される動作

不正なタイプ値を受信した場合、エラーを返すべき。

Completed: 2026-03-29

## 解決方法

decodeSubgroupHeader() に SUBGROUP_ID_MODE = 0b11 と 0b00X1XXXX 形式でないタイプ値の検証を追加した。
