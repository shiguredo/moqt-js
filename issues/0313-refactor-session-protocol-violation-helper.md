# session.ts の ProtocolViolationError から SessionError への変換を toProtocolViolationSessionError に共通化する

- Priority: Low
- Created: 2026-06-05
- Model: Opus 4.8
- Branch: feature/refactor-session-protocol-violation-helper
- Reporter: @voluntas

## 目的

`src/session.ts` の 3 箇所にインライン展開されている「`ProtocolViolationError` を `SessionError(PROTOCOL_VIOLATION)` に変換して `closeWithError` する」ロジックを、#0298 で追加した pure function `toProtocolViolationSessionError` に共通化する。

## 優先度根拠

機能的なバグではなく重複コードの解消 (DRY) であり、挙動は変わらない。#0298 で同一ロジックを pure function として抽出した際に「これら 3 箇所を揃える共通化は別 issue で検討する」とスコープ外宣言した follow-up。リファクタリングであり緊急性はないため Low。

## 現状

`src/session.ts` の 3 箇所が、`toProtocolViolationSessionError` の中身と同一のロジックをインライン展開している。

```typescript
// src/session.ts:3666-3668
if (err instanceof ProtocolViolationError) {
  this.closeWithError(new SessionError(err.message, SessionErrorCode.PROTOCOL_VIOLATION));
}
```

```typescript
// src/session.ts:3848-3854 (IncompleteDataError / INTERNAL_ERROR 分岐を伴う)
if (err instanceof ProtocolViolationError) {
  // 仕様違反: PROTOCOL_VIOLATION でセッションを閉じる
  this.closeWithError(new SessionError(err.message, SessionErrorCode.PROTOCOL_VIOLATION));
  break;
}
```

```typescript
// src/session.ts:3913 (3666 と同型)
if (err instanceof ProtocolViolationError) {
  // ...
}
```

`toProtocolViolationSessionError` (`src/session/errors.ts`、#0298 で追加) と合わせると同一ロジックが 4 重複 (pure function 1 + インライン 3) で存在する。

## 設計方針

3 箇所を `toProtocolViolationSessionError` の呼び出しに置き換える。

```typescript
// 単純なケース (3666 / 3913)
const sessionError = toProtocolViolationSessionError(err);
if (sessionError !== null) {
  this.closeWithError(sessionError);
}
```

```typescript
// 3848: IncompleteDataError 分岐と INTERNAL_ERROR フォールバックは維持する
const sessionError = toProtocolViolationSessionError(err);
if (sessionError !== null) {
  this.closeWithError(sessionError);
  break;
}
// 予期しないエラー: INTERNAL_ERROR でセッションを閉じる (既存のまま)
```

`src/session.ts` で `toProtocolViolationSessionError` を `./session/errors` から import する。置き換え後、不要になる `ProtocolViolationError` の import が残らないか確認する (他で使われていれば残す)。

挙動は完全に等価でなければならない。特に 3848 の `break` と INTERNAL_ERROR フォールバックの順序・条件を変えないこと。

## 完了条件

- `src/session.ts` の 3 箇所が `toProtocolViolationSessionError` を使うよう置き換えられている
- 挙動が変わっていない (既存の全テストが PASS する)
- インライン重複が解消されている
- `CHANGES.md` の `### misc` に `[UPDATE]` エントリを追記する (機能に直接影響しないリファクタリングのため)

## 解決方法

(対応時に記載する)
