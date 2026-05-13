# 未知の単方向ストリームタイプの検証がない

Created: 2026-03-29
Model: Claude Opus 4.6

## 問題

`src/session.ts` の `handleIncomingStream()` で FetchHeaderType (0x05) 以外のストリームタイプをすべて Subgroup ストリームと仮定して処理しており、未知のストリームタイプの検証がない。

## 根拠

refs/moq/draft-ietf-moq-transport-17.txt Section 3.2:

> An endpoint that receives an unknown stream type MUST close the
> session.

## 該当箇所

- `src/session.ts` `handleIncomingStream()` (line 3110-3132)

## 期待される動作

受信したストリームタイプが FetchHeaderType (0x05) でも有効な Subgroup Header タイプ (0x10-0x1F, 0x30-0x3F) でもない場合、セッションを閉じるべき。

Completed: 2026-03-29

## 解決方法

handleIncomingStream() でストリームタイプが FetchHeaderType (0x05) でも有効な Subgroup Header (0x10-0x1F, 0x30-0x3F) でもない場合に PROTOCOL_VIOLATION でセッションを閉じるようにした。
