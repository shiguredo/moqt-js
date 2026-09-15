# Immutable Properties 配下の Property を検索していない

- Created: 2026-09-15
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-immutable-properties-search
- Polished: {YYYY-MM-DD}

## 目的

draft-ietf-moq-transport-21 §10.7 は、Property の値を探す際に mutable な Property 列と Immutable Properties の内容の双方を検索する MUST を定める。Object の delivery timeout を読む経路だけが 0x0B の内側を再帰せず、Immutable Properties 配下に置かれた値を無視する。§5.2 は subgroup 先頭 Object の Object Property で Track 値を上書きできると定めるため、上書きが効かない。

## 現状

- `readDeliveryTimeoutObjectProperties` (`src/properties.ts`) はデコード結果を平坦に走査し、IMMUTABLE_PROPERTIES (0x0B) の内側を再帰しない
- 同じファイルの `supportsDynamicGroups` と `resolveDefaultPublisherPriority` は 0x0B の内側も検索しており、この 1 経路だけが MUST を満たしていない
- DELIVERY_TIMEOUT 系の Object Property は Illformed ではなく正当な配置であり、Track Property と同じ Property Type (0x02 / 0x06) を使う

draft-ietf-moq-transport-21 §10.7:

> Unless specified by a particular Property specification, Properties MAY appear either in the mutable property list or inside Immutable Properties. When looking for the value of a property, processors MUST search both the mutable properties and the contents of Immutable Properties.

## 設計方針

- 0x0B を検出したら内側を再帰的にデコードし、0x02 / 0x06 も抽出対象にする
- 既存の再帰ヘルパと同形に揃え、走査ロジックを重複させない
- mutable 側を優先する既存の解決順序は変えない

## 完了条件

- Immutable Properties 配下の OBJECT_DELIVERY_TIMEOUT / SUBGROUP_DELIVERY_TIMEOUT が解決される
- mutable 側が優先される既存の挙動が変わらない
- 不完全な内側 KVP に対する寛容な打ち切りが既存契約どおり
- テストがある
- `vp check` / `tsc --noEmit` / `vp test run` が通る

## 参照

- draft-ietf-moq-transport-21 §5.2 (Delivery Timeouts and Data Reliability)
- draft-ietf-moq-transport-21 §10.1 (SUBGROUP_DELIVERY_TIMEOUT)
- draft-ietf-moq-transport-21 §10.2 (OBJECT_DELIVERY_TIMEOUT)
- draft-ietf-moq-transport-21 §10.7 (Immutable Properties)
- draft-ietf-moq-transport-21 §11.1.3 (Object Properties)
