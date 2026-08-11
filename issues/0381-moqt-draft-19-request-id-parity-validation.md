# 受信 Request ID のパリティ・重複検証が未実装

- Priority: Low
- Created: 2026-08-06
- Completed: {YYYY-MM-DD}
- Model: DeepSeek V4 Flash
- Branch: feature/fix-moqt-draft-19-request-id-parity-validation
- Polished: {YYYY-MM-DD}

## 目的

draft-ietf-moq-transport-19 §10.1 の「If an endpoint receives a Request ID where the least significant bit is incorrect for the sender, or a duplicate Request ID, it MUST close the session with INVALID_REQUEST_ID.」を満たす。現在はクライアントが偶数 Request ID を生成するのみで、受信側のパリティ検証と重複検証がない。

## 優先度根拠

INVALID_REQUEST_ID (0x4) は `src/error.ts:22` に定義済みだが受信時検証が未実装。クライアントは SUBSCRIBE_TRACKS 経由の受信 PUBLISH の Request ID (サーバー発のため奇数) を受け取るため、パリティ検証の実装が必要。Low。

## 現状

- クライアントの送信側は `nextRequestId = 0n` から 2 ずつ増分 (`src/session.ts:986, 1451-1453` 等) し、偶数 Request ID を生成する。
- 受信側 (`src/session.ts:3300-3360` の `handleIncomingBidirectionalStream` 等) に Request ID のパリティチェックがない。
- 重複 Request ID の検証も受信パスにない。

## 設計方針

- 受信した Request ID の LSB が送信者 (サーバー) の期待値 (奇数) と一致するかを検証し、不一致時は INVALID_REQUEST_ID でセッションを閉じる。
- 受信 Request ID の重複を検出し、同様に INVALID_REQUEST_ID でセッションを閉じる。
- エラーコード `INVALID_REQUEST_ID` は定義済みのため、検証の追加のみ。

## 完了条件

- LSB が期待値と一致しない Request ID を受信した場合に INVALID_REQUEST_ID でセッションが閉じること。
- 重複 Request ID を受信した場合に INVALID_REQUEST_ID でセッションが閉じること。
- 上記を検証するテストがあること。
- `CHANGES.md` の `## develop` に `[FIX]` があること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- draft-ietf-moq-transport-19 §10.1 (Request ID)

## 注記 (0371 実装時)

- 0371 (未対応リクエストの NOT_SUPPORTED 応答) 実装後は、受信 bidi ストリームの先頭が分類 2 (未対応の 6 種: SUBSCRIBE / FETCH / TRACK_STATUS / PUBLISH_NAMESPACE / SUBSCRIBE_NAMESPACE / SUBSCRIBE_TRACKS) の場合にペイロードをデコードしないため、本 issue のパリティ・重複検証は受信 PUBLISH (分類 1) のみに適用される。完了条件の「LSB が期待値と一致しない Request ID を受信した場合に INVALID_REQUEST_ID でセッションが閉じること」「重複 Request ID を受信した場合に INVALID_REQUEST_ID でセッションが閉じること」は 6 種では発火しないため、検証対象を受信 PUBLISH のみとする注記と完了条件の調整が必要。分類 2 の 6 種では §10.1 の MUST (INVALID_REQUEST_ID) が未達のまま残る (残余リスク)。
- 0371 の実装で session.ts の `handleIncomingBidirectionalStream` の構造が変更され行がドリフトしたため、`src/session.ts:3300-3360` の行番号参照をシンボル名に書き換えること。

## 注記 (0373 実装時)

- 0373 (受信 PUBLISH ストリーム上の REQUEST_UPDATE 誤検知) の実装で、受信 PUBLISH ストリーム上の REQUEST_UPDATE の Request ID を `bidiHandlePublishRequestUpdate` (`src/session/bidi.ts`) 内で `decodeRequestUpdatePayload` により読み取るが、パリティ・重複検証は行わない。本 issue の検証対象 (受信側 Request ID のパリティ・重複検証) に受信 REQUEST_UPDATE の Request ID を含めるか否かを、本 issue の実装時に確定して完了条件を調整すること。

## 解決方法

未着手。
