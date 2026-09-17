# SubgroupHeader の firstObject の表現を正規化する

- Created: 2026-09-14
- Completed: 2026-09-17
- Branch: feature/refactor-subgroup-first-object
- Polished: 2026-09-17

## 目的

`SubgroupHeader.firstObject` は「FIRST_OBJECT bit (0x40) が立っているか」を表すが、`true` か `undefined` しか取らない optional boolean であり、`false` と `undefined` の区別に意味が無い。消費側は `=== true` で判定する必要があり、`!header.firstObject` と書くと「未設定」と「false」が混ざる。公開型として曖昧な表現を残さず、draft-21 対応のリリース前に正規化する。

## 現状

- `src/dataStream/subgroup.ts` の `SubgroupHeader.firstObject?: boolean` は optional であり、`false` を明示的に設定する経路が無い。
- `decodeSubgroupHeader` は `(typeNum & 0x40) !== 0 ? true : undefined` としており、bit が無い場合に `undefined` を入れる。
- `encodeSubgroupHeader` は `header.firstObject ? header.type | 0x40 : header.type` としており、`undefined` と `false` を同じ扱いにしている。
- `src/session/stream.ts` の `processSubgroupObjects` は `header.firstObject === true` と明示比較しており、`undefined` を考慮した書き方になっている。
- `src/session/publish.ts` は `firstObject: true` を設定する。
- `SubgroupHeader` は `src/index.ts` から公開されており (`export { ..., type SubgroupHeader, ... }`)、`dist/index.d.ts` にも現れる。表現の変更は公開型の変更になる。

## 設計方針

1. `firstObject` を必須の boolean に正規化する (`firstObject: boolean`)。wire 上の bit が無い場合は `false` とする。
2. フィールド名は用途が読める名前にするか検討する (`isFirstObject` 等)。改名する場合は公開型の破壊的変更になるため、`CHANGES.md` では `[CHANGE]` として扱い、`CODEBASE.md` の公開 API 方針に従う。
3. `encodeSubgroupHeader` / `decodeSubgroupHeader` / `processSubgroupObjects` / `publish.ts` の設定箇所を追随させる。
4. 既存テスト (`src/dataStream.subgroup.test.ts` / `src/dataStream.prop.ts` / `src/session/stream.test.ts`) を新しい表現に追随させる。PBT の arbitrary も `false` を含む形にする。

## 完了条件

- `SubgroupHeader.firstObject` が `undefined` を取らなくなり、`false` と未設定の区別が不要になること。
- wire 表現は変えないこと (`encodeSubgroupHeader` / `decodeSubgroupHeader` の往復が既存テストで一致すること)。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 関連

- `src/dataStream/subgroup.ts` (`SubgroupHeader` / `encodeSubgroupHeader` / `decodeSubgroupHeader`)
- `src/session/stream.ts` (`processSubgroupObjects`)
- `src/session/publish.ts`

## 解決方法

### `SubgroupHeader` (`src/dataStream/subgroup.ts`)

- `firstObject?: boolean` を必須の `firstObject: boolean` に変更した。JSDoc に「wire 上で
  FIRST_OBJECT ビットが立たない場合も `false` を設定するため未設定との区別が無い」ことを明記した
- フィールド名は改名しない判断にした。完了条件が `SubgroupHeader.firstObject` を指していること、
  wire 上のビット名 FIRST_OBJECT と一致すること、同じインターフェイスの `endOfGroup?: boolean` と
  命名が揃うことによる (設計方針 2 の「検討」の結論。改名による公開型の破壊的変更は行わない)
- `decodeSubgroupHeader` は `(typeNum & 0x40) !== 0 ? true : undefined` を `(typeNum & 0x40) !== 0`
  に変更し、戻り値で `firstObject` を常に設定する。`exactOptionalPropertyTypes` 向けの条件付き展開
  (`...(firstObject !== undefined ? { firstObject } : {})`) は不要になったため削除した
- `encodeSubgroupHeader` は `header.firstObject ? header.type | 0x40 : header.type` のままで
  挙動は変わらない (必須 boolean になっても false の扱いは同じ)。encode / decode の wire 表現は
  変えていない

### 消費側 (`src/session/stream.ts` / `src/session/publish.ts`)

- `processSubgroupObjects` の delivery timeout 上書きの判定を `header.firstObject === true` から
  `header.firstObject` に変更した (`undefined` を考慮した明示比較が不要になった)
- `src/session/publish.ts` は元から `firstObject: true` を設定しており、新しい表現でもそのまま
  妥当なため変更していない

### テスト

- `src/dataStream.subgroup.test.ts`: `SubgroupHeader` のリテラルに `firstObject: false` を追加し、
  decode 結果に `undefined` を期待していたアサーションを `false` に変更した。BASE タイプのデコード、
  END_OF_GROUP ビットのデコード、No Priority タイプの roundtrip で、ビットが無い場合に `false` に
  なることを検証する。roundtrip テスト (`subgroupHeaderTestCases`) には `decoded.firstObject` が
  入力と一致することの確認を追加した (wire 表現が変わっていないことの回帰ガード)
- `src/dataStream.prop.ts`: Subgroup Header の arbitrary (`subgroupHeaderShapes` /
  `subgroupHeaderArb`) を新設し、`firstObject` を `fc.boolean()` で true / false の両方生成する。
  encode→decode のラウンドトリップで `firstObject` の保持、Type Flags の一致、SUBGROUP_ID_MODE
  ごとの `subgroupId`、Priority Present の有無による `publisherPriority` の有無を検証する PBT を
  追加した
- `src/session/stream.test.ts` / `src/session/incoming.test.ts` / `src/session.test.ts`:
  ヘッダリテラルと `encodeSubgroupHeader` 呼び出しに `firstObject` を追加した。`stream.test.ts` の
  「FIRST_OBJECT ビットなしでは timeout を抽出しない」テストは、コメントと値を中継転送相当の
  `firstObject: false` に変更した。あわせて `exactOptionalPropertyTypes` と矛盾していた
  `subgroupId: undefined` の明示指定を削除した (フィールド省略と同じ意味)

### 検証

`vp check` / `tsc --noEmit` / `vp test run` (2295 passed) / `vp run build` が通ることを確認した。
生成した `dist/index.d.ts` でも `SubgroupHeader.firstObject` が必須の `boolean` になっている。
