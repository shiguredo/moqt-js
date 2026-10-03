# 残っている draft-21 の節番号・図表番号の参照を draft-22 に合わせる

- Created: 2026-10-03
- Completed: 2026-10-03
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

`refs/moq/draft-ietf-moq-transport-22.txt` と v21 (git 履歴 `d011611e`) の節見出しを突き合わせ、残っていた参照を draft-22 に揃えた。挙動の変更はない。

### 1. 節番号の対応表

v21 と v22 で同じ番号の節の題名が変わるもの (番号が繰り下がった節) を洗い出し、その対応で修正した。

| v21 | v21 の題名 | v22 |
| --- | --- | --- |
| §1.5 | Modularity | §1.6 |
| §2.1.1 | Canonical Object Fields | §2.1.2 |
| §2.4.2 | Reserved Namespaces | §2.4.3 |
| §3.1.1 / §3.1.2 / §3.1.3 | Subscription State Management / Track Alias / Largest Object | §3.1.2 / §3.1.3 / §3.1.4 |
| §3.2.1 | Fetch State Management | §3.2.4 |
| §3.6 | Mandatory Track Properties | §3.7 |
| §4.1 / §4.2 / §4.3 | Subscribing to Namespaces / Publishing Namespaces / Filtering SUBSCRIBE_TRACKS | §4.2 / §4.1 / §3.6.1 |
| §7.5 / §7.6 / §7.7 | Publisher Interactions / Relay Track Handling / Relay Object Handling | §7.6 / §7.7 / §7.8 |
| §9.20.2〜§9.20.22 | (Allowed Parameters の廃止と各パラメータの繰り下がり) | §9.20.2〜§9.20.21 |
| §11.1.1 / §11.1.2 / §11.1.3 | Object Header / Object Status / Object Properties | (廃止) / §11.1.1 / §11.1.2 |

- 番号が変わらない節 (§8.3 / §9.1〜§9.19 / §11.3.1 / §12.1 など) は版表記のみ v22 に更新した (1683 行)
- 図番号も v22 のキャプションに合わせた (OBJECT_DATAGRAM 24 → 25、SUBGROUP_HEADER 25 → 26、Subgroup Object Fields 26 → 27、FETCH Message 15 → 16、Key-Value-Pair 2 → 3、FETCH_HEADER / Fetch Object Fields は 0798 で更新済み)
- §3.7 の節名 (Mandatory to Understand Track Properties) や v22 で語句が変わった引用 (§3.1.3.1 の "buffer it briefly"、§8.6 の delta 加算超過、§9.20.1 の "If a parameter appears ..."、§3.3.2 の "it is unchanged") を v22 の文面に直した

### 2. v21 を意図的に残した参照 (12 行)

- v21 の SETUP 統合の経緯 (4 行)、v21 Appendix A.2 の変更履歴 (3 行)、v21 の文面を引用する行 (5 行。v22 では呼称が REQUEST_UPDATE_OK / TRACK_STATUS_ERROR になるため、引用に合わせて v21 の版表記を保ち、v22 の呼称を併記した)
- `src/loc.ts` の LOC Property の provisional 値は v22 の Table 16 を指すように更新した

### 3. レビューで見つけて直した誤り

機械的な版表記の更新だけでは不十分で、次の誤りをレビュー 2 周で検出して修正した。v22 に存在しない §11.1.3 を引いていた行 (17 行)、Key-Value-Pair を Figure 2 としていた行 (10 行)、§3.7 の旧節名 (10 行)、出典不明の引用 (§8.6 の delta 加算超過 3 行)、v21 の呼称を引用しながら v22 を名乗っていた行 (§9.5.1 / §9.13 / §3.3.2)、`publisher.test.ts` / `publisher.prop.ts` の見出し (§3.2.1 → §3)、devtools の表示文字列 (draft-21 → draft-22)。

### 4. 検証

`vp check` / `tsc --noEmit` / `vp test run` (198 files / 3576 tests) が通る。差分行はすべてコメント・表示文字列で、実行コードの挙動は変えていない。

### 5. 本 issue の対象外とした残り

- `README.md` / `docs/*.md` / `tests/e2e/*` に v21 の参照が 22 行残っている (本 issue の完了条件は `src` と `devtools` が対象)
- 接続時のプロトコル識別子は `moqt-21` のままである (`src/connect.ts`)。コメントは v22 を指す一方でワイヤは draft-21 を広告しており、どちらに合わせるかは別途判断が必要である
