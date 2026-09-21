# コメントの仕様節番号の誤りを修正する

- Created: 2026-09-21
- Completed: {YYYY-MM-DD}
- Branch: feature/update-fix-section-references
- Polished: {YYYY-MM-DD}

## 目的

closed/0619 は実装コードのコメントの節番号を修正したが、テストファイルと、その後追加された実装に誤った引用が残っている。存在しない節や無関係な節を引くと、後続の設計判断とレビューを誤らせるため、一次資料に合わせる。挙動は変えない。

## 現状

いずれも `refs/moq/draft-ietf-moq-transport-21.txt` と照合して確認した。

- `src/properties.test.ts` の 5 箇所が誤っている。`§1.4.3` は draft-21 に存在しない (Key-Value-Pair の規則は §8.3)。`§14` は Transport Considerations であり Grease は §13。`§2.5.1` は存在せず、Mandatory Track Property の 0x4000-0x7FFF は §3.6 が定める
- `src/filter.test.ts` の 2 箇所が IMMUTABLE_PROPERTIES の探索を `§12.7` としているが、§12.7 は存在しない。正しくは §10.7 (Immutable Properties)
- Track Namespace のフィールド長を `§2.3` と引用している箇所がある。§2.3 は Groups である。逐語 "Each Track Namespace Field Value MUST contain at least one byte." は §8.7 (Track Namespace Structure) にあり、`src/message/parameterArb.ts` の `namespacePartsArb` と `namespaceArb`、`src/message/parameter.prop.ts` の `TrackNamespace のエンコード・デコードがラウンドトリップする`、`src/message/parameter.test.ts` の `decodeTrackNamespace で Field Length=0 のフィールドはエラー`、`src/message/fetch.prop.ts` が同じ節を引いている
- `src/message/types.ts` の `isPublishDoneErrorStatus` は PUBLISH_DONE のエラー判定を §9.9 としている。コードの一覧は §12.4 (Publish Done Codes)、未知のエラーコードの扱いは §13 (Grease) が定める
- `src/message/authorizationToken.ts` は Token 構造を §9.20.3 と引用している。§9.20.3 は AUTHORIZATION TOKEN Parameter であり、Token 構造は §8.9 (Authorization Token Compression)
- `src/message/setup.ts` は GREASE Setup Option を「RFC 9170 §3.3 由来の SHOULD 推奨」と書くが、RFC 9170 は Informational であり §3.3 はグリースの考え方を説明するだけで SHOULD を含まない。同じ内容を draft-21 §13 が MUST で定めている

## 設計方針

- 引用は「draft 番号 + 節番号 + 節タイトル」の形に統一し、`refs/moq/draft-ietf-moq-transport-21.txt` の逐語と一致させる
- 節番号だけでなく引用文も一次資料に合わせる。現行の逐語が別の節のものである場合は逐語ごと差し替える
- 引用の根拠が一次資料に無い記述は削除するか、根拠のある節に書き換える
- コメントだけを直し、テストの期待値とテスト名は変えない

## 完了条件

- 上記の各箇所で、引用が一次資料と一致する
- 存在しない節 (§1.4.3 / §2.5.1 / §12.7) への参照が `src/` から消える
- `src/` の差分がすべてコメント行である
- `pnpm test` / `pnpm typecheck` が通る

## 参照

- closed/0619 (実装コードのコメントの節番号と引用のずれ。本 issue はその残り)
- `refs/moq/draft-ietf-moq-transport-21.txt` §8.3 / §8.7 / §8.9 / §10.7 / §12.4 / §13 / §14 / §3.6

## 解決方法

{未着手}
