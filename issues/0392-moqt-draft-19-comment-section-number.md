# message/types.ts の MessageParameterType コメントの仕様参照誤りを修正する

- Priority: Low
- Created: 2026-08-06
- Completed: 2026-08-13
- Model: DeepSeek V4 Flash
- Branch: feature/fix-moqt-draft-19-comment-section-number
- Polished: 2026-08-12

## 目的

`src/message/types.ts` の `MessageParameterType` コメントに記載されたドラフトの参照 (セクション番号とパラメータ名) を draft-19 の正しい値に修正する。SUBGROUP_FILTER 以降の Range Filter 5 種が「10.2.15」〜「10.2.19」と記載されているが、draft-19 では 10.2.10 〜 10.2.14 が正しい。あわせて、同じコメントブロックに残る旧ドラフト名の誤り (LOCATION_FILTER のタイトル / GROUP_ORDER の Track Property 名) も修正する。

## 優先度根拠

仕様参照コメントの誤りは、実装者がドラフトの該当箇所を誤って参照する原因になる。軽微だが broken window を放置しない。Low。

## 現状

`MessageParameterType` のコメント (誤りはすべて `SUBGROUP_FILTER` 〜 `TRACK_PROPERTY_FILTER` と `LOCATION_FILTER` / `GROUP_ORDER` の各エントリ):

- `SUBGROUP_FILTER` に「(Section 10.2.15)」— 正しくは §10.2.10
- `OBJECTID_FILTER` に「(Section 10.2.16)」— 正しくは §10.2.11
- `PRIORITY_FILTER` に「(Section 10.2.17)」— 正しくは §10.2.12
- `OBJECT_PROPERTY_FILTER` に「(Section 10.2.18)」— 正しくは §10.2.13
- `TRACK_PROPERTY_FILTER` に「(Section 10.2.19)」— 正しくは §10.2.14
- `LOCATION_FILTER` に「(Section 10.2.9 SUBSCRIPTION FILTER Parameter)」— セクション番号 10.2.9 は正しいが、タイトルが draft-18 の旧名「SUBSCRIPTION FILTER」のまま (draft-19 は「LOCATION FILTER」)。0340 のリネーム漏れ
- `GROUP_ORDER` のコメント「Publisher の GROUP_ORDER_PREFERENCE は Track Property として使用。」— `GROUP_ORDER_PREFERENCE` は draft-19 に存在しない (正しくは `DEFAULT_PUBLISHER_GROUP_ORDER` (Property Type 0x22、§12.5))。draft-17 からの残存
- 他のパラメータ (OBJECT_DELIVERY_TIMEOUT / AUTHORIZATION_TOKEN / RENDEZVOUS_TIMEOUT / SUBGROUP_DELIVERY_TIMEOUT / EXPIRES / LARGEST_OBJECT / FILL_TIMEOUT / FORWARD / SUBSCRIBER_PRIORITY / NEW_GROUP_REQUEST / TRACK_NAMESPACE_PREFIX) のセクション番号は draft-19 の目次と一致 (照合済み)。EXPIRES (0x08) の §10.2.15 は正しく、誤っているのは SUBGROUP_FILTER 側の重複

誤りの由来: 正しい 10.2.10-14 で実装された後、closed issue 0343 の実装が「節番号シフト」として draft-18 由来の参照のみに適用すべき更新を Range Filter コメントにも機械適用した。

変更対象ファイル: `src/message/types.ts` (コメントのみ。コード変更なし)。

## 設計方針

- Range Filter 5 種のコメントのセクション番号を draft-19 の正しい番号 (§10.2.10-14) に修正し、同一ブロックの他エントリと揃えて正式節タイトル (SUBGROUP FILTER Parameter / OBJECTID FILTER Parameter / PRIORITY FILTER Parameter / OBJECT PROPERTY FILTER Parameter / TRACK PROPERTY FILTER Parameter) も付ける (0343 の完了条件「正式節タイトルになっていること」と整合)。
- `LOCATION_FILTER` のコメントタイトルを「LOCATION FILTER Parameter」に、`GROUP_ORDER` のコメントの `GROUP_ORDER_PREFERENCE` を `DEFAULT_PUBLISHER_GROUP_ORDER` に修正する。
- `MessageParameterType` の全エントリのセクション番号を draft-19 の目次 (refs/moq/draft-ietf-moq-transport-19.txt の §10.2.1-10.2.19) と照合し、誤りがないことを確認する (照合済みの他パラメータに変更はない)。
- 再発防止: 節番号シフトの更新は draft-18 由来の参照のみに適用し、draft-19 表記のコメントを動かさないこと。

## 完了条件

- Range Filter 5 種のコメントのセクション番号が §10.2.10-14 に修正され、正式節タイトルが付いていること。
- `LOCATION_FILTER` のコメントタイトルが「LOCATION FILTER Parameter」に、`GROUP_ORDER` のコメントの `GROUP_ORDER_PREFERENCE` が `DEFAULT_PUBLISHER_GROUP_ORDER` に修正されていること。
- `MessageParameterType` の全エントリのコメントのセクション番号が draft-19 の目次と一致すること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- draft-ietf-moq-transport-19 §10.2.10 (SUBGROUP FILTER Parameter)
- draft-ietf-moq-transport-19 §10.2.11 (OBJECTID FILTER Parameter)
- draft-ietf-moq-transport-19 §10.2.12 (PRIORITY FILTER Parameter)
- draft-ietf-moq-transport-19 §10.2.13 (OBJECT PROPERTY FILTER Parameter)
- draft-ietf-moq-transport-19 §10.2.14 (TRACK PROPERTY FILTER Parameter)
- draft-ietf-moq-transport-19 §10.2.9 (LOCATION FILTER Parameter)
- draft-ietf-moq-transport-19 §12.5 (DEFAULT_PUBLISHER_GROUP_ORDER)
- 関連: `issues/closed/0340-draft-19-rename-subscription-filter-to-location-filter.md`（LOCATION_FILTER リネームの元。コメントタイトルの修正漏れ）
- 関連: `issues/closed/0343-draft-19-update-spec-reference-comments.md`（節番号シフトの機械適用で本 issue の誤りを導入した元）

## 解決方法

- `src/message/types.ts` の `MessageParameterType` コメント (コメントのみ。コード変更なし) を修正した:
  - Range Filter 5 種のセクション番号を §10.2.10-14 に修正し、正式節タイトル (SUBGROUP FILTER Parameter / OBJECTID FILTER Parameter / PRIORITY FILTER Parameter / OBJECT PROPERTY FILTER Parameter / TRACK PROPERTY FILTER Parameter) を付与した
  - `LOCATION_FILTER` のコメントタイトルを「LOCATION FILTER Parameter」に修正した (draft-18 の旧名「SUBSCRIPTION FILTER」のままだった 0340 のリネーム漏れ)
  - `GROUP_ORDER` のコメントの `GROUP_ORDER_PREFERENCE` を `DEFAULT_PUBLISHER_GROUP_ORDER` に修正し、参照を §12.5 (DEFAULT PUBLISHER GROUP ORDER) に変更した (draft-17 からの残存)
  - レビューで見つかった `SUBGROUP_DELIVERY_TIMEOUT` の節タイトルの表記ゆれ (SUBGROUP_DELIVERY TIMEOUT → SUBGROUP_DELIVERY_TIMEOUT) もついでに修正した
- 全エントリのセクション番号と節タイトルを `refs/moq/draft-ietf-moq-transport-19.txt` の目次 (§10.2.1-10.2.19) と一字一致で照合し、誤りがないことを確認した
- レビュー 3 周すべて致命的・重要 0 件 (1 周目・3 周目は指摘なし、2 周目の改善 1 件は反映済み)
