# KEY_VALUE_FORMATTING_ERROR でセッションを閉じる経路を実装する

- Created: 2026-09-09
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-key-value-formatting-error-session-close
- Polished: {YYYY-MM-DD}

## 目的

draft-ietf-moq-transport-21 §8.3 は、既知 Type の Value 不一致を KEY_VALUE_FORMATTING_ERROR でセッションを閉じる MUST を定める。issue 0558 の適合監査 (改善-1) で `src/properties.ts` は `SessionError(KEY_VALUE_FORMATTING_ERROR)` を送出するようになったが、受信ループの変換が `SessionError` を扱わないためセッションが閉じられない。

## 現状

- `src/session/errors.ts` の `toProtocolViolationSessionError` は `ProtocolViolationError` / `IncompleteDataError` のみを `PROTOCOL_VIOLATION` に変換し、`SessionError` は null を返す (既存テストで保証)。
- `src/properties.ts` の `decodeKnownPropertyVarint` 等が送出する `SessionError(KEY_VALUE_FORMATTING_ERROR)` が受信ループの catch でセッションクローズに伝播しない。

## 設計方針

1. `SessionError` を保持したままセッションクローズへ伝播する専用の経路を追加する (既存の `toProtocolViolationSessionError` の意味は変えない)。
2. 受信ループの catch で `SessionError` を検出したらそのコードで `closeWithError` する。
3. 既存テストの期待 (SessionError → null) を壊さない。

## 完了条件

- 既知 Type の Value 不一致で KEY_VALUE_FORMATTING_ERROR によりセッションが閉じる。
- `vp check` / `tsc --noEmit` / `vp test run` が通る。

## 参照

- `refs/moq/draft-ietf-moq-transport-21.txt` §8.3
- 監査: issue 0558 の適合監査 (改善-1)
