# Mandatory-to-Understand な Property/Parameter を拒否する

- Priority: High
- Created: 2026-05-13
- Model: Opus 4.7
- Polished: 2026-06-02

## 目的

draft-18 §2.5.1 で Mandatory Track Properties の処理規則が明確化された。未知の Mandatory Track Property (Property Type 0x4000-0x7FFF) を受信した場合、トラックを処理・転送してはならない。

draft-ietf-moq-transport-18 §2.5.1:

> When an endpoint receives Track Properties (in PUBLISH, SUBSCRIBE_OK,
> or FETCH_OK messages) containing a Mandatory Track Property type that
> it does not understand, it MUST NOT process or forward that track.

## 優先度根拠

- draft-18 準拠の MUST 要件
- 未知の Mandatory Property を無視し続けるとプロトコル違反になる

## 現状

`src/properties.ts:472-595` の `decodeProperties` は未知の Property Type を `unknownProperties` 配列に保持するが、
Mandatory Track Property 範囲 (0x4000-0x7FFF) かどうかの判定と拒否ロジックは実装されていない。

`src/properties.ts:93` に範囲のコメントはあるが、判定ロジックはない。
既知の Property Type は `MOQTPropertyId` / `TrackPropertyId` に定義されているが、
これらと受信 Property の突合による unknown 判定がない。

## 設計方針

- `decodeProperties` 内で、未知の Property Type が Mandatory Track Property 範囲 (0x4000-0x7FFF) にあるか判定する
- Mandatory Track Property かつ未知の場合、`MalformedTrackError` または `REQUEST_ERROR(UNSUPPORTED_EXTENSION)` で拒否する
- 呼び出し元（session.ts の PUBLISH/SUBSCRIBE_OK/FETCH_OK 受信処理）で適切なエラーハンドリングを行う
- 既知の Property Type リスト: `MOQTPropertyId` (0x00-0xFF), `TrackPropertyId` (0x0B-0x30)
- 空き範囲 (0x08-0x0A, 0x0C-0x0D, 0x0F-0x21 等) の Property も未知として扱うが、Mandatory 範囲外なので `unknownProperties` に残すだけ

## 完了条件

- 未知の Mandatory Track Property (0x4000-0x7FFF 範囲) 受信時に `MalformedTrackError` が throw される
- 未知の非 Mandatory Property は従来通り `unknownProperties` に保持される
- PUBLISH / SUBSCRIBE_OK / FETCH_OK 受信時の拒否フローが正しく動作する

## 変更内容

### 1. Mandatory Track Property の検出と拒否 (`src/properties.ts`)

- `decodeProperties` 内の unknown Property 処理で Property ID が 0x4000-0x7FFF 範囲か判定
- 範囲内の unknown Property は `MalformedTrackError` を throw
- 既知 Property のリスト（`KNOWN_TRACK_PROPERTY_IDS` 等）を定義し突合ロジックを実装

### 2. PUBLISH / SUBSCRIBE_OK / FETCH_OK 受信時の拒否処理 (`src/session.ts`)

- `MalformedTrackError` を catch して `REQUEST_ERROR(UNSUPPORTED_EXTENSION)` で応答する
- または `ProtocolViolationError` に変換してセッションを閉じる（MUST NOT process の解釈次第）

## 該当箇所一覧

| ファイル            | 変更内容                                                           |
| ------------------- | ------------------------------------------------------------------ |
| `src/properties.ts` | Mandatory Track Property 範囲 (0x4000-0x7FFF) の検出と拒否ロジック |
| `src/session.ts`    | PUBLISH / SUBSCRIBE_OK / FETCH_OK 受信時の error handling 更新     |
| `src/error.ts`      | UNSUPPORTED_EXTENSION (0x33) の追加 (0186 と連携)                  |

## テスト方針

- 未知 Property Type (0x4000) 受信時に `MalformedTrackError` が throw されることを検証
- 未知 Property Type (0x3800: 非 Mandatory 範囲) は `unknownProperties` に保持されることを検証
- `properties.test.ts` に両方のテストを追加

## 影響範囲

- `decodeProperties` の振る舞いが変わる（未知 Mandatory Property でエラー、破壊的変更）
- PUBLISH / SUBSCRIBE_OK / FETCH_OK の受信処理にエラーケースが追加される
