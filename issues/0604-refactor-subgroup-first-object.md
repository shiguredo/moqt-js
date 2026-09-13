# SubgroupHeader の firstObject の表現を正規化する

- Created: 2026-09-14
- Completed: {YYYY-MM-DD}
- Branch: feature/refactor-subgroup-first-object
- Polished: {YYYY-MM-DD}

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
