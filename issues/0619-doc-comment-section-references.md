# コメントの節番号と引用のずれを修正する

- Created: 2026-09-15
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-comment-section-references
- Polished: {YYYY-MM-DD}

## 目的

draft-ietf-moq-transport-21 への移行後に、コメントの節番号と引用が一次資料とずれている箇所が残っている。引用の誤りは後続の設計判断やレビューを誤らせるため、まとめて修正する。挙動の変更は行わない。

## 現状

- Track Namespace のフィールド数上限の根拠として §9.15 (SUBSCRIBE_NAMESPACE) を挙げている (`src/message/parameter/trackNamespace.ts`)。上限は §8.7 に規定がある
- FETCH のパラメータ構築で SUBSCRIBER_PRIORITY を §9.20.9、GROUP_ORDER を §9.20.19 と記載している (`src/session/params.ts`)。正しくは §9.20.8 と §9.20.9
- PUBLISH_DONE の MUST を §9.8 として引用している (`src/session/bidi.ts`)。この MUST は §9.9 にある
- SETUP の DELETE / USE_ALIAS 禁止を §9.20.3 として引用しているテストコメントがある (`src/message/setup.test.ts`)。正しくは §9.1.4
- TRACK_STATUS のコメントが §9.13 の例示と異なるパラメータ名を挙げている (`src/message/trackstatus.ts`)
- namespace ループのコメントが「§9.14 に先頭メッセージ MUST が無い」と述べており、Table 5 と §6.3 の First 指定と矛盾する (`src/session/namespaceLoops.ts`)。応答側の先頭メッセージに関する MUST が無い、という趣旨に書き直す
- LOCATION_FILTER の Length の根拠として §8.3 の偶数 / 奇数規則を持ち込んでいる (`src/message/parameter/locationFilter.ts`)。この Length は §9.20.10 の構造自身のフィールド
- Object Datagram と Subgroup Header のコメントが draft-21 に存在しない型表を図として提示している (`src/dataStream/datagram.ts` / `src/dataStream/subgroup.ts`)

## 設計方針

- 節番号・引用・図表の出典を `refs/moq/draft-ietf-moq-transport-21.txt` に合わせる
- 引用は「draft 番号 + セクション番号 + セクションタイトル」の形に統一する
- 挙動は変えない。テストの期待値も変えない

## 完了条件

- 上記の引用が一次資料と一致する
- 挙動の変更がない
- `vp check` / `tsc --noEmit` / `vp test run` が通る

## 参照

- draft-ietf-moq-transport-21 §6.3 (Session initialization)
- draft-ietf-moq-transport-21 §8.3 (Key-Value-Pair Structure)
- draft-ietf-moq-transport-21 §8.7 (Track Namespace Structure)
- draft-ietf-moq-transport-21 §9.1.4 (AUTHORIZATION TOKEN)
- draft-ietf-moq-transport-21 §9.9 (PUBLISH_DONE)
- draft-ietf-moq-transport-21 §9.13 (TRACK_STATUS)
- draft-ietf-moq-transport-21 §9.14 (PUBLISH_NAMESPACE)
- draft-ietf-moq-transport-21 §9.20.8 (SUBSCRIBER PRIORITY Parameter)
- draft-ietf-moq-transport-21 §9.20.9 (GROUP ORDER Parameter)
- draft-ietf-moq-transport-21 §9.20.10 (LOCATION FILTER Parameter)
- draft-ietf-moq-transport-21 §11.2.1 (Object Datagram)
- draft-ietf-moq-transport-21 §11.3.1 (Subgroup Header)
