# LOC Video Config Extension 対応

## 概要

LOC は H.264/H.265 で 2 つのビットストリーム形式をサポートしている。

- **annexB 形式**: Start code prefixes を使用、description 不要
- **canonical 形式** (avc1, hvc1): Length prefixes を使用、description 必要

現在の devtools 実装は annexB 形式のみをサポートしている。

## LOC 仕様 (draft-ietf-moq-loc-01)

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
const extensions = LOC.encodeVideoHeaderExtensions({
  captureTimestamp: BigInt(chunk.timestamp),
  frameMarking: { ... },
  config: encoderMetadata.decoderConfig.description,  // 追加
});
```

### Subscriber 側

Video Config Extension をパースして decoderConfig.description に設定する。

```typescript
const headerExtensions = LOC.decodeVideoHeaderExtensions(obj.extensions);
if (headerExtensions.config) {
  decoderConfig.description = headerExtensions.config;
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
- LOC.encodeVideoHeaderExtensions / decodeVideoHeaderExtensions に config フィールドは未実装
- MSF Catalog の initData フィールドは未使用

## 参考

- refs/moq/draft-ietf-moq-loc-01.txt
- refs/moq/draft-ietf-moq-msf.md
