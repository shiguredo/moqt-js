# PUBLISH_OK メッセージタイプをテキストエイリアスに変更する

Created: 2026-05-13
Model: Opus 4.7

## 概要

draft-18 で PUBLISH_OK (0x1E) が削除され、REQUEST_OK (0x7) の textual alias になった。
PUBLISH リクエストへの成功応答は REQUEST_OK で表現し、リクエスト種別による応答名の区別は
コード上でのみ行う。

> This document uses the shorthand PUBLISH_OK, REQUEST_UPDATE_OK,
> SUBSCRIBE_NAMESPACE_OK and PUBLISH_NAMESPACE_OK to refer to a
> REQUEST_OK response to SUBSCRIBE, FETCH, PUBLISH, SUBSCRIBE_NAMESPACE,
> SUBSCRIBE_TRACKS and PUBLISH_NAMESPACE respectively.
>
> -- draft-ietf-moq-transport-18 §10.5

Wire format 上は REQUEST_OK (0x7) のみ。PUBLISH_OK (0x1E) は存在しない。

## 変更内容

### 1. MessageType.PUBLISH_OK を削除する (`src/message/types.ts`)

- `PUBLISH_OK = 0x1E` を削除する
- PUBLISH 応答のメッセージ型を `REQUEST_OK = 0x7` に統一する

### 2. publish.ts の PublishOk 型を変更する (`src/message/publish.ts`)

- `PublishOk` インターフェースの `type` を `typeof MessageType.REQUEST_OK` に変更する
- `encodePublishOkPayload()` を `encodeRequestOkPayload()` に置換する
  - または `encodePublishOkPayload` の内部実装を `RequestOk` ベースに変更する
- `decodePublishOkPayload()` を `decodeRequestOkPayload()` に置換する
  - または `decodePublishOkPayload` の内部実装を `RequestOk` デコードに変更する

### 3. PublishOkPayload を RequestOkPayload に統一する (`src/message/publish.ts`)

- `PublishOkPayload` インターフェースを削除するか、`RequestOkPayload` のエイリアスにする
- PUBLISH_OK の専用エンコード/デコード関数を削除する

### 4. session.ts の PUBLISH_OK 処理を REQUEST_OK に統一する

- `readPublishResponse()` の `PUBLISH_OK` case を `REQUEST_OK` case に変更する
- PUBLISH_OK を期待している既存コードを REQUEST_OK に書き換える

## 該当箇所

| ファイル                                           | 変更内容                                                                       |
| -------------------------------------------------- | ------------------------------------------------------------------------------ |
| `src/message/types.ts:49`                          | `PUBLISH_OK = 0x1E` を削除する                                                 |
| `src/message/publish.ts:160-265`                   | `PublishOkPayload` 型と encode/decode を削除または REQUEST_OK ベースに変更する |
| `src/session.ts` (readPublishResponse 等)          | PUBLISH_OK case を REQUEST_OK case に変更する                                  |
| `src/session/bidi.ts` (bidiReadPublishResponse 等) | 応答タイプ判定から PUBLISH_OK を削除する                                       |

## テスト方針

- PUBLISH_OK (0x1E) がメッセージタイプ定数から削除されていることを確認する
- PUBLISH 応答が REQUEST_OK (0x7) でエンコード/デコードされることを検証する
- 全 PBT で PUBLISH_OK を含むテストケースを REQUEST_OK に書き換える

## 影響範囲

- `MessageType.PUBLISH_OK` 定数が削除される（後方互換なし）
- PUBLISH 応答パースが REQUEST_OK ベースに変更される
- 既存の PUBLISH_OK 参照コードはビルドエラーになる
