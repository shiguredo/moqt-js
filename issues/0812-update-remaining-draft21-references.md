# 残っている draft-21 の節番号・図表番号の参照を draft-22 に合わせる

- Created: 2026-10-03
- Completed: {YYYY-MM-DD}
- Branch: feature/update-remaining-draft21-references
- Polished: {YYYY-MM-DD}

## 目的

0796〜0808 で draft-22 の節構成・番号の変更に追随したが、各 issue が対象とした範囲の外に `draft-ietf-moq-transport-21` の版表記と、v21 の番号のままの節番号・図表番号が残っている。ドラフトの節番号と図表番号は版ごとにずれるため、残った参照は読み手に誤った箇所を示す。参照を draft-22 に揃える。

## 現状

残っている参照の例 (実際に確認したもの):

- `src/dataStream/subgroup.ts` の SUBGROUP_HEADER / Subgroup Object Fields の Figure 番号 (v21 の Figure 25 / 26)。v22 は Figure 26 / 27 で、`src/dataStream/datagram.ts` の OBJECT_DATAGRAM も v22 では Figure 25 (v21 は 24)
- `src/message/types.ts` などの `draft-ietf-moq-transport-21 Section 9.x` 表記 (`rg -c "moq-transport-21 Section 9\.[0-9]" src` で 30 ファイル以上)。§9.20 系は 0803 で更新済みだが、§9.1〜§9.19 の表記は v21 のまま残っている
- `src/publisher.test.ts` / `src/publisher.prop.ts` の見出しが `Section 3.2.1` を指しているが、v22 の §3.2.1 は Fetch Object Delivery であり、内容は §3.3.1 (Location Filters) に対応する
- `refs/moq/draft-ietf-moq-transport-22.txt` を正として、v21 と v22 で番号が変わった節 (例: §3.1.x の繰り下がり、§3.2.x、§11.x の図表) を 1 つずつ確認する必要がある

## 設計方針

- 参照を「版表記」「節番号」「図表番号」「逐語引用」の 4 種類に分けて洗い出し、`refs/moq/draft-ietf-moq-transport-22.txt` と 1 件ずつ突き合わせる
- 機械置換は行わない。0803 の作業で、1 行に複数の番号がある行や、名前と番号が離れている行で誤変換が発生したため、番号の直前・直後にあるシンボル名・節名で対応を確認してから直す
- v21 の文面を引用している箇所は、v22 の文面に直すか、v21 の版表記のまま残すかを判断する (v22 に同じ文が無い場合は版表記を v21 に保つ)
- 番号が v21 と v22 で同じ節 (例: §9.1.1〜§9.1.7 / §3.3.2 / §3.4) は版表記だけを更新する
- 1 ファイルずつ修正し、`npx tsc --noEmit` と `vp check` で確認しながら進める

## 完了条件

- `rg "moq-transport-21" src devtools` の残りが、v21 を意図的に引用している箇所 (v21 の文面を引用しているコメントなど) だけになっている
- 節番号・図表番号が v22 の一次資料と一致している (各参照について、指す先の節名と内容が一致していることを確認する)
- 逐語引用が v22 の原文と一致している (v21 の文面を残す場合は版表記が v21 である)
- `vp check` / `tsc --noEmit` / `vp test run` が通る

## 参照

- `refs/moq/draft-ietf-moq-transport-22.txt`
- `src/dataStream/datagram.ts` / `src/dataStream/subgroup.ts`
- `src/message/types.ts` / `src/message/setup.ts` / `src/message/parameter/kvp.ts`
- `src/publisher.test.ts` / `src/publisher.prop.ts`
- `src/session/dataStreamIncoming.ts` / `src/session/params.ts` / `src/session/bidi.ts`
- 関連 issue: 0796 / 0797 / 0798 / 0799 / 0800 / 0801 / 0802 / 0803 / 0804 / 0805 / 0806 (各 issue が対象とした範囲は更新済み)

## 解決方法

{未着手}
