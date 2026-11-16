# MSF draft-02 追従調査: Catalog の骨格

> **決定事項 (本レポートの後に確定)**: draft-01 との互換性は維持しない。
> したがって、本レポートの「互換性影響」欄にある「両方を受ける」「移行期は旧綴りも受理する」
> 「後方互換になる」といった選択肢は採らない。実装時は [README.md](README.md) 冒頭の決定事項を優先する。

- 調査対象: moqt-js (`/home/shiguredo/shiguredo/moqt-js`)、HEAD `bc7abdbf`「refs の draft-ietf-moq-msf を draft-02 に更新する」
- 正本 (draft-02): `refs/moq/draft-ietf-moq-msf-02.txt` (5600 行)
- 比較用 (draft-01): `refs/moq/draft-ietf-moq-msf-01.txt` (4144 行)
- リポジトリ内のファイルは一切変更していない (読み取り専用)。
- 調査日: 2026-11-16

## 0. 調査方法と表記

- 仕様の引用は `refs/moq/draft-ietf-moq-msf-02.txt:行番号` とし、draft-01 は `refs/moq/draft-ietf-moq-msf-01.txt:行番号` と表記する。
- 実装の引用は `path:行番号` と表記する (行番号は上記 HEAD 時点のもの)。
- 担当範囲の仕様節は全文を読んだ: §5 intro (683-746)、§5.1 (747-926)、§5.3 (1976-2020)、§5.4 (2021-2076)、§5.5 (2077-2087)、§11.2 (4278-4411)、§13 (4743-4972)。加えて、これらの節が参照する §5.2.2 / §5.2.3 / §5.2.4 / §5.2.14 / §5.2.15 / §5.2.34 / §5.2.35 / §5.2.37 / §5.2.40 / §5.2.41 / §12.1 / §12.2 も読んだ。
- 担当範囲の実装ファイルは全文を読んだ: `src/msf/version.ts`、`src/msf/catalogCodec.ts`、`src/msf/catalogValidation.ts`、`src/msf/catalogDelta.ts`、`src/msf/json.ts`、`src/msf/variables.ts`、`src/fullTrackName.ts`、`src/msf.ts`。加えて `src/msf/types.ts`、`src/msf/catalogTrackValidation.ts`、`src/msf/tracks.ts`、`src/msf/authInfo.ts`、`src/msf/fragment.ts`、`src/mediaSubscriber/catalogSubscription.ts`、`src/createMediaSubscriber.ts` の catalog 経路、`src/createMediaPublisher.ts` の catalog 送信経路、`src/catalogRepublish.ts` を読んだ。
- テストは `src/msf.test.ts` (3441 行) と `src/msf.prop.ts` (1205 行) の全テスト名を確認し、担当範囲に関わるテストを読んだ。加えて `src/createMediaSubscriber.catalog.test.ts` を確認した。
- 静的な読解に加え、`dist/index.js` (ビルド済み `2026.3.0-canary.0`) を Node.js から実行して挙動を実測した。実測結果は付録 A に載せる。`dist` が `src` より古い可能性は排除できないが、実測した挙動は `src` の該当コードと一致していることを確認した。
- 指示にあった「`$` エスケープ規則の変化」は、draft-01 / draft-02 のどちらの §5.4 にも存在しない。両方とも変数は `%name%` で、`$` は §11.1 の ABNF (`sub-delims`) にしか現れない (`refs/moq/draft-ietf-moq-msf-02.txt:4068-4069`、`refs/moq/draft-ietf-moq-msf-01.txt:3396-3397`)。誤認と判断し、本レポートでは `%` 規則の変更として整理した。

## 1. 結論サマリ (最重要 5 件)

1. **CAT-01: `version` の値**。encode は `MSF_VERSION = "draft-01"` 固定 (`src/msf/version.ts:25`)、decode は `{"draft-01", "1"}` のみ受理 (`src/msf/version.ts:33`)。draft-02 §5.1.1 (774-791) は "draft-XX" 規約で、draft-02 の全 16 例が `"draft-02"` を使う (`refs/moq/draft-ietf-moq-msf-02.txt:2134` ほか)。このままでは draft-02 の catalog を 1 つも decode できず、こちらの catalog も相手に拒否される。**P0**。
2. **CAT-05: delta update のルートフィールド拘束**。draft-02 §5.3 (1994-1997) は「`deltaUpdate` (1 操作以上) と `generatedAt` を MUST で含み、他の Root Catalog フィールドを MUST NOT で含む」。実装は `generatedAt` を任意にし (`src/msf/catalogCodec.ts:239-249, 345-358`)、`publishTracks` / `isComplete` / `initDataList` を未知フィールドとして受理・保持する (`src/msf/catalogCodec.ts:360-369`)。実測でも受理された。**P0**。
3. **CAT-06: `update` 操作の欠落**。draft-02 §5.1.6 (875-880) が `update` を追加し、§5.6.4 の例 (2416-2424) も使う。実装は `unknown op 'update', expected one of [add, remove, clone]` で拒否する (`src/msf/catalogCodec.ts:417-419`)。**P0**。
4. **CAT-14: Track Namespace の `/` 区切り化と Full Track Name 解決**。draft-02 §5.2.2 (1069-1098) は namespace を `/` 区切りの 1-32 フィールドに変え、malformed は catalog invalid。実装は namespace を単一の不透明文字列として扱い (`src/msf/types.ts:117`)、高レベル購読は catalog の `track.namespace` を無視して URL の namespace で SUBSCRIBE する (`src/createMediaSubscriber.ts:2119, 2140, 2192`)。draft-02 の例 (§5.6.1 の `"namespace": "conference.example.com/conference123/alice"`) のような catalog では誤った Full Track Name を購読する。**P0**。
5. **CAT-13: §11.2 name mapping の必須検査**。catalog document は UTF-8 かつ BOM 禁止 (`refs/moq/draft-ietf-moq-msf-02.txt:4329-4330`)、孤立サロゲートは consumer が catalog invalid としなければならない (4317-4322)。実装は非 fatal の `TextDecoder` と BOM 除去に依存し (`src/msf/catalogCodec.ts:273`)、孤立サロゲートも受理する (実測)。**P0**。

次点は CAT-07 (illogical operation の per-op 検査がなく、`add` 既存 + `remove` でエラーにならない) と CAT-11/CAT-12 (§5.4 の文字制約変更と置換後検証)。

## 2. draft-01 → draft-02 の Catalog 骨格の変更点 (仕様側)

draft-02 末尾の変更履歴 A.1.3 (5396-5462) と A.1.7 (5517-5524) が一次サマリである。担当範囲の骨格に関わる変更を、draft-01 の該当行と対比して整理する。

| 項目                            | draft-01                                                         | draft-02                                                                                                       | 根拠 (draft-02 / draft-01) |
| ------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | -------------------------- |
| catalog の入れ子参照            | 規定なし                                                         | catalog track は他の catalog track を参照 MAY。`packaging: "catalog"` を追加                                   | 693, 1145 / (なし)         |
| catalog track 名                | 「The catalog track MUST have ... "catalog"」                    | 「The **top-level** catalog track MUST have ... "catalog"」                                                    | 695-696 / 509              |
| publisher / subscriber priority | 規定なし                                                         | catalog track は記述する track より高い publisher priority が SHOULD。購読は高い subscriber priority が SHOULD | 709-714 / (なし)           |
| catalog 公開のトリガ            | tracks の availability が変わったとき                            | catalog の content が変わったとき                                                                              | 705-707 / 518-520          |
| Object マッピング               | Subgroup 0 / Object ID 0 = independent / >= 1 = delta            | 同文 (「sub-group」→「Subgroup」の表記のみ)                                                                    | 716-722 / 522-528          |
| Joining FETCH                   | SUBSCRIBE + Joining FETCH (offset = 0) MUST                      | 同文 (変更なし)                                                                                                | 733-736 / 530-533          |
| delta のルートフィールド        | `tracks` / `version` のみ MUST NOT。`generatedAt` は任意         | `generatedAt` も MUST。他の Root Catalog フィールドすべて MUST NOT                                             | 1994-1997 / 1552-1554      |
| delta の操作                    | add / remove / clone                                             | add / remove / clone / **update**                                                                              | 851-880 / 662-690          |
| 属性の不変性                    | track 属性は宣言後 MUST NOT 変更。変更は別 track を作って remove | 不変性の規則を削除。`update` で変更可                                                                          | 1985-1989 / 1573-1577      |
| illogical operation             | 明示の規則なし                                                   | `add` 既存名 / `remove`・`update` 未知 / `clone` 既存名は catalog を reject MUST                               | 2010-2012 / (なし)         |
| initDataList の型               | `inline` のみ                                                    | `inline` / `track-property` / `object-property`                                                                | 901-914 / 702-712          |
| initDataList の位置             | tracks の後ろに MUST                                             | tracks の後ろに SHOULD                                                                                         | 922-926 / 716-719          |
| 変数名の文字制約                | 英数字 / ハイフン / アンダースコア                               | 制約を撤廃                                                                                                     | 2031-2032 / 1594-1597      |
| 変数値の文字制約                | 英数字 / ハイフン / アンダースコア / `@`                         | `+` `/` `=` `.` を追加                                                                                         | 2038-2043 / 1603-1608      |
| fragment の分割                 | `&` 区切り、`=` 区切り                                           | 各ペアを**最初の** `=` で分割                                                                                  | 2059-2063 / 1629-1633      |
| 置換後の名前マッピング          | 規定なし                                                         | §11.2 の name mapping を置換後に適用                                                                           | 2045-2046 / (なし)         |
| §11.2 name mapping              | 節自体が存在しない (§11.2 は Initiating a broadcast)             | UTF-8 / 正規化なし / バイト完全一致 / 孤立サロゲート・NUL 禁止 / BOM 禁止                                      | 4278-4411 / 3589           |
| §13 Security Considerations     | `ToDo` のみ                                                      | 9 節の規範要件 (trackBaseKey / 展開後サイズ上限 / 循環検出 / 置換後検証 ほか)                                  | 4743-4971 / 3832-3834      |

## 3. 差分一覧 (CAT)

各項目は「仕様要件」「draft-01 での扱い」「現行実装」「必要な変更」「互換性影響」「優先度」の順に書く。優先度は P0 = draft-02 準拠に必須、P1 = 望ましい、P2 = 先送り可。

### 差分サマリ表

| ID     | 概要                                                                                  | 要否                 | 優先度                |
| ------ | ------------------------------------------------------------------------------------- | -------------------- | --------------------- |
| CAT-01 | `version` を `"draft-02"` にし、受理集合を更新する                                    | 要                   | P0                    |
| CAT-02 | `packaging: "catalog"` の追加と入れ子 catalog の扱い                                  | 要 (入れ子追従は P1) | P1                    |
| CAT-03 | catalog object のマッピング規則 (Subgroup 0 / Object ID 0 / >= 1) の購読側検証        | 要                   | P1                    |
| CAT-04 | catalog track の publisher priority / subscriber priority の SHOULD                   | 要                   | P1                    |
| CAT-05 | delta update のルートフィールド拘束 (`generatedAt` 必須、他は禁止)                    | 要                   | P0                    |
| CAT-06 | `update` 操作の追加                                                                   | 要                   | P0                    |
| CAT-07 | illogical operation の per-op 検出 (`add` 既存 / `clone` 既存名)                      | 要                   | P0                    |
| CAT-08 | `remove` / `clone` / `update` の track object の必須・許可フィールド                  | 要                   | P0                    |
| CAT-09 | `clone` の属性継承と上書き (実装は仕様どおり。確認のみ)                               | 不要                 | なし                  |
| CAT-10 | initDataList の `track-property` / `object-property` と `data` の意味、配置 SHOULD 化 | 要                   | P0                    |
| CAT-11 | Variable Substitution の文字制約変更 (名前制約撤廃、値に `+ / = .`)                   | 要                   | P0                    |
| CAT-12 | 置換の配線・置換後の catalog 検証 (MUST)・endpoint フィールドの SHOULD NOT            | 要                   | P0 (検証) / P1 (配線) |
| CAT-13 | §11.2.1 の UTF-8 / BOM / 孤立サロゲート / NUL 検査                                    | 要                   | P0                    |
| CAT-14 | namespace の `/` 区切り・Full Track Name 比較・購読時の namespace 解決                | 要                   | P0                    |
| CAT-15 | §13.2 `trackBaseKey` の MUST NOT                                                      | 要                   | P1                    |
| CAT-16 | §13.7 展開後サイズ上限・循環検出・delta 連鎖上限などの資源防御                        | 要                   | P1                    |
| CAT-17 | §13 のその他 SHOULD (E2E 保護・timing sanity bound・publishTracks ポリシー)           | 一部要               | P2                    |
| CAT-18 | §5.5 / §12.1 catalog 圧縮 (MSF_COMPRESSION 0x78) の受信対応                           | 要 (§12 担当と連携)  | P0                    |
| CAT-19 | Joining FETCH の fill fetch (SUBSCRIBE + FILL_PARAMETERS) への移行                    | 要                   | P1                    |
| CAT-20 | 仕様節番号の更新 (コメント・エラーメッセージ)                                         | 要                   | P2                    |

---

### CAT-01: `version` の値と受理集合

**仕様要件**

- §5.1.1 (774-780): `version` は Required: Yes / JSON Type: String。`"A subscriber MUST NOT attempt to parse a catalog version which it does not understand."` (779-780)
- §5.1.1 (789-791): `"For usage against IETF Internet-Draft releases, follow the convention of specifying the version as "draft-XX". For example "draft-03" refers to the -03 draft release."`
- draft-02 の全 catalog 例 16 個が `"version": "draft-02"` を使う (`refs/moq/draft-ietf-moq-msf-02.txt:2134, 2176, 2281, 2526, 2582, 2638, 2703, 2806, 2848, 2923, 2974, 2993, 3030, 3065, 3142, 3174`)。A.1.1 (5364-5365): `"Catalog examples were corrected, and they now use "draft-02" as the version string."`
- 一方 draft-02 には `"1"` を使う例が 1 つもない。

**draft-01 での扱い**

- 本文の MUST は同一 (`refs/moq/draft-ietf-moq-msf-01.txt:585-597`)。ただし draft-01 の catalog 例 15 個はすべて `"version": "1"` (`:1686` ほか)。これが実装が `"1"` を受理する根拠になっている (`src/msf/version.ts:18-20` のコメント)。

**現行実装**

- `MsfVersion = "draft-01" | "1"` (`src/msf/version.ts:22`)。
- encode 時の値は `MSF_VERSION = "draft-01"` 固定 (`src/msf/version.ts:25`)。`createCatalog` (`src/msf/tracks.ts:94`) と `createCompleteCatalog` (`src/msf/tracks.ts:117`) がこれを使う。
- decode の受理集合は `MSF_KNOWN_VERSIONS = new Set(["draft-01", "1"])` (`src/msf/version.ts:33`)。`validateCatalog` が集合外を拒否する (`src/msf/catalogValidation.ts:47-60`)。
- 実測: `{"version":"draft-02",...}` は `invalid catalog: unsupported MSF version 'draft-02', expected one of [draft-01, 1]` で拒否。`"1"` は受理 (付録 A-1, A-2)。

**必要な変更**

1. `MsfVersion` を `"draft-02"` にする (必要なら decode 専用の受理型を別に持つ)。
2. `MSF_VERSION` を `"draft-02"` にする。
3. `MSF_KNOWN_VERSIONS` に `"draft-02"` を入れる。
4. `"1"` と `"draft-01"` を受理し続けるかは判断が要る (下記「要確認」)。§5.1.1 の MUST NOT に素直に従うなら、この実装が理解しているのは draft-02 のフィールド解釈だけなので、`MSF_KNOWN_VERSIONS = {"draft-02"}` とし、`"draft-01"` / `"1"` は unsupported にするのが一貫する。draft-01 の catalog を draft-02 の解釈で読むと、namespace の `/` 区切り・delta のルートフィールド拘束・initDataList の型が変わるため、誤解釈になる (`"draft-01"` の受理は §5.1.1 の MUST NOT に反するおそれがある)。
5. エラーメッセージの `expected one of [...]` は集合から自動生成されるため、集合を変えれば追従する (`src/msf/catalogValidation.ts:55-59`)。

**互換性影響**

- wire: encode の `version` が変わる。draft-01 実装とは相互に catalog を読めなくなる (意図した破壊的変更)。draft-02 の相手とは読めるようになる。
- TypeScript API: 公開型 `MsfVersion` の変更は破壊的 (`src/index.ts:143` で公開)。`Catalog.version` に `"draft-02"` を要求するため、利用者のリテラルも変わる。
- `"1"` の受理をやめる場合、draft-01 の例に倣った catalog を送る相手とは読めなくなる。

**優先度**: P0。catalog の相互運用の入口であり、これだけで draft-02 の catalog を一切読めない。

---

### CAT-02: `packaging: "catalog"` と入れ子 catalog

**仕様要件**

- §5 (693): `"A catalog track MAY reference other catalog tracks."`
- §5 (695-696): `"The top-level catalog track MUST have a case-sensitive Track Name of "catalog"."` (draft-01 の「The catalog track」から「The top-level catalog track」に限定)
- §5.2.4 Table 5 (1145): packaging の許容値に `| Catalog | catalog | See Section 5 |` を追加。
- §5.6.16 (3128-3163): 他の catalog を 3 つ参照する例。参照先は `tracks` 配列内の `{"name": "premium-catalog", "isLive": true, "packaging": "catalog"}` のような track object。
- A.1.3 (5398-5400): `"A catalog MAY now reference other catalogs, via a new "catalog" packaging value. Only the top-level catalog track MUST be named "catalog"."`
- §13.7 (4943-4945): 参照を追う実装は循環検出 MUST (`"Subscribers MUST detect reference cycles and SHOULD bound the depth of catalog references they will follow."`)。

**draft-01 での扱い**

- 「catalog track」だけが catalog で、他の catalog 参照の規定はない (`refs/moq/draft-ietf-moq-msf-01.txt:509`)。packaging の許容値にも `catalog` はない (`:856-870`)。

**現行実装**

- `CATALOG_TRACK_NAME = "catalog"` (`src/msf/version.ts:36`)。使われ方はトップレベル catalog の購読 (`src/mediaSubscriber/catalogSubscription.ts:226, 310`)、PUBLISH (`src/createMediaPublisher.ts:1828`)、metrics catalog 名 (`src/moqmetrics.ts:764`) のみ。
- `PackagingType` に `"catalog"` がない (`src/msf/version.ts:44`)。ただし `validateCatalogTrack` は packaging を「文字列であること」しか検証しない (`src/msf/catalogValidation.ts:381-387`)。実測でも `packaging: "catalog"` と未知の packaging 文字列を decode できた (付録 A-4)。つまり wire としては読めるが、型として表現できず、入れ子 catalog を列挙・購読・再帰解決する処理は存在しない。
- 高レベル購読はトップレベル catalog 1 本しか購読しない (`src/mediaSubscriber/catalogSubscription.ts:224-255`)。
- catalog を再帰的に取得する API、循環検出、深さ上限は存在しない。

**必要な変更**

1. `PackagingType` に `"catalog"` を追加する (`src/msf/version.ts:44`)。Table 5 の許容値変更に追従。未知 packaging を受理し続けるかは別問題 (下記「要確認」)。
2. 入れ子 catalog を追うかは設計判断。追う場合:
   - `tracks` から `packaging === "catalog"` の track を列挙する helper (例 `getCatalogTracks`) を追加。
   - 各参照先の Full Track Name (namespace は §5.2.2 の `/` 区切り、名前は track.name) で SUBSCRIBE/FETCH し、受信 Object を同じ規則 (§5 の Object マッピング) で decode/apply する。
   - 循環検出 MUST (§13.7) と深さ上限 SHOULD を実装。参照元 catalog の Full Track Name 集合を訪問済みとして持つ。
   - 参照先 catalog の `version` も検証する。
3. 追わない場合でも、`packaging: "catalog"` の track を「メディア track ではない」として扱い、`getVideoTracks` / `getAudioTracks` などが誤って選択しないことを保証する (現状は role で絞るため通常は混ざらないが、`role: "video"` + `packaging: "catalog"` のような不正な組を検出する必要はない。§5.2.4.1 の表に catalog の行はない)。
4. `CATALOG_TRACK_NAME` はトップレベルにのみ使う。現状の使われ方は仕様に合致しており変更不要。ただし metrics の catalog track 名 (`src/moqmetrics.ts:764`) は MSF のトップレベル catalog とは別の namespace の別 track なので、混同しないようコメントを補うのが望ましい。

**互換性影響**

- `PackagingType` の追加は TypeScript の union 拡張であり、既存コードを壊さない (逆に `switch` の網羅性検査が変わる可能性はある)。
- 入れ子 catalog の追従は新機能で、wire 互換性の破壊はない。
- 未知 packaging を拒否するように変えると、将来の packaging 値を持つ catalog を拒否する (現状は受理)。仕様は「Allowed values are strings as defined in Table 5」(`:1129-1130`) とし、未知値の扱いは明記していないため、受理継続が無難 (要確認)。

**優先度**: P1。トップレベル名の扱いは現状のままでよく、入れ子参照は MAY の機能。ただし §13.7 の循環検出 MUST は「参照を追う実装」に課されるため、追わない限り不要。draft-02 の catalog を扱う上で参照先 track を「catalog である」と認識できないと、アプリに誤ったメディア track 情報を渡すおそれがあるため P1 とする。

---

### CAT-03: catalog Object のマッピング規則の購読側検証

**仕様要件**

- §5 (698-703): `"A catalog object MAY be independent of other catalog objects or it MAY represent a delta update of a prior catalog object. The first catalog object published within a new group MUST be independent and MUST provide a complete catalog that does not require any prior catalog object for interpretation. Any catalog updates that precede the first Object of the latest Group MUST be ignored."`
- §5 (716-722): `"Each catalog update MUST be mapped to an MOQT Object. All catalog updates, both independent and delta, MUST be mapped to MOQT Subgroup 0. The first Object (with Object ID 0) in any Group in a catalog track MUST hold an independent copy of the catalog. All subsequent Objects within that Group (i.e Objects IDs >= 1) MUST hold a delta update. As soon as an independent update is produced, it MUST be placed at the start of a new Group."`

**draft-01 での扱い**

- 同文 (`refs/moq/draft-ietf-moq-msf-01.txt:511-528`)。「sub-group」表記のみ差分。変更なし。

**現行実装**

- publisher 側は概ね適合する: catalog は常に独立 catalog を Object ID 0 で送る (`src/createMediaPublisher.ts:1982-2002`)。送り直しは Group ID を +1 した新しい Group の先頭 Object として送る (`src/createMediaPublisher.ts:2018-2064`)。delta は送らない (`src/createMediaPublisher.ts:1936-1951` のコメント参照)。Subgroup ID は `SendObjectParams` に存在せず、publisher の「1 Group = 1 Subgroup = 1 Stream」モデルで Group 先頭 Object の `subgroupId = objectId` として導出される (`src/publisher.ts:1045-1056`、`src/session.ts:650`)。したがって catalog (objectId 0) は Subgroup 0 で送られるが、これは暗黙の導出であり、テストで固定されていない。なお、将来 publisher が delta を送る場合、objectId 1 以降は `subgroupId = objectId` の新しい Subgroup になるため、§5 の「すべて Subgroup 0」を満たすには publisher 側の拡張が必要 (現状は delta を送らないため違反しない)。
- subscriber 側は検証しない: `processCatalogPayload` は payload を decode した結果の型 (`"deltaUpdate" in message`) だけで full/delta を判定し (`src/createMediaSubscriber.ts:400-420`)、`handleCatalogObject` は届いた全 Object を到着順に適用する (`src/createMediaSubscriber.ts:2428-2458`)。Object ID 0 に delta、Object ID >= 1 に full が来ても受け入れる。Group の新旧比較もしていない (古い Group の Object が後着すると catalog を巻き戻す)。
- FETCH フェーズ中の重複除去は Location 比較で行う (`src/createMediaSubscriber.ts:250-272`、`src/mediaSubscriber/catalogSubscription.ts:503-519`) が、これは FETCH と live の重複対策であり、Group の単調性保証ではない。参考として devtools は適用済み最大 Location を保持して単調性を保証している (`devtools/src/hooks/useSubscriber.ts:3036-3060`)。ライブラリ側にはこの防御がない。

**必要な変更**

1. subscriber の `handleCatalogObject` に状態を追加: 適用済みの最大 Group ID、その Group で最初の Object を適用済みか、その Group の最終 Object ID。
2. 規則の強制:
   - `obj.objectId === 0` のとき、decode 結果が delta なら catalog invalid として拒否 (または無視) する。
   - `obj.objectId >= 1` のとき、decode 結果が独立 catalog なら reject する (Group 先頭が independent である前提を壊す)。
   - `obj.groupId` が適用済み最大 Group より小さい Object は無視する (§5 の "MUST be ignored")。同じ Group 内で Object ID が単調でない場合の扱いも決める。
   - `obj.subgroupId !== 0` の catalog Object は拒否または無視する (Subgroup 0 固定)。受信 Object は `subgroupId?: bigint` を持つ (`src/dataStream/moqtObject.ts:57-60`)。
3. publisher 側は現状の独立 catalog (objectId 0 → subgroupId 0 の導出) をテストで固定する。`SendObjectParams` に subgroupId は無いため、将来 delta を送る場合は「同一 Group の複数 Object を Subgroup 0 の 1 ストリームに載せる」か「`SendObjectParams` に subgroupId を追加する」拡張が必要になる。
4. エラーは既存の契約どおり plain `Error` とし、`onError` へ流す (`src/createMediaSubscriber.ts:2440-2443` の経路)。

**互換性影響**

- 内部挙動のみ。仕様違反の catalog ストリームを従来は受理していたが、拒否・無視するようになる (意図した厳格化)。
- 正常な publisher (moqt-js 自身を含む) には影響しない。

**優先度**: P1。§5 の MUST は publisher (マッピング) に課されたもので、subscriber の検証は防御。ただし悪意・バグのある publisher に対する catalog 破損防止として価値が高い。

---

### CAT-04: catalog track の priority の SHOULD

**仕様要件**

- §5 (709-710): `"The catalog track SHOULD have a higher publisher priority than all tracks described within the catalog."`
- §5 (712-714): `"A subscriber to a catalog track SHOULD use a higher subscriber priority for the catalog subscription than for any other concurrent subscriptions."`
- A.1.3 (5402-5404): 同内容が変更履歴に明記。

**draft-01 での扱い**

- 規定なし (`refs/moq/draft-ietf-moq-msf-01.txt:518-520` の周辺に priority の記述はない)。

**現行実装**

- publisher: catalog の PUBLISH options に `publisherPriority` を指定していない (`src/createMediaPublisher.ts:1822-1845`)。MOQT の既定は 128 (`refs/moq/draft-ietf-moq-transport-23.txt:6019`)。音声・映像の PUBLISH も `publisherPriority` を指定していない (`src/createMediaPublisher.ts` 内に `publisherPriority` の記述はない) ため、track の既定 publisher priority はすべて 128 で「catalog が高い」状態になっていない。
- 個々の catalog Object は `priority: PRIORITY_CATALOG` (0) で送る (`src/createMediaPublisher.ts:69, 1998`)。これは Subgroup ヘッダの publisher priority で、track 既定を上書きする (`refs/moq/draft-ietf-moq-transport-23.txt:2217-2222`)。0 は音声 (64)・映像 delta (128) より高いが、映像キーフレームも 0 (`src/createMediaPublisher.ts:72`) で「すべての track より高い」とは言えない。
- subscriber: catalog の SUBSCRIBE options に `subscriberPriority` を指定していない (`src/mediaSubscriber/catalogSubscription.ts:242-254`)。MOQT の既定は 128 (`refs/moq/draft-ietf-moq-transport-23.txt:5492`)。音声・映像の SUBSCRIBE も指定していないため、catalog だけが高い状態になっていない。`SubscribeOptions.subscriberPriority` は実装済み (`src/session/publicTypes.ts:728-736`。省略時 128 の旨も同コメントにある)。

**必要な変更**

1. catalog の `session.publish` options に `publisherPriority: 0` を明示する (またはメディア track の既定より確実に低い値)。送り直しも同じ publisher を使うため自動で適用される。
2. catalog の `session.subscribe` options に `subscriberPriority: 0` を明示する (または他の購読より確実に低い値)。
3. どちらも SHOULD のため、値の根拠をコメントに残す。

**互換性影響**

- スケジューリングの優先度が変わるのみ。wire 上はパラメータが増えるが、MOQT の任意パラメータであり相互運用性の破壊はない。
- 既存の統計・テストで priority を固定しているものがあれば更新 (要確認)。

**優先度**: P1。SHOULD であり、実装コストが小さい。

---

### CAT-05: delta update のルートフィールド拘束

**仕様要件**

- §5.1.6 (830-849): `deltaUpdate` は「An ordered Array of operation objects」。存在すれば delta、なければ独立 catalog。
- §5.3 (1994-1997): `"A delta update MUST include the Delta Update Section 5.1.6 field with at least one operation and the generatedAt field Section 5.1.2. It MUST NOT include any other Root Catalog fields Section 5.1."`
- §5.1 Table 2 (752-768) の Root Catalog fields は `version` / `generatedAt` / `isComplete` / `tracks` / `publishTracks` / `deltaUpdate` / `initDataList`。
- A.1.3 (5408-5411): `"Delta updates MUST now carry generatedAt and no other root fields."`
- §5.3 (2010-2012) のエラー規則も参照 (CAT-07)。

**draft-01 での扱い**

- §5.3 (1552-1554): `"A delta update MUST include the Delta Update ... field with at least one operation. It MUST NOT contain an instance of a Tracks ... field or an MSF version ... field."` `generatedAt` の必須はなく、`publishTracks` / `isComplete` / `initDataList` は禁止されていなかった。

**現行実装**

- decode: `decodeCatalogDelta` は `version` と `tracks` だけを拒否する (`src/msf/catalogCodec.ts:313-321`)。`generatedAt` は任意で、あれば number / 有限数を検証する (`src/msf/catalogCodec.ts:345-358`)。残りのルートフィールドは「未知フィールド保持」として `publishTracks` / `isComplete` / `initDataList` も受理して保持する (`src/msf/catalogCodec.ts:360-369`。`KNOWN_CATALOG_DELTA_ROOT_FIELDS` は `deltaUpdate` / `operations` / `generatedAt` / `version` / `tracks` のみ、`src/msf/catalogValidation.ts:535-541`)。
- encode: `encodeCatalogDelta` は `generatedAt` を任意で出力し (`src/msf/catalogCodec.ts:239-249`)、`KNOWN_CATALOG_DELTA_ROOT_FIELDS` 以外のルートフィールドをそのまま wire に載せる (`src/msf/catalogCodec.ts:250-257`)。
- 実測: `{"deltaUpdate":[{"op":"add",...}]}` (`generatedAt` なし) を decode できた。`{"generatedAt":1,"publishTracks":[],"deltaUpdate":[...]}`、`isComplete`、`initDataList` を含む delta も decode できた (付録 A-5)。`encodeCatalogDelta` も `generatedAt` なしで出力できた (付録 A-11)。
- `applyCatalogDelta` は `delta.generatedAt ?? current.generatedAt` で引き継ぐ (`src/msf/catalogDelta.ts:155-158`)。`generatedAt` 必須化後もこの処理は成立する。

**必要な変更**

1. decode: `generatedAt` が delta に存在しない場合は reject する (`invalid catalog delta: generatedAt is required per §5.3` など)。存在する場合の型・有限数検証は現状のまま。
2. decode: `version` / `tracks` / `isComplete` / `publishTracks` / `initDataList` を reject する。現状の「未知フィールド保持」は「§5.1 の既知 Root Catalog fields を除いた未知フィールド」に限定する。
3. encode: `generatedAt` を必須にする (undefined なら throw)。
4. encode: `CatalogDelta` の内部型から `publishTracks` 等が混入した場合も wire に載せない、または throw する (cast 経由の混入対策。`src/msf/catalogValidation.ts:526-541` のコメントの意図を維持)。
5. テスト: `src/msf.test.ts:1878-2044` の delta テストはすべて `generatedAt` を付ける。`src/msf.test.ts:1941` の「未知ルートフィールドは decode → encode で round-trip する」は `publishTracks` を含むため、期待値を「reject」に変える。`src/createMediaSubscriber.catalog.test.ts` の delta も同様 (CAT テスト一覧を参照)。

**互換性影響**

- wire: delta に `generatedAt` が必須になる (draft-01 の delta を送る側は拒否される)。draft-02 の MUST に一致。
- TypeScript API: `CatalogDelta.generatedAt` を必須にするかは設計判断。必須にすると既存利用者のコードが壊れる (破壊的変更は CODEBASE.md の方針どおり許容)。
- 既存の受理済み delta (generatedAt なし) が拒否される (意図した厳格化)。

**優先度**: P0。draft-02 の delta を読むために必須で、実装量も小さい。

---

### CAT-06: `update` 操作の追加

**仕様要件**

- §5.1.6 (875-880): `"* "update" - update a subset of fields within an existing track. The value of the "tracks" field is an Array of track objects Section 5.2.1. Each track object MUST include a Parent Name Section 5.2.34 field and MAY include a Parent namespace Section 5.2.35 field. Attributes declared in the track object override existing values."`
- §5.3 (1985-1989): delta で許される操作に「Update properties of a previously declared track」を列挙。
- §5.3 (2010-2012): `"any illogical update operation, such as adding an existing name, removing or updating an unknown track or cloning to an existing name MUST be rejected as an invalid catalog."`
- §5.2.34 (1663-1666): `parentName` は `"MUST only be included inside a 'clone' or 'update' operation in a delta update"`。§5.2.35 (1685-1690) も同様。
- §5.6.4 の例 (2413-2456): 最初の操作が `{"op": "update", "tracks": [{"parentName": "video-1080", "bitrate": 4000000}]}`。

**draft-01 での扱い**

- `update` は存在しない (`refs/moq/draft-ietf-moq-msf-01.txt:662-690` は add / remove / clone のみ)。属性変更は「新しい track を add / clone して古い track を remove」で行う規則 (`:1573-1577`)。

**現行実装**

- `CatalogDeltaOperation` は add / remove / clone の union のみ (`src/msf/types.ts:294-297`)。
- decode は未知 op を `unknown op 'update', expected one of [add, remove, clone]` で拒否する (`src/msf/catalogCodec.ts:417-419`)。実測でも拒否 (付録 A-6)。
- encode は `type` をそのまま `op` に写すだけ (`src/msf/catalogCodec.ts:219-236`) のため、型を足せば `op: "update"` は出力できる。
- `validateCatalogTrack` は `source: "clone"` 以外で `parentName` / `parentNamespace` を拒否する (`src/msf/catalogValidation.ts:404-414`)。`update` 用の検証コンテキストはない。
- `applyCatalogDelta` は remove / add / clone のみ処理する (`src/msf/catalogDelta.ts:62-139`)。update の対象解決・属性合成・合成後の再検証は未実装。

**必要な変更**

1. 型: `CatalogDeltaOperation` に `{ type: "update"; tracks: UpdateTrack[] }` を追加。`UpdateTrack` は `parentName: string` (必須)、`parentNamespace?: string`、および上書きし得る `CatalogTrack` の属性をすべて optional にした型。`name` を許すかは要確認 (下記)。
2. decode (`decodeCatalogDeltaOperation`): `op === "update"` の分岐を追加。`parentName` を MUST 検証、`parentNamespace` を MAY として型検証、それ以外のフィールドは属性として `validateUpdateTrack` で型検証する。`name` / `packaging` / `isLive` を必須にしない。
3. `ValidationContext.source` に `"update"` を追加し (`src/msf/types.ts:348-350`)、`validateCatalogTrack` の clone 相当の「必須を緩める」経路を update にも使う。ただし update は `parentName` 必須で `name` は属性 (許す場合)。
4. apply (`applyCatalogDelta`): clone と同じ親解決 (`normalizeNamespace(cloneTrack.parentNamespace, catalogNamespace)`、`src/msf/catalogDelta.ts:92-97` のロジック) で対象を探し、見つからなければ reject (§5.3 の MUST)。対象 track に属性を `{...target, ...updateProps}` で上書きし、clone と同様に合成後の packaging / role / audio codec / uniqueness / initRef を再検証する (`src/msf/catalogDelta.ts:116-135, 144-148` の検証を共通化)。`parentName` / `parentNamespace` は結果の track に残さない。
5. encode (`encodeCatalogDelta`): update の tracks も template の bigint → number 変換が必要 (`src/msf/catalogCodec.ts:229-235` の `serializeTracksForJson` 経路に update を追加)。
6. エラーメッセージの op 一覧を `[add, remove, clone, update]` にする (`src/msf/catalogCodec.ts:418`)。

**互換性影響**

- wire: `op: "update"` を受理・送信できるようになる。draft-01 の相手に update を送ると拒否される (draft-02 追従の意図どおり)。
- TypeScript API: union の追加は破壊的 (網羅 switch を持つ利用者)。
- `parentName` を持つ track を delta 外で拒否する既存挙動 (`src/msf/catalogValidation.ts:404-414`) は維持する (update 内でのみ許可)。

**優先度**: P0。draft-02 の delta を読むために必須。§5.6.4 の例が update を先頭に置いており、実装できないと実カタログを適用できない。

---

### CAT-07: illogical operation の per-op 検出

**仕様要件**

- §5.3 (2010-2012): `"Error handling - any illogical update operation, such as adding an existing name, removing or updating an unknown track or cloning to an existing name MUST be rejected as an invalid catalog."`
- §5.3 (1999-2003): `"Operations are applied sequentially in the order they appear in the deltaUpdate array. Each operation is applied to the target document; the resulting document becomes the target of the next operation. Evaluation continues until all operations are successfully applied."`
- A.1.3 (5406-5411): 「Illogical operations ... MUST cause the catalog to be rejected」。

**draft-01 での扱い**

- 逐次適用の規定はある (`refs/moq/draft-ietf-moq-msf-01.txt:1556-1560`) が、illogical operation の reject 規則はない。実装は draft-01 に対して「add 重複・clone 親不存在・remove 不存在を throw する」という独自の厳格化をしていた (`src/msf/catalogDelta.ts:38-40` のコメント)。

**現行実装**

- remove: 対象が無ければ throw (`src/msf/catalogDelta.ts:62-82`)。適合。
- clone: 親が無ければ throw (`src/msf/catalogDelta.ts:98-102`)。適合。
- add: 既存チェックなしで append する (`src/msf/catalogDelta.ts:83-84`)。重複は全操作適用後の `assertTrackNameUnique` (`src/msf/catalogDelta.ts:144`) でしか検出されない。このため「add 既存 → その後 remove で重複解消」という列はエラーにならない。実測: 期待に反し成功し、最終 tracks は空になった (付録 A-7)。
- clone: 親と同じ Full Track Name だけを拒否する (`src/msf/catalogDelta.ts:111-115`)。既存の別 track と同じ名前への clone は、その track が後続の remove で消えると検出されない。実測: `clone` で既存 `x` を作り直し、その後 `x` を remove すると成功した (付録 A-9)。
- update: 未実装 (CAT-06)。

**必要な変更**

1. `add`: 各 track について、適用時点の tracks に同じ Full Track Name が存在すれば即 reject する。
2. `clone`: 合成後の Full Track Name が、親・既存のいずれかと一致すれば即 reject する (§5.3 の "cloning to an existing name")。
3. `update`: 親が存在しなければ即 reject する (CAT-06 と同時)。
4. 全操作後の `assertTrackNameUnique` / `assertInitRefResolvable` は不変条件の最終確認として残す。
5. 比較は §11.2 のバイト一致 (実装は文字列一致で可、CAT-14 の namespace 検証後に等価) とし、`(name, namespace ?? catalogNamespace)` のタプルで行う (`src/msf/catalogDelta.ts:191-198` の `normalizeNamespace` を再利用)。

**互換性影響**

- 従来受理していた delta (例: add 既存 → remove) を拒否する。意図した厳格化。
- wire 形式の変更はない。

**優先度**: P0。draft-02 の MUST であり、既存実装の最終検証だけでは順序依存で検出できない。

---

### CAT-08: `remove` / `clone` / `update` の track object の必須・許可フィールド

**仕様要件**

- remove (§5.1.6, 860-864): `"Each track object MUST include a Track Name Section 5.2.3 field, MAY include a Track Namespace Section 5.2.2 field, and MUST NOT hold any other fields."`
- clone (§5.1.6, 866-873): `"Each track object MUST include a Parent Name Section 5.2.34 field and MAY include a Parent namespace Section 5.2.35 field. The cloned track inherits all attributes from the parent except the Track Name which MUST be new. Attributes redefined in the track object override inherited values."` (Track Name は「MUST be new」なので必須)
- update (§5.1.6, 875-880): `"Each track object MUST include a Parent Name ... and MAY include a Parent namespace ... Attributes declared in the track object override existing values."` (Track Name の必須は書かれていない)
- §5.2.34 (1663-1666): parentName は clone / update 内のみ。§5.2.35 (1685-1690): parentNamespace も clone / update 内のみ。

**draft-01 での扱い**

- remove / clone の文面は同一 (参照節番号だけ §5.2.33 / §5.2.34 から §5.2.34 / §5.2.35 に変化) (`refs/moq/draft-ietf-moq-msf-01.txt:677-690`)。update はなし。

**現行実装**

- remove: `validateRemoveTrack` が `name` 必須・string、`namespace` MAY・string、それ以外のフィールドを reject (`src/msf/catalogValidation.ts:267-310`)。適合。
- clone: `validateCloneCatalogTrack` が `name` 必須・string、`parentName` 必須・string、`parentNamespace` MAY・string。`mimetype` / `connectionUri` / `token` を拒否し、`packaging` / `isLive` は optional で型だけ検証する (`src/msf/catalogValidation.ts:445-512`)。適合。
- update: 未実装。
- 参考: `parentName` / `parentNamespace` は clone 以外 (root / add / publishTracks) では拒否する (`src/msf/catalogValidation.ts:404-414`)。
- 参考: 受信 Object は `subgroupId?: bigint` を持つため (`src/dataStream/moqtObject.ts:57-60`)、Subgroup 0 の検証は `handleCatalogObject` で可能。

**必要な変更**

1. update 用の検証 (`validateUpdateTrack`) を追加:
   - `parentName` MUST (string)。`parentNamespace` MAY (string)。
   - `name` の扱いは要確認。仕様は必須と書かず、例 (§5.6.4 2418-2423) も `name` を含まない。`name` を「上書き可能な属性」として許可するなら、結果の Full Track Name が一意であることを CAT-07 で検証する。`name` を禁止する解釈もある (rename は「別 track を作る」操作という draft-01 の考え方)。推奨は「許可するが、合成後に Full Track Name の一意性を満たす場合のみ受理」。
   - それ以外のフィールドは `CatalogTrack` の属性として型検証する (`name` / `packaging` / `isLive` を必須にしない)。
2. `validateCatalogTrack` の `ValidationContext.source` に `"update"` を追加し、`parentName` 許可の条件を `clone` / `update` の両方にする (`src/msf/catalogValidation.ts:404-414` のメッセージも更新)。
3. remove / clone の既存挙動は変更しない。

**互換性影響**

- 内部の検証追加。wire は update の受理のみ。
- `parentName` を clone 以外で拒否する既存テスト (`src/msf.test.ts:1231-1240`) は update を許すように文言・対象を調整する。

**優先度**: P0 (CAT-06 と不可分)。remove / clone 自体は既に適合しており、追加作業は update のみ。

---

### CAT-09: `clone` の属性継承と上書き

**仕様要件**

- §5.1.6 (866-873): `"The cloned track inherits all attributes from the parent except the Track Name which MUST be new. Attributes redefined in the track object override inherited values."`
- §5.2.35 (1689-1690): `"If this field is missing from a clone operation, then the namespace of the catalog is assumed."`
- §5.2.2 (1094-1098): namespace 未宣言は catalog track の namespace を継承。宣言された namespace は継承を置換する (拡張しない)。

**draft-01 での扱い**

- 同文 (`refs/moq/draft-ietf-moq-msf-01.txt:683-690`、`:1261-1268`)。差分なし。

**現行実装**

- `applyCatalogDelta` の clone 分岐 (`src/msf/catalogDelta.ts:85-137`):
  - 親解決: `(parentName, parentNamespace ?? catalogNamespace)` (`:92-97`)。無ければ throw (`:98-102`)。
  - 継承と上書き: `const { parentName, parentNamespace, ...cloneProps } = cloneTrack; const cloned = {...baseTrack, ...cloneProps}` (`:103-106`)。親の属性を継承し、clone 側の宣言が上書きする。
  - 親と同じ Full Track Name の clone を拒否 (`:111-115`)。
  - `targetLatency` と `buffers` の併存を合成後に検出 (`:116-122`)。
  - packaging 別 MUST / role 条件付き MUST / audio codec MUST を合成後に再検証 (`:123-135`)。
  - 最終的な Full Track Name の一意性を検証 (`:144`)。
- 実測: 親の codec を継承し、上書きした値だけが変わることをテストで固定 (`src/msf.test.ts:2081-2119`、`src/msf.prop.ts:871-894`)。
- 結論: 仕様に適合している。namespace の「置換」も `{...baseTrack, ...cloneProps}` の上書きで実現されている。
- update 追加時は、clone の「親解決 + 合成 + 再検証」ロジックを共通関数に切り出して update と共有するのがよい (現状は clone 専用のインライン実装)。

**必要な変更**

- なし (確認のみ)。ただし CAT-14 で namespace を `/` 区切りとして検証するようになった後も、`normalizeNamespace` の文字列一致がフィールド列一致と等価であることをコメントで明記する。update 追加時に共通化する (CAT-06)。

**互換性影響**

- なし。

**優先度**: なし。

---

### CAT-10: initDataList の型追加と `data` の意味

**仕様要件**

- §5.1.7 (882-926):
  - `id`: catalog 内で一意な string (889-890)。
  - `type`: `"a string defining the type of reference. This version of the specification defines the following allowed types:"` (901-903)。Table 3 (904-914) は `inline` = `"Base64 [BASE64] encoded initialization data"`、`track-property` = `"The Track property type in hex notation"`、`object-property` = `"An Object property type in hex notation"`。
  - `data`: `"a string holding the init payload as defined by the type."` (916)。
  - 918-920: `"For both the track-property and object-property types, the initialization data is serialized as raw binary data and carried in the value field of the initialization properties, see Section 12.2."`
  - 922-926: `"The Initialization Data List, if present, SHOULD be located after the tracks array in the root of the JSON catalog."` (MUST → SHOULD)
- §12.2 (4709-4724): 初期化データが track の寿命で不変なら Track property として持ち、`initRef` が `type: 'track-property'` の entry を参照 MUST。可変なら Object property とし、`type: 'object-property'` の entry を参照 MUST。プロパティ型は VIDEO_CONFIG 0x0D / AUDIO_CONFIG 0x0F (4686-4694)。
- A.1.3 (5448-5450): `"initDataList gains "track-property" and "object-property" types. Its placement after the tracks array is relaxed from MUST to SHOULD."`

**draft-01 での扱い**

- §5.1.7 (692-719): 型は `inline` のみ (`:702-712`)。位置は `"MUST be located after the tracks array"` (`:716-719`)。`data` の意味は Base64 の初期化データのみ。

**現行実装**

- decode: `validateInitDataEntry` は `id` / `type` / `data` が string であることだけを検証し、`type` の許容値を制限しない (`src/msf/catalogValidation.ts:315-343`)。したがって `track-property` / `object-property` は wire から読める。`id` の重複は catalog 内で拒否 (`src/msf/catalogValidation.ts:132-142`)。
- `resolveInitData` は `type === "inline"` のときだけ `data` を返し、それ以外は `undefined` を返す (`src/msf/tracks.ts:32-39`)。実測: `type: "track-property", data: "0x0D"` は `undefined` (付録 A-10)。
- encode: `initDataList` を tracks の後に出力する (`src/msf/catalogCodec.ts:100-106`)。順序は SHOULD を満たすため変更不要。ただしコメントが MUST のまま (`src/msf/catalogCodec.ts:37-38, 82`、`src/msf.test.ts:648-649`)。
- `src/msf.prop.ts:274-278` の `initDataEntryArb` は `type` を `"inline"` 固定にしており、PBT が新型を踏まない。

**必要な変更**

1. `InitDataEntry` の `type` を `"inline" | "track-property" | "object-property" | string` のように表現し直し、既知 3 値の定数 (`INIT_DATA_TYPES` など) を追加する (`src/msf/types.ts:32-39`)。
2. `resolveInitData` の返り値を、型ごとに意味が異なることが分かる形にする。例:
   - `{ kind: "inline"; data: string }` (Base64 文字列)
   - `{ kind: "track-property"; propertyType: string }`
   - `{ kind: "object-property"; propertyType: string }`
   - または `resolveInitData` を inline 専用に残し、`resolveInitDataPropertyType` を追加する。
     現在の「string | undefined」は inline 以外を `undefined` に落とすため、draft-02 の新型を表現できない。公開 API (`src/index.ts:128` で `resolveInitData` を公開) の破壊的変更になるが、CODEBASE.md の方針上許容。
3. `property type in hex notation` の表記を確定する。仕様は "hex notation" としか書いておらず、`"0x0D"` か `"0D"` か `"0d"` かは未確認。§12.2 の property type (0x0D / 0x0F) と対応させる実装を書く前に、実装側の解釈を決めてコメント・テストで固定する (要確認)。
4. `type` が未知の値のときの扱いを決める。decode は現状どおり受理し、`resolveInitData` は `undefined` を返す (前方互換)。ただし §5.1.7 が「defines the following allowed types」とするため、厳格に拒否する解釈もある (要確認)。
5. 既知 3 型を PBT の arbitrary に加える (`src/msf.prop.ts:274-278`)。
6. コメント・エラーメッセージの「MUST be located after the tracks array」を「SHOULD」に直す (`src/msf/catalogCodec.ts:37-38, 82`、`src/msf.test.ts:648-649`)。encode の出力順は現状維持でよい。

**互換性影響**

- decode は従来どおり新型を読める (実質互換)。
- `resolveInitData` の返り値変更は公開 API の破壊的変更。
- 配置は MUST → SHOULD の緩和なので、既存の出力はそのまま適合する。

**優先度**: P0 (型と `resolveInitData` の意味)。配置のコメント修正は P2。

---

### CAT-11: Variable Substitution の文字制約変更

**仕様要件**

- §5.4.1 (2029-2046):
  - `"Variables are denoted by enclosing the variable name in percent characters (%). Variable names are case-sensitive."` (2031-2032)
  - `"The percent character (%) MUST NOT appear in catalog field values except as part of a variable reference. Literal percent characters are not permitted."` (2034-2036)
  - `"Variable values MUST consist only of alphanumeric characters, hyphens, underscores, plus sign, forward slash, equals, period and the at sign (@). Special characters including commas, semicolons, quotes, ampersands, and other punctuation MUST NOT appear in variable values."` (2038-2043)
  - `"The rules of mapping catalog strings to MOQT byte values Section 11.2 are applied after variable substitution has been performed."` (2045-2046)
- §5.4.2 (2059-2063): `"the fragment is parsed as key-value pairs, using & as delimiter. Each pair is split at its first = character into a key and a value."`
- §5.4.2 (2056-2057): `"Query parameters (following the ? character) are reserved for server-side processing and MUST NOT be used for variable substitution."`
- A.1.3 (5459-5462): `"Variable substitution: the restriction on variable-name characters was removed, and '+', '/', '=' and '.' are now permitted in values. Fragment pairs are split at the first '='. Name mapping is applied after substitution."`

**draft-01 での扱い**

- §5.4.1 (1592-1608): 変数名は `"MUST consist of alphanumeric characters, hyphens, and underscores"` (1594-1597)。値は `"alphanumeric characters, hyphens, underscores, and the at sign (@)"` (1603-1605)。`+` `/` `=` `.` は禁止。
- §5.4.2 (1629-1633): `"using & as delimiter and = as separator"` で、「最初の `=`」の明記はない (実装は最初の `=` で分割しており結果は同じ)。
- 名前マッピングを置換後に適用する規定はない (draft-01 に §11.2 自体がない)。

**現行実装**

- 変数名: `/^[A-Za-z0-9_-]+$/` (`src/msf/variables.ts:21`)、値: `/^[A-Za-z0-9_@-]*$/` (`src/msf/variables.ts:22`)、参照: `/%([A-Za-z0-9_-]+)%/g` (`src/msf/variables.ts:23`)。
- 検証は `resolveCatalogVariables` の冒頭で変数名・値の両方に行う (`src/msf/variables.ts:67-79`)。
- `substituteString` は置換後の値に `%` が残っていれば reject する (`src/msf/variables.ts:107-131`)。draft-02 でも `%` リテラル禁止は維持されるため、この検査は必要。
- msf fragment の解析 (`parseMsfFragmentValue`) は各パラメータを最初の `=` で分割している (`src/msf/fragment.ts:107-122`)。§5.4.2 の「最初の `=`」規則と整合する。ただしこれは fragment 解析であり、変数解決処理とは配線されていない (CAT-12)。

**必要な変更**

1. 変数名の文字制約を撤廃する。参照の文法を「`%` と `%` の間に `%` を含まない 1 文字以上」と定義する (例: `/%([^%]+)%/g`)。空の名前 (`%%`) の扱いは要確認。Unicode を許すかも要確認だが、§11.2 の名前マッピングと整合させるなら任意のスカラー値を許し、後段の名前検証で弾くのが一貫する。
2. 値の許可文字に `+` `/` `=` `.` を追加する (`/^[A-Za-z0-9_@+\/=.-]*$/`)。ハイフンは文字クラスの末尾に置く。
3. 変数名の検証 (現 `src/msf/variables.ts:69-73`) は削除するか、「空でない」「`%` を含まない」程度に弱める。
4. fragment の key-value を変数辞書にする処理を追加する場合、最初の `=` で分割する (`src/msf/fragment.ts:110-117` と同じ実装を再利用)。`&` 区切りのうち `=` を含まないセグメント (msf fragment の track-identifier 部分) は変数にしない。
5. query parameter を使わないことをコメントで明記する (現状も URL の hash のみを見ており、query は使っていない)。
6. 置換後の値に対して §11.2 の名前マッピング検証を適用する (CAT-12 と CAT-13 で実施)。

**互換性影響**

- 受理範囲の拡大 (draft-01 で有効だった入力は引き続き有効)。拒否していた `+` `/` `=` `.` を含む値が通るようになるため、「不正値を拒否する」ことを固定していたテスト (`src/msf.test.ts:2306-2316` は `;` の拒否なので維持、`src/msf.test.ts:2318-2328` は空白を含む変数名の拒否で、変更が必要) を見直す。
- wire の変更なし (catalog の値の解釈のみ)。

**優先度**: P0。§5.4 は draft-02 で明示的に変更された MUST で、`/` を値に含む URL (例: `%event%` に `/` を含む) を扱えないと実カタログで破綻する。

---

### CAT-12: 置換の配線・置換後の catalog 検証・endpoint フィールド

**仕様要件**

- §13.5 (4877-4882): `"Subscribers MUST validate the catalog after substitution, including applying the rules of Section 11.2 to any substituted name or namespace. Subscribers SHOULD NOT apply variable substitution to fields that determine a network endpoint, such as Connection URI (Section 5.2.37), unless the application explicitly trusts the source of the URI."`
- §13.5 (4884-4888): 置換された個人化値は relay に見えるため、opaque な非識別値を使う SHOULD。
- §5.4.2 (2048-2063): 変数は catalog 取得 URI の fragment から解決する。query は MUST NOT。
- §5.4.1 (2045-2046): §11.2 のマッピングは置換後に適用する。

**draft-01 での扱い**

- §5.4.2 (1610-1633) は同じ解決方法を定めるが、「置換後の catalog 検証」の MUST はない (§13 が `ToDo`、`refs/moq/draft-ietf-moq-msf-01.txt:3832-3834`)。

**現行実装**

- `resolveCatalogVariables` は `src/msf.ts:66` からは公開されるが、`src/index.ts` には含まれず、プロダクションコードから呼ばれていない (呼び出しはテストのみ。付録 A-3 で `index.js` に存在しないことを実測)。高レベル購読は受信 catalog に置換を適用しない (`src/createMediaSubscriber.ts:2428-2458` は decode/apply のみ)。
- 置換後の検証は `assertInitRefResolvable` のみ (`src/msf/variables.ts:102-104`)。`validateCatalog` / `validateCatalogTrack` の再実行はしない (issue `issues/0854-bug-substitution-conditional-must-revalidation.md` が同じ問題を起票済み)。
- `connectionUri` と `token` も置換対象にしている (`src/msf/variables.ts:192-206`)。`connectionUri` は §13.5 が SHOULD NOT の例として名指しするフィールド。
- fragment のパラメータを変数辞書にする処理はない。c4m だけは `resolveMsfAuthorizationToken` 経由で別処理している (`src/msf/c4mAuthorization.ts`)。

**必要な変更**

1. `resolveCatalogVariables` の置換後に、メモリ上の Catalog を完全検証する。具体的には:
   - `CatalogTrack` の各フィールドの型・条件付き MUST (`validatePackagingSpecificRules` / `validateRoleSpecificRules` / `validateAudioCodecRules` 相当) を再実行する。
   - namespace / name / parentName / parentNamespace に §11.2 の検証 (CAT-13) を適用する。namespace は `/` 区切り検証 (CAT-14) も。
   - `initDataList` の id 重複、`initRef` の参照切れを再検証する。
   - `tracks` / `publishTracks` の Full Track Name の一意性を再検証する。
     `validateCatalog` は wire 形式 (`unknown`) を取るため、内部表現用の再検証関数を切り出すか、encode 経由の自己 decode を再実行する (前者が望ましい)。
2. 高レベル購読に置換を配線する: 接続 URI の msf fragment パラメータ (track-identifier 以外) を変数辞書とし、catalog 受信時に `resolveCatalogVariables` を適用してから onCatalog へ渡す。少なくとも、置換を行わない場合に `%var%` を含む catalog をそのまま使わない (使用前にエラーにする) 方針を決める。
3. `connectionUri` の置換をやめる。やめない場合は「アプリが URI の出所を明示的に信頼する」オプションを設け、既定では置換しない。
4. `token` は draft-02 で track-level token 自体が廃止 (A.1.3 5444-5446) されるため、CAT-20 / 他担当の変更と合わせて削除または非推奨化する。
5. `resolveCatalogVariables` を公開 API にするかは別途判断 (現状は `src/msf.ts` のみ)。§5.4 の機能を提供するなら公開が自然。

**互換性影響**

- 置換 API の挙動が厳格になる (置換後に条件付き MUST 違反があれば throw)。利用者が置換結果をそのまま使う経路では、これまで通っていた catalog が拒否される (意図した修正)。
- `connectionUri` の置換停止は挙動変更。
- 高レベル購読への配線は新機能。catalog に `%` を含む producer と接続した場合の挙動が変わる。

**優先度**: P0 (置換後の完全検証は §13.5 の MUST で、既存の置換関数が不完全)。配線と connectionUri の扱いは P1。

---

### CAT-13: §11.2.1 の UTF-8 / BOM / 孤立サロゲート / NUL

**仕様要件**

- §11.2.1 (4289-4330):
  - `"The MOQT byte value corresponding to a JSON string is the UTF-8 [UTF8] encoding of the sequence of Unicode scalar values obtained by parsing the JSON string per [JSON], Section 7."` (4291-4293)
  - `"JSON escape sequences are resolved before encoding."` (4295-4299)
  - `"No Unicode normalization (NFC, NFD, NFKC, NFKD), case folding, or other transformation is applied"` (4301-4308)
  - `"Producers MUST NOT emit a JSON string in any of the fields listed above that, after resolving escapes, contains a code point that is not a Unicode scalar value; that is, an unpaired surrogate code point in the range U+D800 to U+DFFF ... A consumer that encounters one MUST treat the catalog as invalid."` (4317-4322)
  - `"Producers MUST NOT emit a U+0000 (NUL) code point in these fields."` (4324-4327)
  - `"The catalog document itself MUST be encoded in UTF-8, as required by [JSON], Section 8.1, and MUST NOT begin with a byte order mark."` (4329-4330)
- §11.2.5 の表 (4403-4407): `""` は invalid Track Name / invalid namespace field、`"\uDEAD"` は `"invalid; catalog MUST be rejected"`。
- §13.1 (4781-4783): `"A catalog that violates those constraints ... MUST be treated as invalid."`
- 対象フィールド: §11.2 (4280-4287) は §5.2.2 / §5.2.3 / §5.2.15 (depends) / §5.2.34 / §5.2.35 を列挙し、`"Extension fields that carry track names or namespaces MUST use the same mapping."` とする。

**draft-01 での扱い**

- §11.2 は存在しない (draft-01 §11.2 は "Initiating a broadcast"、`refs/moq/draft-ietf-moq-msf-01.txt:3589`)。名前は単なる string で、UTF-8 / BOM / サロゲート / NUL の規定はない (`:822-847`)。

**現行実装**

- catalog document の decode は `new TextDecoder().decode(data)` (`src/msf/catalogCodec.ts:273`)。既定の `TextDecoder` は (a) 先頭 BOM を除去する、(b) 不正な UTF-8 を U+FFFD に置換する。実測: BOM 付き catalog は受理され、名前位置の `0xFF` は U+FFFD になって受理された (付録 A-12, A-13)。
- 孤立サロゲート: `JSON.parse` は `"\uDEAD"` を長さ 1 の孤立サロゲート string にする。`validateCatalogTrack` は string であることしか見ないため受理する。実測: decode 受理、encode も `"\udead"` として出力 (付録 A-14)。MOQT バイト列への変換時は `TextEncoder` が U+FFFD (EF BF BD) に置換する (付録 A-16 で Node.js の挙動を確認)。
- NUL: 名前に `\u0000` を含む catalog は受理される (検査なし)。
- namespace / name / parentName / parentNamespace / depends に対する §11.2 の検証は存在しない (`src/msf/catalogValidation.ts`、`src/msf/catalogTrackValidation.ts` 全体)。
- 一方、`fullTrackName.ts` の `parseFullTrackNameSegment` は fatal な `TextDecoder` で UTF-8 を検証する (`src/fullTrackName.ts:209`)。ただしこれは MSF fragment の復号経路であり、catalog JSON の検証ではない。
- `formatFullTrackName` などは `TextEncoder` で UTF-8 化する (`src/fullTrackName.ts:46-48, 90-100`)。孤立サロゲートは U+FFFD に化ける。

**必要な変更**

1. catalog decode の UTF-8 検証: `new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })` を使い、BOM を保持したうえで先頭 3 バイトが `EF BB BF` なら reject する。`ignoreBOM: true` にしないと BOM が消えて検査できない (実測どおり既定は除去)。BOM は UTF-8 の BOM だけでなく、先頭の U+FEFF を JSON として解釈しないことでも検出できるが、バイト列での検査が明快。
2. 名前系フィールドの検証関数を追加し、decode / encode / 置換後の 3 経路で使う:
   - 対象: `namespace`、`name`、`parentName`、`parentNamespace`、`depends` の string 要素 (track name 参照)、および拡張フィールドで名前を運ぶもの (§11.2 4286-4287)。
   - 内容: 孤立サロゲート (U+D800-U+DFFF) を含まない、NUL (U+0000) を含まない、空の Track Name でない (§5.2.3 1106-1107: `"A Track Name MUST NOT be the empty string."`)、namespace は CAT-14 の `/` 形式。
3. encode 側でも同じ検証を行い、`TextEncoder` に到達する前に reject する (producer MUST NOT)。
4. 検証はカタログ全体 (root / tracks / publishTracks / initDataList の関連文字列) に適用する。置換後にも再適用する (CAT-12)。
5. テスト: BOM 付き、不正 UTF-8、孤立サロゲート、NUL、空 name、空 namespace field の reject を単体テストで固定する。
6. NUL の受信側の扱いは要確認 (仕様は producer に対する MUST のみで consumer の MUST は書かれていないが、§13.1 の「違反 catalog は invalid」から拒否が妥当)。

**互換性影響**

- decode が従来受理していた不正 catalog を拒否する (意図した厳格化)。
- encode が従来出力できた不正な名前を拒否する (API の挙動変更)。
- 正常な UTF-8 の catalog には影響しない。

**優先度**: P0。BOM と不正 UTF-8 の受理は §11.2.1 の MUST に直接反し、孤立サロゲートは §11.2.1 の consumer MUST に反する。実装量は小さい。

---

### CAT-14: namespace の `/` 区切り・Full Track Name 比較・購読時の namespace 解決

**仕様要件**

- §5.2.2 (1069-1098):
  - `"The value is a single JSON string in which the '/' character (U+002F SOLIDUS) delimits the boundaries between Track Namespace Fields."` (1070-1072)
  - `"The string MUST yield between 1 and 32 fields, and every field MUST be non-empty ... the string MUST NOT be empty, MUST NOT begin or end with a '/' character, and MUST NOT contain two consecutive '/' characters. A parser that encounters a value that is not a string, an empty string, a string yielding more than 32 fields, or a string yielding an empty field MUST treat the catalog as invalid."` (1085-1092)
  - `"If it is not declared within a track object, then the track MUST inherit the Track Namespace of the catalog track ... A namespace declared in a track object replaces (and does not extend) any inherited namespace."` (1094-1098)
- §5.2.3 (1100-1115):
  - `"A Track Name MUST NOT be the empty string."` (1106-1107)
  - `"Within a catalog, the combination of Track Namespace and Track Name (the Full Track Name) MUST be unique. Uniqueness, and every other comparison ... is determined by exact comparison of the mapped bytes as described in Section 11.2, never by comparison of the JSON source text."` (1109-1115)
- §11.2 (4280-4287): 名前を運ぶフィールドは §5.2.2 / §5.2.3 / §5.2.15 / §5.2.34 / §5.2.35。拡張フィールドも同じマッピング MUST。
- §11.2.2 (4334-4343): `"Two Track Names, or two Track Namespace Fields, are equal if and only if their mapped byte sequences are identical. Two Track Namespaces are equal if and only if they have the same number of fields and each corresponding field is equal. Implementations MUST NOT use locale-aware, case-insensitive, or normalization-aware string comparison when matching track names or namespaces within a catalog, between a catalog and a delta update, or between a catalog and the names carried in MOQT control messages."`
- §11.2.3 (4350-4363): `"When an implementation needs to compare a name obtained from an MOQT control message ... against a catalog, it MUST compare the raw MOQT bytes against the mapped bytes of the catalog string; it MUST NOT decode the MOQT bytes as UTF-8 and compare the result as text."` `"an MSF publisher MUST only publish tracks whose Track Namespace Fields and Track Names are valid UTF-8 and satisfy the constraints of this section."`
- §11.2.4 (4373-4380): URL fragment の namespace-name 文字列は、JSON 原文ではなく §11.2 のバイトに §8.8 の符号化を適用したもの。
- A.1.3 (5416-5421): `"Track namespace is now a '/'-delimited string that maps to MOQT Track Namespace Fields, with 1-32 non-empty fields. Malformed values invalidate the catalog. A declared namespace replaces, rather than extends, the inherited one. Track names MUST be non-empty, and uniqueness now applies to the Full Track Name."`

**draft-01 での扱い**

- §5.2.2 (822-830): namespace は「The name space under which the track name is defined」の不透明な string。フィールド分割の規則はない。
- §5.2.3 (832-847): `"Within the catalog, track names MUST be unique per namespace."` バイト比較の規定はない。
- §11.2 は存在しない。

**現行実装**

- `CatalogTrack.namespace` は単一の string (`src/msf/types.ts:117`)。検証は型のみ (`src/msf/catalogTrackValidation.ts:130-138`)。`/` の分割・1-32 フィールド・空フィールドの検査はない。
- 一意性は `(namespace ?? catalogNamespace, name)` の JS 文字列比較 (`src/msf/catalogValidation.ts:178-218`)。delta の remove / clone / update の対象解決も同様 (`src/msf/catalogDelta.ts:65-73, 92-97, 191-198`)。JS 文字列比較は、名前が有効なスカラー値列である限り UTF-8 バイト比較と同値だが、その前提 (孤立サロゲート排除) が守られていない (CAT-13)。
- 高レベル購読は catalog の `track.namespace` を無視し、常に URL の namespace (`options.namespace`) で SUBSCRIBE する: `src/createMediaSubscriber.ts:2119` で `const namespace = this.options.namespace`、音声は `:2140`、映像は `:2192` でそのまま渡す。`catalogSubscription.ts` も catalog track 自身の購読にのみ `CATALOG_TRACK_NAME` を使う (`:224-255`)。
- `getTrackByName` は name のみで検索する (`src/msf/tracks.ts:62-64`)。`resolveTrackInfo` も name のみで照合する (`src/mediaSubscriber/catalogSubscription.ts:561-575`)。
- MOQT の名前バイト列は非 fatal な `TextDecoder` で string 化している: `src/message/parameter/trackNamespace.ts:334-337`、`src/session/incomingPublish.ts:644-646, 1273`、`src/session/namespaceLoops.ts:1503`。不正 UTF-8 は U+FFFD になるため、§11.2.3 の「invalid UTF-8 は catalog のどの entry とも一致し得ない」という性質が構造的に保証されない。
- `fullTrackName.ts` は §8.8 のバイト表現を UTF-8 で正しく実装している (`src/fullTrackName.ts:90-100` の escape、`:209` の fatal decode、`:35-44` の長さ付き比較キー)。ただしこれは MSF fragment / 表示用であり、catalog の namespace フィールド分割には使われていない。
- `moqtUri.ts` の役割は `moqt://` の scheme 置換、authority 検証、fragment の type/value 分割 (`src/moqtUri.ts:56-79, 100-148`) であり、名前のバイト変換は行わない。§11.2.4 の「catalog の Full Track Name を URL fragment 形式にする」経路は `formatFullTrackName` / `formatTrackNamespace` (`src/fullTrackName.ts:116-149`) が担っており、UTF-8 バイト化してから §8.8 の escape を適用するため仕様に適合する。逆方向は `parseMsfFragmentValue` → `parseFullTrackNameSegment` (`src/msf/fragment.ts:94-105`) で、fatal な UTF-8 復号を伴う。catalog の namespace 文字列をそのまま fragment に埋め込む経路は存在しないため、追加の変更は不要 (catalog の namespace を URL に出す機能を追加する場合は CAT-14 の検証を経由させること)。
- 実測: `"namespace": "a/b"` / `""` / `"a//b"` / `"/a"` / `"a/"` / `"a/"` を 40 回繰り返した長大な namespace をすべて受理した。空の Track Name と NUL を含む name も受理した (付録 A-17)。いずれも draft-02 では catalog invalid。

**必要な変更**

1. `CatalogTrack.namespace` の検証を追加する (`src/msf/catalogTrackValidation.ts:130-138`): string であること、`/` で分割した結果が 1-32 個、各フィールドが空でない、先頭・末尾・連続 `/` がない。違反は catalog invalid (§5.2.2 の MUST)。
2. `depends` の string 要素 (track name 参照) と `parentName` / `parentNamespace` にも同じ名前検証 (CAT-13) と namespace 形式検証を適用する。
3. 購読時の Full Track Name 解決を修正する: 音声・映像の SUBSCRIBE で、`track.namespace` が宣言されていれば `/` 分割したフィールド列を、なければ catalog track の namespace を渡す。`src/createMediaSubscriber.ts:2119-2140, 2192` を、解決済み track ごとの namespace に変える。`session.subscribe(namespace: string[], ...)` の型 (`src/session.ts:239-244, 922-927`) に合わせる。
4. 名前検索を Full Track Name 対応にする: `getTrackByName(catalog, name)` に namespace 引数を追加するか、`fullTrackNameKey` を使う新 helper を追加する。高レベル API の `video.trackName` / `audio.trackName` は名前のみ指定なので、namespace 未指定時は catalog namespace 継承として解決する。
5. §11.2.3 の raw バイト比較: 少なくとも catalog と MOQT 制御メッセージの名前を突き合わせる経路 (現状は購読の組み立てが主) で、比較を「バイト列 → string → 比較」ではなく「バイト列のまま比較」にする。全経路の `TextDecoder` を fatal にするのは影響範囲が広いため、catalog 連携部分に限定する実装でもよい (要確認: 対象経路の範囲)。
6. namespace の文字列表現を公開 API で使い続けるか、`string[]` に変えるかは設計判断。`CatalogTrack.namespace` を string のままにする場合、`/` を含む field を表現できない (draft-02 が `/` を区切りとして予約するため表現不要) ので問題ない。

**互換性影響**

- wire: draft-01 の catalog で namespace field に `/` を含むもの (例: `"namespace": "a/b"` を 1 フィールドのつもりで書いたもの) は draft-02 では 2 フィールドとして解釈される。draft-01 の不透明文字列としての namespace をそのまま使っていたカタログは意味が変わる (仕様変更による意図した非互換)。
- 購読の Full Track Name が変わる (現状は誤り。修正により正しい track を購読する)。
- TypeScript API: `CatalogTrack.namespace` の型は string のままでよいが、ヘルパーの引数追加は破壊的。

**優先度**: P0。draft-02 の実カタログ (例: §5.6.1) は `/` 区切り namespace を使い、track ごとに namespace を宣言する。現行の購読実装はその場合に誤った track を購読するため、相互運用が成立しない。§11.2.3 の比較規則の完全対応 (5.) は P1。

---

### CAT-15: §13.2 `trackBaseKey` の MUST NOT

**仕様要件**

- §13.2 (4787-4803): `"The trackBaseKey field (Section 5.2.41) carries raw key material from which content encryption keys are derived. Any party that can read a catalog containing this field can decrypt the corresponding tracks. ... Publishers MUST NOT include a trackBaseKey in a catalog unless that catalog is encrypted end-to-end such that only authorized subscribers can read it, or is delivered to subscribers over a channel that relays cannot observe."` (4795-4798)
- §13.2 (4799-4803): relay を排除するなら KMS ([E2EE-MLS] 等) で鍵を渡す SHOULD。`keyId` は秘密ではないが鍵ローテーション等を漏らし得るため `SHOULD NOT encode sensitive information`。
- A.1.1 (5350-5355): 新しい規範要件として明記。

**draft-01 での扱い**

- §13 は `ToDo` のみ (`refs/moq/draft-ietf-moq-msf-01.txt:3832-3834`)。規定なし。

**現行実装**

- `trackBaseKey` を無条件に受理する: `pickOptionalString(obj, "trackBaseKey", "§5.2.41", ...)` (`src/msf/catalogTrackValidation.ts:295`)。`createCatalog` / `encodeCatalog` も拒否しない。
- moqt-js は SecureObjects / E2EE を実装していない (catalog の暗号化フィールドを parse するだけ。`src/msf/catalogTrackValidation.ts:286-302`)。つまり「catalog が E2E 暗号化されている」ことをライブラリは検証できない。
- `resolveCatalogVariables` は `trackBaseKey` を置換対象にしている (`src/msf/variables.ts:158`)。視聴者ごとの鍵を差し込む用途は §13.2 の MUST と両立しない (relay が catalog を読める場合)。
- 高レベル publisher は `trackBaseKey` を生成しない (`src/createMediaPublisher.ts:2107-2163`)。したがって既定経路では MUST 違反は起きないが、公開 API (`createCatalog` / `encodeCatalog`) 経由では起こり得る。

**必要な変更**

1. producer 側の安全弁: `encodeCatalog` / `createCatalog` で `trackBaseKey` を含む catalog を既定で reject し、明示的な opt-in (例: `createCatalog(..., { catalogIsEndToEndProtected: true })` または `encodeCatalog(catalog, { allowTrackBaseKey: true })`) がある場合のみ許可する。オプション名・シグネチャは要確認。
2. subscriber 側: 受信 catalog の `trackBaseKey` は削除せず保持する (復号に必要)。ただし「信頼できない relay 経由で受けた trackBaseKey で復号してよいか」はアプリ判断。少なくとも API ドキュメントに §13.2 のリスクを書く。
3. `resolveCatalogVariables` の `trackBaseKey` 置換は、上記 opt-in と連動させる (既定では置換しない、または鍵素材は置換対象外にする)。
4. `keyId` に機微情報を入れない注意をコメントに書く (§13.2 4801-4803)。

**互換性影響**

- encode / createCatalog が従来受理していた `trackBaseKey` を既定で拒否する (破壊的変更)。draft-02 の MUST に従うための変更。
- wire 形式の変更なし。

**優先度**: P1。producer MUST だが、既定の高レベル API では発生せず、公開 API の利用者だけが該当する。実装は小さく、安全側に倒す価値がある。

---

### CAT-16: §13.7 資源防御 (展開後サイズ・循環・delta 連鎖)

**仕様要件**

- §13.7 (4918-4922): `"Compressed payloads (Section 12.1) may expand to a size far larger than the transmitted object. Subscribers MUST enforce an upper bound on the decompressed size of any catalog, media timeline or event timeline object and SHOULD abort decompression when that bound is exceeded."`
- §13.7 (4933-4936): `"Catalogs, media timelines and event timelines are JSON documents that can be arbitrarily large or deeply nested. Subscribers SHOULD bound the document size, nesting depth, number of tracks and number of timeline records they are willing to process."`
- §13.7 (4938-4941): `"Long chains of delta updates (Section 5.3) increase processing cost for joining subscribers. Subscribers MAY bound the number of delta updates they will apply before requiring a new independent catalog."`
- §13.7 (4943-4945): `"A catalog may reference other catalogs. Subscribers MUST detect reference cycles and SHOULD bound the depth of catalog references they will follow."`
- §13.7 (4947-4951): timeline の履歴サイズの SHOULD (担当外)。
- A.1.1 (5350-5355): `"subscribers MUST bound decompressed object size; subscribers MUST detect catalog reference cycles"`。

**draft-01 での扱い**

- §13 は `ToDo` のみ。規定なし。

**現行実装**

- 圧縮の受信自体が未実装 (CAT-18) のため、展開後サイズの上限も存在しない。catalog の展開は `decodeCatalogMessage` の `JSON.parse` (`src/msf/catalogCodec.ts:274`) のみ。
- 文書サイズ・ネスト深さ・track 数・タイムライン件数の上限はない (`JSON.parse` に任せる)。`validateCatalog` は配列を全件 map する (`src/msf/catalogValidation.ts:102-104, 115, 132`)。
- delta 連鎖の上限はない。`processCatalogPayload` は届いた delta を無制限に適用する (`src/createMediaSubscriber.ts:400-420`)。新しい Group の独立 catalog が来るまで連鎖し続ける。
- 入れ子 catalog の追従がないため、参照循環は現状発生しない (CAT-02 を実装する場合に MUST となる)。
- 独立 catalog を新 Group で定期送信する publisher 側の運用 (`src/createMediaPublisher.ts:2018-2064`、`src/catalogRepublish.ts`) は、delta 連鎖の上限を設ける際の前提になる。

**必要な変更**

1. CAT-18 (圧縮) と同時に、展開後のバイト数上限を実装する。上限値は設定可能 (既定値は要検討) とし、超えたら展開を中止して catalog invalid とする (SHOULD abort)。
2. `decodeCatalogMessage` の入口で Object payload のバイト数上限を検査する (SHOULD)。track 数・delta 適用回数の上限も設定可能にする (MAY)。深さ上限は `JSON.parse` の後に再帰走査で検査するか、`JSON.parse` の reviver では検出できないため事前のバイト数上限で代替する。
3. CAT-02 で入れ子 catalog を追う場合、訪問済み Full Track Name の集合で循環を検出し、深さ上限を設ける (MUST / SHOULD)。
4. 上限値の既定値と、利用者が変更する API (`createMediaSubscriber` options など) を設計する。既存 API との整合から、まず内部定数 + 環境設定でよい。

**互換性影響**

- 過大な catalog を拒否する (意図した防御)。正常なサイズでは影響なし。
- 新 API (上限設定) は追加のみ。

**優先度**: P1。展開後サイズの MUST は CAT-18 の圧縮実装と不可分。文書サイズ・深さ・delta 連鎖は SHOULD/MAY。循環検出 MUST は CAT-02 を実装する場合に必要。

---

### CAT-17: §13 のその他の SHOULD (E2E 保護・timing sanity bound・publishTracks ポリシー)

**仕様要件**

- §13.1 (4775-4783): relay を信頼しないなら publisher は catalog を E2E 保護する SHOULD ([SecureObjects] 等)、subscriber は認証に失敗した catalog Object を拒否する SHOULD。catalog の全フィールドを untrusted として検証する SHOULD。違反 catalog は invalid とする MUST。
- §13.3 (4805-4824): 名前・ラベルに識別情報を置かない SHOULD、catalog を E2E 暗号化する SHOULD。
- §13.4 (4826-4856): catalog に per-subscriber 資格情報を直接置かない SHOULD、短命・限定スコープの SHOULD。fragment のトークンも短命・限定スコープの SHOULD。
- §13.6 (4890-4911): publish track と Connection URI はアプリのポリシーで許可された endpoint のみに publish する SHOULD。ポリシー外の publish track は無視する SHOULD。log / metrics の publish を rate-limit する SHOULD。
- §13.8 (4953-4960): targetLatency / buffer / wallclock に sanity bound を課す SHOULD、セキュリティ判断に使わない SHOULD NOT。
- §13.9 (4962-4971): 見た目が紛らわしい名前を避ける SHOULD、表示名の視覚確認に依存しない SHOULD NOT。

**draft-01 での扱い**

- すべて新規 (§13 は `ToDo`)。

**現行実装**

- E2E: catalog の認証・暗号化の仕組みはない (QUIC/WebTransport の hop ごとの保護に依存)。`MOQ Secure Objects` の暗号化フィールドは parse するが復号はしない (`src/msf/catalogTrackValidation.ts:286-302`。`trackBaseKey` を保持するだけで、復号器へは渡していない)。
- timing: `effectiveTargetLatencyMs` は `isLive` と有限性・非負だけを見て、上限は設けない (`src/msf/tracks.ts:138-148`)。`resolveSharedTargetLatencyMs` も同様 (`:187-206`)。
- publishTracks: 高レベル API は `publishTracks` を消費しない (`src/createMediaSubscriber.ts` に `publishTracks` の参照はない)。connectionUri も消費しない。したがって §13.6 の「ポリシー外を無視」「rate-limit」は現状は自動的には不要 (危険な動作をしない)。ただしアプリに catalog を渡すため、アプリが実装する際の注意をドキュメントに書くべき。
- 名前の表示: devtools の購読経路は catalog を decode してログ・UI に名前を出す (`devtools/src/hooks/useSubscriber.ts:3040-3077`)。§13.9 はアプリ側の注意。

**必要な変更**

1. ドキュメント: §13 の脅威モデル (relay は catalog を読める/改変できる、E2E 保護は [SecureObjects] 等で行う、catalog の全フィールドを untrusted として扱う) を `docs/MSF.md` などに追記する。
2. targetLatency に任意の上限 (例: 60 秒) を課すか、少なくとも負値・非有限の除外を維持しつつ「上限はアプリ責任」と明記する (§13.8 は SHOULD のため P2)。
3. 将来 `publishTracks` / `connectionUri` を自動処理する機能を追加する場合は、許可リスト・rate-limit・同一管理ドメイン制約を同時に実装する (§13.6)。
4. 認証失敗時の catalog 拒否は、E2E 復号を実装する時点で「復号・認証に失敗した Object を捨てる」として実装する (現状は E2E 自体がないため保留)。

**互換性影響**

- ドキュメントと任意の上限のみ。挙動変更は小さい。

**優先度**: P2。SHOULD が中心で、実装の大部分はアプリケーション/デプロイの責務。ただしドキュメント追記は P1 相当の価値がある (誤用防止)。

---

### CAT-18: §5.5 / §12.1 catalog 圧縮 (MSF_COMPRESSION 0x78)

**仕様要件**

- §5.5 (2077-2086): `"Catalogs can contain significant redundancy, particularly when initialization data is included. To reduce payload size, catalog objects MAY be compressed using the MSF_COMPRESSION property (Section 12.1). If all catalog objects are compressed, the track property (Section 12.1.1) is used. If only some catalog objects are compressed (for example, the complete catalog is compressed while delta updates are not), the object property (Section 12.1.2) is used on each compressed object."`
- §12.1 (4583-4623):
  - `"A publisher MUST NOT use both mechanisms on the same track. If the track property is set, then every object in the track is compressed and the object property MUST NOT be present."` (4604-4608)
  - `"All MSF implementations MUST support both uncompressed payloads (value 0 or property absent) and GZIP compressed payloads (value 1)."` (4622-4623)
- §12.1.1 (4625-4657): track property type 0x78。PUBLISH / SUBSCRIBE_OK / FETCH_OK に載る MUST。subscriber は処理前に確認 MUST。未知アルゴリズムは処理せず unsubscribe する SHOULD。
- §12.1.2 (4659-4678): object property type 0x78。各圧縮 Object に載る MUST。subscriber は Object ごとに確認 MUST。未知アルゴリズムはその Object を処理しない MUST。
- A.1.8 (5536-5540): `"MSF_COMPRESSION was assigned type 0x78 (track and object). It may also be carried in FETCH_OK."`

**draft-01 での扱い**

- §5.5 と §12.1 の文面は同一 (`refs/moq/draft-ietf-moq-msf-01.txt:1635-1644, 3732-3780`)。ただし MSF_COMPRESSION の property ID は draft-01 では TBD で、実装は「ID が TBD のため未実装」としていた (`src/properties.ts:36-39`)。draft-02 で 0x78 に確定したため、このブロッカーは解消した。

**現行実装**

- `MsfCompressionAlgorithm = { NONE: 0n, GZIP: 1n }` の定数のみ (`src/properties.ts:41-44`)。property ID 定数、encode/decode helper、Track / Object 併用 MUST NOT の検証はいずれも未実装 (`src/properties.ts:36-39` のコメントが明言)。
- catalog 受信経路は payload をそのまま `decodeCatalogMessage` に渡す (`src/createMediaSubscriber.ts:405`)。Track Property / Object Property の MSF_COMPRESSION は見ていない。
- catalog 送信経路も圧縮しない (`src/createMediaPublisher.ts:1982-2002` は `encodeCatalog(catalog)` をそのまま送る)。
- ドキュメントも未実装と明記 (`docs/MSF.md:28`、`docs/IMPLEMENTATION_STATUS.md:181`)。

**必要な変更**

1. property ID 0x78 の定数と encode/decode を追加する (§12 担当の作業と共有)。
2. subscriber: catalog 購読の Track Properties (`SUBSCRIBE_OK` / `PUBLISH` / `FETCH_OK`) から MSF_COMPRESSION を読み、値 1 (GZIP) なら全 Object を展開してから `decodeCatalogMessage` に渡す。Object Property があればその Object だけ展開する。0 または absent は非圧縮。未知値は処理せず、§12.1.1 の SHOULD に従い購読を中止する。
3. Track / Object 併用の MUST NOT を検証する (両方あったら invalid)。
4. 展開後サイズの上限 (CAT-16) を同時に実装する。GZIP 展開は `DecompressionStream("gzip")` を使う (ブラウザ前提。Node.js テストでは `node:zlib` が必要になる可能性。要確認)。
5. publisher: catalog を圧縮するかは任意 (MAY)。高レベル API では既定非圧縮のままでよいが、MSF_COMPRESSION を載せる手段を提供するかは要確認。
6. テスト: gzip 圧縮した catalog Object の decode、非圧縮との混在、未知アルゴリズムの拒否。

**互換性影響**

- 受信側は新機能 (圧縮 catalog を読めるようになる)。
- 送信側は既定非圧縮のままで互換。
- property 0x78 は application-specific range (0x78-0x7F) で IANA 登録不要 (A.1.8 5559-5561。範囲の解釈は `src/properties.ts:458` のコメント)。

**優先度**: P0 (受信対応)。§12.1 の `"All MSF implementations MUST support ... GZIP compressed payloads"` は実装全体に課される MUST であり、catalog はその対象。§12 担当エージェントの調査と重複するが、catalog の decode 前処理は本担当の範囲。

---

### CAT-19: Joining FETCH から fill fetch への移行

**仕様要件**

- §5 (733-736): `"Subscribers accessing the catalog MUST use SUBSCRIBE with a Joining FETCH (offset = 0) in order to obtain the latest complete catalog along with all subsequent catalog objects, including delta updates, that follow."` (draft-01 と同文)
- MOQT draft-23 §A.4 (9035-9039): `"Replace Joining FETCH with fill fetch streams (#1673)"`。Joining FETCH は draft-20 で削除済み。
- MOQT draft-23 §3.4 (1629-1711): fill fetch stream の意味。`"A subscription that carries a FILL_PARAMETERS parameter ... causes the publisher to open a unidirectional stream beginning with a FETCH_HEADER"` (1631-1635)。`"When the fill range overlaps the subscription's Location filter, an object can be both fill-delivered and subscription-delivered. A subscriber that wants each Object delivered exactly once uses the Next Object Subscription Location Filter coupled with an open-ended fill range, which the publisher will end at Largest Object."` (1666-1671)
- MOQT draft-23 §3.5 (1712-1748): `"To join a Track at the current Group, the subscriber sends a SUBSCRIBE with a Location Filter that starts at the Next Object and a FILL_PARAMETERS parameter (see Section 9.19.15) whose Location filter has StartGroup=1, which fills the current Group from its start."` (1724-1727)
- MOQT draft-23 §9.19.9 (5593-5608): Location Filter Type 0x01 は相対指定で `StartGroup=1` は現在の Group の先頭。

**draft-01 での扱い**

- §5 (530-533) に同じ MUST。draft-01 当時は Joining FETCH が存在した。

**現行実装**

- `catalogSubscription.subscribe` は 2 リクエストで代替する:
  1. `session.subscribe(namespace, "catalog", callbacks, { filter: { nextObject: true } })` (`src/mediaSubscriber/catalogSubscription.ts:224-255`)
  2. `session.fetch(namespace, "catalog", { filter: catalogFetchFilter(largestLocation) })` (`:306-352`)
- `catalogFetchFilter` は LARGEST_OBJECT の Group の先頭 Object から要求する (`src/createMediaSubscriber.ts:279-286`)。LARGEST_OBJECT が不明なときは絶対位置 `{0,0}` を指定する。
- 低レベルには fill fetch のサポートがある: `SubscribeOptions.fill?: FillRequestOptions` (`src/subscriber.ts:64-73`、`src/session/publicTypes.ts:804-820`)、FILL_PARAMETERS の送信 (`src/session/params.ts:171, 622`)、fill fetch stream の受信 (`src/session.ts:514-521`、`src/subscriber.ts:571` 付近)。つまり「fill fetch 化は未実装」というドキュメント記述は catalog 経路については正しいが、低レベル API には実装済みである。
- ドキュメント: `docs/MSF.md:16`、`docs/IMPLEMENTATION_STATUS.md:145`、`docs/LOW_LEVEL_API.md:702` が「2 リクエストで代替、fill fetch 化は未実装」と説明している。

**必要な変更**

1. catalog 購読を 1 リクエストに統合する: `session.subscribe(namespace, "catalog", callbacks, { filter: { nextObject: true }, fill: { filter: { startGroup: 1n } } })`。`LocationFilter` の値は bigint (`src/message/parameter/locationFilter.ts:50-62`)。
   - subscription 側の `{ nextObject: true }` は Next Object (0x05) で live 更新を受ける。
   - fill 側の `{ startGroup: 1n }` は Location Filter Type 0x01 の相対指定で、現在の Group の先頭から Largest Object までを fill fetch で取得する。これは draft-02 の「最新 Group の先頭 Object (独立 catalog)」を取得する意図と一致し、Joining FETCH (offset = 0) の置き換えとして最も近い。
2. fill fetch 由来の Object を `fillDelivered` (`src/dataStream/moqtObject.ts:92-103`) で識別し、既存の `pendingCatalogObjects` / `catalogFetchLastLocation` の重複除去ロジックを維持する (`src/mediaSubscriber/catalogSubscription.ts:503-519`、`src/createMediaSubscriber.ts:250-272`)。
3. FILL_TIMEOUT / エラー時の扱いを現行の受信タイムアウト (`CATALOG_RECEIVE_TIMEOUT` 5000 ms、`src/mediaSubscriber/catalogSubscription.ts:43`) と整合させる。fill fetch は REQUEST_ERROR を持たないため、fill stream の reset を検出して live 待ちへ切り替える (`refs/moq/draft-ietf-moq-transport-23.txt:1701-1710`)。
4. ドキュメントを更新する: 「低レベル API には FILL_PARAMETERS があるが、catalog 取得は 2 リクエストのまま」→「catalog 取得も fill fetch に移行した」または「移行予定」。
5. `catalogFetchFilter` は不要になる (削除または fill の filter 組み立てに置換)。

**互換性影響**

- wire: SUBSCRIBE に FILL_PARAMETERS が付く (draft-23 で合法)。FETCH リクエストが 1 本減る。
- 挙動: fill fetch と live の重複が publisher 側で Largest Object 終端されるため、`catalogFetchLastLocation` の重複除去は依然必要だが、競合窓は小さくなる。
- 既存のテスト (`src/createMediaSubscriber.catalog.test.ts` の FETCH 関連) は書き換えが必要。
- API の破壊はない (内部の購読手順)。

**優先度**: P1。draft-02 §5 の MUST は Joining FETCH を名指すが、その transport 機能が存在しないため字義どおりの準拠は不可能で、fill fetch への読み替えが唯一の解釈。現行の 2 リクエストでも機能的には同等だが、draft-23 §3.5 の想定手順に合致させ、RTT と重複処理を減らす価値がある。

---

### CAT-20: 仕様節番号の更新 (コメント・エラーメッセージ)

**仕様要件 (節番号の移動)**

- draft-02 の track field 節は draft-01 から 1 つずつ後ろにずれる (§5.2.5 が packagingMetadata の新設のため):
  - eventType: draft-01 §5.2.5 (`refs/moq/draft-ietf-moq-msf-01.txt:874`) → draft-02 §5.2.6 (`refs/moq/draft-ietf-moq-msf-02.txt:1225`)
  - role: draft-01 §5.2.6 (`refs/moq/draft-ietf-moq-msf-01.txt:888`) → draft-02 §5.2.7 (`refs/moq/draft-ietf-moq-msf-02.txt:1247`)
  - isLive: draft-01 §5.2.7 (`refs/moq/draft-ietf-moq-msf-01.txt:957`) → draft-02 §5.2.8 (`refs/moq/draft-ietf-moq-msf-02.txt:1331`)
  - targetLatency: draft-01 §5.2.8 (`refs/moq/draft-ietf-moq-msf-01.txt:968`) → draft-02 §5.2.9 (`refs/moq/draft-ietf-moq-msf-02.txt:1357`)
  - buffers: draft-01 §5.2.9 (`refs/moq/draft-ietf-moq-msf-01.txt:987`) → draft-02 §5.2.10 (`refs/moq/draft-ietf-moq-msf-02.txt:1377`)
  - label: draft-01 §5.2.10 (`refs/moq/draft-ietf-moq-msf-01.txt:1026`) → draft-02 §5.2.11 (`refs/moq/draft-ietf-moq-msf-02.txt:1418`)
  - renderGroup: draft-01 §5.2.11 (`refs/moq/draft-ietf-moq-msf-01.txt:1034`) → draft-02 §5.2.12 (`refs/moq/draft-ietf-moq-msf-02.txt:1426`)
  - altGroup: draft-01 §5.2.12 (`refs/moq/draft-ietf-moq-msf-01.txt:1043`) → draft-02 §5.2.13 (`refs/moq/draft-ietf-moq-msf-02.txt:1435`)
  - initRef: draft-01 §5.2.13 (`refs/moq/draft-ietf-moq-msf-01.txt:1055`) → draft-02 §5.2.14 (`refs/moq/draft-ietf-moq-msf-02.txt:1447`)
  - depends: draft-01 §5.2.14 (`refs/moq/draft-ietf-moq-msf-01.txt:1069`) → draft-02 §5.2.15 (`refs/moq/draft-ietf-moq-msf-02.txt:1461`)
  - template: draft-01 §5.2.15 (`refs/moq/draft-ietf-moq-msf-01.txt:1079`) → draft-02 §5.2.16 (`refs/moq/draft-ietf-moq-msf-02.txt:1480`)
  - temporalId: draft-01 §5.2.16 (`refs/moq/draft-ietf-moq-msf-01.txt:1094`) → draft-02 §5.2.17 (`refs/moq/draft-ietf-moq-msf-02.txt:1495`)
  - spatialId: draft-01 §5.2.17 (`refs/moq/draft-ietf-moq-msf-01.txt:1102`) → draft-02 §5.2.18 (`refs/moq/draft-ietf-moq-msf-02.txt:1503`)
  - codec: draft-01 §5.2.18 (`refs/moq/draft-ietf-moq-msf-01.txt:1110`) → draft-02 §5.2.19 (`refs/moq/draft-ietf-moq-msf-02.txt:1521`)
  - mimeType: draft-01 §5.2.19 (`refs/moq/draft-ietf-moq-msf-01.txt:1129`) → draft-02 §5.2.20 (`refs/moq/draft-ietf-moq-msf-02.txt:1532`)
  - framerate: draft-01 §5.2.20 (`refs/moq/draft-ietf-moq-msf-01.txt:1135`) → draft-02 §5.2.21 (`refs/moq/draft-ietf-moq-msf-02.txt:1538`)
  - timescale: draft-01 §5.2.21 (`refs/moq/draft-ietf-moq-msf-01.txt:1143`) → draft-02 §5.2.22 (`refs/moq/draft-ietf-moq-msf-02.txt:1546`)
  - bitrate: draft-01 §5.2.22 (`refs/moq/draft-ietf-moq-msf-01.txt:1149`) → draft-02 §5.2.23 (`refs/moq/draft-ietf-moq-msf-02.txt:1552`)
  - avgBitrate: draft-01 §5.2.23 (`refs/moq/draft-ietf-moq-msf-01.txt:1157`) → draft-02 §5.2.24 (`refs/moq/draft-ietf-moq-msf-02.txt:1560`)
  - maxGopDuration: draft-01 §5.2.24 (`refs/moq/draft-ietf-moq-msf-01.txt:1164`) → draft-02 §5.2.25 (`refs/moq/draft-ietf-moq-msf-02.txt:1576`)
  - maxGroupDuration: draft-01 §5.2.25 (`refs/moq/draft-ietf-moq-msf-01.txt:1181`) → draft-02 §5.2.26 (`refs/moq/draft-ietf-moq-msf-02.txt:1585`)
  - width: draft-01 §5.2.26 (`refs/moq/draft-ietf-moq-msf-01.txt:1189`) → draft-02 §5.2.27 (`refs/moq/draft-ietf-moq-msf-02.txt:1593`)
  - height: draft-01 §5.2.27 (`refs/moq/draft-ietf-moq-msf-01.txt:1197`) → draft-02 §5.2.28 (`refs/moq/draft-ietf-moq-msf-02.txt:1601`)
  - samplerate: draft-01 §5.2.28 (`refs/moq/draft-ietf-moq-msf-01.txt:1205`) → draft-02 §5.2.29 (`refs/moq/draft-ietf-moq-msf-02.txt:1609`)
  - channelConfig: draft-01 §5.2.29 (`refs/moq/draft-ietf-moq-msf-01.txt:1212`) → draft-02 §5.2.30 (`refs/moq/draft-ietf-moq-msf-02.txt:1616`)
  - displayWidth: draft-01 §5.2.30 (`refs/moq/draft-ietf-moq-msf-01.txt:1222`) → draft-02 §5.2.31 (`refs/moq/draft-ietf-moq-msf-02.txt:1635`)
  - displayHeight: draft-01 §5.2.31 (`refs/moq/draft-ietf-moq-msf-01.txt:1237`) → draft-02 §5.2.32 (`refs/moq/draft-ietf-moq-msf-02.txt:1643`)
  - lang: draft-01 §5.2.32 (`refs/moq/draft-ietf-moq-msf-01.txt:1245`) → draft-02 §5.2.33 (`refs/moq/draft-ietf-moq-msf-02.txt:1651`)
  - parentName: draft-01 §5.2.33 (`refs/moq/draft-ietf-moq-msf-01.txt:1253`) → draft-02 §5.2.34 (`refs/moq/draft-ietf-moq-msf-02.txt:1659`)
  - parentNamespace: draft-01 §5.2.34 (`refs/moq/draft-ietf-moq-msf-01.txt:1261`) → draft-02 §5.2.35 (`refs/moq/draft-ietf-moq-msf-02.txt:1668`)
  - trackDuration: draft-01 §5.2.35 (`refs/moq/draft-ietf-moq-msf-01.txt:1270`) → draft-02 §5.2.36 (`refs/moq/draft-ietf-moq-msf-02.txt:1692`)
  - connectionUri: draft-01 §5.2.36 (`refs/moq/draft-ietf-moq-msf-01.txt:1278`) → draft-02 §5.2.37 (`refs/moq/draft-ietf-moq-msf-02.txt:1700`)
  - token: draft-01 §5.2.37 (`refs/moq/draft-ietf-moq-msf-01.txt:1304`) → draft-02 で廃止 (A.1.3 5444-5446)
  - encryptionScheme: draft-01 §5.2.38 (`:1313`) → draft-02 §5.2.38 (1715)
  - cipherSuite: draft-01 §5.2.39 (`:1336`) → draft-02 §5.2.39 (1745)
  - keyId: draft-01 §5.2.40 (`:1375`) → draft-02 §5.2.40 (1774)
  - trackBaseKey: draft-01 §5.2.41 (`:1405`) → draft-02 §5.2.41 (1804)
  - authInfo: draft-01 §5.2.42 (`:1421`) → draft-02 §5.2.42 (1820)
  - accessibility: draft-01 §5.2.44 (`:1489`) → draft-02 §5.2.44 (1885)
  - 新規: accessibleWindowTime §5.2.45 (1927)、keyframeSpacing §5.2.46 (1949)
- 文書全体の節移動: draft-01 §11.2 (Initiating) → draft-02 §11.3 (4412)、draft-01 §11.3 (Ending) → draft-02 §11.4 (4429)、draft-01 §11.4 (Authorization) → draft-02 §11.5 (4449)、draft-01 §11.4.3 (Presenting Authorization) → draft-02 §11.5.3 (4513)。§11.2 は新設の name mapping に割り当てられた。

**現行実装**

- ほぼすべての MSF モジュールの JSDoc とエラーメッセージが draft-01 の節番号を引用している。例:
  - `src/msf/version.ts:2` (「§5.1.1 / §5.2.4 / §5.2.6 / §5.2.39」)
  - `src/msf/catalogTrackValidation.ts:2` のヘッダと、`:118, 128, 159, 181, 209, 220, 238, 263, 286, 304, 326, 388, 416, 445, 504, 607` 付近の §5.2.x
  - `src/msf/catalogValidation.ts:167, 221-232, 262-266, 312-313, 345-360` の §5.1.x / §5.2.x
  - `src/msf/catalogDelta.ts:2, 26-40, 50-51, 107-108, 116, 123-134, 141-148, 150`
  - `src/msf/catalogCodec.ts:2, 37, 41, 179, 264-270, 308-311` など
  - `src/msf/variables.ts:21-62` の §5.4.1 の文字制約コメント
  - `src/msf/types.ts` の各フィールドの節番号 (draft-01 のまま)
  - `src/msf.ts:1-8, 16, 26, 45-108` のファイル全体の節番号
  - エラーメッセージ中の `per §5.2.13` (initRef) は draft-02 では §5.2.14 を指すべき (`src/msf/catalogValidation.ts:255` ほか)。逆に draft-02 §5.2.13 は altGroup であり、誤解を招く。
  - `src/fullTrackName.ts:132-133, 161-163` の `draft-ietf-moq-msf-01 §11.1.2` 参照。
  - `docs/HIGH_LEVEL_API.md` / `docs/LOW_LEVEL_API.md` / `docs/ARCHITECTURE.md` にも多数。
- 生成メッセージの文字列はテストで固定されているため、テストも同時に更新が必要 (`src/msf.test.ts` の `/per §5\.2\.13/` など)。

**必要な変更**

- 実装コードの JSDoc・コメント・エラーメッセージの節番号を draft-02 に更新する。少なくともエラーメッセージ (ユーザー可視) を優先する。
- 「§5.2.x」の一括置換は機械的に行わず、フィールド名と節番号の対応表 (上記) を使って 1 件ずつ確認する。draft-01 の §5.2.13 (initRef) を draft-02 の §5.2.13 (altGroup) に単純置換すると誤りになる。
- `token` 関連 (§5.2.37) の記述は削除または非推奨に更新する。
- テストの期待メッセージも同時に更新する。

**互換性影響**

- エラーメッセージ文字列の変更 (テストと、メッセージを解析する利用者に影響)。wire には影響しない。
- API の型・挙動の変更なし。

**優先度**: P2。プロトコル準拠には影響しないが、調査・実装の根拠としての正確性に影響する。他の変更でテストを触る際に合わせて直すのが効率的。

## 4. 変更不要と確認した項目

| 項目                                                                                      | 仕様                                                                            | 現行実装                                                                                                                                                                                  | 判定                                                                   |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `isComplete` の MUST NOT include if false / MUST NOT remove once added                    | §5.1.3 (800-811)。draft-01 と同文                                               | `src/msf/catalogValidation.ts:72-84`、`src/msf/catalogDelta.ts:50-60, 160-162`                                                                                                            | 変更不要                                                               |
| `tracks` は必須 Array                                                                     | §5.1.4 (813-817)。draft-01 と同文                                               | `src/msf/catalogValidation.ts:62-70`                                                                                                                                                      | 変更不要                                                               |
| `publishTracks` は optional Array、通常 track と同じ構造                                  | §5.1.5 (819-828)。draft-01 と同文                                               | `src/msf/catalogValidation.ts:106-116`、`src/msf/catalogTrackValidation.ts`                                                                                                               | 変更不要                                                               |
| parser は未知フィールドを ignore MUST                                                     | §5 (745)                                                                        | 実装は「検証しないが保持する」(`src/msf/catalogValidation.ts:147-159`、`src/msf/catalogCodec.ts:107-112, 250-257, 360-369`)。ignore より強い保持だが、round-trip と §5.4 置換のために必要 | 変更不要 (保持方針を維持)                                              |
| catalog object は変化時 / cache 期限切れ時に publish SHOULD                               | §5 (705-707)。文言が "availability of tracks" → "content of the catalog" に変化 | 初回 + `catalogRepublishIntervalMs` の周期送り直し (`src/createMediaPublisher.ts:1918-1953, 2018-2064`、`src/catalogRepublish.ts:44-53`)                                                  | 変更不要 (周期送り直しは SHOULD に適合)                                |
| producer は頻繁な delta のとき独立 catalog を新 Group で定期 publish SHOULD               | §5.3 (2005-2008)                                                                | publisher は delta を送らず、常に独立 catalog を新 Group で送る (`src/createMediaPublisher.ts:2018-2064`)                                                                                 | 変更不要 (delta 未送信のため SHOULD の対象外。むしろ適合)              |
| 独立 catalog は新 Group の先頭 (Object ID 0)                                              | §5 (716-722)                                                                    | `src/createMediaPublisher.ts:1982-2002`                                                                                                                                                   | 変更不要 (subgroup 0 の明示のみ CAT-03)                                |
| remove の track object の必須・許可フィールド                                             | §5.1.6 (860-864)                                                                | `src/msf/catalogValidation.ts:267-310`                                                                                                                                                    | 変更不要                                                               |
| clone の属性継承・上書き、parentNamespace 省略時の catalog namespace 継承                 | §5.1.6 (866-873)、§5.2.35 (1689-1690)                                           | `src/msf/catalogDelta.ts:85-137`                                                                                                                                                          | 変更不要 (CAT-09)                                                      |
| delta の逐次適用                                                                          | §5.3 (1999-2003)                                                                | `src/msf/catalogDelta.ts:62-139` (配列順)                                                                                                                                                 | 変更不要                                                               |
| `depends` / `template` の型                                                               | §5.2.15 (1461-1478)、§5.2.16 (1480-1493)                                        | `src/msf/catalogTrackValidation.ts:220-236`                                                                                                                                               | depends の renderGroup 対応は他担当 (§6 参照)。template の型は変更なし |
| `catalog` の root は JSON document、mandatory fields 必須、custom field 名は衝突 MUST NOT | §5 (738-745)                                                                    | `src/msf/catalogCodec.ts:272-304`、`src/msf/catalogValidation.ts:38-161`                                                                                                                  | 変更不要 (custom field 名の衝突検査は producer 責任のため実装対象外)   |

## 5. 要確認事項

実装前に方針を決める必要があるものを列挙する。

1. **`"1"` / `"draft-01"` を decode で受理し続けるか** (CAT-01)。§5.1.1 の MUST NOT を厳格に取るなら `"draft-02"` のみ。draft-01 の catalog を読む必要が残るなら、version ごとに解釈を切り替える実装 (namespace の `/` 区切り・delta root 拘束・initData 型) が必要で、単に受理集合に入れるだけでは誤解釈になる。
2. **delta 内の未知 (custom) ルートフィールドの可否** (CAT-05)。§5.3 の「other Root Catalog fields」は §5.1 の 7 フィールドを指すと解釈できる。custom field は §5 (741-743) で producer が追加 MAY とされているため、delta でも保持してよいか。推奨は「既知ルートフィールドは拒否、custom は保持」。
3. **`update` の `name` の扱い** (CAT-06/08)。仕様は update の track object に Track Name を要求せず、例も含まない。rename を許すか禁止するか。推奨は「属性として許可し、合成後の Full Track Name 一意性を検査」。
4. **変数参照の完全な文法** (CAT-11)。名前制約撤廃後の「`%` と `%` の間」の定義、空名前 (`%%`)・多重 `%` (`%%x%%`) の扱い。fragment の `param-name` は `/` `:` `@` や sub-delims を含める (§11.1 ABNF 4053-4069) ため、catalog 値中の `%a/b%` を許すか。推奨は「`%` を含まない 1 文字以上」。
5. **initData の `data` の hex 表記** (CAT-10)。"hex notation" が `"0x0D"` か `"0D"` か。また `resolveInitData` の新 API 形状。
6. **未知の initData `type` の扱い** (CAT-10)。受理して `undefined` を返すか、catalog invalid とするか。
7. **NUL の受信側の扱い** (CAT-13)。仕様は producer MUST NOT のみ。consumer は §13.1 から invalid 扱いが妥当だが明記はない。
8. **孤立サロゲートの検査対象フィールドの範囲** (CAT-13)。§11.2 が列挙する §5.2.2 / §5.2.3 / §5.2.15 / §5.2.34 / §5.2.35 と拡張フィールド。`label` / `lang` / `codec` など名前以外の文字列にも課すか (仕様は「name mapping の対象フィールド」に限定している)。
9. **購読時の namespace 解決の API 形状** (CAT-14)。`CatalogTrack.namespace` を string のまま、`/` 分割を内部で行うか、公開型を `string[]` に変えるか。高レベル API の `video.trackName` と namespace の指定方法も含む。
10. **§11.2.3 の raw バイト比較をどこまで適用するか** (CAT-14)。MOQT 受信経路の `TextDecoder` を fatal にすると影響範囲が広い。catalog 連携の比較だけに限定するか。
11. **`trackBaseKey` の opt-in の設計** (CAT-15)。オプション名、既定で拒否する範囲 (encode のみ / createCatalog も)、subscriber 側の扱い。
12. **catalog 圧縮の publisher 対応** (CAT-18)。高レベル publisher が catalog を圧縮する手段を提供するか、subscriber のみ対応するか。
13. **`CatalogDelta.generatedAt` を TypeScript の必須プロパティにするか** (CAT-05)。必須にすると `applyCatalogDelta` を直接呼ぶ利用者のコードが壊れる。
14. **`getTrackByName` のシグネチャ変更** (CAT-14)。namespace 引数の追加は公開 API の破壊的変更。別名の新関数を追加する選択肢もある。
15. **未知の `packaging` 値の扱い** (CAT-02)。受理継続 (現状) か、catalog invalid か。Table 5 は "Allowed values" とだけ書く。

## 6. 担当外だが接続が必要な変更 (他エージェントとの突き合わせ用)

本レポートの担当範囲 (Catalog の骨格) の外だが、同じファイル・同じ検証関数に触れるため、担当間で整合が必要な項目を列挙する。

| 項目                                                                                          | 仕様                                                  | 実装の現状                                                                                                                                                                  | 影響する CAT                                       |
| --------------------------------------------------------------------------------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| packagingMetadata と `streamMapping`                                                          | §5.2.5 (1205-1223)、§4.1.1                            | `PackagingType` に `packagingMetadata` フィールドなし (`src/msf/types.ts:100-226`)、`KNOWN_TRACK_FIELDS` に含まれない (`src/msf/catalogTrackValidation.ts:28-71`)           | CAT-02 / CAT-20                                    |
| `depends` が renderGroup (Number) を参照可能                                                  | §5.2.15 (1461-1478)、A.1.4 (5473-5475)                | `depends?: string[]` (`src/msf/types.ts:144`)、string のみ検証 (`src/msf/catalogTrackValidation.ts:226-232`)、renderGroup の解決検証なし                                    | CAT-14 (名前比較) / CAT-20                         |
| `mediatimeline` / `eventtimeline` の mimeType 必須撤廃、depends の条件変更                    | §7.2 (3421-3431)、§8.2 (3645-3658)、A.1.4 (5470-5472) | `validatePackagingSpecificRules` が depends MUST と mimeType=`application/json` MUST を課す (`src/msf/catalogTrackValidation.ts:449-513`)                                   | CAT-09 (合成後検証) / CAT-07 (update 適用後の検証) |
| role `data` の追加                                                                            | Table 7 (1322-1324)                                   | `RESERVED_TRACK_ROLES` に `data` なし (`src/msf/version.ts:61-72`)                                                                                                          | CAT-02 (定数)                                      |
| track-level `token` の廃止、`authInfo` への移行                                               | A.1.3 (5444-5446)、§5.2.42-43 (1820-1885)             | `PublishTrack.token` (`src/msf/types.ts:234-240`)、clone 以外で `token` を許可 (`src/msf/catalogValidation.ts:416-428, 476-486`)、置換対象 (`src/msf/variables.ts:200-206`) | CAT-12 / CAT-15                                    |
| `cipherSuite` は `encryptionScheme === "moq-secure-objects"` のときのみ必須                   | §5.2.39 (1750-1751)、A.1.3 (5452-5453)                | `encryptionScheme` があれば常に `cipherSuite` 必須 (`src/msf/catalogTrackValidation.ts:296-301`)。custom scheme では過剰                                                    | CAT-20 相当 (検証の厳しすぎ)                       |
| `accessibleWindowTime` / `keyframeSpacing` の追加                                             | §5.2.45 (1927-1948)、§5.2.46 (1949-1974)              | 型・検証ともになし                                                                                                                                                          | CAT-20 (節番号) / CAT-14 (depends)                 |
| MSF_COMPRESSION の property ID 0x78                                                           | §12.1 (4625-4678)、A.1.8 (5538-5540)                  | 定数のみで ID・helper・併用検証が未実装 (`src/properties.ts:36-44`)                                                                                                         | CAT-18 / CAT-16                                    |
| VIDEO_CONFIG (0x0D) / AUDIO_CONFIG (0x0F) と initData の `track-property` / `object-property` | §12.2 (4680-4724)                                     | 初期化プロパティは LOC の Track Property として別実装 (`src/properties.ts`)。catalog の initRef とは未接続                                                                  | CAT-10 / CAT-18                                    |
| `c4m` → `cat` (fragment の予約パラメータ名)                                                   | §11.1.1 (4107, 4134)、A.1.7 (5530-5532)               | `getC4mParameter` は `c4m` 固定 (`src/msf/c4m.ts:75-90`)、`authInfo` の変数参照は `%c4m%` (`src/msf/authInfo.ts:23, 58`)                                                    | CAT-11 / CAT-12 (authInfo の変数)                  |
| §11.4.3 → §11.5.3 (Authorization の節移動)                                                    | §11.5.3 (4513)                                        | コメント・メッセージが §11.4.3 を引用 (`src/mediaSubscriber/catalogSubscription.ts:147-152`、`src/createMediaPublisher.ts:1820-1823` ほか)                                  | CAT-20                                             |
| Event Timeline の index key が `t`/`l`/`m` → `T`/`L`/`M`、MSF_EVENT_TIMELINE_HEADER           | A.1.5 (5480-5495)、§8.1 (3554-3612)                   | `EventTimelineEntry` は小文字キー (`src/msf/types.ts:380-392`)、`src/msf/timeline.ts`                                                                                       | 本担当外 (CAT-20 の参照更新のみ)                   |
| MOQ Log / Metrics の namespace / track name 規則の変更                                        | A.1.6 (5509-5515)                                     | `src/moqlog.ts` / `src/moqmetrics.ts`。metrics の catalog track 名に `CATALOG_TRACK_NAME` を再利用 (`src/moqmetrics.ts:764`)                                                | CAT-02 (名前の混同注意)                            |

## 7. draft-01 の挙動を固定していて更新が必要なテスト一覧

`src/msf.test.ts` (3441 行) と `src/msf.prop.ts` (1205 行) を全テスト名ベースで確認し、draft-01 の挙動を固定しているテストを列挙する。行番号は HEAD 時点。

### 7.1 `src/msf.test.ts`

| 行                                     | テスト名                                                                                | 固定している draft-01 挙動                                         | 必要な更新                                                                                               | CAT                    |
| -------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- | ---------------------- |
| 88                                     | `MSF_VERSION: encode 時は draft-01 を出力する (§5.1.1)`                                 | encode 値 `"draft-01"`                                             | 期待値を `"draft-02"` へ                                                                                 | CAT-01                 |
| 92                                     | `MSF_KNOWN_VERSIONS: draft-01 と 1 を受理する (§5.1.1)`                                 | 受理集合 `{"draft-01","1"}`                                        | `"draft-02"` を追加し、`"1"`/`"draft-01"` の扱いを方針どおりに                                           | CAT-01                 |
| 102                                    | `Catalog: フルカタログの round-trip (draft-01)`                                         | version `"draft-01"`、テスト名                                     | version を `"draft-02"` へ、テスト名も                                                                   | CAT-01                 |
| 112                                    | `Catalog: 文字列 1 も decode 受理する (§5.1.1 non-normative 例)`                        | `"1"` の受理                                                       | 受理をやめるなら削除、残すなら根拠コメントを draft-02 に                                                 | CAT-01                 |
| 118, 123, 128                          | `draft-00` / 未知 version の reject テスト                                              | reject の期待集合 (`expected one of [draft-01, 1]`)                | 期待メッセージを新しい集合に                                                                             | CAT-01                 |
| 159, 172, 188, 208, 230                | `isComplete` / delta root / generatedAt のテスト                                        | 内部で `version: "draft-01"` を構築                                | version リテラル置換                                                                                     | CAT-01                 |
| 517, 549, 578, 618, 648, 666, 677, 692 | root / track 構造のテスト                                                               | `version: "draft-01"` を構築                                       | version リテラル置換                                                                                     | CAT-01                 |
| 648                                    | `Catalog: encodeCatalog の JSON フィールド順序は ... (§5.1.7)`                          | 「MUST be located after the tracks array」                         | コメントを SHOULD に。順序の期待は維持                                                                   | CAT-10                 |
| 1010-1091                              | `initRef` の参照切れ / `%` を含む値の skip 系                                           | §5.2.13 の節番号、`%` を含む initRef の扱い                        | 節番号を §5.2.14 に。変数名制約撤廃後の `%` 判定を再確認                                                 | CAT-11, CAT-20         |
| 1045                                   | `Catalog: initRef は type を問わず initDataList のエントリを指せば受理される (§5.2.13)` | `type` を解釈しない                                                | `type` が意味を持つようになるため、テスト名・対象を更新                                                  | CAT-10                 |
| 1231                                   | `Catalog: parentName を delta 外で含めると reject (§5.2.33)`                            | parentName は clone 専用                                           | update を許可するためメッセージ・対象を更新                                                              | CAT-08, CAT-20         |
| 1354                                   | `Catalog: 未知ルートフィールドは検証しないが保持する (§5)`                              | 未知 root の保持                                                   | delta の既知 root フィールド拒否と区別するテストを追加                                                   | CAT-05                 |
| 1507-1873                              | template / applyCatalogDelta 統合テスト群                                               | `version: "draft-01"`、generatedAt なし delta                      | version 置換、generatedAt 追加                                                                           | CAT-01, CAT-05         |
| 1878                                   | `CatalogDelta: encode は deltaUpdate 配列形式で op キーを出力する (§5.1.6)`             | generatedAt なし encode                                            | generatedAt を追加 (必須化)                                                                              | CAT-05                 |
| 1892, 1902, 1916, 1972, 2041           | delta の round-trip / 複数 op / 空 op                                                   | generatedAt なし delta                                             | generatedAt を追加                                                                                       | CAT-05                 |
| 1941                                   | `CatalogDelta: 未知ルートフィールドは decode → encode で round-trip する (§5)`          | delta の `publishTracks` 保持                                      | `publishTracks` は reject、custom field のみ保持に分割                                                   | CAT-05                 |
| 1988, 1993                             | version / tracks を含む delta の reject                                                 | 既存                                                               | 維持 (文言は §5.3 のまま)                                                                                | CAT-05                 |
| 1998                                   | `deltaUpdate が空配列は reject`                                                         | generatedAt なし                                                   | generatedAt 追加後の検証順序を確認                                                                       | CAT-05                 |
| 2003, 2008                             | draft-00 形式の reject                                                                  | 既存                                                               | 維持                                                                                                     | —                      |
| 2017                                   | `CatalogDelta: 未知 op 値は reject (§5.1.6)`                                            | op 一覧 `[add, remove, clone]`                                     | `[add, remove, clone, update]` に。`patch` は unknown のまま                                             | CAT-06                 |
| 2022, 2027, 2034                       | op の tracks 欠落 / remove 追加フィールド / clone parentName                            | 既存                                                               | 維持 (2034 は節番号を §5.2.34 に)                                                                        | CAT-08, CAT-20         |
| 2050-2248                              | `applyCatalogDelta` の直呼びテスト群                                                    | `CatalogDelta` を直接構築 (generatedAt なし)、version `"draft-01"` | generatedAt 必須化に伴い修正。update / illogical op のテストを追加                                       | CAT-05, CAT-06, CAT-07 |
| 2161, 2174, 2187, 2205                 | 存在しない remove / 二重 remove                                                         | 既存                                                               | 維持 (CAT-07 の方針と整合)                                                                               | CAT-07                 |
| 2254-2291                              | `resolveInitData` の inline 解決 / id 重複                                              | 返り値 string、`type` 不問                                         | 返り値の型変更に追随。track-property / object-property のテスト追加                                      | CAT-10                 |
| 2297-2462                              | `resolveCatalogVariables` のテスト群                                                    | 変数名・値の制約、置換後は initRef のみ検証                        | 値の許可文字追加、名前制約撤廃、置換後の完全検証に追随 (2318 は反転、2306 に `+ / = .` の許可ケース追加) | CAT-11, CAT-12         |
| 2456                                   | `resolveCatalogVariables: % リテラル単独は reject (§5.4.1)`                             | 既存                                                               | 維持                                                                                                     | CAT-11                 |
| 2464-2560                              | 未知フィールドの置換                                                                    | 既存                                                               | 維持 (connectionUri の置換をやめる場合のみ 2545 を確認)                                                  | CAT-12                 |
| 2707                                   | `MsfCompressionAlgorithm: NONE=0n と GZIP=1n ...`                                       | 定数のみ                                                           | property ID 0x78 と encode/decode のテストを追加                                                         | CAT-18                 |
| 2783                                   | `createCatalog: version は draft-01 になる`                                             | `"draft-01"`                                                       | `"draft-02"` へ                                                                                          | CAT-01                 |
| 2788-2888                              | createCatalog / createCompleteCatalog 系                                                | version `"draft-01"`                                               | version 置換                                                                                             | CAT-01                 |
| 2888                                   | `CATALOG_TRACK_NAME: 定数が catalog`                                                    | 既存                                                               | 維持                                                                                                     | CAT-02                 |
| 2892-3056                              | トラック検索 / targetLatency のテスト                                                   | version `"draft-01"`                                               | version 置換                                                                                             | CAT-01                 |
| 3241, 3287                             | `catalogAuthInfoForSetupToken` の `%c4m%`                                               | draft-01 の予約パラメータ `c4m`                                    | c4m → cat の変更に追随 (URI/認可担当と連携)                                                              | CAT-11 (連携)          |

### 7.2 `src/msf.prop.ts`

| 行        | テスト / arbitrary                                     | 固定している draft-01 挙動                                               | 必要な更新                                                                                                                           | CAT                            |
| --------- | ------------------------------------------------------ | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------ |
| 55-61     | `packagingArb`                                         | Table 4 の 5 値のみ                                                      | `catalog` を追加 (§5.2.4 Table 5)                                                                                                    | CAT-02                         |
| 181-269   | `catalogTrackArb`                                      | namespace は任意 string。draft-02 の新フィールドなし                     | namespace を `/` 区切り 1-32 field の生成器に (CAT-14 の検証を入れると現行 arbitrary は大量に不正値を生成する)。新フィールドは他担当 | CAT-14                         |
| 274-278   | `initDataEntryArb`                                     | `type` は `"inline"` 固定                                                | 3 型の arbitrary に                                                                                                                  | CAT-10                         |
| 321-330   | `catalogArb`                                           | `version: "draft-01"`                                                    | `"draft-02"` へ                                                                                                                      | CAT-01                         |
| 433-441   | `Catalog: decode 後の version は常に draft-01`         | encode が常に `"draft-01"`                                               | `"draft-02"` へ                                                                                                                      | CAT-01                         |
| 644-706   | `deltaArb` / delta round-trip                          | generatedAt 任意、update op なし                                         | generatedAt 必須、updateOpArb 追加                                                                                                   | CAT-05, CAT-06                 |
| 712-713   | `variableNameArb` / `variableValueArb`                 | 名前 `[A-Za-z0-9_-]`、値 `[A-Za-z0-9_@-]`                                | 名前は `%` を含まない任意 (または URI の param-name 準拠)、値に `+ / = .` を追加                                                     | CAT-11                         |
| 715-748   | 変数置換の PBT 2 件                                    | 上記 arbitrary に依存                                                    | arbitrary 更新に追随                                                                                                                 | CAT-11                         |
| 751-768   | `applyCatalogDelta: add で track 数が増加する性質`     | 衝突時は「何も検証しない」                                               | 衝突時は reject されることを検証する性質に変更                                                                                       | CAT-07                         |
| 770-796   | `applyCatalogDelta: remove で指定 track が消える性質`  | 既存                                                                     | 維持                                                                                                                                 | —                              |
| 841-917   | `applyCatalogDelta` の個別テスト                       | version `"draft-01"`                                                     | version 置換。update / illogical op のテスト追加                                                                                     | CAT-01, CAT-06, CAT-07         |
| 989-998   | `packagingArb: Table 4 reserved 値を網羅する (§5.2.4)` | Table 4 の 5 値                                                          | Table 5 の 6 値に。テスト名・期待値を更新                                                                                            | CAT-02                         |
| 1004-1018 | `createCatalog` / `createCompleteCatalog` の version   | `"draft-01"`                                                             | `"draft-02"` へ                                                                                                                      | CAT-01                         |
| 1024-1187 | 仕様書 §5.6 例のテスト (draft-01 §5.6 由来)            | `"version": "1"` (`:1027`)、`"draft-01"` (`:1176`)、draft-01 の delta 例 | draft-02 の例 (§5.6.1 / §5.6.4 / §5.6.5 など) に差し替え。§5.6.4 は update を含む。namespace は `/` 区切り                           | CAT-01, CAT-05, CAT-06, CAT-14 |
| 1193-1204 | fragment PBT                                           | 既存                                                                     | 維持                                                                                                                                 | —                              |

### 7.3 その他のテスト

| ファイル:行                                            | 内容                                                                                                                             | 必要な更新                                                                                                               | CAT                    |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------- |
| `src/createMediaSubscriber.catalog.test.ts:56-262`     | `processCatalogPayload` / delta 適用のテスト。delta を `generatedAt` なしで構築し、`makeCatalog` が `version: "draft-01"` を返す | `makeCatalog` の version を `"draft-02"` に。delta に generatedAt を追加。Object ID / Group のマッピング検証テストを追加 | CAT-01, CAT-03, CAT-05 |
| `src/testSupport/mediaSubscriberTestSupport.ts:34-39`  | `makeCatalog` が `version: "draft-01"` 固定                                                                                      | `"draft-02"` へ (影響する全テストに波及)                                                                                 | CAT-01                 |
| `src/createMediaPublisher.test.ts`                     | catalog payload の検証は `"version" in decoded` の判別のみで version リテラルなし                                                | 変更不要 (ただし compression / priority のテストは追加候補)                                                              | CAT-04, CAT-18         |
| `devtools/src/hooks/usePublisher.test.ts:181-198, 957` | `encodeCatalog` → `decodeCatalogMessage` の round-trip                                                                           | version 変更には自動追随。`%c4m%` の期待は c4m→cat に追随                                                                | CAT-01, CAT-11 (連携)  |
| `devtools/src/hooks/useSubscriber.ts:3040-3060`        | devtools は delta を適用しない (「applyCatalogDelta による差分適用は未実装」)                                                    | draft-02 の delta を扱うには devtools 側の実装が必要 (本担当外だが、catalog 骨格の変更に追随)                            | CAT-05, CAT-06         |

## 8. 更新が必要なドキュメント記述

### 8.1 `docs/MSF.md` (35 行)

| 行    | 現在の記述                                                                                                                     | 更新内容                                                                                                                                                                  |
| ----- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 10    | 正本: `refs/moq/draft-ietf-moq-msf-01.txt`                                                                                     | `refs/moq/draft-ietf-moq-msf-02.txt`                                                                                                                                      |
| 11    | 公開版: draft-ietf-moq-msf-01                                                                                                  | draft-ietf-moq-msf-02                                                                                                                                                     |
| 14-16 | 「draft-23 前提」の説明。MSF-01 §5 の Joining FETCH を fill fetch として解釈。現状は 2 リクエストで代替、fill fetch 化は未実装 | draft-02 でも §5 (733-736) の MUST は同文であることを明記。低レベル API には `SubscribeOptions.fill` があり、catalog 取得のみ 2 リクエストという現状を正確に書く (CAT-19) |
| 22    | `parseMsfFragmentValue` の参照が §11.1                                                                                         | 変更なし (§11.1 は同じ)。ただし CAT-14 の namespace 解釈を追記                                                                                                            |
| 23-24 | トークン付与の参照 §11.4.3                                                                                                     | §11.5.3 に更新 (CAT-20)                                                                                                                                                   |
| 25    | Catalog API 一覧 `MSF_VERSION` / `CATALOG_TRACK_NAME`                                                                          | 変更なし。`resolveCatalogVariables` の公開状況、入れ子 catalog の扱いを追記                                                                                               |
| 26    | `authInfo` の `{"cat": "%c4m%"}`                                                                                               | fragment パラメータ名が `cat` になったことに合わせて `%c4m%` の扱いを更新 (URI 担当と連携)                                                                                |
| 28    | 「現行 Timeline encode/decode は無圧縮 JSON のみ。ペイロード圧縮のシグナリングは仕様の MSF_COMPRESSION (未実装)」              | draft-02 で 0x78 が確定したこと、catalog の受信対応 (CAT-18) を追記                                                                                                       |
| 29    | 「draft-00 の Catalog wire 形式および Timeline 圧縮オプションとは非互換」                                                      | draft-01 → draft-02 の破壊的変更 (version / delta / namespace / initData) を追記                                                                                          |

### 8.2 `docs/IMPLEMENTATION_STATUS.md` (231 行)

| 行      | 現在の記述                                                                      | 更新内容                                                                                                                                                                                                                 |
| ------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 143     | 「draft-ietf-moq-msf-01 の機能実装状況である」                                  | draft-02 に更新                                                                                                                                                                                                          |
| 145     | Joining FETCH の説明 (2 リクエスト代替)                                         | draft-02 では §5 の Joining FETCH MUST が維持されていること、fill fetch への移行状況 (CAT-19) を追記                                                                                                                     |
| 147-175 | Catalog の実装状況リスト                                                        | version を `draft-02` に。delta を add / remove / clone / **update** に。initDataList に `track-property` / `object-property` を追加。namespace を `/` 区切りに。publishTracks / token の廃止、trackBaseKey の制約を反映 |
| 181     | 「Timeline の payload は無圧縮 JSON のみ (MSF_COMPRESSION による圧縮は未実装)」 | catalog の圧縮受信対応を追加 (CAT-18)                                                                                                                                                                                    |
| 202-203 | トークンを `SUBSCRIBE` / `FETCH` / `authInfo` に付与、§11.4.3                   | §11.5.3 に更新 (CAT-20)                                                                                                                                                                                                  |

### 8.3 `README.md` (391 行)

| 行    | 現在の記述                                                                    | 更新内容                                                             |
| ----- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| 44-46 | 「MOQT Streaming Format (MSF) 対応」/ draft-01 のリンク / 「`draft-01` 対応」 | draft-02 のリンクと「`draft-02` 対応」に更新                         |
| 47    | 「Catalog / Timeline」                                                        | 変更なし (入れ子 catalog 対応を入れるなら追記)                       |
| 53    | 「MSF URI Fragment の `c4m` を SETUP の Authorization Token として送出」      | 予約パラメータ名が `cat` になったことに合わせて更新 (URI 担当と連携) |

### 8.4 参考 (依頼外だが同時に更新すべき文書)

- `docs/HIGH_LEVEL_API.md`: 115, 119, 125, 139, 148, 163, 230, 338, 348, 351, 363, 760, 763, 1234, 1588 に draft-01 の節番号・記述。
- `docs/LOW_LEVEL_API.md`: 95, 104, 702 に draft-01 と Joining FETCH の記述。
- `docs/ARCHITECTURE.md`、`docs/MEDIA_PLAYOUT.md`、`docs/proposals/*.md` (FETCH_GAP_RECOVERY / NAMESPACE_ANNOUNCEMENT / AUDIO_FEC)、`src/observability.ts:118`、`src/moqlog.prop.ts` / `src/moqmetrics.prop.ts`、`tests/e2e/**/*.spec.ts` にも draft-01 参照がある。本担当の範囲では実装コメントの更新 (CAT-20) に合わせて一括で見直すのが効率的。

## 9. 推奨実装順序

依存関係を考慮した順序。P0 を先に、P1 を後に置く。

1. **CAT-01** (version)。これがないと他の変更を実 catalog で検証できない。テストの version リテラル一括置換も同時に行う。
2. **CAT-13 + CAT-14 の namespace 検証**。catalog の受理条件の土台。`name` / `namespace` / `parentName` / `parentNamespace` の共通検証関数を 1 つ作る。
3. **CAT-05** (delta root 拘束) と **CAT-06 / CAT-07 / CAT-08** (update と illogical op)。delta の decode / encode / apply をまとめて変更する (同じファイル・同じテスト群)。
4. **CAT-10** (initData 型と `resolveInitData`)。API の破壊的変更を伴うため、公開 API の移行を一度にまとめる。
5. **CAT-11 / CAT-12** (変数)。CAT-13/14 の検証関数を置換後に再利用する。
6. **CAT-18** (圧縮受信) と **CAT-16** (展開後サイズ上限)。§12 担当と property encode/decode を共有する。
7. **CAT-14 の残り** (購読時の namespace 解決・Full Track Name 検索)。高レベル API の修正と E2E テストが必要。
8. **CAT-03** (Object マッピング検証)、**CAT-04** (priority)、**CAT-15** (trackBaseKey)、**CAT-19** (fill fetch)、**CAT-02** (入れ子 catalog。追うなら CAT-16 の循環検出も同時)。
9. **CAT-17** (ドキュメント中心)、**CAT-20** (節番号)。

## 10. 付録 A: 実測ログ

ビルド済み `dist/index.js` を Node.js から実行した結果 (2026-11-16)。`src` の該当コードと整合することを確認済み。

- A-1: `decodeCatalogMessage({"version":"draft-02","tracks":[]})` → `unsupported MSF version 'draft-02', expected one of [draft-01, 1]`。
- A-2: `{"version":"1"}` → 受理。`{"version":"draft-00"}` / `version: 1` → reject。
- A-3: `index.js` に `resolveCatalogVariables` は存在しない (`typeof` が `undefined`)。
- A-4: `packaging: "catalog"` と `packaging: "unknown-packaging"` の track を decode できた。
- A-5: `{"deltaUpdate":[{"op":"add",...}]}` (generatedAt なし)、`{"generatedAt":1,"publishTracks":[],"deltaUpdate":[...]}`、`isComplete` / `initDataList` 付き delta を decode できた。
- A-6: `{"generatedAt":1,"deltaUpdate":[{"op":"update","tracks":[{"parentName":"a","bitrate":1}]}]}` → `unknown op 'update', expected one of [add, remove, clone]`。
- A-7: `add` 既存 → `remove` の delta を `applyCatalogDelta` に適用 → エラーにならず、最終 tracks は空。
- A-8: `add` 既存のみ → `duplicate track name 'a' under namespace (no namespace) in tracks per §5.2.3` (最終一意性検査でのみ検出)。
- A-9: `clone` で既存 `x` を作り直し → `x` を `remove` → エラーにならず、最終 tracks は `["p"]`。
- A-10: `initDataList: [{id:"i", type:"track-property", data:"0x0D"}]` の `resolveInitData` → `undefined`。
- A-11: `encodeCatalogDelta` に `generatedAt` なしの delta を渡せた (出力 JSON に generatedAt なし)。
- A-12: BOM (`EF BB BF`) 付き draft-01 catalog → 受理 (BOM は既定の `TextDecoder` が除去)。
- A-13: 名前位置に `0xFF` を含む catalog → 受理 (U+FFFD に置換されて decode された)。
- A-14: 孤立サロゲート `\uDEAD` を名前に持つ catalog → decode 受理。`encodeCatalog` は `"\udead"` として出力 (JSON エスケープとしては保持)。
- A-15: `resolveCatalogVariables` は production 呼び出しなし (静的確認。`src/` 内の呼び出しはテストのみ)。
- A-16 (Node.js の前提確認): `new TextDecoder().decode(BOM+...)` は BOM を除去する。`new TextEncoder().encode("\uDEAD")` は `EF BF BD` (U+FFFD) を返す。`new TextDecoder("utf-8",{fatal:true}).decode([0xFF,0xFE])` は `TypeError`。`JSON.parse('"\\uDEAD"')` は長さ 1 の孤立サロゲートを返す。
- A-17: `namespace` に `"a/b"` / `""` / `"a//b"` / `"/a"` / `"a/"` / `"a/"` を 40 回繰り返した長大な値を入れても decode できた。空の Track Name、NUL を含む name も decode できた (draft-02 ではいずれも catalog invalid)。

## 11. 付録 B: 実装ファイル別の変更点 (作業分担用)

| ファイル                                                                                                                                    | 変更する CAT                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `src/msf/version.ts`                                                                                                                        | CAT-01, CAT-02, CAT-04 (定数追加)                             |
| `src/msf/types.ts`                                                                                                                          | CAT-02, CAT-05, CAT-06, CAT-10, CAT-14 (namespace の型方針)   |
| `src/msf/catalogValidation.ts`                                                                                                              | CAT-01, CAT-05, CAT-06, CAT-10, CAT-13, CAT-14                |
| `src/msf/catalogTrackValidation.ts`                                                                                                         | CAT-08, CAT-10, CAT-13, CAT-14                                |
| `src/msf/catalogCodec.ts`                                                                                                                   | CAT-01, CAT-05, CAT-06, CAT-10, CAT-13                        |
| `src/msf/catalogDelta.ts`                                                                                                                   | CAT-05, CAT-06, CAT-07, CAT-09, CAT-14                        |
| `src/msf/variables.ts`                                                                                                                      | CAT-11, CAT-12                                                |
| `src/msf/tracks.ts`                                                                                                                         | CAT-01, CAT-10, CAT-14 (`resolveInitData` / `getTrackByName`) |
| `src/msf.ts` / `src/index.ts`                                                                                                               | CAT-10, CAT-12 (公開 API の変更)                              |
| `src/fullTrackName.ts`                                                                                                                      | CAT-14 (§11.2.4 の整合確認、fatal decode の再利用)            |
| `src/mediaSubscriber/catalogSubscription.ts`                                                                                                | CAT-03, CAT-04, CAT-19                                        |
| `src/createMediaSubscriber.ts`                                                                                                              | CAT-03, CAT-04, CAT-12, CAT-14, CAT-19                        |
| `src/createMediaPublisher.ts`                                                                                                               | CAT-03, CAT-04, CAT-15, CAT-18, CAT-19 (publisher 側)         |
| `src/properties.ts`                                                                                                                         | CAT-16, CAT-18 (property 0x78)                                |
| `src/session/*`, `src/subscriber.ts`                                                                                                        | CAT-19 (fill の利用)、CAT-14 (§11.2.3 の比較経路)             |
| テスト (`src/msf.test.ts`, `src/msf.prop.ts`, `src/createMediaSubscriber.catalog.test.ts`, `src/testSupport/mediaSubscriberTestSupport.ts`) | §7 の一覧                                                     |
| ドキュメント (`docs/MSF.md`, `docs/IMPLEMENTATION_STATUS.md`, `README.md`)                                                                  | §8                                                            |
