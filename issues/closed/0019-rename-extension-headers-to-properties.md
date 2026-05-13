# Extension Headers を Properties にリネーム

## 概要

Extension Headers という用語を Properties にリネームする。

## 参照

- draft-ietf-moq-transport-17 Section 2.5
- https://github.com/moq-wg/moq-transport/pull/1504

## 変更内容

- draft-16 では Extension Headers と呼ばれていた機能が、draft-17 では Properties にリネームされた
- コード内の Extension Headers への参照をすべて Properties に変更する

## 影響範囲

- `src/extensions.ts` (ファイル名変更の可能性)
- `src/message/types.ts`
- `src/session.ts`
- `src/dataStream.ts`
- `src/publisher.ts`

## 実装方針

1. コードベース全体で "Extension Headers" / "extensions" への参照を検索する
2. 型名、変数名、コメントを Properties に変更する
3. `src/extensions.ts` のファイル名変更を検討する
4. テストを更新する

## 解決方法

以下のリネームを全ファイルに適用した:

- `extensions.ts` → `properties.ts` (テスト、PBT 含む)
- `ExtensionHeader` → `Property`
- `MOQTExtensionHeaderId` → `MOQTPropertyId`
- `TrackExtensionHeaderId` → `TrackPropertyId`
- `encodeExtensionHeader(s)` → `encodeProperty/encodeProperties`
- `decodeExtensionHeaders` → `decodeProperties`
- `parseExtensionHeaders` → `parseProperties`
- `ParsedExtensionHeaders` → `ParsedProperties`
- `ImmutableExtensions` → `ImmutableProperties`
- `trackExtensions` → `trackProperties`
- `EXTENSIONS_PRESENT` → `PROPERTIES_PRESENT`
- `hasExtensionsPresent` → `hasPropertiesPresent`
- Object/Datagram の `extensions` フィールド → `properties`

変更ファイル: 15 ファイル (LOC 関連は別概念のため除外)
