# 公開エンコーダが仕様違反のワイヤを生成しうる

- Created: 2026-09-15
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-encoder-wire-validation
- Polished: {YYYY-MM-DD}

## 目的

公開エクスポートされたエンコーダが、仕様が PROTOCOL_VIOLATION の対象とするワイヤを生成できる。生成したワイヤは moqt-js 自身のデコーダも拒否するため、テストや relay 実装から使うと相互運用が破綻する。デコーダ側の検証は実装済みで、エンコーダ側だけが非対称になっている。

## 現状

- `encodeObjectDatagram` (`src/dataStream/datagram.ts`) は PROPERTIES ビットが立っているのに Properties Length 0 を書きうる (`datagram.properties?.length ?? 0`)。§11.2.1 はこの組み合わせを受信時に PROTOCOL_VIOLATION とする
- `encodeObjectDatagram` と `encodeSubgroupHeader` (`src/dataStream/subgroup.ts`) は Type Flags の妥当性を検証せず、呼び出し側が渡した値をそのまま書く。§11.2.1 と §11.3.1 は不正な Type Flags を列挙し、受信時に PROTOCOL_VIOLATION とする
- `encodeTrackNamespace` (`src/message/parameter/trackNamespace.ts`) は合計 4,096 バイトのみ検査し、フィールド長 0 と 32 フィールド超を検査しない。§8.7 はフィールドが少なくとも 1 バイトであることを MUST とし、32 フィールド超を受信時に PROTOCOL_VIOLATION とする
- `encodeRequestErrorPayload` (`src/message/session.ts`) は Error Code が REDIRECT 以外でも Redirect 構造を付加しうる。§9.4.1 は Redirect を REDIRECT のときのみと定める
- 内部送信経路 (`sendDatagram` / `sendObject` / `bidiSendRequestError`) は防御しているため、公開エクスポート経由の誤用が対象になる

draft-ietf-moq-transport-21 §11.2.1:

> If an endpoint receives a datagram with the PROPERTIES bit set and an Properties Length of 0, it MUST close the session with a PROTOCOL_VIOLATION.

## 設計方針

- 各エンコーダの入口でデコーダと同じ妥当性検証を行い throw する。判定関数はデコーダ側と共有し、規則を二重管理しない
- `encodeTrackNamespace` の検証は `createTrackNamespace` と共通化する
- 生成結果が正当な入力に対して変わらないことを確認する

## 完了条件

- PROPERTIES ビット + Properties Length 0 の Object Datagram が生成前に拒否される
- 不正な Type Flags の Object Datagram / Subgroup Header が生成前に拒否される
- フィールド長 0 または 32 フィールド超の Track Namespace が生成前に拒否される
- REDIRECT 以外の Error Code に Redirect を付けた REQUEST_ERROR が生成前に拒否される
- 正当な入力のエンコード結果が変わらない
- 各検証のテストがある
- `vp check` / `tsc --noEmit` / `vp test run` が通る

## 参照

- draft-ietf-moq-transport-21 §8.7 (Track Namespace Structure)
- draft-ietf-moq-transport-21 §9.4.1 (Redirect Structure)
- draft-ietf-moq-transport-21 §11.2.1 (Object Datagram)
- draft-ietf-moq-transport-21 §11.3.1 (Subgroup Header)
