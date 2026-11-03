# 対応済み Property の重複を既定で拒否し未知型の反復を保つ

- Created: 2026-11-03
- Completed: {YYYY-MM-DD}
- Branch: feature/change-property-duplicate-validation
- Polished: {YYYY-MM-DD}

## 目的

draft 23 §8.4 は、定義が反復を許す場合を除いて同じ Track / Object の対応済み Property を 1 つとし、受信違反を malformed track とした。未知 Property の複数出現は許容されるため、全 ID の一律重複禁止にもできない。

## 現状

- `src/properties.ts` の `decodeProperties` は重複した通常 Property を配列に残し、`parseProperties` は既知値を上書きする
- Object 側の `assertObjectPropertyList` は Immutable / Prior Gap の一部の重複だけを検査する
- `src/loc.ts` の `extractLocProperties` は同一 ID の後続値で上書きする。`encodeProperties` にも一般の既知 Property の一意性確認は無い

## 設計方針

- 対応済み型の反復可否を定義し、明示的に許可されない重複を検出する。scope の定義は 0913 と共有できる形にする
- mutable list と Immutable Properties 内側を検索し、個別 Property の定義に従って出現回数を数える。既存の Prior Gap の合算規則を維持する
- 受信時は MalformedTrackError とし、送信 API も既知の不正な重複を生成しない。汎用 KVP codec で未知 Property まで一律に拒否しない
- 受信 PUBLISH での拒否は未知 Mandatory Property の UNSUPPORTED_EXTENSION と区別し、MALFORMED_TRACK として扱う。0913 の scope 検証と同じ分類を使う
- 既知値の上書きで違反を隠さず、LOC の寛容な抽出と transport の受信検証を分ける
- PBT の Property 任意生成が同じ既知型を重複させて正常例を作っていないか更新する

## 完了条件

- Track と Object の既知 Property 重複、mutable と Immutable の組み合わせを検証する
- 未知型・GREASE の反復は受理され、既知型の例外は個別定義に従う
- 不正な後続値で先行値を上書きして正常処理しない
- 同一 Track の取消しと、送信前拒否をそれぞれ検証する

## 参照

- `refs/moq/draft-ietf-moq-transport-23.txt` §8.4 / §10.7〜§10.9 / §12.1
- `src/properties.ts` の `encodeProperties` / `decodeProperties` / `parseProperties` / `assertObjectPropertyList`
- `src/loc.ts` の `extractLocProperties`、`src/properties.prop.ts`、`src/message/*.prop.ts`
- closed 0122 は Immutable / Prior Gap の個別規則であり、一般の既知 Property 重複規則とは別である

## 解決方法

{未着手}
