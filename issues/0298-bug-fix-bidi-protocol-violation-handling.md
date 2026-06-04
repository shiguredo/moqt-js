# bidiReadRequestStreamMessages の ProtocolViolationError 握り潰しを修正する

- Priority: High
- Created: 2026-06-04
- Model: qwen3.7-plus
- Branch: feature/fix-bidi-protocol-violation-handling
- Polished: 2026-06-05

## 目的

リクエストストリームの受信ループ `bidiReadRequestStreamMessages` で `ProtocolViolationError` が発生した際に、セッションを `PROTOCOL_VIOLATION` で正しく終了させる。GOAWAY 群（#0289 / #0291 / #0298）一括見直しの一部であり、テストはアンチスタブ（pure function 単体テスト）方針で揃える。

## 優先度根拠

draft-ietf-moq-transport-18 §3.5 は PROTOCOL_VIOLATION (0x3) を "The remote endpoint performed an action that was disallowed by the specification" と定義し、本文中の多数の箇所で受信データの妥当性検証違反に対して "MUST close the session with a PROTOCOL_VIOLATION" を要求している。現状では受信ループの catch が全例外を握り潰すため、プロトコル違反を検出してもセッションが生き残り、MUST 要件に違反する。セキュリティ上も、不正なメッセージを送る peer に対して接続を維持し続けるのは危険。よって High。

## 現状

`src/session/bidi.ts` の `bidiReadRequestStreamMessages` は、リクエストストリーム上のメッセージを `switch (msg.type)` で処理する。各 case はペイロードのデコード関数を呼ぶ。

- `PUBLISH_DONE` -> `bidiHandlePublishDone` -> `decodePublishDonePayload`
- `REQUEST_ERROR` -> `decodeRequestErrorPayload`
- `REQUEST_UPDATE` -> `decodeRequestUpdatePayload`
- `GOAWAY` -> `decodeGoawayPayload`

これらのデコード関数は仕様違反入力に対して `ProtocolViolationError` を throw する。例えば `decodeGoawayPayload`（`src/message/session.ts`）は GOAWAY URI 長が上限超過の場合に `throw new ProtocolViolationError("GOAWAY URI length exceeds maximum: ...")` する。

しかし受信ループ末尾の catch が全例外を無条件で握り潰している。

```typescript
// src/session/bidi.ts の bidiReadRequestStreamMessages 末尾
  } catch {
    // ストリームが閉じられた場合は無視
  } finally {
    reader.releaseLock();
    session.requestStreams.delete(requestId);
  }
```

そのため、デコード関数が `ProtocolViolationError` を throw すると、ループを抜けて catch に入り、`session.closeWithError` は呼ばれずにストリームだけが静かに閉じられる。プロトコル違反が検出されてもセッションは `connected` のまま残る。

## 仕様根拠

draft-ietf-moq-transport-18:

- **§3.5 (Termination)**: "PROTOCOL_VIOLATION (0x3): The remote endpoint performed an action that was disallowed by the specification." セッション終了エラーコードは §15.10.1 (Session Termination Error Codes) に定義される。
- 受信メッセージの妥当性検証違反に対する MUST 要件の例: GOAWAY URI 長上限超過、Reason Phrase 長超過、Field Length 不正など本文の各所で "MUST close the session with a PROTOCOL_VIOLATION" と規定。これらは moqt-js では各デコード関数が `ProtocolViolationError` を throw することで表現されている。

参考 URL: https://www.ietf.org/archive/id/draft-ietf-moq-transport-18.html#section-3.5

## 設計方針

catch で例外を受け取り、`ProtocolViolationError` の場合のみ `session.closeWithError` で `PROTOCOL_VIOLATION` を発行する。それ以外の例外（ストリームの正常終了・キャンセル等）は従来通り無視して既存動作を維持する。

テスト可能化（モック禁止下でのアンチスタブ）のため、判定ロジックを pure function に抽出する。

```typescript
// src/session/errors.ts に追加（isSessionClosedError の先例に倣う pure function）
/**
 * ProtocolViolationError を PROTOCOL_VIOLATION の SessionError に変換する。
 * ProtocolViolationError 以外は null を返す（catch 側で無視させる）。
 */
export function toProtocolViolationSessionError(error: unknown): SessionError | null {
  if (error instanceof ProtocolViolationError) {
    return new SessionError(error.message, SessionErrorCode.PROTOCOL_VIOLATION);
  }
  return null;
}
```

`bidiReadRequestStreamMessages` の catch をこの関数で書き換える。

```typescript
  } catch (error) {
    // ProtocolViolationError は仕様違反のため PROTOCOL_VIOLATION でセッションを閉じる
    const sessionError = toProtocolViolationSessionError(error);
    if (sessionError !== null) {
      session.closeWithError(sessionError);
    }
    // それ以外（ストリーム閉じ等）は既存通り無視する
  } finally {
    reader.releaseLock();
    session.requestStreams.delete(requestId);
  }
```

`src/session/errors.ts` は `ProtocolViolationError` / `SessionError` / `SessionErrorCode` を `src/error.ts` から import する（必要なら追加する）。`bidi.ts` は `toProtocolViolationSessionError` を `src/session/errors.ts` から import する。

なお `src/session.ts` の `handleIncomingDatagram` 等 3 箇所（`err instanceof ProtocolViolationError` 判定）も同じパターンだが、本 issue のスコープは `bidiReadRequestStreamMessages` の catch に限定する。これら 3 箇所を `toProtocolViolationSessionError` に揃える共通化は別 issue で検討する（本 issue で抽出する関数を将来再利用できる形にしておく）。

## エッジケース

| ケース                                                                             | 期待動作                                            |
| ---------------------------------------------------------------------------------- | --------------------------------------------------- |
| 上限超過の GOAWAY URI を持つメッセージを受信 (`decodeGoawayPayload` が throw)      | セッションを `PROTOCOL_VIOLATION` で閉じる          |
| 不正な Redirect を持つ REQUEST_ERROR を受信 (`decodeRequestErrorPayload` が throw) | セッションを `PROTOCOL_VIOLATION` で閉じる          |
| リクエストストリームが正常に閉じられた (`read()` が done)                          | ループを抜けるのみ。セッションは閉じない (既存動作) |
| ストリームが reset / cancel された (非 `ProtocolViolationError`)                   | 無視 (既存動作)                                     |

注: 現状 `bidiReadRequestStreamMessages` の各 case のデコード関数のうち `ProtocolViolationError` を throw するのは `decodeGoawayPayload`（GOAWAY URI 長超過）と `decodeRequestErrorPayload`（Redirect 後続データ・不正 Redirect）のみである。`decodePublishDonePayload` は Reason Phrase 長超過時にプレーンな `Error` を throw しており（仕様上は PROTOCOL_VIOLATION 相当だが、本修正の `ProtocolViolationError` 判定では捕捉されず握り潰されたままになる）、`decodeRequestUpdatePayload` は throw しない。`decodePublishDonePayload` のエラークラスを `ProtocolViolationError` に是正するのは別 issue で扱う（本 issue のスコープ外）。

## テスト方針

pure function `toProtocolViolationSessionError` を `src/session/errors.test.ts` で単体テストする。`as unknown as BidiSessionInternal` 等のスタブは使わず、本物の値を渡す（GOAWAY 群一括見直しのアンチスタブ方針）。

- `ProtocolViolationError` を渡すと、`code` が `SessionErrorCode.PROTOCOL_VIOLATION`、`message` が元の `ProtocolViolationError.message` と一致する `SessionError` が返る
- `ProtocolViolationError` 以外（通常の `Error`、`DOMException` 相当のオブジェクト、`undefined` 等）を渡すと `null` が返る

`bidiReadRequestStreamMessages` 本体（WebTransport ストリーム依存の非同期ループ）の動作確認は E2E の対象とし、本 issue では pure function 単体テストに留める。Vitest の `test` / `assert`（`vite-plus/test`）を使用し、テストメッセージは日本語で書く。

## 後方互換の影響

- 受信時のエラーハンドリング強化のみで、公開 API に変更はない
- これまでプロトコル違反を検出してもセッションが残っていたのが、仕様通り `PROTOCOL_VIOLATION` で終了するようになる

## 完了条件

- `toProtocolViolationSessionError`（`src/session/errors.ts`、export）が追加されている
- `bidiReadRequestStreamMessages` の catch が `toProtocolViolationSessionError` を使い、`ProtocolViolationError` 発生時にセッションが `PROTOCOL_VIOLATION` で閉じられる
- ストリームの正常終了・キャンセル等、`ProtocolViolationError` 以外のエラーは既存通り無視される
- `src/session/errors.test.ts` に `toProtocolViolationSessionError` の単体テスト（スタブ不使用）が追加され、既存の全テストが PASS する
- `CHANGES.md` に `[FIX]` エントリを追記する
