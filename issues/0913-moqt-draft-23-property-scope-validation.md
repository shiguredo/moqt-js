# 対応済み Property の Track / Object scope 違反を malformed とする

- Created: 2026-11-03
- Completed: {YYYY-MM-DD}
- Branch: feature/change-property-scope-validation
- Polished: {YYYY-MM-DD}

## 目的

draft 23 §8.4 / §12.1 は、対応済み Property を定義外の scope で受信した場合に Track を malformed とする。現在の検証は Mandatory Track Property の Object 出現などに限られ、通常の既知 Property の scope を網羅しない。

## 現状

- `src/properties.ts` の `assertNoMandatoryTrackPropertyInObjectProperties` は Mandatory / Immutable / Prior Gap を検査するが、一般の Track-only Property を照合しない
- `decodeProperties` は呼び出し元の Track / Object scope を受け取らない
- `src/loc.ts` の `extractLocProperties` は scope に応じて抽出するため、Object-only の LOC Property が Track 側に来ても単に抽出されない場合がある

## 設計方針

- 対応済み Property の scope を、transport の定義と LOC の最新登録に基づいて明示する。Object Delivery Timeout など両 scope を持つものを誤って Track-only にしない
- Track Properties の各受信口と、Datagram / Subgroup / FETCH の Object Properties で、解釈前に scope を検証する
- Immutable Properties 内側も周囲の scope として検証する
- 未知 Property は「scope を知らない」ため、この規則だけで拒否しない。既知 Property の Value 形式不正による Session エラーとは区別する
- 違反は MalformedTrackError と既存の同一 Track 取消しへ接続する。寛容な LOC 抽出 helper だけを厳格化して受信経路の検証を代用しない
- 受信 PUBLISH の現在の catch は MalformedTrackError を一律 UNSUPPORTED_EXTENSION にする。既知 Property の scope 違反と未知 Mandatory Property を区別し、前者を MALFORMED_TRACK の拒否・同じ Track の取消しへ接続する。0903 の UNSUPPORTED_PROPERTY を scope 違反の説明に使わない

## 完了条件

- MAX_CACHE_DURATION / DEFAULT_PUBLISHER_PRIORITY / DYNAMIC_GROUPS などの Track-only と、LOC TIMESTAMP / Prior Gap などの Object-only をそれぞれ逆 scope で検証する
- 両 scope の Property、未知 Property、Immutable Properties 内側を検証する
- scope 違反で無関係な Track や Session 全体を終了しない
- 0916 の CODEC_STRING を対応済みに追加したときも同じ定義を使える

## 参照

- `refs/moq/draft-ietf-moq-transport-23.txt` §8.4 / §10 / §12.1 / §16.8
- `refs/moq/draft-ietf-moq-loc-05.txt` §2.3 / §6.1
- `src/properties.ts`、`src/loc.ts`、`src/dataStream/datagram.ts`、`src/dataStream/subgroup.ts`、`src/dataStream/fetch.ts`

## 解決方法

{未着手}
