# closeWithError が callbacks.error の throw で close() に到達せずセッションが開いたままになる

- Created: 2026-08-29
- Updated: 2026-09-05
- Completed: 2026-09-05
- Branch: feature/fix-close-with-error-callback-throw
- Polished: 2026-09-05

## 目的

`SessionImpl.closeWithError()` は「エラーを上位に通知し、セッションを閉じる」ことを仕様上の終了手順として保証すべきだが、アプリ登録の `callbacks.error` が throw すると後続の `close()` が実行されず、プロトコル違反を検出しながらセッションが開いたままになる。通知の成否に関わらず必ずセッションを閉じる構造にする。

## 現状

- `closeWithError()` (`src/session.ts`) は `this.callbacks.error?.(error); void this.close(error.code, error.message);` の順であり、try/finally でない。
- アプリの error コールバックが throw すると `close()` に到達せず、`sessionState` は connected のまま残る。
- 実測 (0427 レビュー時のプローブ、error コールバックが毎回 throw する設定): Subgroup データストリームの PROTOCOL_VIOLATION 経路で error コールバックが throw すると、例外が `handleIncomingStream` の内側 catch に伝播して `INTERNAL_ERROR` に変換され再度 `closeWithError` が呼ばれ、2 回目の通知も throw するためセッションは connected のまま残る (本来の違反コードが失われる)。
- `closeWithError` の呼び出し元は多数 (スコープ違反・未知ストリーム種別・未完成 Object FIN 等) あり、いずれも同じ影響を受ける。

## 設計方針

- `closeWithError()` を `try { this.callbacks.error?.(error); } catch (callbackError) { /* 記録のみ */ } finally { void this.close(error.code, error.message); }` 構造に変更し、通知コールバックの throw に関わらず close を実行する。throw は再 throw せず swallow する（再 throw すると呼び出し元 catch に再流入し二重通知・`INTERNAL_ERROR` 化を招くため）。
- コールバック由来の throw は握り潰さずデバッグ記録に残す。データストリーム経路では `emitDataStreamErrorDebug` 相当 (`typeName: "DATA_STREAM_ERROR"` の直構築、`closeWithError` は Fetch ヘッダを持たないため `fetchHeader=null` で記録) とし、制御ストリーム等その他の経路では既存の分類（`emitDebug` 系の使い分け）に従う。セッションレベルの `callbacks.error` 呼び出しで throw を吸収する先例は `runPublishStreamSubLoop` や GOAWAY コールバック側にあり、同方針に揃える。
- `close()` 自体は既に完了済みチェック (sessionState === "closed" で即 return) を持つため、二重 close にはならない。
- 呼び出し元側の catch (内側 catch での INTERNAL_ERROR 化) は本変更で到達不能にならないケース (close 中の別例外など) に備えて維持する。

## 完了条件

- error コールバックが毎回 throw するセッション設定で Subgroup 未完成 FIN の PROTOCOL_VIOLATION 経路を駆動したとき、`sessionState` が closed になり、`close()` の終了処理（対応する pending の reject と `markClosed`、`transport.close` の呼び出しをスパイ可能な構成で確認）が実行されること (`src/session.test.ts` で検証する)。
- 通知が throw した事実はデバッグ記録に現れること。
- 正常系 (コールバックが throw しない) の通知・クローズ順は従来どおり (先に callbacks.error、後に close) であること。
- `CHANGES.md` の `## develop` に `[FIX]` があること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- draft-ietf-moq-transport-20 §3.5 (Termination、終了手順の一般的根拠)
- draft-ietf-moq-transport-20 §11.4 (Streams、FIN 時の未完成 Object は PROTOCOL_VIOLATION SHOULD。代表経路の発生側要件)
- 関連: `issues/closed/0427-bug-data-stream-fin-incomplete-object.md`（同経路での顕在化を実測。参考所見として記録）

## 解決方法

- `closeWithError()` を try/catch/finally 構造に変更し、通知コールバックの throw に関わらず `close()` を実行するようにした。throw は再 throw せず、デバッグ記録 (`emitDataStreamErrorDebug` 相当) に残す。記録自体の throw にも内側 try/catch で備えた。
- テストは `src/session.test.ts` に 3 件追加した (throw 時の close 完遂・二重 throw 時の非伝播・正常時の順序)。
- 触ったファイル: `src/session.ts`、`src/session.test.ts`、`CHANGES.md`。
