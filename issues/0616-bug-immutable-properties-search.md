# Immutable Properties 配下の Property を検索していない

- Created: 2026-09-15
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-immutable-properties-search
- Polished: 2026-09-15

## 目的

draft-ietf-moq-transport-21 §10.7 は、Property の値を探す際に mutable な Property 列と Immutable Properties の内容の双方を検索する MUST を定める。Object の delivery timeout を読む経路だけが 0x0B の内側を再帰せず、Immutable Properties 配下に置かれた値を無視する。§5.2 は subgroup 先頭 Object の Object Property で Track 値を上書きできると定めるため、上書きが効かない。

## 現状

- `readDeliveryTimeoutObjectProperties` (`src/properties.ts`) はデコード結果を平坦に走査し、IMMUTABLE_PROPERTIES (0x0B) の内側を再帰しない
- 同じファイルの `supportsDynamicGroups` と `resolveDefaultPublisherPriority` は 0x0B の内側も検索しており、delivery timeout を読むこの経路だけが MUST を満たしていない (`src/loc.ts` の `extractLocProperties` も 0x0B の内側を検索しないが、本 issue の対象外とする)
- DELIVERY_TIMEOUT 系の Object Property は malformed ではなく正当な配置であり、Track Property と同じ Property Type (0x02 / 0x06) を使う

draft-ietf-moq-transport-21 §10.7:

> Unless specified by a particular Property specification, Properties MAY appear either in the mutable property list or inside Immutable Properties. When looking for the value of a property, processors MUST search both the mutable properties and the contents of Immutable Properties.

## 設計方針

- 0x0B を検出したら内側もデコードし、0x02 / 0x06 も抽出対象にする
- 内側のデコードには `decodeObjectPropertiesTolerant` を使う。`decodeObjectPropertiesTolerant` の出力では 0x0B の `property.data` は ID と Length を含まない KVP 列であり、Track 向けの `decodeProperties` は Mandatory Track Property の拒否や Length 上限で throw して寛容契約を壊すため使わない。走査は同ファイルの `assertPriorIdGapInProperties` と同じ形に揃える
- 内側は 1 段だけ辿る。§10.7 は 0x0B の内側に 0x0B が現れる Object を malformed とするため、内側に現れた 0x0B は辿らない。受信経路では `assertObjectPropertyList` が先に再帰ネストを拒否しており、より深い探索は不要である
- mutable list を先に走査し、その型が mutable 側に見つかった場合はその値を使う。見つからない場合だけ Immutable Properties 配下を走査する。いずれのリストでも同じ型が複数ある場合は現行どおり最後の値が残る
- 不完全・不正な内側 KVP は `decodeObjectPropertiesTolerant` の契約どおりそこで打ち切り、それまでに読めた値だけを保持する (例外は送出しない)。§10.7 の「A Key-Value-Pair cannot be parsed」を malformed として検出する対応は本 issue の対象外とする

## 完了条件

- Immutable Properties 配下の OBJECT_DELIVERY_TIMEOUT / SUBGROUP_DELIVERY_TIMEOUT が解決される
- mutable 側に同じ型がある場合は mutable 側の値が優先される。同じリスト内に同じ型が複数ある場合は現行どおり最後の値になる
- 内側の探索は 1 段だけで、内側に現れた 0x0B は辿らない
- 不完全な内側 KVP では例外を送出せず、読めた分の値を保持する (`decodeObjectPropertiesTolerant` の契約)
- テストがある
- `vp check` / `tsc --noEmit` / `vp test run` が通る

## 参照

- draft-ietf-moq-transport-21 §5.2 (Delivery Timeouts and Data Reliability)
- draft-ietf-moq-transport-21 §10.1 (SUBGROUP_DELIVERY_TIMEOUT)
- draft-ietf-moq-transport-21 §10.2 (OBJECT_DELIVERY_TIMEOUT)
- draft-ietf-moq-transport-21 §10.7 (Immutable Properties)
- draft-ietf-moq-transport-21 §11.1.3 (Object Properties)
