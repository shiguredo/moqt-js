# review-diff-code で検出された不足テストを追加する

- Priority: Medium
- Created: 2026-06-03
- Model: deepseek-v4-pro
- Branch: feature/draft-18
- Polished: 2026-06-03

## 目的

以下 10 項目のテストが不足しているため追加する:

1. GOAWAY on control stream Request ID 欠落 → PROTOCOL_VIOLATION テスト
2. GOAWAY パリティ不一致 → INVALID_REQUEST_ID テスト
3. リクエストストリーム上重複 GOAWAY → PROTOCOL_VIOLATION テスト
4. PADDING stream/datagram 受信テスト
5. closedSubgroups 再送信拒否フローテスト
6. normalizeSessionErrorCode の使用テスト
7. REQUEST_ERROR with redirect の RequestError 構築テスト
8. publisher/subscriber closed 状態での GOAWAY コールバックテスト
9. 非最小エンコーディング varint の検出テスト
10. classifyIncomingStreamType の PADDING 種別テスト (0x132b3e28/0x132b3e29)

## 優先度根拠

draft-18 移行で追加された重要なセキュリティ・プロトコル検証ロジックのテストカバレッジが不足している。

## 設計方針

- 各不足テストを既存のテストファイルに追加する
- テストメッセージは全て日本語
- Vitest の test / assert を使用する

## 完了条件

- 上記 10 項目のテストが追加され全テストが PASS する
