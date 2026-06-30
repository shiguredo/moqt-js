# Track Properties 内の未知 Mandatory Track Property (0x4000-0x7FFF) の処理が未実装

- Priority: High
- Created: 2026-06-30
- Completed:
- Model: Kimi Code CLI
- Branch: feature/fix-mandatory-track-properties-handling
- Polished:

## 目的

draft-18 §2.5.1 で定義された Mandatory Track Properties（Property Type 0x4000-0x7FFF）の処理規則を実装する。未知の Mandatory Track Property を含む Track を受信した場合、処理・転送してはならない（MUST NOT）。

## 優先度根拠

- draft-18 準拠の MUST 要件。
- 未知の Mandatory Track Property を無視すると、将来の拡張との相互運用で誤動作する。
- 過去 issue #0192 で対応済みとされているが、現在の `src/properties.ts` には Track Properties 用の拒否ロジックが残っていない。

## 現状

`src/properties.ts:decodeProperties()`（Track Properties 用）は未知の Property Type を単に `extensions` 配列に追加する。0x4000-0x7FFF 範囲の未知 Property を検出して拒否するロジックがない。

`src/properties.ts:parseProperties()`（Object Properties 用）では 0x4000-0x7FFF を `MalformedTrackError` で拒否しているが、これは Object Properties に対する正しい処理であり、Track Properties 用ではない。

`src/session.ts` の PUBLISH / SUBSCRIBE_OK / FETCH_OK 受信処理でも、Mandatory Track Property の有無を判定していない。

## 設計方針

- `decodeProperties()` 内で、未知の Property Type が 0x4000-0x7FFF 範囲にある場合、`MalformedTrackError` を throw する。
- `src/session.ts` の各受信処理で `MalformedTrackError` を catch し、仕様に応じた処理を行う:
  - PUBLISH 受信時: `REQUEST_ERROR(UNSUPPORTED_EXTENSION)` を返す。
  - SUBSCRIBE_OK / FETCH_OK 受信時: サブスクリプション/フェッチをキャンセルする。
- 既知の Track Property ID（`TrackPropertyId` / `MOQTPropertyId`）は受け入れる。

## 完了条件

- 未知の Mandatory Track Property（0x4000-0x7FFF）を含む Track Properties を受信した場合、トラックを処理・転送しない。
- PUBLISH 受信時は `REQUEST_ERROR(UNSUPPORTED_EXTENSION)` を返す。
- SUBSCRIBE_OK / FETCH_OK 受信時はサブスクリプション/フェッチをキャンセルする。
- 非 Mandatory 範囲（例: 0x3800）の未知 Property は従来通り unknown として保持される。

## 解決方法

1. `src/properties.ts` の `decodeProperties()` に 0x4000-0x7FFF 範囲の未知 Property 検出を追加する。
2. `src/session.ts` の PUBLISH / SUBSCRIBE_OK / FETCH_OK 受信処理で `MalformedTrackError` を catch して適切に応答する。
3. `src/properties.test.ts` / `src/session/bidi.test.ts` 等にテストを追加する。

## 該当箇所一覧

| ファイル | 変更内容 |
| --- | --- |
| `src/properties.ts` | `decodeProperties()` に Mandatory Track Property 範囲の検出を追加 |
| `src/session.ts` | PUBLISH / SUBSCRIBE_OK / FETCH_OK 受信時の拒否処理を追加 |
