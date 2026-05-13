# moqt:// URI スキームを QUIC / WebTransport で統一する

Created: 2026-05-13
Model: Opus 4.7

## 概要

draft-18 で `moq://` (Native QUIC) と `https://` (WebTransport) の使い分けが廃止され、
両者共通の `moqt://` URI スキームに統一される。
moqt-js は WebTransport クライアントのみだが、接続 URL のパース・正規化・検証ロジックを
新スキームに合わせて更新する必要がある。

## draft-18 参照

- draft-ietf-moq-transport-18 §3.1.1 MOQT URI Scheme
- draft-ietf-moq-transport-18 §3.1.3 WebTransport
- draft-ietf-moq-transport-18 §3.1.5 Connection URL
- moq-wg/moq-transport#1486

## 影響範囲

- `Session` 開設時の URL パラメータ仕様
- 既存サンプル / devtools の接続先入力 UI
- ドキュメント (README / examples)
