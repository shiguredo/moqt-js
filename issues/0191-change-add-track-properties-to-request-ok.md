# REQUEST_OK に Track Properties を追加する

Created: 2026-05-13
Model: Opus 4.7

## 概要

draft-18 で REQUEST_OK に Track Properties が追加された。
SUBSCRIBE / PUBLISH の OK 応答に Track Properties (Immutable Properties など) を載せて返せるようになり、
クライアントが track のメタ情報を OK 受信時点で確定できるようになる。
ワイヤーフォーマットの後方互換性がない。

## draft-18 参照

- draft-ietf-moq-transport-18 §10.5 REQUEST_OK
- draft-ietf-moq-transport-18 §2.5 Properties
- moq-wg/moq-transport#1576

## 影響範囲

- REQUEST_OK / SUBSCRIBE_OK のデコード
- Subscriber 側の Track Properties 取得タイミング
- Publisher 側の Track Properties 応答生成
- devtools / アプリケーション API
