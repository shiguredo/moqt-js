# validateForwardValue / validateGroupOrderValue が受信経路で呼ばれていない

Created: 2026-05-02
Completed: 2026-05-03
Model: Opus 4.7

## 概要

`src/message/parameter.ts:137 / 151` に `validateGroupOrderValue` / `validateForwardValue` が定義されているが、

- `validateGroupOrderValue` の呼び出し箇所が `src/` 全体で 0 件 (定義とエクスポートのみ)
- `validateForwardValue` の呼び出し箇所は `src/session.ts:2766` の PUBLISH_OK ハンドラのみ

であり、それ以外の受信経路では FORWARD / GROUP_ORDER パラメータの値域 MUST 検証が行われていない。

## RFC 根拠

draft-ietf-moq-transport-17 §9.3.10 FORWARD Parameter (line 3052-3064):

> The FORWARD parameter (Parameter Type 0x10) is a uint8. It MAY appear in SUBSCRIBE, REQUEST_UPDATE (for a subscription), PUBLISH, PUBLISH_OK and SUBSCRIBE_NAMESPACE. It specifies the Forwarding State on affected subscriptions (see Section 5.1). The allowed values are 0 (don't forward) or 1 (forward). If an endpoint receives a value outside this range, it MUST close the session with PROTOCOL_VIOLATION.

draft-ietf-moq-transport-17 §9.3.6 GROUP ORDER Parameter (line 2985-2998):

> The GROUP_ORDER parameter (Parameter Type 0x22) is a uint8. It MAY appear in a SUBSCRIBE, PUBLISH_OK, or FETCH.
>
> Its value indicates how to prioritize Objects from different groups within the same subscription (see Section 7), or how to order Groups in a Fetch response (see Section 9.14.3). The allowed values are Ascending (0x1) or Descending (0x2). If an endpoint receives a value outside this range, it MUST close the session with PROTOCOL_VIOLATION.

両方とも「どこに現れても」MUST。

## 該当箇所

### FORWARD の検証漏れ

仕様上 FORWARD パラメータが現れうる場所:

- SUBSCRIBE
- PUBLISH
- SUBSCRIBE_NAMESPACE
- REQUEST_UPDATE
- PUBLISH_OK ← ここのみ検証あり (`session.ts:2766`)

`session.ts` の SUBSCRIBE 受信は実装スコープ外 (クライアント専用) だが、SUBSCRIBE_NAMESPACE で Publisher 側から FORWARD が含まれた PUBLISH を受信する経路では未検証。

### GROUP_ORDER の検証漏れ

- `validateGroupOrderValue` の grep 結果は定義行のみ
- GROUP_ORDER パラメータ (Message Parameter, 0x22) はクライアントが受信する SUBSCRIBE_OK / FETCH_OK / REQUEST_OK 等にも現れうるが、いずれも値検証なし
- Track Property の DEFAULT_PUBLISHER_GROUP_ORDER (Property 0x22) も検証なし — これは別 issue 0119 でカバー予定

## 期待される動作

- `decodeMessageParameter` (`parameter.ts:580-620` 付近) の uint8 ブランチに type ごとの値検証フックを差し込み、FORWARD / GROUP_ORDER については `validateForwardValue` / `validateGroupOrderValue` を呼ぶ
- もしくは各メッセージの decode 後に parameters を走査して該当 type を見つけ次第 validate する処理を制御メッセージ受信ループへ追加
- 検証失敗時は `ProtocolViolationError` を throw し、上位ハンドラで `closeWithError(SessionErrorCode.PROTOCOL_VIOLATION)` に翻訳する

## 優先度

重要。MUST 違反を検出しない。送受信どちらの方向でも 0/1 以外の不正値を黙って受け入れてしまうため、相互運用試験で容易に MUST 違反として検出される。

## 解決方法

期待される動作の選択肢のうち、`decodeMessageParameter` の uint8 ブランチに type ごとの validate を差し込む形で実装した。これにより全ての受信経路 (SUBSCRIBE / PUBLISH / SUBSCRIBE_NAMESPACE / REQUEST_UPDATE / PUBLISH_OK / SUBSCRIBE_OK / FETCH 等) で自動的に検証が行われる。

- `src/message/parameter.ts` の `validateForwardValue` / `validateGroupOrderValue` の throw 型を `Error` から `ProtocolViolationError` に変更する (上位制御メッセージループの既存 `ProtocolViolationError` catch 経路で `closeWithError(SessionErrorCode.PROTOCOL_VIOLATION)` に翻訳される)
- `src/message/parameter.ts` の `decodeMessageParameter` の `case "uint8"` ブロックで `paramType === 0x10` (FORWARD) なら `validateForwardValue(value[0])`、`paramType === 0x22` (GROUP_ORDER) なら `validateGroupOrderValue(value[0])` を呼ぶ
- `session.ts` 既存の PUBLISH_OK ハンドラ (`l.2766` 付近) の `validateForwardValue` 呼び出しは decodeMessageParameter で先に検証されるため重複だが防御的にそのまま残す
- 7 つの PBT (`namespace.prop.ts` / `parameter.prop.ts` / `session.prop.ts` / `trackstatus.prop.ts` / `publish.prop.ts` / `subscribe.prop.ts` / `fetch.prop.ts`) の `uint8ParameterArb` を type ごとに値域を絞る形に更新する:
  - FORWARD (0x10): `fc.constantFrom(0, 1)`
  - SUBSCRIBER_PRIORITY (0x20): `fc.integer({ min: 0, max: 255 })`
  - GROUP_ORDER (0x22): `fc.constantFrom(1, 2)`

### スコープ外

Track Property の DEFAULT_PUBLISHER_GROUP_ORDER (Property 0x22) の値域検証は #0119 で `validateTrackPropertyValue` として既にカバー済み。
