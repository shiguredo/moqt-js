# MOQT Streaming Format (MSF)

MOQT Streaming Format (MSF) は、Media Over QUIC Transport (MOQT) 上で
メディアコンテンツを配信するためのストリーミングフォーマットである。
フィールド定義・ワイヤ形式・手順の詳細は正本を参照すること。本ドキュメントは
moqt-js からの入口のみを示す。

## 仕様参照

- 正本: [`refs/moq/draft-ietf-moq-msf-01.txt`](../refs/moq/draft-ietf-moq-msf-01.txt)
- 公開版: [draft-ietf-moq-msf-01](https://datatracker.ietf.org/doc/html/draft-ietf-moq-msf-01)
- LOC: [draft-ietf-moq-loc-04](https://datatracker.ietf.org/doc/html/draft-ietf-moq-loc-04)

## moqt-js での公開 API

- 高レベル: [`createMediaPublisher`](HIGH_LEVEL_API.md) / [`createMediaSubscriber`](HIGH_LEVEL_API.md)
- URI fragment の `c4m`（Base64 でエンコードされた C4M トークン）を `SETUP` の `AUTHORIZATION TOKEN` として送る: [`connect()`](LOW_LEVEL_API.md)（`src/msf/c4mAuthorization.ts`）
- `SETUP` に載せたトークンを、catalog の `SUBSCRIBE` / `FETCH` と `authInfo` を持つトラックの `SUBSCRIBE` / `REQUEST_UPDATE` へ付与する（draft-ietf-moq-msf-01 §11.4.3）: [`createMediaSubscriber`](HIGH_LEVEL_API.md)
- `SETUP` に載せたトークンを `PUBLISH` / `PUBLISH_NAMESPACE` へ付与する（draft-ietf-moq-msf-01 §11.4.3）: [`createMediaPublisher`](HIGH_LEVEL_API.md) / [`connect()`](LOW_LEVEL_API.md)
- Catalog（主要エントリポイント）: `encodeCatalog` / `encodeCatalogDelta` / `decodeCatalogMessage` / `applyCatalogDelta` / `createCatalog` / `createCompleteCatalog` / `MSF_VERSION` / `CATALOG_TRACK_NAME`（`src/msf/`）
- Authorization Info（§5.2.42）: `catalogAuthInfoForSetupToken` が、SETUP の Authorization Token が C4M のトークン (CAT) のときに track に載せる `authInfo` (`{"cat": "%c4m%"}`) を返す（`src/msf/authInfo.ts`）
- Timeline（いずれも同期関数）: `encodeMediaTimeline` / `decodeMediaTimeline` / `encodeEventTimeline` / `decodeEventTimeline`（`src/msf/`）
- 現行 Timeline encode/decode は無圧縮 JSON のみ。ペイロード圧縮のシグナリングは仕様の MSF_COMPRESSION（未実装）
- draft-00 の Catalog wire 形式および Timeline 圧縮オプションとは非互換
- 実装状況の詳細は [README の MOQT Streaming Format 節](../README.md#moqt-streaming-format) を参照

## 関連ドキュメント

- [高レベル API](HIGH_LEVEL_API.md)
- [README の MOQT Streaming Format 節](../README.md#moqt-streaming-format)
