# session.ts の ProtocolViolationError から SessionError への変換を toProtocolViolationSessionError に共通化する

- Priority: Low
- Created: 2026-06-05
- Completed: 2026-06-05
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

`src/session.ts` の 3 箇所にインライン展開された `if (err instanceof ProtocolViolationError) { this.closeWithError(new SessionError(err.message, SessionErrorCode.PROTOCOL_VIOLATION)); }` を、`#0298` で追加した pure function `toProtocolViolationSessionError` (`src/session/errors.ts`) の呼び出しに置き換えた。`toProtocolViolationSessionError` は既に import 済みのため import 追加は不要。

- 単純な 2 箇所: `const sessionError = toProtocolViolationSessionError(err); if (sessionError !== null) { this.closeWithError(sessionError); }`
- IncompleteDataError / INTERNAL_ERROR 分岐を伴う箇所: `sessionError !== null` で `closeWithError` + `break`、null なら従来通り INTERNAL_ERROR フォールバックに進む。`break` と順序を維持。
- `else if (err instanceof MalformedTrackError)` を伴う箇所: `MalformedTrackError` は `ProtocolViolationError` のサブクラスでないため、`toProtocolViolationSessionError(err) !== null` が `ProtocolViolationError` 専用判定として働き、else-if 分岐の意味は不変。

`toProtocolViolationSessionError` は `instanceof ProtocolViolationError` のとき `SessionError(err.message, PROTOCOL_VIOLATION)` を返し、それ以外は null を返すため、置き換えは挙動完全等価。3 箇所とも変数名を `sessionError` に統一した。

リファクタ後 `ProtocolViolationError` は `session.ts` のコードから消えた (コメントにのみ残る) ため、`../error` からの import を削除した。

### 検証

挙動を変えない純粋リファクタのため、既存の全テスト (670 passed) が変更なしで PASS することを確認した。`toProtocolViolationSessionError` 自体の pure function テストは `#0298` で `src/session/errors.test.ts` に追加済み。

### CHANGES.md

機能に直接影響しないリファクタリングのため `### misc` に `[UPDATE]` エントリを追記した。
