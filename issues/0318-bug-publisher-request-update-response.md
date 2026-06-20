# Publisher 側が REQUEST_UPDATE を受信しても応答しない

- Priority: High
- Created: 2026-06-17
- Model: Opus 4.8
- Branch: feature/fix-publisher-request-update-response
- Polished: 2026-06-20

## 目的

Publisher 側が `REQUEST_UPDATE` メッセージを受信した際に、`REQUEST_OK` または `REQUEST_ERROR` のいずれかを必ず返すように修正する。現在の `bidiReadRequestStreamMessages` の `REQUEST_UPDATE` ケースでは、FORWARD 状態の更新のみ行い応答メッセージを送信していない。合わせて `src/message/subscribe.ts` L222 の TODO コメントも削除する。

## 優先度根拠

draft-ietf-moq-transport-18 §10.9 では `REQUEST_UPDATE` の受信側は `REQUEST_OK` または `REQUEST_ERROR` を必ず返す MUST である。応答を返さないと、リクエスト側（`bidiSendRequestUpdate` で `pendingRequestUpdate` に登録された Promise）は永久に解決されずタイムアウトまで待ち続ける。プロトコル違反に相当するため High。

## 現状

`src/session/bidi.ts` L681-L693 において、`REQUEST_UPDATE` を受信した場合:

```typescript
case MessageType.REQUEST_UPDATE: {
  const decoded = decodeRequestUpdatePayload(msg.payload);
  const publisher = session.publishers.get(requestId);
  if (publisher) {
    const forwardState = extractForwardState(decoded.parameters);
    publisher.setForwardState(forwardState);
  }
  break; // ← 応答を送信していない
}
```

`bidiSendRequestUpdate`（L761-815）は `pendingRequestUpdate` に Promise を登録し、`REQUEST_OK`（`bidiHandleRequestUpdateOk` で resolve）または `REQUEST_ERROR`（L666-679 で reject）を待つ。しかし送信側は応答を送っていないため、この Promise は永久に解決されない。

## 仕様根拠

draft-ietf-moq-transport-18:

- **§10.9 (REQUEST_UPDATE)**: "The receiver of a REQUEST_UPDATE MUST respond with exactly one REQUEST_OK or REQUEST_ERROR message indicating if the update was successful."
- **§10.5 (REQUEST_OK)**: REQUEST_UPDATE_OK では Track Properties は空でなければならない (MUST)
- **§10.2.1 (Parameter Scope)**: 許可されたパラメータのみを受理する (MUST)
- **§10.9.1 (REQUEST_UPDATE_OK)**: REQUEST_UPDATE_OK には LARGEST_OBJECT パラメータが含まれうる。"The REQUEST_UPDATE_OK will include the LARGEST_OBJECT parameter, and the subscriber can issue a FETCH to retrieve the omitted Objects, if any." ただし本 issue が処理するのは publisher 側の FORWARD パラメータ更新であり、LARGEST_OBJECT は subscriber 側が自らの End Location 拡大時に必要とするパラメータのため、publisher 側応答では不要

## 設計方針

`bidiReadRequestStreamMessages` の `REQUEST_UPDATE` ケースで、状態更新後に対応する応答を同じ双方向ストリームへ送信する。

### 処理フロー

1. `decodeRequestUpdatePayload(msg.payload)` でデコードする
2. パラメータを `REQUEST_UPDATE_ALLOWED_PARAMS` （`parameterScope.ts` で定義済み）で検証する。許可外パラメータがあれば `validateParameterScope` が `closeWithError(PROTOCOL_VIOLATION)` を呼び `return` する:

```typescript
if (
  !validateParameterScope(decoded.parameters, REQUEST_UPDATE_ALLOWED_PARAMS, "REQUEST_UPDATE", (error) =>
    session.closeWithError(error),
  )
) {
  return;
}
```

3. `session.publishers.get(requestId)` で publisher を検索する:
   - 存在する: `extractForwardState(decoded.parameters)` で FORWARD パラメータを抽出し `publisher.setForwardState(forwardState)` で更新する。FORWARD 以外の許可パラメータ（AUTHORIZATION_TOKEN 等 7 種）は本 issue の範囲外として処理しない（検証は通過させるが無視する）
   - 存在しない: `REQUEST_ERROR` を送信する（詳細後述）
4. `encodeRequestOkPayload({ trackProperties: [] })` で `REQUEST_OK` ペイロードを構築する。`parameters` は空配列（FORWARD 更新の応答に LARGEST_OBJECT は不要）、Track Properties は空配列（§10.5 の MUST）
5. `session.controlWriter.encode(MessageType.REQUEST_OK, payload)` でフレーミングする
6. `await session.requestStreams.get(requestId)?.writer.write(message)` で同一の双方向ストリームに書き込む。writer は `bidiSendRequestOnBidiStream` で取得済みであり新たに `getWriter()` を呼ばない
7. `session.emitDebug("send", MessageType.REQUEST_OK, payload, decoded)` でデバッグ出力する

### publisher が存在しない場合の REQUEST_ERROR

```typescript
const errorPayload = encodeRequestErrorPayload({
  errorCode: normalizeRequestErrorCode(RequestErrorCode.INTERNAL_ERROR),
  retryInterval: 0n,
  reasonPhrase: "publisher not found for request update",
});
const errorMessage = session.controlWriter.encode(MessageType.REQUEST_ERROR, errorPayload);
await session.requestStreams.get(requestId)?.writer.write(errorMessage);
session.emitDebug("send", MessageType.REQUEST_ERROR, errorPayload, { errorCode: RequestErrorCode.INTERNAL_ERROR });
```

`INTERNAL_ERROR (0x0)` を使用する。`src/error.ts` の `normalizeRequestErrorCode` が未知コードを `INTERNAL_ERROR` に正規化する既存パターンと整合させる。`retryInterval` は 0n（再試行しない）、`reasonPhrase` は説明文、redirect は含めない。

### エラー条件と対応

| 条件 | 応答/処理 |
|------|-----------|
| publisher が存在しない | `REQUEST_ERROR` （`INTERNAL_ERROR` = 0x0）を送信する。セッションは閉じない |
| 許可外パラメータを含む | `PROTOCOL_VIOLATION` でセッションを閉じる |
| publisher が存在し正常に更新 | `REQUEST_OK` （空の parameters、空の trackProperties）を送信する |

### writer.write() のエラーハンドリング

`await writer.write()` は while ループ内で実行されるため、書き込み完了まで次の `reader.read()` がブロックされる。書き込み失敗時は `writer.write()` が throw するが、`bidiReadRequestStreamMessages` の catch ブロック（L744-750）がすべての例外を `toProtocolViolationSessionError` で処理するため、`ProtocolViolationError` 以外は無視される。writer write 失敗は一般的なネットワークエラーであり `ProtocolViolationError` ではないため、catch ブロックに到達してもセッションは閉じられず、`pendingRequestUpdate` Promise は未解決のまま残る。

この問題は既存の `PUBLISH_DONE` 等の writer write にも共通するため本 issue の範囲外とし、別 issue で対応する。

## 変更対象ファイル

- `src/session/bidi.ts`: `bidiReadRequestStreamMessages` の `case MessageType.REQUEST_UPDATE` ブロックを修正する
- `CHANGES.md` に `[FIX]` エントリを追記する
- `src/message/subscribe.ts` L222 の `TODO: Publisher として REQUEST_UPDATE を受信する処理の実装。` コメントを削除する（FORWARD 以外のパラメータ処理は別 issue に委ねるが、本 issue の修正により応答送信の枠組みが実装されるため、TODO の指摘内容は解消される）

## テスト方針

`src/session/bidi.test.ts` に以下を追加する（モック・スタブ禁止の方針に従い `BidiSessionInternal` のテスト実装を用いる）:

- publisher が存在し、正常に `REQUEST_OK` を送信するケース
- publisher が存在しない場合に `REQUEST_ERROR` （`INTERNAL_ERROR`）を送信するケース
- 許可外パラメータを含む `REQUEST_UPDATE` を受信した場合に `PROTOCOL_VIOLATION` で `closeWithError` が呼ばれるケース
- パラメータが空の `REQUEST_UPDATE` を受信し正常に処理するケース
- 複数回の `REQUEST_UPDATE` を逐次受信し、各応答が正しい順序で `pendingRequestUpdate` を解決するケース
- subscriber ストリームで `REQUEST_UPDATE` を受信した場合に `REQUEST_ERROR` が返るケース（`session.publishers` にエントリなし）

## 完了条件

- `REQUEST_UPDATE` 受信時に `REQUEST_OK` または `REQUEST_ERROR` のいずれかを必ず返す
- `bidiSendRequestUpdate` で登録された `pendingRequestUpdate` Promise が正しく resolve/reject される
- 正常系・異常系のテストが PASS する
- 既存の全テストが PASS する
- `CHANGES.md` に `[FIX]` エントリが追記される
