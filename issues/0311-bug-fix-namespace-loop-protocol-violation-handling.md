# namespace / tracks / namespace-publication ストリームループの ProtocolViolationError 握り潰しを修正する

- Priority: High
- Created: 2026-06-05
- Model: Opus 4.8
- Branch: feature/fix-namespace-loop-protocol-violation-handling
- Reporter: @voluntas

## 目的

`src/session.ts` の namespace 系ストリーム受信ループ 3 種 (`startNamespaceStreamLoop` / `startTracksStreamLoop` / `startNamespacePublicationStreamLoop`) の catch が `ProtocolViolationError` を握り潰しており、仕様違反を検出してもセッションを `PROTOCOL_VIOLATION` で閉じない。これを #0298 (`bidiReadRequestStreamMessages` の同型修正) と同じ方針で修正する。

## 優先度根拠

draft-ietf-moq-transport-18 §3.5 は受信データの妥当性検証違反に対して "MUST close the session with a PROTOCOL_VIOLATION" を要求している。本 3 ループはいずれも `decodeRequestErrorPayload` を呼び、この関数は Redirect 後続データ・不正 Redirect に対して `ProtocolViolationError` を throw する (#0277 で追加)。しかし catch が `closeWithError` を呼ばないため、プロトコル違反を検出してもセッションが `connected` のまま残る。#0298 と同一の MUST 違反であり、不正なメッセージを送る peer に対して接続を維持し続けるためセキュリティ上も危険。よって High。

## 現状

3 ループの catch はいずれも、subscription / publication を `closed` にして error コールバックを呼び、Promise を reject するのみで、`session.closeWithError` を呼ばない。

```typescript
// src/session.ts:2024 (startNamespaceStreamLoop)
} catch (error) {
  if (subscription.state === "active") {
    subscription.state = "closed";
    const normalizedError = error instanceof Error ? error : new Error(String(error));
    if (!isSessionClosedError(normalizedError)) {
      callbacks.error?.(normalizedError);
    }
    if (!resolved) {
      reject(normalizedError);
    }
  }
} finally {
  // ...
}
```

`startTracksStreamLoop` (`src/session.ts:2189`)、`startNamespacePublicationStreamLoop` (`src/session.ts:2435`) も同型。

各ループが switch 内で呼ぶ `decodeRequestErrorPayload` の位置は次の通り。

- `startNamespaceStreamLoop`: `src/session.ts:1945`
- `startTracksStreamLoop`: `src/session.ts:2133`
- `startNamespacePublicationStreamLoop`: `src/session.ts:2383`

`decodeRequestErrorPayload` (`src/message/session.ts`) は Redirect の後続データや非 REDIRECT コードでの Redirect 存在に対して `ProtocolViolationError` を throw する (`src/message/session.ts:137` / `:395` / `:408`)。この throw が for/while を抜けて catch に入るが、catch は `closeWithError` を呼ばないため、セッションは閉じられない。

なお switch 内で直接 `closeWithError` を呼んでいるケース (未知メッセージ型、Track Properties 検証等) は正しくセッションを閉じる。問題は decode 関数が throw する例外経路のみ。

## 仕様根拠

draft-ietf-moq-transport-18:

- **§3.5 (Termination)**: "PROTOCOL_VIOLATION (0x3): The remote endpoint performed an action that was disallowed by the specification."
- 受信メッセージの妥当性検証違反に対する MUST 要件は本文の各所で "MUST close the session with a PROTOCOL_VIOLATION" と規定されており、moqt-js では各 decode 関数が `ProtocolViolationError` を throw することで表現されている。

参考 URL: https://www.ietf.org/archive/id/draft-ietf-moq-transport-18.html#section-3.5

## 設計方針

#0298 で `src/session/errors.ts` に追加した pure function `toProtocolViolationSessionError` を再利用する。3 ループの catch 冒頭で `toProtocolViolationSessionError(error)` を呼び、`null` でなければ `this.closeWithError` を呼ぶ。その後の subscription / publication クローズ・error コールバック・reject は既存動作を維持する。

```typescript
} catch (error) {
  // ProtocolViolationError は仕様違反のため PROTOCOL_VIOLATION でセッションを閉じる
  const sessionError = toProtocolViolationSessionError(error);
  if (sessionError !== null) {
    this.closeWithError(sessionError);
  }
  if (subscription.state === "active") {
    // 既存の subscription クローズ・error コールバック・reject
  }
}
```

`closeWithError` 後も subscription / publication のローカルクローズと Promise reject は必要 (ユーザーが await している可能性があるため)。`closeWithError` と reject の順序は既存テストと整合させること。

## 完了条件

- 3 ループ (`startNamespaceStreamLoop` / `startTracksStreamLoop` / `startNamespacePublicationStreamLoop`) の catch が `ProtocolViolationError` 検出時に `closeWithError(PROTOCOL_VIOLATION)` を呼ぶ
- `ProtocolViolationError` 以外のエラー (ストリーム終了・キャンセル等) は既存通り subscription / publication をローカルクローズして error コールバック・reject する
- 既存の全テストが PASS する
- `CHANGES.md` に `[FIX]` エントリを追記する

## 解決方法

(対応時に記載する)
