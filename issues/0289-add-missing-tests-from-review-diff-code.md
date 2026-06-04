# review-diff-code で検出された不足テストを追加する

- Priority: Medium
- Created: 2026-06-03
- Model: deepseek-v4 Pro
- Branch: feature/add-missing-goaway-and-error-tests
- Polished: 2026-06-04

## 目的

draft-18 移行で追加された GOAWAY バリデーションとエラー処理経路のテストカバレッジが不足している。以下 4 項目のテストを追加する。

## 優先度根拠

- GOAWAY バリデーション（項目 1-3）はプロトコル違反検出のセキュリティ上重要なロジックだがテストがない
- #0257/#0259/#0273 の FIX で追加されたロジックに対するリグレッションテストが未実装

## テスト項目

### 1. GOAWAY on control stream: Request ID 欠落検出テスト

- **テスト対象**: `src/session.ts` の `handleGoaway` 内の `requestId === null` チェック（#0257 で追加）
- **方針**: `decodeGoawayPayload` に Request ID なしのペイロードを渡し、デコード結果の `requestId` が `null` であることを検証する純粋関数テスト。セッション側の PROTOCOL_VIOLATION 分岐は E2E テストの対象
- **追加先**: `src/message/session.prop.ts`

### 2. GOAWAY パリティ不一致検出テスト

- **テスト対象**: `src/session.ts` の `handleGoaway` 内のパリティチェック（#0273/#0286 で修正）
- **方針**: パリティチェックロジック（`requestId % 2n !== 0n` のチェック）を pure function に抽出して単体テストする。偶数（クライアント）/奇数（サーバー）の Request ID の正当性を検証する
- **追加先**: `src/message/session.prop.ts`

### 3. リクエストストリーム上重複 GOAWAY 検出テスト

- **テスト対象**: `src/session/bidi.ts` の `bidiReadRequestStreamMessages` 内の `goawayReceivedOnRequestStreams.has(requestId)` チェック（#0259 で追加）
- **方針**: `validateGoawayOnRequestStream` は既に pure function として `bidi.ts` に存在する。重複検出は Set のチェックであり、`BidiSessionInternal` テスト実装を使って `bidiReadRequestStreamMessages` 相当のロジックをテスト
- **追加先**: `src/session/bidi.test.ts`

### 4. REQUEST_ERROR with Redirect の RequestError 構築テスト

- **テスト対象**: `src/session/bidi.ts` の `bidiReadPublishResponse`/`bidiReadSubscribeResponse`/`bidiReadFetchResponse` 内の `RequestError` コンストラクタ呼び出し
- **方針**: `decodeRequestErrorPayload` で Redirect 付きペイロードをデコードし、その結果から `RequestError` が正しく構築されること（`error.redirect` フィールドが正しく設定されること）を検証する
- **追加先**: `src/session/bidi.test.ts`

## 本 issue の対象外（制約あり）

### closedSubgroups 再送信拒否テスト

- **テスト対象**: `src/session.ts` の `sendObject` 内の `closedSubgroups.has(...)` チェック（#0178 で追加）
- **理由**: フローテストが WebTransport 依存であり、モック禁止制約下で単体テスト不可能。`ClosedSubgroupError` の型テストは `error.test.ts` に既存。フローテストは E2E テストとして別途対応する

### publisher/subscriber closed 状態での GOAWAY コールバックテスト

- **テスト対象**: `src/session/bidi.ts` の `bidiReadRequestStreamMessages` 内の GOAWAY ハンドラ（line 694-704）
- **理由**: 現状のコードは state チェックなしで goawayCallback を呼んでおり、テスト追加前に「closed 状態で呼ぶべきか否か」の設計判断が必要。設計判断が未了のためテスト仕様を確定できない。別 issue で設計判断とテストを行う

## 削除した項目と理由

- **旧項目 4 (PADDING stream/datagram 受信テスト)**: #0236 で「テスト不要（PADDING 受信はデータ破棄のみで副作用がない）」と設計判断済み
- **旧項目 6 (normalizeSessionErrorCode)**: `src/error.test.ts` (line 92-111) に既に実装済み
- **旧項目 9 (非最小エンコーディング varint 検出)**: `decodeVarint` に非最小エンコーディング検出の実装が存在しない。テスト以前に機能実装が必要であり、別 issue で対応すべき
- **旧項目 10 (classifyIncomingStreamType PADDING 種別)**: `classifyIncomingStreamType` は先頭 1 バイト型の判定関数であり、PADDING (0x132b3e28) はマルチバイト型のため責務範囲外。既存 PBT で "unknown" として暗黙的にカバー済み

## 設計方針

- テストメッセージは全て日本語
- Vitest の test / assert を使用する
- モックやスタブは利用しない
- 純粋関数をテスト可能な場合はそちらを優先する
- WebTransport 依存のフローテストは E2E テスト（Playwright）の対象とし、本 issue では純粋関数レベルのテストを優先する
- 既存の `src/session/bidi.test.ts` の `BidiSessionInternal` テスト実装パターンを活用する

## 完了条件

- テスト項目 1〜4 のテストが追加されている
- 全テストが PASS する
- `CHANGES.md` に `[UPDATE]` エントリを追記する

## 備考

- CHANGES.md に「#0246-0271 の各 issue 実装に含めてテストを追加済み」(#0266) と記載されているが、実際には #0257/#0259/#0273 に対応するテストは不足している。本 issue はその残漏れを補完する
