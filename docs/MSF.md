# MOQT Streaming Format (MSF)

MOQT Streaming Format (MSF) は、Media Over QUIC Transport (MOQT) 上で
メディアコンテンツを配信するためのストリーミングフォーマットである。
フィールド定義・ワイヤ形式・手順の詳細は正本を参照すること。本ドキュメントは
moqt-js からの入口のみを示す。

## 仕様参照

- 正本: [`refs/moq/draft-ietf-moq-msf-02.txt`](../refs/moq/draft-ietf-moq-msf-02.txt)
- 公開版: [draft-ietf-moq-msf-02](https://datatracker.ietf.org/doc/html/draft-ietf-moq-msf-02)
- LOC: [draft-ietf-moq-loc-05](https://datatracker.ietf.org/doc/html/draft-ietf-moq-loc-05)

## draft-23 前提

MSF-02 §5 は catalog の取得に SUBSCRIBE + Joining FETCH (offset = 0) を MUST としているが、Joining FETCH は MOQT transport draft-20 で削除され、draft-23 には存在しない (draft-ietf-moq-transport-23 §A.4)。moqt-js は draft-23 を前提とするため、この要件は draft-23 §3.4 の fill fetch stream (`FILL_PARAMETERS` §9.19.15) として解釈する。現状の catalog 取得は `subscribe()` + `fetch()` の 2 リクエストで代替しており、fill fetch 化は未実装である。

### catalog 取得の現行方式

transport は `FILL_PARAMETERS` (§3.4 / §9.19.15) を購読に載せられる。一方、moqt-js の catalog 取得は
SUBSCRIBE (Next Object) + FETCH (絶対開始) の 2 リクエストで実装されており、fill fetch に置き換えて
いない。理由は、catalog の購読開始と履歴取得を別々の応答として扱う方が状態管理が単純であり、
2 リクエストでも Joining FETCH の「catalog 全体を取得してから live を購読する」意味論を満たせるためで
ある。fill fetch への移行は未着手であり、必要になった時点で別 issue とする。

## log / metrics の payload 契約

MSF 本文 §9.1 / §10.1 は log / metrics の payload 形式を companion draft
([draft-jennings-moq-log-04](https://datatracker.ietf.org/doc/html/draft-jennings-moq-log-04) /
[draft-jennings-moq-metrics-03](https://datatracker.ietf.org/doc/html/draft-jennings-moq-metrics-03))
に委ねるが、§9.3 / §10.3 はマイクロ秒 Group や Object 0 の timestamp など独自の契約も定めており、
両者は一致しない。moqt-js は **companion draft を正** とし、MSF 本文の独自契約には合わせない。
理由は、相互接続では companion draft の実装どうしが一致する方が実用的であり、MSF 本文の記述が
参照先の版とずれているためである。実装の詳細は [実装状況](IMPLEMENTATION_STATUS.md) を参照する。

## moqt-js での公開 API

- 高レベル: [`createMediaPublisher`](HIGH_LEVEL_API.md) / [`createMediaSubscriber`](HIGH_LEVEL_API.md)
- URI fragment の `cat`（Base64 でエンコードされた C4M トークン）を `SETUP` の `AUTHORIZATION TOKEN` として送る: [`connect()`](LOW_LEVEL_API.md)（`src/msf/c4mAuthorization.ts`）
- msf fragment の track-identifier（MSF namespace-name）を解析して Track Namespace、Track Name、parameter を取り出す（draft-ietf-moq-msf-02 §11.1）: `parseMsfFragmentValue` / `MsfFragmentValue`（`src/msf/fragment.ts`）
- `SETUP` に載せたトークンを、catalog の `SUBSCRIBE` / `FETCH` と `authInfo` を持つトラックの `SUBSCRIBE` / `REQUEST_UPDATE` へ付与する（draft-ietf-moq-msf-02 §11.5.3）: [`createMediaSubscriber`](HIGH_LEVEL_API.md)
- `SETUP` に載せたトークンを `PUBLISH` / `PUBLISH_NAMESPACE` へ付与する（draft-ietf-moq-msf-02 §11.5.3）: [`createMediaPublisher`](HIGH_LEVEL_API.md) / [`connect()`](LOW_LEVEL_API.md)
- Catalog（主要エントリポイント）: `encodeCatalog` / `encodeCatalogDelta` / `decodeCatalogMessage` / `applyCatalogDelta` / `createCatalog` / `createCompleteCatalog` / `MSF_VERSION` / `CATALOG_TRACK_NAME`（`src/msf/`）
- Authorization Info（§5.2.42）: `catalogAuthInfoForSetupToken` が、SETUP の Authorization Token が C4M のトークン (CAT) のときに track に載せる `authInfo` (`{"cat": "%cat%"}`) を返す（`src/msf/authInfo.ts`）
- Timeline（いずれも同期関数）: `encodeMediaTimeline` / `decodeMediaTimeline` / `encodeEventTimeline` / `decodeEventTimeline`（`src/msf/`）
- Timeline encode/decode は無圧縮 JSON を前提とする。MSF_COMPRESSION (0x78) の GZIP 圧縮 / 展開は `compressGzip` / `decompressGzip` / `decompressObjectPayload` として実装済みで、Track と Object の併用は拒否する
- draft-01 以前の Catalog wire 形式および Timeline 圧縮オプションとは非互換 (draft-01 の catalog は受理しない)
- 実装状況の詳細は [実装状況](IMPLEMENTATION_STATUS.md#moqt-streaming-format) を参照

## 関連ドキュメント

- [高レベル API](HIGH_LEVEL_API.md)
- [実装状況](IMPLEMENTATION_STATUS.md#moqt-streaming-format)
