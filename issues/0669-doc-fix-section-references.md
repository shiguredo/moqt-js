# コメントの仕様節番号の誤りを修正する

- Created: 2026-09-21
- Completed: {YYYY-MM-DD}
- Branch: feature/update-fix-section-references
- Polished: 2026-09-29

## 目的

closed/0619 は実装コードのコメントの節番号を修正したが、テストファイルと、その後追加された実装に誤った引用が残っている。存在しない節や無関係な節を引くと、後続の設計判断とレビューを誤らせるため、一次資料に合わせる。挙動は変えない。

## 現状

いずれも `refs/moq/draft-ietf-moq-transport-21.txt` と照合して確認した。

- `src/properties.test.ts` の 5 箇所が誤っている。`§1.4.3` は draft-21 に存在しない (Key-Value-Pair の規則は §8.3)。`§14` は Transport Considerations であり Grease は §13。`§2.5.1` は存在せず、Mandatory Track Property の 0x4000-0x7FFF は §3.6 が定める
- `src/filter.test.ts` の 2 箇所が IMMUTABLE_PROPERTIES の探索を `§12.7` としているが、§12.7 は存在しない。正しくは §10.7 (Immutable Properties)
- Track Namespace のフィールド長を `§2.3` と引用している箇所がある。§2.3 は Groups である。逐語 "Each Track Namespace Field Value MUST contain at least one byte." は §8.7 (Track Namespace Structure) にあり、`src/message/parameterArb.ts` の `namespacePartsArb` と `namespaceArb`、`src/message/parameter.prop.ts` の `TrackNamespace のエンコード・デコードがラウンドトリップする`、`src/message/parameter.test.ts` の `decodeTrackNamespace で Field Length=0 のフィールドはエラー` が同じ節を引いている
- Track Namespace の 0 フィールドと空の Track Name を `§8.7` と引用している箇所がある。§8.7 は Track Namespace の符号化であり、0 フィールドと空 Track Name を許すのは §2.4.1 (Track Naming) である。`src/message/fetch.prop.ts` の「ゼロ要素 (空) のネームスペースを許可する」、`src/fullTrackName.test.ts` の `formatFullTrackName` テストの「Track Name は §8.7 が空を許す」と `formatTrackNamespace` テストの「Track Namespace は §8.7 が 0 フィールドを許す」が対象。逐語 "Track Namespace is an ordered set of between 0 and 32 Track Namespace Fields" と "Track Name is a sequence of bytes, possibly empty" は §2.4.1 にある
- `src/message/types.ts` の `isPublishDoneErrorStatus` と `src/subscriber.ts` の `handleEnd` は PUBLISH_DONE のエラー判定を §9.9 としている。§9.9 はメッセージの節であり、コードの一覧は §12.4 (Publish Done Codes)、未知のエラーコードの扱いは §13 (Grease) が定める
- `src/message/authorizationToken.ts` はモジュールヘッダーと Alias Type コメントの 2 箇所で Token 構造を §9.20.3 と引用している。§9.20.3 は AUTHORIZATION TOKEN Parameter であり、Token 構造は §8.9 (Authorization Token Compression) が定める (Figure 3 も §8.9 にある)
- `src/session/params.test.ts` は buildFetchParameters 周りのコメントで SUBSCRIBER PRIORITY を §9.20.9 としている。§9.20.9 は GROUP ORDER Parameter であり、SUBSCRIBER PRIORITY は §9.20.8 が定める。逐語 "It MAY appear in a SUBSCRIBE, PUBLISH, FETCH, or REQUEST_UPDATE" は §9.20.8 にある
- `src/message/authorizationToken.test.ts` はモジュールヘッダー、`AuthorizationToken: デコード失敗で KEY_VALUE_FORMATTING_ERROR` テスト、`AuthorizationToken: SETUP では DELETE を拒否する` テストで Token 構造と SETUP での禁止を §9.20.3 としている。§9.20.3 は AUTHORIZATION TOKEN Parameter。逐語 "If the Token structure cannot be decoded, the receiver MUST close the Session with KEY_VALUE_FORMATTING_ERROR." は §8.9、"If a server receives Alias Type DELETE (0x0) or USE_ALIAS (0x2) in a SETUP message, it MUST close the session with a PROTOCOL_VIOLATION." は §9.1.4 (AUTHORIZATION TOKEN) にある
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
- `refs/moq/draft-ietf-moq-transport-21.txt` §2.4.1 / §3.6 / §8.3 / §8.7 / §8.9 / §9.1.4 / §9.20.8 / §10.7 / §12.4 / §13 / §14
- `issues/0667-refactor-consolidate-test-helpers.md` (`src/message/parameterArb.ts` の `namespacePartsArb` / `namespaceArb` を整理する。先に実装された場合は現行文言を読み直す) / `issues/0664-test-ineffective-property-tests.md` (`src/properties.test.ts` を触る。対象行は本文書のコメント行と重ならないが、先に実装された場合は現行文言を読み直す)

## 解決方法

{未着手}
