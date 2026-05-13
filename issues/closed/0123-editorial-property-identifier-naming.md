# Track Property 識別子の名称が draft-17 §14.4 と乖離

Created: 2026-05-02
Completed: 2026-05-03
Model: Opus 4.7

## 概要

`src/properties.ts` で定義している Property 識別子のうち 3 つが、draft-17 §14.4 の正式名称と一致しない。

| 値   | 仕様 §14.4                    | 実装 (`src/properties.ts`)                         |
| ---- | ----------------------------- | -------------------------------------------------- |
| 0x0B | IMMUTABLE_PROPERTIES          | `MOQTPropertyId.IMMUTABLE_EXTENSIONS`              |
| 0x0E | DEFAULT_PUBLISHER_PRIORITY    | `TrackPropertyId.PUBLISHER_PRIORITY`               |
| 0x22 | DEFAULT_PUBLISHER_GROUP_ORDER | `TrackPropertyId.PUBLISHER_GROUP_ORDER_PREFERENCE` |

ワイヤフォーマット (値) は一致しているが、コード上の識別子が古い (おそらく draft-15 以前の) 名称のまま。同じファイル内で `ImmutableProperties` 型名や `decodeImmutableProperties` 関数名は仕様用語に準拠しているため、定数名だけが浮いている。

## RFC 根拠

draft-ietf-moq-transport-17 §14.4 Properties レジストリ表 (line 5800-5818):

```
| 0x0B | IMMUTABLE_PROPERTIES          | Track, Object | Section 11.6 |
| 0x0E | DEFAULT_PUBLISHER_PRIORITY    | Track         | Section 11.3 |
| 0x22 | DEFAULT_PUBLISHER_GROUP_ORDER | Track         | Section 11.4 |
```

## 該当箇所

- `src/properties.ts:25` `IMMUTABLE_EXTENSIONS: 0x0bn`
- `src/properties.ts:69` `PUBLISHER_PRIORITY: 0x0en`
- `src/properties.ts:77` `PUBLISHER_GROUP_ORDER_PREFERENCE: 0x22n`
- `src/properties.ts:337-392` の関数名 (`encodeImmutableProperties` / `decodeImmutableProperties`) は仕様用語と整合
- `src/session.ts:1088` `id: TrackPropertyId.PUBLISHER_GROUP_ORDER_PREFERENCE` 等、参照箇所も連動して改名が必要

## 期待される動作

- 定数名を仕様の正式名称に揃える: `IMMUTABLE_PROPERTIES` / `DEFAULT_PUBLISHER_PRIORITY` / `DEFAULT_PUBLISHER_GROUP_ORDER`
- 古い名称をエクスポートしている箇所 (`src/message/index.ts` 経由など) を更新

## 優先度

軽微。動作には影響しないが、利用者がコードと仕様を行き来する際の認知負荷が上がる。後方互換は不要 (CLAUDE.md 方針) なので一括改名で良い。

## 解決方法

3 つの識別子を仕様の正式名称 (draft-ietf-moq-transport-17 §14.4) に一括改名した。

- `MOQTPropertyId.IMMUTABLE_EXTENSIONS` → `MOQTPropertyId.IMMUTABLE_PROPERTIES`
- `TrackPropertyId.PUBLISHER_PRIORITY` → `TrackPropertyId.DEFAULT_PUBLISHER_PRIORITY`
- `TrackPropertyId.PUBLISHER_GROUP_ORDER_PREFERENCE` → `TrackPropertyId.DEFAULT_PUBLISHER_GROUP_ORDER`

`src/` 配下の以下のファイルを連動して改名した:

- `src/properties.ts` (定義)
- `src/properties.test.ts` / `src/properties.prop.ts`
- `src/session.ts` / `src/subscriber.ts`
- `src/message/types.ts` / `src/message/trackstatus.ts`
- `src/message/publish.prop.ts` / `src/message/subscribe.prop.ts` / `src/message/fetch.prop.ts`

コメント内に出てくる旧名称も同時に置換した。`encodeImmutableProperties` / `decodeImmutableProperties` / `ImmutableProperties` interface は元から仕様用語と整合していたため改名不要。`devtools/dist/` の build artifact は対象外 (再ビルドで反映される)。
