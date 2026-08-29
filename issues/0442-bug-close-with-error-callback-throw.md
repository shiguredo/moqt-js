# closeWithError が callbacks.error の throw で close() に到達せずセッションが開いたままになる

- Created: 2026-08-29
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-close-with-error-callback-throw
- Polished: {YYYY-MM-DD}

## 目的

`SessionImpl.closeWithError()` は「エラーを上位に通知し、セッションを閉じる」ことを仕様上の終了手順として保証すべきだが、アプリ登録の `callbacks.error` が throw すると後続の `close()` が実行されず、プロトコル違反を検出しながらセッションが開いたままになる。通知の成否に関わらず必ずセッションを閉じる構造にする。

## 現状

- `closeWithError()` (`src/session.ts`) は `this.callbacks.error?.(error); void this.close(error.code, error.message);` の順であり、try/finally でない。
- アプリの error コールバックが throw すると `close()` に到達せず、`sessionState` は connected のまま残る。違反通知そのものも上位で再処理されない。
- 実測 (0427 レビュー時のプローブ): Subgroup データストリームの PROTOCOL_VIOLATION 経路で error コールバックが throw すると、例外が `handleIncomingStream` の外側 catch に伝播して `INTERNAL_ERROR` に変換され再度 callbacks.error が呼ばれた後、セッションは connected のまま残る (最終通知は `SessionError(INTERNAL_ERROR)` になり本来の違反コードが失われる)。
- `closeWithError` の呼び出し元は多数 (スコープ違反・未知ストリーム種別・未完成 Object FIN 等) あり、いずれも同じ影響を受ける。

## 設計方針

- `closeWithError()` を `try { this.callbacks.error?.(error); } finally { void this.close(error.code, error.message); }` 構造に変更し、通知コールバックの throw に関わらず close を実行する。
- コールバック由来の throw をこれ以上広げないため、通知は握り潰さず `emitDebug` (DATA_STREAM_ERROR 相当) に記録する。throw 自体を無音にしない (`handleMalformedFetchTrack` の「アプリの error コールバックの throw は握り潰す」方針との整合は、通知が必須の closeWithError 側では記録を追加する、という差異で説明する)。
- `close()` 自体は既に完了済みチェック (sessionState === "closed" で即 return) を持つため、二重 close にはならない。
- 呼び出し元側の catch (外側 catch での INTERNAL_ERROR 化) は本変更で到達不能にならないケース (close 中の別例外など) に備えて維持する。

## 完了条件

- error コールバックが throw するセッション設定で PROTOCOL_VIOLATION 経路を駆動したとき、`sessionState` が closed になり、`close()` の終了処理 (pending reject / markClosed / transport.close) が実行されること (`src/session.test.ts` で検証する)。
- 通知が throw した事実はデバッグ記録に現れること。
- 正常系 (コールバックが throw しない) の通知・クローズ順は従来どおり (先に callbacks.error、後に close) であること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- draft-ietf-moq-transport-19 §3.5 (Session Termination)
- 関連: `issues/closed/0427-bug-data-stream-fin-incomplete-object.md`（同経路での顕在化を実測。参考所見として記録）

## 解決方法

未着手。
