# DATAGRAM PBT と roundtrip 単体テストの重複を整理する

- Created: 2026-09-08
- Completed: 2026-09-13
- Branch: feature/refactor-datagram-pbt-overlap
- Polished: YYYY-MM-DD

## 目的

DATAGRAM 先頭オブジェクトの roundtrip が PBT と単体テストで重複している。役割分担を明確にして保守性を上げる。

## 現状

- `src/dataStream.prop.ts` の DATAGRAM PBT が下位 2 ビットを 0〜3 で振って roundtrip を検証する。
- `src/dataStream.fetch.test.ts` の「Datagram 先頭オブジェクトの encode→decode roundtrip」が固定値 1 組で同じ往復を検証する。
- `shiguredo-typescript` は「PBT でカバーできるものを単体テストで書かないこと」を定める。

## 設計方針

1. 重複する roundtrip 単体テストは、PBT で表現できない意図的なエラーパス・境界値に絞る。
2. PBT がカバーする roundtrip は PBT に寄せる。
3. テストの役割分担をコメントで明記する。

## 完了条件

- 重複が整理され、PBT と単体テストの役割分担が明確になること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 関連

- `src/dataStream.prop.ts` / `src/dataStream.fetch.test.ts`
- draft-ietf-moq-transport-20 §11.4.4.1

## 解決方法

設計方針 1〜3 に従い、PBT が網羅している roundtrip の単体テストを削除し、役割分担をコメントで明記した。

- `src/dataStream.fetch.test.ts` の「FetchObjectFields: Datagram 先頭オブジェクトの encode→decode roundtrip」(固定値 1 組、25 行) を削除した。`src/dataStream.prop.ts` の「FetchObjectFields: DATAGRAM 先頭オブジェクトの encode→decode がラウンドトリップする」が `subgroupBits` を 0〜3 で振り、Properties の有無も `firstFetchObjectFieldsArb` で網羅しているため、削除対象はその部分集合である。
- `src/dataStream.prop.ts` の同テストに役割分担のコメントを追加した。FetchObjectFields の roundtrip は PBT が担い、単体テストは PBT で表現できない意図的なエラーパス (Object ID の overflow、timed_out の status 種別など) に絞ることを明記し、根拠として shiguredo-typescript の「PBT でカバーできるものを単体テストで書かないこと」を挙げた。
- `CHANGES.md` の `## develop` の `### misc` に `[UPDATE]` を追加した。

## 検証

- `pnpm test run`: 70 ファイル / 2,092 テスト全通過 (削除した 1 件のみ減少。PBT 側の検証内容は変えていない)
- `pnpm typecheck` / `pnpm lint` / `pnpm fmt` すべて成功
