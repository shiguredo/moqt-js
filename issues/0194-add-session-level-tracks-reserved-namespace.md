# Session-Level Tracks 用の予約名前空間を追加する

Created: 2026-05-13
Model: Opus 4.7

## 概要

draft-18 で session レベルの予約名前空間 (Session-Level Tracks and Namespaces) が定義された。
セッション固有のメタデータや制御用 track をやり取りするための名前空間プレフィクスが
予約される。
moqt-js は予約名前空間を namespace 衝突回避のため認識し、
内部利用または受信時の特別扱いを実装する必要がある。

## draft-18 参照

- draft-ietf-moq-transport-18 §3.2.1 Reserved Namespaces
- draft-ietf-moq-transport-18 §3.2.2 Session-Level Tracks and Namespaces
- moq-wg/moq-transport#1562

## 影響範囲

- 予約名前空間の定数定義
- namespace 検証ロジック
- ドキュメント
