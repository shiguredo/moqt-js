# Object の存在性と複数ソース間の矛盾を明確化する

Created: 2026-05-13
Model: Opus 4.7

## 概要

draft-18 で「Object が存在する」と判定される条件、および複数の relay / publisher 間で
Object の状態に矛盾がある場合の取り扱いが明確化された。
moqt-js は Object の存在判定や重複検出を仕様に合わせて確認する。

## draft-18 参照

- draft-ietf-moq-transport-18 §2.1 Objects
- draft-ietf-moq-transport-18 §9 Relays
- moq-wg/moq-transport#1566

## 影響範囲

- Object キャッシュ / TrackCache の存在判定
- Object Status ハンドリング
- ドキュメント
