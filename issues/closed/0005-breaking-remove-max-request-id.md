# MAX_REQUEST_ID/REQUESTS_BLOCKED の削除

## 概要

MAX_REQUEST_ID メッセージと REQUESTS_BLOCKED メッセージを削除する。

## 参照

- draft-ietf-moq-transport-17 Section 5
- https://github.com/moq-wg/moq-transport/pull/1471

## 変更内容

- draft-16 では MAX_REQUEST_ID で相手が使用可能な Request ID の上限を通知し、REQUESTS_BLOCKED でブロック状態を通知していた
- draft-17 ではリクエストが双方向ストリームに移動したため、QUIC のストリーム制御で代替される
- MAX_REQUEST_ID と REQUESTS_BLOCKED メッセージを削除する

## 影響範囲

- `src/message/session.ts`
- `src/message/types.ts`
- `src/session.ts`

## 実装方針

1. `src/message/types.ts` から MAX_REQUEST_ID, REQUESTS_BLOCKED のメッセージタイプを削除する
2. `src/message/session.ts` から対応するエンコード・デコード関数を削除する
3. `src/session.ts` から Request ID 管理ロジックを削除する
4. テストを更新する

## 解決方法

以下を削除:

- `MessageType` から `MAX_REQUEST_ID` (0x15) と `REQUESTS_BLOCKED` (0x1a)
- `SetupOptionType` から `MAX_REQUEST_ID` (0x02)
- `MaxRequestId`/`RequestsBlocked` インターフェースと encode/decode 関数
- `getSetupMaxRequestId` 関数
- `createClientSetup`/`createServerSetup` の `maxRequestId` オプション
- `session.ts` の `peerMaxRequestId` フィールドと関連ハンドラ
- 関連テスト
