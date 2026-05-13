# Startup Latency と 0-RTT のガイダンスを改善する

Created: 2026-05-13
Model: Opus 4.7

## 概要

draft-18 で接続立ち上げ時のレイテンシ削減と 0-RTT 利用に関するガイダンスが拡充された。
moqt-js は WebTransport クライアントとして 0-RTT を利用する経路があるかを確認し、
ガイダンスに沿った接続シーケンスになっているか点検する。

## draft-18 参照

- draft-ietf-moq-transport-18 §3.3.1 0-RTT
- draft-ietf-moq-transport-18 §3.3 Session initialization
- moq-wg/moq-transport#1544

## 影響範囲

- Session 確立シーケンス
- ドキュメント (README / examples)
