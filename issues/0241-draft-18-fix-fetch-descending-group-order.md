# Fetch オブジェクトの Descending Group Order を実装する

- Priority: High
- Created: 2026-06-03
- Model: deepseek-v4-pro
- Branch: feature/add-descending-fetch-group-order
- Polished: 2026-06-03

## 目的

draft-ietf-moq-transport-18 Section 11.4.4.1 で定義されている Fetch Object Fields の Descending Group Order が未実装であるため、追加する。

> "If the Group Order is Descending, the Group ID is the prior Object's
>  Group ID minus the (Group ID Delta + 1)."

現在は Ascending (昇順) の計算式のみが実装されており、GROUP_ORDER parameter で Descending (0x02) が指定された場合に Fetch レスポンスの Group ID が正しくデコードできない。

## 優先度根拠

仕様で MUST 要件として定義された Group ID 計算式の欠落であり、Descending Group Order を指定する Fetch で誤った Group ID が計算されるため、High とする。

## 現状

`src/dataStream.ts` の `encodeFetchObjectFields` (line 1082) と `decodeFetchObjectFields` (line 1266) の両方で、Ascending のみが実装されている:

```ts
// encodeFetchObjectFields (line 1082)
const delta = fields.groupId - context.groupId - 1n;

// decodeFetchObjectFields (line 1266)
groupId = context.groupId + delta + 1n;
```

## 設計方針

1. `encodeFetchObjectFields` / `decodeFetchObjectFields` に Group Order を表すパラメータを追加する
2. Ascending / Descending に応じた計算式を実装する
3. Descending 時の Group ID が 0 未満にならないことの検証を追加する（仕様: "If the computed Group ID would be less than 0 or greater than 2^64-1, the Subscriber MUST close the Session with error 'PROTOCOL_VIOLATION'"）

## 完了条件

- `encodeFetchObjectFields` が Descending Group Order に対応し、正しい delta を計算すること
- `decodeFetchObjectFields` が Descending Group Order に対応し、正しい Group ID を解決すること
- 関連するテスト (fetch.prop.ts) が追加されていること
- 既存のテストがすべて通過すること

## 解決方法

1. `encodeFetchObjectFields` に `groupOrder: "ascending" | "descending"` パラメータを追加し、Descending 時は `delta = context.groupId - fields.groupId - 1n` を計算する
2. `decodeFetchObjectFields` に同様のパラメータを追加し、Descending 時は `groupId = context.groupId - (delta + 1n)` を計算する
3. Group ID の範囲検証を追加する
4. PBT でラウンドトリップテストを追加する
