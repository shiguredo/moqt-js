# 制御ストリーム close 時に PROTOCOL_VIOLATION を発生させていない

Created: 2026-03-29
Model: Opus 4.6

## 概要

制御ストリームがセッション中に閉じられた場合、PROTOCOL_VIOLATION エラーでセッションを終了すべきだが、現在の実装ではループを抜けるだけでエラーを発生させていない。

## RFC 根拠

draft-ietf-moq-transport-17 Section 3.3 Session initialization:

> A control stream MUST NOT be closed at the underlying transport layer during the session's lifetime. Doing so results in the session being closed as a PROTOCOL_VIOLATION.

draft-ietf-moq-transport-17 Section 3.5 Termination:

> PROTOCOL_VIOLATION (0x3): The remote endpoint performed an action that was disallowed by the specification.

## 該当箇所

- `src/session.ts` 行 2624-2648: `startControlMessageLoop()` で `done` が `true` になった場合にループを抜けるだけ

## 修正方針

制御ストリームの `done` 検出時に `SessionErrorCode.PROTOCOL_VIOLATION` でセッションを終了する処理を追加する。
