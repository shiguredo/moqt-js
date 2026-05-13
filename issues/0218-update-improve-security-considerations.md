# Security Considerations 節を改善する

Created: 2026-05-13
Model: Opus 4.7

## 概要

draft-18 で Security Considerations 節が拡充された。
moqt-js は AUTHORIZATION TOKEN まわりの取り扱い、リレー信頼境界、
namespace の権限確認など、仕様の新ガイダンスに照らして実装を点検する。

## draft-18 参照

- draft-ietf-moq-transport-18 §14 (推定) Security Considerations
- moq-wg/moq-transport#1625

## 影響範囲

- AUTHORIZATION TOKEN 処理 (0099 で実装済み)
- ドキュメント
