# REQUEST_OK の Request Type 別 textual alias を定義する

Created: 2026-05-13
Model: Opus 4.7

## 概要

draft-18 で REQUEST_OK に対し、リクエスト種別ごとの textual alias
(SUBSCRIBE_OK, FETCH_OK, TRACK_STATUS_OK, PUBLISH_NAMESPACE_OK,
SUBSCRIBE_NAMESPACE_OK, REQUEST_UPDATE_OK) が定義された。
ワイヤー上は同じ REQUEST_OK だが、ログ・デバッグ表示で分かりやすくなる。

moqt-js は既に `getMessageTypeName` で各メッセージタイプの表示名を定義しており、
また `readSubscribeResponse` / `readFetchResponse` 等でリクエスト種別に応じた
処理を行っている。`getMessageTypeName` にエイリアスを追加し、
ログ出力のメッセージ型名を更新する。

## RFC 参照

draft-ietf-moq-transport-18 §10.5 (REQUEST_OK):

> This document uses the shorthand PUBLISH_OK, REQUEST_UPDATE_OK,
> TRACK_STATUS_OK, SUBSCRIBE_NAMESPACE_OK, and PUBLISH_NAMESPACE_OK to
> refer to REQUEST_OK messages on the response stream of each request type.

draft-ietf-moq-transport-18 A.1: "Define textual aliases for REQUEST_OK (#1610)"

## 変更内容

1. `src/message/types.ts` の `getMessageTypeName` に各エイリアス名のマッピングを追加する (表示専用)
2. ログメッセージ中の "REQUEST_OK" 表記をコンテキストに応じたエイリアスに変更する

## 該当ファイル

| ファイル               | 行番号                   | 変更内容                                                                       |
| ---------------------- | ------------------------ | ------------------------------------------------------------------------------ |
| `src/message/types.ts` | (getMessageTypeName)     | SUBSCRIBE_OK / FETCH_OK / TRACK_STATUS_OK 等のエイリアス名マッピングを追加する |
| `src/session.ts`       | (デバッグコールバック内) | デバッグログの typeName をエイリアス対応にする                                 |
| `src/controlStream.ts` | (全般)                   | draft 番号を 18 に更新する                                                     |

## 期待される動作

1. SUBSCRIBE の応答 REQUEST_OK はログ上 "SUBSCRIBE_OK" と表示される
2. FETCH の応答 REQUEST_OK はログ上 "FETCH_OK" と表示される
3. TRACK_STATUS の応答 REQUEST_OK はログ上 "TRACK_STATUS_OK" と表示される
4. REQUEST_UPDATE の応答 REQUEST_OK はログ上 "REQUEST_UPDATE_OK" と表示される
5. ワイヤーフォーマットに変更はない (全て REQUEST_OK = 0x05)

## テスト方針

- `src/message/types.ts` の単体テストで `getMessageTypeName` が正しいエイリアス名を返すことを検証する

## 影響範囲

- 実装変更あり (表示名の追加)
- 後方互換あり (ワイヤーフォーマット不変、表示名のみの変更)
- devtools の DebugPanel 表示が改善される
