# OBJECT_DELIVERY_TIMEOUT の命名を DELIVERY_TIMEOUT から修正する

- Priority: Low
- Created: 2026-06-03
- Model: deepseek-v4-pro
- Branch: feature/change-rename-object-delivery-timeout
- Polished: 2026-06-03

## 目的

draft-ietf-moq-transport-18 の正式名称に合わせて、内部の定数名と文字列キーを修正する。

- Message Parameter Section 10.2.4: 名称は `OBJECT_DELIVERY_TIMEOUT`
- Track Property Section 12.2: 名称は `OBJECT_DELIVERY_TIMEOUT`

現在のコードでは両方が `DELIVERY_TIMEOUT` と命名されており、`SUBGROUP_DELIVERY_TIMEOUT` (0x06) や `DataStreamErrorCode.DELIVERY_TIMEOUT` (0x02, Section 15.10.4) との区別が曖昧で、仕様参照時の混乱を招く。

`DataStreamErrorCode.DELIVERY_TIMEOUT` (`src/error.ts:112`) は Section 15.10.4 に従っており正しいため修正不要。

## 優先度根拠

命名修正のみであり、機能的なバグではないため Low とする。ただし複数ファイルにまたがる定数名変更であり、全テストの通過確認が必要。

## 現状

定数定義 2 箇所に加え、コメント・文字列キー・PBT テストを含む全参照箇所の修正が必要。

| ファイル:行 | 種別 | 修正内容 |
|---|---|---|
| `src/message/types.ts:106` | コメント | `DELIVERY_TIMEOUT` → `OBJECT_DELIVERY_TIMEOUT` |
| `src/message/types.ts:111` | コメント | 同上 |
| `src/message/types.ts:121` | **定数定義** | `DELIVERY_TIMEOUT: 0x02,` → `OBJECT_DELIVERY_TIMEOUT: 0x02,` |
| `src/properties.ts:59` | **定数定義** | `DELIVERY_TIMEOUT: 0x02n,` → `OBJECT_DELIVERY_TIMEOUT: 0x02n,` |
| `src/session/params.ts:85` | コメント | `// DELIVERY_TIMEOUT` → `// OBJECT_DELIVERY_TIMEOUT` |
| `src/session/params.ts:87` | 文字列リテラル | `"DELIVERY_TIMEOUT"` → `"OBJECT_DELIVERY_TIMEOUT"` (エラーメッセージ用) |
| `src/session/params.ts:89` | **定数参照** | `TrackPropertyId.DELIVERY_TIMEOUT` → `TrackPropertyId.OBJECT_DELIVERY_TIMEOUT` |
| `src/session/params.ts:161` | コメント | `// DELIVERY_TIMEOUT` → `// OBJECT_DELIVERY_TIMEOUT` |
| `src/session/params.ts:163` | 文字列リテラル | `"DELIVERY_TIMEOUT"` → `"OBJECT_DELIVERY_TIMEOUT"` |
| `src/session/params.ts:165` | **定数参照** | `MessageParameterType.DELIVERY_TIMEOUT` → `MessageParameterType.OBJECT_DELIVERY_TIMEOUT` |
| `src/session.ts:1253` | 文字列キー | `DELIVERY_TIMEOUT:` → `OBJECT_DELIVERY_TIMEOUT:` (debug 出力用プロパティ名) |
| `src/session.ts:1384` | 文字列キー | 同上 |
| `src/session.prop.ts:171` | **PBT** | `MessageParameterType.DELIVERY_TIMEOUT` → `MessageParameterType.OBJECT_DELIVERY_TIMEOUT` |
| `src/session.prop.ts:270` | **PBT** | 同上 |
| `src/message/parameter.ts:571` | コメント | `// DELIVERY_TIMEOUT` → `// OBJECT_DELIVERY_TIMEOUT` |
| `src/message/trackstatus.ts:10` | コメント | `DELIVERY_TIMEOUT` → `OBJECT_DELIVERY_TIMEOUT` |
| `src/message/trackstatus.ts:34` | コメント | 同上 |
| `src/subscriber.ts:57` | コメント | `DELIVERY_TIMEOUT` → `OBJECT_DELIVERY_TIMEOUT` |

## 設計方針

1. `MessageParameterType.DELIVERY_TIMEOUT` → `MessageParameterType.OBJECT_DELIVERY_TIMEOUT`
2. `TrackPropertyId.DELIVERY_TIMEOUT` → `TrackPropertyId.OBJECT_DELIVERY_TIMEOUT`
3. 上記リストの全参照箇所を修正する（文字列キー `DELIVERY_TIMEOUT:` も debug 出力として使用されており、仕様準拠のため `OBJECT_DELIVERY_TIMEOUT:` に変更する）
4. `src/error.ts` の `DataStreamErrorCode.DELIVERY_TIMEOUT` はそのまま（正しい）
5. `src/fetcher.ts` は `DELIVERY_TIMEOUT` への参照がないため修正不要

## 完了条件

- 上記 17 箇所すべての定数名・コメント・文字列キーが修正されていること
- `grep -r "DELIVERY_TIMEOUT" src/` の結果が `error.ts` の 1 箇所のみであること
- すべてのテストが通過すること
- `CHANGES.md` に `[CHANGE]` エントリを追加すること
