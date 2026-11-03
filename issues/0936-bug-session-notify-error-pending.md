# sessionNotifyErrorIfActive が Session を閉じるだけで保留中のリクエストを reject しない

- Created: 2026-11-03
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-session-notify-error-pending
- Polished: {YYYY-MM-DD}

## 目的

`src/session/lifecycle.ts` の `sessionNotifyErrorIfActive` は、Session を閉じるエラーを検出すると `sessionState` を `"closed"` にするだけで、`sessionRejectPendingRequests` を呼ばない。以降の `sessionClose` は `sessionState === "closed"` で早期 return するため、保留中のリクエスト (publish / subscribe / fetch / publishNamespace など) の Promise は `transport.closed` が解決するまで settle しない。WebTransport の実装では `transport.closed` が解決する想定だが、ライブラリとして「Session が閉じたら未確立の待ちは settle する」契約を保証できていない。

## 現状

- `src/session/lifecycle.ts` の `sessionNotifyErrorIfActive` は `session.sessionState !== "connected"` または `isSessionClosedError(error)` のとき状態を `"closed"` にするだけで返る
- `sessionClose` は `sessionState === "closed"` のとき早期 return するため、`sessionRejectPendingRequests` が呼ばれない
- 制御ストリーム / データストリームのループから `sessionNotifyErrorIfActive` が呼ばれる経路がある
- 0890 で publishNamespace の送信待ちの reject を追加したが、この経路では `pendingNamespacePublication` も reject されない

## 設計方針

`sessionNotifyErrorIfActive` が Session を `"closed"` にするとき、`sessionRejectPendingRequests` も呼ぶ。ただし、`isSessionClosedError` (ピア起点の正常終了) では reject の理由を「セッション終了」として扱い、エラー通知は行わない。状態遷移と reject を 1 箇所にまとめ、`sessionClose` との二重実行を避ける (Promise の settle は 1 回だけなので二重 reject は no-op になるが、意図を明確にする)。

## 完了条件

- Session を閉じるエラーを `sessionNotifyErrorIfActive` が処理したとき、保留中のリクエストの Promise が settle する
- `sessionClose` を経由した場合と通知理由が矛盾しない
- テストで固定する (保留中の `publishNamespace` / `publish` / `subscribe` など)
- `vp check` と `vp test --run` が通る

`CHANGES.md` は MOQT RFC ドラフト中のため更新しない (`CODEBASE.md` の特別ルール)。

## 参照

- `src/session/lifecycle.ts` の `sessionNotifyErrorIfActive` / `sessionClose` / `sessionRejectPendingRequests`
- `src/session/incomingPublish.ts` と `src/session/dataStreamIncoming.ts` の `sessionNotifyErrorIfActive` 呼び出し
- `src/session/errors.ts` の `isSessionClosedError`
- draft-ietf-moq-transport-22 §6.6
