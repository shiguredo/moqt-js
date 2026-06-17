# Publisher 側が REQUEST_UPDATE を受信しても応答しない

- Priority: High
- Created: 2026-06-17
- Model: Opus 4.8
- Branch: feature/fix-publisher-request-update-response

## 目的

Publisher 側が `REQUEST_UPDATE` メッセージを受信した際に、`REQUEST_OK` または `REQUEST_ERROR` のいずれかを必ず返すように修正する。現在の `bidiReadRequestStreamMessages` の `REQUEST_UPDATE` ケースでは、転送状態 (`FORWARD`) の更新のみ行い、応答メッセージを送信していない。

## 優先度根拠

draft-ietf-moq-transport-18 §10.9 では `REQUEST_UPDATE` の受信側は `REQUEST_OK` または `REQUEST_ERROR` を必ず返す MUST である。応答を返さないと、リクエスト側はタイムアウトするまで待ち続け、セッション状態が不整合になりうる。プロトコル違反に相当するため High。

## 現状

`src/session/bidi.ts` L681-L693 において、`REQUEST_UPDATE` を受信した場合、対象 request または track 状態の更新のみ行っており、応答メッセージの送信処理が存在しない。

```typescript
// src/session/bidi.ts:681-693 (概略)
case MessageType.REQUEST_UPDATE:
  // FORWARD 状態の更新等
  // REQUEST_OK / REQUEST_ERROR を返していない
  break;
```

## 仕様根拠

draft-ietf-moq-transport-18:

- **§10.9 (REQUEST_UPDATE)**: `REQUEST_UPDATE` を受信したエンドポイントは、`REQUEST_OK` または `REQUEST_ERROR` のいずれかを必ず返さなければならない (MUST)。

## 設計方針

`bidiReadRequestStreamMessages` の `REQUEST_UPDATE` ケースで、状態更新後に対応する `REQUEST_OK` または `REQUEST_ERROR` を同じ双方向ストリームへ送信する。

- 正常時: `REQUEST_OK` を送信する。
- 異常時 (無効な update、存在しない request/track、範囲外の値等): `REQUEST_ERROR` を送信し、必要に応じてセッションを `PROTOCOL_VIOLATION` で閉じる。
- 応答送信は非同期だが、次のメッセージ読み取りとの競合を避けるため、writer の排他を適切に制御する。
- `REQUEST_UPDATE` が受信できない状態や、更新後の track 状態が無効な場合のエラーコードは draft の規定に従う。

## 完了条件

- `REQUEST_UPDATE` 受信時に `REQUEST_OK` または `REQUEST_ERROR` のいずれかを必ず返す
- 正常系・異常系の双方をカバーする単体テストを追加する
- 既存の全テストが PASS する
- `CHANGES.md` に `[FIX]` エントリを追記する
