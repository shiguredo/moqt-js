# Session-Level Tracks 用の予約名前空間定数を追加する

Created: 2026-05-13
Model: Opus 4.7

## 概要

draft-18 で session レベルの予約名前空間 (Session-Level Tracks and Namespaces) が定義された。

> MOQT reserves all Track Namespace values whose first tuple field
> begins with a period (0x2e, .).
>
> -- draft-ietf-moq-transport-18 §3.2.1 (Reserved Namespaces)

> MOQT defines the .session namespace ... in the first position of the Track
> Namespace for session-level tracks and namespaces. Session-level
> tracks and namespaces are managed by the MOQT implementation, not the
> Application.
>
> -- draft-ietf-moq-transport-18 §3.2.2 (Session-Level Tracks and Namespaces)

moqt-js は予約名前空間を認識し、ユーザーが予約プレフィクスを使用した場合に
警告または拒否する。

## 変更内容

### 1. 予約名前空間プレフィクス定数を定義する (`src/message/parameter.ts`)

- `RESERVED_NAMESPACE_PREFIX = "."` 定数を追加する
- `isReservedNamespace(namespace: TrackNamespace): boolean` ヘルパーを新設する
  - 先頭タプルフィールドが `.` で始まるかどうかを判定する
- `isSessionLevelNamespace(namespace: TrackNamespace): boolean` ヘルパーを新設する
  - 先頭タプルフィールドが `.session` かどうかを判定する

### 2. namespace 使用時に予約チェックを追加する

- `createTrackNamespace()` で予約プレフィクスが使われた場合に警告を出す
- `Session.publish()` / `Session.subscribe()` で予約プレフィクスが使われた場合に
  許可するか拒否するかを判断する（クライアントは予約名前空間に publish すべきではない）

## 該当箇所

| ファイル                   | 変更内容                                           |
| -------------------------- | -------------------------------------------------- |
| `src/message/parameter.ts` | 予約名前空間定数とヘルパー関数を追加する           |
| `src/session.ts`           | publish / subscribe 時に予約名前空間チェックを追加 |

## テスト

- `isReservedNamespace()` / `isSessionLevelNamespace()` の単体テストを追加する
- `.session` 名前空間への publish / subscribe が拒否されることを確認する
