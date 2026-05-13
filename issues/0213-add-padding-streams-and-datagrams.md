# Padding ストリームと Padding データグラムを追加する

Created: 2026-05-13
Model: Opus 4.7

## 概要

draft-18 で帯域確保や greasing のための Padding ストリームと Padding データグラムが追加された。
受信側は Padding を識別して破棄する必要がある。
moqt-js は Padding type を受信時に黙ってドロップする処理を実装する。
送信側 (Publisher) は当面送出しない方針として良いが、type 定数の予約は必要。

## draft-18 参照

- draft-ietf-moq-transport-18 §11.5 Padding
- draft-ietf-moq-transport-18 §11.5.1 Padding Streams
- draft-ietf-moq-transport-18 §11.5.2 Padding Datagrams
- moq-wg/moq-transport#1475

## 影響範囲

- データストリーム / データグラム受信時の type 判定
- 未知 type を PROTOCOL_VIOLATION で閉じる既存処理 (0051) との整合性確認
