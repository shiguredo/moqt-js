# 非 Normal Status のオブジェクトにペイロードがある場合の検証がない

Created: 2026-03-29
Model: Claude Opus 4.6

## 問題

`src/dataStream.ts` で Object Status が Normal (0x0) 以外のオブジェクトに空でないペイロードがある場合の検証がない。Subgroup ストリームでは Object Status は payload length = 0 の場合にのみデコードされるため問題ないが、Fetch ストリームでの検証が必要。

## 根拠

refs/moq/draft-ietf-moq-transport-17.txt Section 10.2.1.1:

> Any object with a status code other than zero MUST have an empty
> payload.

## 期待される動作

非 Normal Status のオブジェクトにペイロードがある場合、エラーを返すべき。
