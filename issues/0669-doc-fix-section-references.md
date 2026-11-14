# コメントの仕様節番号の誤りを修正する

- Created: 2026-09-21
- Completed: {YYYY-MM-DD}
- Branch: feature/update-fix-section-references
- Polished: 2026-11-14

## 目的

closed/0619 は実装コードのコメントの節番号を修正したが、テストファイルと実装コードに誤った引用が残っている。closed/0925 の draft-23 移行で一部は解消したが、意味の合わない節を引く箇所が残る。存在しない節や無関係な節を引くと、後続の設計判断とレビューを誤らせるため、一次資料に合わせる。挙動は変えない。

## 現状

`refs/moq/draft-ietf-moq-transport-23.txt` と照合した結果、次の誤りが残っている (2026-11-14 時点)。起票時は draft-22 で確認したが、現行の refs は draft-23 である。

- `src/message/parameterArb.ts` の `namespacePartsArb` の doc コメントと `namespaceArb` の doc コメント、`src/message/parameter.prop.ts` の `TrackNamespace のエンコード・デコードがラウンドトリップする`、`src/message/parameter.test.ts` の `decodeTrackNamespace で Field Length=0 のフィールドはエラー` は、Track Namespace Field の 1 バイト以上を §2.3 としている。§2.3 は Groups であり、逐語 "Each Track Namespace Field Value MUST contain at least one byte." は §8.7 (Track Namespace Structure) にある
- `src/fullTrackName.test.ts` の `formatFullTrackName: 空の Track Namespace と空の Track Name を扱う` の doc コメントと `formatTrackNamespace: Track Namespace だけを組み立てる` のコメントは、Track Namespace の 0 フィールドを §8.7 としている。§8.7 は Track Namespace の符号化であり、0 フィールドを許すのは §2.4.1 (Track Naming) の "Track Namespace is an ordered set of between 0 and 32 Track Namespace Fields" である
- `src/message/setup.ts` の `createSetup` の doc コメントと GREASE Setup Option のコメントは、GREASE の根拠を「RFC 9170 §3.3 由来の SHOULD 推奨」としている。RFC 9170 は Informational であり、§3.3 (Falsifying Active Use) はグリースの考え方を説明するだけで SHOULD を含まない。draft-23 §13 (Grease) は "implementations MUST handle unknown values gracefully. Endpoints MUST NOT close the session solely because they received an unknown value." と "Endpoints MUST ignore unknown Setup Options as specified in Section 9.1." を定めている
- 空の Track Name について: draft-23 §2.4.1 は通常メッセージの Track Name に 1 バイト以上を MUST とする。通常メッセージで空を許す記述が残っていないことを確認する。namespace-scoped Redirect (§9.4.2.1) の空 Track Name は closed/0911 の方針どおり維持する

次の項目は closed/0925 の draft-23 移行で既に解消している。本 issue では触らない。

- `src/properties.test.ts` の §1.4.3 / §14 / §2.5.1 は §8.3 / §13 / §3.7 に修正済み。現在の `src/` に §1.4.3 / §2.5.1 は無い
- `src/filter.test.ts` の §12.7 は §10.7 に修正済み
- `src/message/authorizationToken.test.ts` は §9.19.2 / §8.9 / §9.1.4 に修正済み。デコード失敗は MALFORMED_AUTH_TOKEN、SETUP の DELETE / USE_ALIAS は ROLE_VIOLATION を引いており、draft-23 と一致している
- `src/message/fetch.prop.ts` の 0 フィールドの記述は削除済み

## 設計方針

- 上記の残っている誤りを対象にする。既に解消済みの箇所は触らない
- 引用は「draft 番号 + 節番号 + 節タイトル」の形に統一し、`refs/moq/draft-ietf-moq-transport-23.txt` の逐語と一致させる
- 節番号だけでなく引用文も一次資料に合わせる。現行の逐語が別の節のものである場合は逐語ごと差し替える
- 引用の根拠が一次資料に無い記述は削除するか、根拠のある節に書き換える。GREASE のコメントは、RFC 9170 §3.3 の SHOULD ではなく draft-23 §13 (Grease) の MUST を根拠にする
- コメントだけを直し、テストの期待値とテスト名は変えない

## 完了条件

- 上記の残っている誤りが `refs/moq/draft-ietf-moq-transport-23.txt` と一致する
- 存在しない節 (§1.4.3 / §2.5.1 / §12.7) への参照が `src/` に残っていないことを確認する (closed/0925 で解消済み)
- 通常メッセージで空の Track Name を許す記述が `src/` に残っていないことを確認する
- `src/` の差分がすべてコメント行である
- `pnpm test --run` / `pnpm typecheck` が通る

## 参照

- closed/0619 (実装コードのコメントの節番号と引用のずれ。本 issue はその残り)
- closed/0911 (通常の Track Name の非空化。空の Track Name の扱い)
- closed/0925 (draft-23 移行。properties.test.ts / filter.test.ts / authorizationToken.test.ts / fetch.prop.ts の参照を修正済み)
- `refs/moq/draft-ietf-moq-transport-23.txt` §2.4.1 / §3.7 / §8.3 / §8.7 / §8.9 / §9.1.4 / §9.19.2 / §10.7 / §13 / §14
- `issues/0667-refactor-consolidate-test-helpers.md` (`src/message/parameterArb.ts` の `namespacePartsArb` / `namespaceArb` を整理する。先に実装された場合は現行文言を読み直す)
- `issues/0664-test-ineffective-property-tests.md` (`src/properties.test.ts` を触る。本 issue の残りの対象ではない)

## 解決方法

{未着手}
