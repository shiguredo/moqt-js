# PADDING Stream (0x132B3E28) と PADDING Datagram (0x132B3E29) を認識し、データを破棄する対応を追加する

- Priority: Medium
- Created: 2026-06-03
- Model: deepseek-v4-pro
- Branch: feature/add-padding-stream-and-datagram-support
- Polished: 2026-06-03

## 目的

draft-ietf-moq-transport-18 §11.5 で定義されている PADDING Stream (Type 0x132B3E28) と PADDING Datagram (Type 0x132B3E29) を認識し、データを破棄する対応を追加する。現在は unknown 判定され、PROTOCOL_VIOLATION でセッションが閉じられる。

## 優先度根拠

§3.4 で「An endpoint that receives an unknown stream type MUST close the session」と規定されており、PADDING を受信するとセッションが異常終了する。ただしクライアント専用実装では PADDING の受信頻度は低く、実害は限定的なため Medium。

## 一次資料の引用

draft-ietf-moq-transport-18 §11.5 (Padding):

> MOQT provides two methods for adding additional bytes to a session for padding purposes: Padding Streams and Padding Datagrams.

draft-ietf-moq-transport-18 §11.5.1 (Padding Streams):

> A unidirectional stream of type 0x132B3E28 is a padding stream. The receiver MUST discard all data received on a padding stream.

draft-ietf-moq-transport-18 §11.5.2 (Padding Datagrams):

> A datagram of type 0x132B3E29 is a padding datagram. The receiver MUST discard the contents of a padding datagram.

## 現状

`src/dataStream.ts` に PADDING 関連の定数がない。

`src/session.ts` の `handleIncomingStream` が Type 0x132B3E28 を unknown 判定し、`PROTOCOL_VIOLATION` でセッションを閉じる。

`src/dataStream.ts` の `decodeObjectDatagram` が Datagram Type 0x132B3E29 を不正値として `ProtocolViolationError` をスローする。

## 設計方針

### 1. 定数定義

```typescript
export const PADDING_STREAM_TYPE = 0x132b3e28;
export const PADDING_DATAGRAM_TYPE = 0x132b3e29;
```

### 2. Stream 側の対応

`src/session.ts` の `handleIncomingStream` で `0x132B3E28` を認識し、ストリームのデータを全読みして破棄し、通常の処理フローに戻る。

### 3. Datagram 側の対応

`src/dataStream.ts` の `decodeObjectDatagram` または datagram 受信処理で `0x132B3E29` を認識し、データを破棄する。（`decodeObjectDatagram` の責務は Object Datagram のデコードであるため、上位の `handleIncomingDatagram` で事前に PADDING をフィルタリングする方式が望ましい）

## 影響範囲

- `src/dataStream.ts`: 定数を追加（または `src/message/types.ts`）
- `src/session.ts`: `handleIncomingStream` に PADDING stream の分岐を追加
- `src/session.ts`: `handleIncomingDatagram` に PADDING datagram の分岐を追加
- テスト: 不要（PADDING 受信はデータ破棄のみで副作用がない）

## 完了条件

- PADDING Stream (0x132B3E28) を受信しても PROTOCOL_VIOLATION が発生しない
- PADDING Datagram (0x132B3E29) を受信しても ProtocolViolationError が発生しない
- 受信した PADDING データは正しく破棄される
- `vp run test` 全パス
- `vp run build` 成功
