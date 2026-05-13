# REQUEST_OK の Request Type 別 textual alias を定義する

Created: 2026-05-13
Model: Opus 4.7

## 概要

draft-18 で REQUEST_OK に対し、リクエスト種別ごとの textual alias
(SUBSCRIBE_OK / FETCH_OK / PUBLISH_OK 相当) が定義された。
ワイヤー上は同じ REQUEST_OK だが、ログ / デバッグ表示・型レベルで分かりやすくなる。
moqt-js は受信時の alias 解決と devtools 表示を仕様用語に揃える。

## draft-18 参照

- draft-ietf-moq-transport-18 §10.5 REQUEST_OK
- moq-wg/moq-transport#1610

## 影響範囲

- メッセージ表示名 / ログ
- devtools の表示
- 型定義 (TypeScript 側の alias 化)
