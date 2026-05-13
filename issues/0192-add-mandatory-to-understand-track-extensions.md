# Mandatory-to-Understand な track extension のサポートを追加する

Created: 2026-05-13
Model: Opus 4.7

## 概要

draft-18 で Track Extension (Properties / Parameters) に "mandatory-to-understand" の概念が追加された。
未知の mandatory-to-understand 拡張を受信した側はエラー応答 (request error) を返さなければならない。
moqt-js はこの判定ロジックを実装し、未知拡張を適切に拒否する必要がある。

## draft-18 参照

- draft-ietf-moq-transport-18 §4 Extensibility
- draft-ietf-moq-transport-18 §2.5 Properties
- moq-wg/moq-transport#1509

## 影響範囲

- Properties / Parameters のデコード時に mandatory ビットを判定
- 未知 mandatory 拡張に対するエラー応答パス
- 既存の未知 property / parameter ハンドリングの再点検
