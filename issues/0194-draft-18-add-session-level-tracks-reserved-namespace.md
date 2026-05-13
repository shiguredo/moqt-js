# Session-Level Tracks 用の予約名前空間定数を追加する

Created: 2026-05-13
Model: Opus 4.7

## 概要

draft-18 で session レベルの予約名前空間 (Session-Level Tracks and Namespaces) が定義された。

> MOQT reserves all Track Namespace values whose first tuple field
> starts with the ASCII characters "moq-" (case-sensitive) as
> Session-Level Tracks and Namespaces.
>
> -- draft-ietf-moq-transport-18 §3.2.1

> Reserved Namespaces can be used to define session control tracks that
> carry metadata, configuration, or other session-level information
> between endpoints.
>
> -- draft-ietf-moq-transport-18 §3.2.2

moqt-js は予約名前空間を認識し、ユーザーが予約プレフィクスを使用した場合に
警告または拒否する。

## 変更内容

### 1. 予約名前空間プレフィクス定数を定義する (`src/message/parameter.ts`)

- `RESERVED_NAMESPACE_PREFIX = "moq-"` 定数を追加する
- `isReservedNamespace(namespace: TrackNamespace): boolean` ヘルパーを新設する
  - 先頭タプルフィールドが `moq-` で始まるかどうかを case-sensitive で判定する

### 2. namespace 使用時に予約チェックを追加する

- `createTrackNamespace()` で予約プレフィクスが使われた場合に警告を出す
- `Session.publish()` / `Session.subscribe()` で予約プレフィクスが使われた場合に
  許可するか拒否するかを判断する（クライアントは予約名前空間に publish すべきではない）

## 該当箇所

| ファイル | 変更内容 |
|---|---|
| `src/message/parameter.ts` | `RESERVED_NAMESPACE_PREFIX` 定数と `isReservedNamespace()` ヘルパーを追加する |
| `src/session.ts` (publish/subscribe) | 予約名前空間使用時の警告を追加する |

## テスト方針

- `src/message/parameter.test.ts`: `isReservedNamespace()` の単体テストを追加する
  - `"moq-"` で始まるフィールドが予約判定されること
  - 異なる大文字/小文字が予約判定されないこと (case-sensitive)
  - 通常の namespace が予約判定されないこと

## 影響範囲

- 新規定数とヘルパー関数の追加（後方互換あり）
- 既存の namespace 使用に影響なし
