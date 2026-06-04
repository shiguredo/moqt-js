# bidiReadRequestStreamMessages の ProtocolViolationError 握り潰しを修正する

- Priority: High
- Created: 2026-06-04
- Model: qwen3.7-plus
- Branch: feature/fix-bidi-protocol-violation-handling
- Polished: 2026-06-04

## 目的

リクエストストリームの受信ループ `bidiReadRequestStreamMessages` で `ProtocolViolationError` が発生した際に、セッションを `PROTOCOL_VIOLATION` で正しく終了させる。

## 優先度根拠

draft-ietf-moq-transport-18 §3.5 は PROTOCOL_VIOLATION (0x3) を "The remote endpoint performed an action that was disallowed by the specification" と定義し、本文中の多数の箇所で受信データの妥当性検証違反に対して "MUST close the session with a PROTOCOL_VIOLATION" を要求している。現状では受信ループの catch が全例外を握り潰すため、プロトコル違反を検出してもセッションが生き残り、MUST 要件に違反する。セキュリティ上も、不正なメッセージを送る peer に対して接続を維持し続けるのは危険。よって High。

## 現状

`src/session/bidi.ts:615` の `bidiReadRequestStreamMessages` は、リクエストストリーム上のメッセージを `switch (msg.type)` で処理する。各 case はペイロードのデコード関数を呼ぶ。

- `PUBLISH_DONE` -> `bidiHandlePublishDone` (`bidi.ts:936`) -> `decodePublishDonePayload`
- `REQUEST_ERROR` -> `decodeRequestErrorPayload`
- `REQUEST_UPDATE` -> `decodeRequestUpdatePayload`
- `GOAWAY` -> `decodeGoawayPayload`

これらのデコード関数は仕様違反入力に対して `ProtocolViolationError` を throw する。例えば `decodeGoawayPayload` (`src/message/session.ts:234`) は GOAWAY URI 長が上限超過の場合に `throw new ProtocolViolationError("GOAWAY URI length exceeds maximum: ...")` する。

しかし受信ループ末尾の catch が全例外を無条件で握り潰している。

```typescript
// src/session/bidi.ts:719-724
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

catch で例外を受け取り、`ProtocolViolationError` の場合のみ `session.closeWithError` で `PROTOCOL_VIOLATION` を発行する。それ以外の例外 (ストリームの正常終了・キャンセル等) は従来通り無視して既存動作を維持する。

```typescript
  } catch (error) {
    // ProtocolViolationError は仕様違反のため PROTOCOL_VIOLATION でセッションを閉じる
    if (error instanceof ProtocolViolationError) {
      session.closeWithError(
        new SessionError(error.message, SessionErrorCode.PROTOCOL_VIOLATION),
      );
    }
    // それ以外 (ストリーム閉じ等) は既存通り無視する
  } finally {
    reader.releaseLock();
    session.requestStreams.delete(requestId);
  }
```

`bidi.ts` は現状 `ProtocolViolationError` を import していないため、`src/error.ts` からの import を追加する (`SessionError` / `SessionErrorCode` は既に import 済み)。`handleIncomingDatagram` (`src/session.ts:3674-3677`) が同じ判定パターンを既に採用しており、それに揃える。

## 変更対象ファイル

- `src/session/bidi.ts`: `bidiReadRequestStreamMessages` の catch を修正し、`ProtocolViolationError` の import を追加する
- `CHANGES.md`: `[FIX]` エントリを追記する

## エッジケース

| ケース | 期待動作 |
| --- | --- |
| 上限超過の GOAWAY URI を持つメッセージを受信 (`decodeGoawayPayload` が throw) | セッションを `PROTOCOL_VIOLATION` で閉じる |
| 不正な REQUEST_ERROR / PUBLISH_DONE / REQUEST_UPDATE を受信 (各デコードが throw) | セッションを `PROTOCOL_VIOLATION` で閉じる |
| リクエストストリームが正常に閉じられた (`read()` が done) | ループを抜けるのみ。セッションは閉じない (既存動作) |
| ストリームが reset / cancel された (非 `ProtocolViolationError`) | 無視 (既存動作) |

## テスト方針

`src/session/bidi.test.ts` の `BidiSessionInternal` テストハーネス (`bidiReadRequestStreamMessages` 相当を駆動できる、#0289 でも活用予定) を用いて、リクエストストリームに上限超過 GOAWAY URI を持つ GOAWAY を流し込み、`session.closeWithError` が `PROTOCOL_VIOLATION` で呼ばれることを検証する。

非 `ProtocolViolationError` 経路 (正常クローズ) では `closeWithError` が呼ばれないことも併せて確認する。Vitest の test / assert を使用し、テストメッセージは日本語で書く。モックやスタブは利用しない。

## 後方互換の影響

- 受信時のエラーハンドリング強化のみで、公開 API に変更はない
- これまでプロトコル違反を検出してもセッションが残っていたのが、仕様通り `PROTOCOL_VIOLATION` で終了するようになる

## 完了条件

- リクエストストリーム上で `ProtocolViolationError` が発生した際にセッションが `PROTOCOL_VIOLATION` で閉じられる
- ストリームの正常終了・キャンセル等、`ProtocolViolationError` 以外のエラーは既存通り無視される
- `bidi.ts` に `ProtocolViolationError` の import が追加されている
- 上記テストが追加され、既存の全テストが PASS する
- `CHANGES.md` に `[FIX]` エントリを追記する
