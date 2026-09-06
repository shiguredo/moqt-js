# message 層の Length 宣言に対する境界検証欠落

- Created: 2026-09-06
- Completed: YYYY-MM-DD
- Branch: feature/fix-message-slice-boundary
- Polished: YYYY-MM-DD

## 目的

宣言 Length が残りバイトを超える場合に短い `slice` を検出せず、後段の別エラーとして報告される。原因特定のため宣言時点で検証する必要がある。

## 現状

- `src/message/parameter.ts` / `session.ts` / `subscribe.ts` / `publish.ts` / `fetch.ts` / `src/properties.ts` の複数デコーダが `slice` 後の長さ検査を持たない。
- 最終的に `PROTOCOL_VIOLATION` で閉じる点では事故にならないが、`truncated` を別原因として報告しうる。
- `decodeLocationFilter` / `decodeRangeFilter` / `decodeMessageParameter` の一部は正しく境界検証しており不整合である。

## 設計方針

1. `slice` 後に宣言長との一致を検証し、不一致は `ProtocolViolationError` とする。
2. 既存の正しい箇所のパターンに揃える。

## 完了条件

- 切り詰め入力のエラー報告が原因を正しく示すこと。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。
