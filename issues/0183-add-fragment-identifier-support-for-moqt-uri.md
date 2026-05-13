# moqt URI に Fragment Identifier サポートを追加する

Created: 2026-05-13
Model: Opus 4.7

## 概要

draft-18 で moqt URI に Fragment Identifier (`#fragment`) のサポートが追加された。
特定のリソース (track / namespace / object 範囲など) を URI で直接参照可能になる。
moqt-js は URL を受け取って `Session` を開設するが、fragment 部分の取り扱いを
仕様に合わせて定義する必要がある。

## draft-18 参照

- draft-ietf-moq-transport-18 §3.1.2 Fragment Identifiers
- moq-wg/moq-transport#1571

## 影響範囲

- `Session` 接続時の URL 解析
- fragment から導出される subscribe / fetch パラメータの自動設定
- ドキュメント
