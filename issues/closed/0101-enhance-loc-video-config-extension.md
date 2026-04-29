# LOC Video Config Extension 対応

Created: 2026-04-22
Completed: 2026-04-29
Model: Opus 4.7

## 概要

LOC は H.264/H.265 で 2 つのビットストリーム形式をサポートしている。

- **annexB 形式**: Start code prefixes を使用、description 不要
- **canonical 形式** (avc1, hvc1): Length prefixes を使用、description 必要

現在の devtools 実装は annexB 形式のみをサポートしている。

## LOC 仕様 (draft-ietf-moq-loc-02)

### Section 2.1 Video Payload Format

> the LOC Payload can use either the "canonical" format ("avc" or "hevc") often used in storage containers like MP4 / ISO BMFF, or the "annexB" format used in some non-MP4 applications.

### Section 2.3.2.1 Video Config

- Name: Video Config
- Description: Video codec configuration "extradata", which maps to the WebCodecs VideoDecoderConfig description property
- ID: 13

## 対応が必要な場合

canonical 形式をサポートする場合:

### Publisher 側

LOC Header Extension の Video Config (ID: 13) で description を送信する。

```typescript
const extensions = LOC.encodeVideoProperties({
  timestamp: BigInt(chunk.timestamp),
  frameMarking: { ... },
  config: encoderMetadata.decoderConfig.description,  // 追加
});
```

### Subscriber 側

Video Config Extension をパースして decoderConfig.description に設定する。

```typescript
const locProperties = LOC.decodeVideoProperties(obj.extensions);
if (locProperties.config) {
  decoderConfig.description = locProperties.config;
}
```

### MSF Catalog

MSF Catalog の `initData` フィールド (Base64 エンコード) も使用可能。

```json
{
  "name": "video",
  "codec": "avc1.42E01E",
  "initData": "AQAB..."
}
```

## 現状

- devtools は annexB 形式のみ対応
- LOC.encodeVideoProperties / decodeVideoHeaderExtensions に config フィールドは未実装
- MSF Catalog の initData フィールドは未使用

## 参考

- refs/moq/draft-ietf-moq-loc-02.txt
- refs/moq/draft-ietf-moq-msf.md

## 解決方法

moqt-js 本体側 (`src/loc.ts`) では `VideoProperties.config` と `LOCPropertyId.CONFIG = 13n` が既に実装済み。devtools 側で publish / subscribe 経路に組み込んだ。

- `devtools/src/hooks/usePublisher.ts` の `handleEncodedChunk` で `LOC.encodeVideoProperties({ ..., config: chunk.description })` を呼び、WebCodecs から得られる `EncodedVideoChunk.description` を Video Config Extension (ID: 13) として送出するようにした。annexB 形式では `description` が `undefined` のため従来通り何も送られない。
- `devtools/src/hooks/useSubscriber.ts` の Catalog 経由デコーダ構成で、`videoTrackFromCatalog.initData` (Base64) が存在する場合に `settings.base64ToArrayBuffer` で展開して `VideoDecoderConfig.description` に設定するようにした。
- LOC Video Config Extension の subscriber 側からの動的読み出し (デコーダ再構成) は本 issue では実装しない。デコーダはオブジェクト到着前に Catalog 情報で構成する必要があり、Catalog の `initData` 経路でカバーする。
- 本 issue に直接関係しないが、現状 H.264 / H.265 用の MSF Catalog `codec` 文字列マッピングが `usePublisher.ts` の三項演算子で av01 にフォールバックしている。canonical 形式の本格対応はそちらの修正と合わせて行う必要があるが、本 issue のスコープ外とする。
