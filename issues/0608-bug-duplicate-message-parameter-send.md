# 送信側で同一 Parameter Type の重複を拒否していない

- Created: 2026-09-15
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-duplicate-message-parameter-send
- Polished: {YYYY-MM-DD}

## 目的

draft-ietf-moq-transport-21 §9.20 は Senders MUST NOT repeat the same Parameter Type を定めるが、`encodeParameters` は Type 昇順のソートのみで重複を検査しない。raw パラメータと型付きオプションを併用すると同一 Type が 2 件載ったワイヤを生成し、仕様準拠のピアは PROTOCOL_VIOLATION でセッションを閉じる。

## 現状

- `encodeParameters` (`src/message/parameter/messageParameter.ts`) は同一 Type を許容してそのまま直列化する
- `bidiSendRequestUpdate` (`src/session/bidi.ts`) は FILL_PARAMETERS と NEW_GROUP_REQUEST に個別の重複ガードを持つが、FORWARD にはない
- 再現手順: `subscriber.update({ parameters: [{ type: 0x10, value: ... }], forward: true })` とすると、`assertParametersAllowedForSend` は FORWARD を許可し、型付き FORWARD がさらに push されるため 0x10 が 2 件載る
- 受信側の `decodeParameters` は重複を検出して PROTOCOL_VIOLATION にするため、送受信で非対称になっている

draft-ietf-moq-transport-21 §9.20:

> Senders MUST NOT repeat the same Parameter Type in a message unless the parameter definition explicitly allows multiple instances of that type to be sent in a single message.

## 設計方針

- `decodeParameters` の `isRepeatable` 判定 (AUTHORIZATION_TOKEN と Range Filter 0x25-0x29) と同一規則を共有し、`encodeParameters` で型ごとの出現回数を検査して重複を throw する
- 既存の個別ガード (FILL_PARAMETERS / NEW_GROUP_REQUEST) は共通検査へ統合する。統合せず二重検査として残す場合も、判定規則は 1 箇所に置く
- 反復が許可される Type の根拠は §8.9 (AUTHORIZATION TOKEN は Type と Value の組が一意なら反復可) と §3.3.2 (Range Filter は複数回出現可) に置く

## 完了条件

- raw と型付きの合算で同一 Type が 2 件以上になる REQUEST_UPDATE が送信前に拒否される
- AUTHORIZATION_TOKEN と Range Filter (0x25-0x29) は複数出現が引き続き許可される
- 他の制御メッセージでも同一規則が適用される
- テストがある
- `vp check` / `tsc --noEmit` / `vp test run` が通る

## 参照

- draft-ietf-moq-transport-21 §9.20 (Control Message Parameters)
- draft-ietf-moq-transport-21 §3.3.2 (Range Filters)
- draft-ietf-moq-transport-21 §8.9 (Authorization Token Compression)
