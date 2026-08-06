# message/types.ts の Range Filter パラメータのセクション番号コメントを修正する

- Priority: Low
- Created: 2026-08-06
- Completed: {YYYY-MM-DD}
- Model: DeepSeek V4 Flash
- Branch: feature/fix-moqt-draft-19-comment-section-number
- Polished: {YYYY-MM-DD}

## 目的

`src/message/types.ts` の MessageParameterType コメントに記載されたドラフトのセクション番号を正しい値に修正する。現在 SUBGROUP_FILTER 以降の Range Filter 5 種が「10.2.15」〜「10.2.19」と記載されているが、draft-19 では 10.2.10 〜 10.2.14 が正しい。

## 優先度根拠

仕様参照コメントの誤りは、実装者がドラフトの該当箇所を誤って参照する原因になる。軽微だが broken window を放置しない。Low。

## 現状

- `src/message/types.ts:171-231` の `MessageParameterType` コメント:
  - `SUBGROUP_FILTER` に「(Section 10.2.15)」— 正しくは §10.2.10
  - `OBJECTID_FILTER` に「(Section 10.2.16)」— 正しくは §10.2.11
  - `PRIORITY_FILTER` に「(Section 10.2.17)」— 正しくは §10.2.12
  - `OBJECT_PROPERTY_FILTER` に「(Section 10.2.18)」— 正しくは §10.2.13
  - `TRACK_PROPERTY_FILTER` に「(Section 10.2.19)」— 正しくは §10.2.14
- `EXPIRES` (0x08) の §10.2.15 と番号が重複しており、誤りであることが明らか。

## 設計方針

- 各 Range Filter パラメータのコメントのセクション番号を draft-19 の正しい番号 (§10.2.10-14) に修正する。
- 他のパラメータのセクション番号も draft-19 の目次と照合して誤りがないか確認する。

## 完了条件

- コメントのセクション番号が draft-19 の目次と一致すること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- draft-ietf-moq-transport-19 §10.2.10 (SUBGROUP FILTER Parameter)
- draft-ietf-moq-transport-19 §10.2.11 (OBJECTID FILTER Parameter)
- draft-ietf-moq-transport-19 §10.2.12 (PRIORITY FILTER Parameter)
- draft-ietf-moq-transport-19 §10.2.13 (OBJECT PROPERTY FILTER Parameter)
- draft-ietf-moq-transport-19 §10.2.14 (TRACK PROPERTY FILTER Parameter)

## 解決方法

未着手。
