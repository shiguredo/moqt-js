# Padding ストリームと Padding データグラムを追加する

- Priority: Medium

Created: 2026-05-13
Model: Opus 4.7

- Polished: 2026-06-02

## 概要

draft-18 で帯域確保や greasing のための Padding ストリームと Padding データグラムが追加された。
受信側は Padding を識別して破棄する必要がある。
moqt-js は受信時に Padding type を黙ってドロップする処理を追加する。

## RFC 参照

draft-ietf-moq-transport-18 §11.5 (Padding):

> An endpoint MAY send padding on unidirectional streams or datagrams.
> Padding does not carry Objects or any other application data. An
> endpoint can use padding to probe for additional bandwidth while
> minimizing the impact on the delivery of application data.

draft-ietf-moq-transport-18 §11.5.1 (Padding Streams):

> An endpoint MAY open a unidirectional stream with a stream type of
> 0x132B3E28 to send padding data.

draft-ietf-moq-transport-18 §11.5.2 (Padding Datagrams):

> An endpoint MAY send a datagram with a type of 0x132B3E29 to send
> padding data.

draft-ietf-moq-transport-18 A.1: "Add padding streams and datagrams (#1475)"

## 変更内容

1. `src/dataStream.ts` に `PADDING_STREAM_TYPE = 0x132B3E28` と `PADDING_DATAGRAM_TYPE = 0x132B3E29` の定数を追加する
2. `src/session.ts` の `startIncomingStreamLoop` で受信ストリームの先頭 type が 0x132B3E28 の場合、ストリームを読み捨てる処理を追加する
3. `src/session.ts` の `startDatagramLoop` で受信データグラムの先頭 type が 0x132B3E29 の場合、データグラムを読み捨てる処理を追加する
4. `src/controlStream.ts` の `classifyIncomingStreamType` に PADDING ストリームの分類を追加する

## 該当ファイル

| ファイル                | 行番号                       | 変更内容                                                                                 |
| ----------------------- | ---------------------------- | ---------------------------------------------------------------------------------------- |
| `src/dataStream.ts`     | (全般)                       | `PADDING_STREAM_TYPE = 0x132B3E28` / `PADDING_DATAGRAM_TYPE = 0x132B3E29` 定数を追加する |
| `src/session.ts`        | `startIncomingStreamLoop`    | ストリーム type が 0x132B3E28 の場合に読み捨てる処理を追加する                           |
| `src/session.ts`        | `startDatagramLoop`          | データグラム type が 0x132B3E29 の場合に読み捨てる処理を追加する                         |
| `src/session/stream.ts` | `classifyIncomingStreamType` | PADDING ストリーム (0x132B3E28) の分類を追加する                                         |

## 期待される動作

1. 受信した単方向ストリームの先頭 type が 0x132B3E28 (PADDING_STREAM) の場合、ストリームの全データを読み捨てる
2. 受信したデータグラムの先頭 type が 0x132B3E29 (PADDING_DATAGRAM) の場合、データグラムを破棄する
3. Padding の受信はエラーにならず、PROTOCOL_VIOLATION でセッションを閉じない
4. Publisher 側で Padding の送信は当面実装しない (将来的な拡張の余地を残す)

## テスト方針

- `src/dataStream.test.ts` に `PADDING_STREAM_TYPE` / `PADDING_DATAGRAM_TYPE` 定数の値が正しいことのテストを追加する
- `src/session.prop.ts` の `classifyIncomingStreamType` PBT に PADDING ストリームの分類を追加する

## 影響範囲

- 実装変更あり
- 後方互換あり (Padding は未知ストリームとして扱われて PROTOCOL_VIOLATION になる問題を解消する)
- `CHANGES.md` に [ADD] エントリを追加する

## 解決方法

本 issue は dataStream.ts の大規模なワイヤーフォーマット変更を伴うため、別途専用の実装セッションで対応する。draft-18 準拠に必要な変更として認識済み。
