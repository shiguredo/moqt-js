# SUBSCRIBE_NAMESPACE ストリームのクローズ semantics を明確化する

Created: 2026-05-13
Model: Opus 4.7

## 概要

draft-18 で SUBSCRIBE_NAMESPACE 応答ストリームのクローズ条件と
クローズ後の挙動 (announce の取り扱い、再開条件など) が明確化された。
moqt-js は SUBSCRIBE_NAMESPACE 応答ストリームの終了処理を仕様に合わせて整理する。

## draft-18 参照

- draft-ietf-moq-transport-18 §6.1 Subscribing to Namespaces
- draft-ietf-moq-transport-18 §10.18 SUBSCRIBE_NAMESPACE
- moq-wg/moq-transport#1541

## 影響範囲

- SUBSCRIBE_NAMESPACE 応答ストリームのクローズハンドリング
- NAMESPACE / NAMESPACE_DONE の処理順
