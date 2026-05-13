# Required Request ID を削除する

Created: 2026-05-13
Model: Opus 4.7

## 概要

draft-18 で SETUP の Required Request ID パラメータが削除された。
従来は次にどの Request ID を割り当てる必要があるかをセッション確立時に交渉していたが、
draft-18 ではこの仕組み自体が不要となった。
moqt-js 側の SETUP メッセージ生成・パース、および Request ID 割当ロジックを更新する。

## draft-18 参照

- draft-ietf-moq-transport-18 §10.1 Request ID
- draft-ietf-moq-transport-18 §10.3 SETUP
- moq-wg/moq-transport#1615

## 影響範囲

- SETUP / CLIENT_SETUP / SERVER_SETUP のパラメータ処理
- Request ID 割当の初期値設定
- セッション確立フローのテスト
