# Session-Level Tracks 用の予約名前空間定数を追加する

- Priority: Medium
- Created: 2026-05-13
- Model: Opus 4.7
- Polished: 2026-06-02

## 目的

draft-18 §3.2.1 / §3.2.2 で session レベルの予約名前空間 (`.` プレフィクス) が定義された。
アプリケーションが誤って予約名前空間を使用するのを防ぐ。

## 優先度根拠

- 軽微な追加機能だが、予約名前空間の誤使用を防ぐ防御的実装として有用
- 新規定数とヘルパー関数の追加で実装コストは小さい

## 現状

予約名前空間のチェック機構は存在しない。ユーザーは任意の namespace 文字列を自由に使用できる。

draft-ietf-moq-transport-18 §3.2.1:
> MOQT reserves all Track Namespace values whose first tuple field
> begins with a period (0x2e, .).

draft-ietf-moq-transport-18 §3.2.2:
> MOQT defines the .session namespace ... in the first position of the
> Track Namespace for session-level tracks and namespaces.

## 設計方針

- `RESERVED_NAMESPACE_PREFIX = "."` 定数を定義
- `isReservedNamespace()`: 先頭タプルフィールドが `.` で始まるか判定
- `isSessionLevelNamespace()`: 先頭タプルフィールドが `.session` か判定
- publish / subscribe 時に予約プレフィクス使用を拒否または警告

## 完了条件

- `isReservedNamespace()` / `isSessionLevelNamespace()` が実装され単体テストが通る
- publish / subscribe 時に予約名前空間使用で適切なエラーが返る

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
