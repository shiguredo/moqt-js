# MSF draft-02 追従調査: Catalog Track Object フィールド (§5.2) 全体

> **決定事項 (本レポートの後に確定)**: draft-01 との互換性は維持しない。
> したがって、本レポートの「互換性影響」欄にある「両方を受ける」「移行期は旧綴りも受理する」
> 「後方互換になる」といった選択肢は採らない。実装時は [README.md](README.md) 冒頭の決定事項を優先する。

- 調査対象リポジトリ: `/home/shiguredo/shiguredo/moqt-js` (TypeScript / pnpm / MOQT クライアントライブラリ)
- 正本: `refs/moq/draft-ietf-moq-msf-02.txt` (5600 行)
- 比較用: `refs/moq/draft-ietf-moq-msf-01.txt` (4144 行, draft-ietf-moq-msf-01)
- 本調査は**読み取り専用**である。リポジトリ内のファイルは一切変更していない。
- 行番号はすべて `awk` / `rg` の行番号 (正本・draft-01 は `\n` 区切り) で数えた。Python の `splitlines` は改ページ (U+000C) を改行として数えるため、本レポートでは使っていない。
- 実行時の挙動の一部は、`/tmp` 配下に置いた一時スクリプト (拡張子なし import を `.ts` に解決するだけの loader) で確認した。リポジトリには何も書き込んでいない。
- 優先度の定義:
  - **P0**: draft-02 に準拠した catalog を**誤って拒否する**、または draft-02 の MUST に反して**受理してしまう**ため相互接続が壊れる。実装しないと draft-02 対応を名乗れない。
  - **P1**: 新規フィールド・新規規則・wire 名の変更など、draft-02 追従に必須の対応。放置すると相手実装との差が出る。
  - **P2**: 検証の厳格さ・文書・定数・テストの整備。動作への影響は限定的。

---

## 0. 最初に直すべき前提 (依頼文とのずれ)

依頼文には「Table 4 (フィールド一覧)、Table 5 (role)、Table 6 (packaging)、Table 7 (cipher suite)、Table 8 (authInfo scheme)」「46 フィールド」とあるが、**正本と一致しない**。以下が実際である。本レポートは実際の番号で書く。

| 表       | draft-02 での内容                                                                                | 行        |
| -------- | ------------------------------------------------------------------------------------------------ | --------- |
| Table 1  | LOC の stream-mapping モード (`group` / `object`)。`packagingMetadata` の `streamMapping` で通知 | 509-522   |
| Table 2  | Root catalog fields                                                                              | 746-770   |
| Table 3  | Initialization Data List の `type` (`inline` / `track-property` / `object-property`)             | 886-914   |
| Table 4  | **Track fields (全 44 フィールド)**                                                              | 929-1039  |
| Table 5  | Allowed packaging values (6 値)                                                                  | 1132-1148 |
| Table 6  | **Required track fields per (packaging, role)**                                                  | 1181-1197 |
| Table 7  | Reserved track roles (11 値)                                                                     | 1283-1326 |
| Table 8  | Defined encryption schemes                                                                       | 1726-1730 |
| Table 9  | Cipher suites for moq-secure-objects                                                             | 1754-1768 |
| Table 10 | Defined Authorization Schemes                                                                    | 1838-1842 |
| Table 11 | Defined accessibility schemes                                                                    | 1911-1917 |

**フィールド数は 46 ではなく 44**。draft-01 側の対応表 (draft-01 では表番号が本文とずれており、本文は "Table 2"、キャプションは "Table 3") は **35 フィールド**で、`template` / `connectionURI` / `token` / 暗号化 4 フィールドが表から漏れていた (draft-01: 728-815)。draft-02 は 9 フィールドを追加して 44 になり、`token` は表からも本文からも削除された。

追加された 9 フィールド: `packagingMetadata` (新規), `template` (表への追加のみ), `connectionURI` (表への追加 + 名前変更), `encryptionScheme` / `cipherSuite` / `keyId` / `trackBaseKey` (表への追加のみ), `accessibleWindowTime` (新規), `keyframeSpacing` (新規)。

### draft-01 と draft-02 の節番号対応 (重要)

`eventType` の後ろに `packagingMetadata` が入り、`token` が消えたため、**節番号が場所によって +1 / 変わらない / 廃止**になる。実装と docs の `§5.2.x` 引用はほぼ全滅するので、機械的に置換してはいけない。

| フィールド               | draft-01 節                               | draft-02 節 | 変化             |
| ------------------------ | ----------------------------------------- | ----------- | ---------------- |
| namespace                | 5.2.2                                     | 5.2.2       | 同番号・内容変更 |
| name                     | 5.2.3                                     | 5.2.3       | 同番号・内容変更 |
| packaging                | 5.2.4                                     | 5.2.4       | 同番号・値追加   |
| (packagingMetadata)      | -                                         | 5.2.5       | 新規             |
| eventType                | 5.2.5                                     | 5.2.6       | +1               |
| role                     | 5.2.6                                     | 5.2.7       | +1               |
| isLive                   | 5.2.7                                     | 5.2.8       | +1               |
| targetLatency            | 5.2.8                                     | 5.2.9       | +1               |
| buffers                  | 5.2.9                                     | 5.2.10      | +1               |
| label                    | 5.2.10                                    | 5.2.11      | +1               |
| renderGroup              | 5.2.11                                    | 5.2.12      | +1               |
| altGroup                 | 5.2.12                                    | 5.2.13      | +1               |
| initRef                  | 5.2.13                                    | 5.2.14      | +1               |
| depends                  | 5.2.14                                    | 5.2.15      | +1               |
| template                 | 5.2.15                                    | 5.2.16      | +1               |
| temporalId               | 5.2.16                                    | 5.2.17      | +1               |
| spatialId                | 5.2.17                                    | 5.2.18      | +1               |
| codec                    | 5.2.18                                    | 5.2.19      | +1               |
| mimeType                 | 5.2.19                                    | 5.2.20      | +1               |
| framerate                | 5.2.20                                    | 5.2.21      | +1               |
| timescale                | 5.2.21                                    | 5.2.22      | +1               |
| bitrate                  | 5.2.22                                    | 5.2.23      | +1               |
| avgBitrate               | 5.2.23                                    | 5.2.24      | +1               |
| maxGopDuration           | 5.2.24                                    | 5.2.25      | +1               |
| maxGroupDuration         | 5.2.25                                    | 5.2.26      | +1               |
| width                    | 5.2.26                                    | 5.2.27      | +1               |
| height                   | 5.2.27                                    | 5.2.28      | +1               |
| samplerate               | 5.2.28                                    | 5.2.29      | +1               |
| channelConfig            | 5.2.29                                    | 5.2.30      | +1               |
| displayWidth             | 5.2.30                                    | 5.2.31      | +1               |
| displayHeight            | 5.2.31                                    | 5.2.32      | +1               |
| lang                     | 5.2.32                                    | 5.2.33      | +1               |
| parentName               | 5.2.33                                    | 5.2.34      | +1               |
| parentNamespace          | 5.2.34                                    | 5.2.35      | +1               |
| trackDuration            | 5.2.35                                    | 5.2.36      | +1               |
| connectionURI            | 5.2.36 (`connectionUri` というキーは無い) | 5.2.37      | +1・JSON 名追加  |
| token                    | 5.2.37                                    | (廃止)      | 削除             |
| encryptionScheme         | 5.2.38                                    | 5.2.38      | 同番号           |
| cipherSuite              | 5.2.39                                    | 5.2.39      | 同番号・条件変更 |
| keyId                    | 5.2.40                                    | 5.2.40      | 同番号           |
| trackBaseKey             | 5.2.41                                    | 5.2.41      | 同番号           |
| authInfo                 | 5.2.42                                    | 5.2.42      | 同番号           |
| (Token Delivery via URI) | 5.2.43                                    | 5.2.43      | 同番号           |
| accessibility            | 5.2.44                                    | 5.2.44      | 同番号           |
| (accessibleWindowTime)   | -                                         | 5.2.45      | 新規             |
| (keyframeSpacing)        | -                                         | 5.2.46      | 新規             |

節番号が同じでも内容が変わったもの: §5.2.2 (形式 MUST 追加)、§5.2.3 (非空 MUST・Full Track Name 一意)、§5.2.4 (値追加)、§5.2.34 / §5.2.35 (`clone or update`)、§5.2.39 (条件緩和)、§5.2.42 / §5.2.43 (文面のみ)。関連節も動いている: draft-01 §8.2 (Event Timeline Catalog requirements) は draft-02 §8.3。draft-01 §7.2 は draft-02 §7.2 (同番号・内容変更)。`initDataList` の MUST 順序は SHOULD に緩和 (draft-01 §5.1.7 → draft-02 §5.1.7、最終段落)。

---

## 1. フィールド単位の対応表 (44 フィールド)

列の意味:

- 「必須」は draft-02 §5.2.x の Required (Yes / Optional / Conditional)。
- 「実装の型」は `src/msf/types.ts` の該当行。
- 「decode/検証」は `src/msf/catalogTrackValidation.ts` (共通) と `src/msf/catalogValidation.ts` (track 入口・catalog 全体) の該当行。
- 「未知保持」= その名前が `KNOWN_TRACK_FIELDS` (`catalogTrackValidation.ts:28-71`) に無いため、未知フィールドとして保持されるだけの状態。

| #   | JSON 名                | §      | 必須        | 実装の型 (types.ts)                               | decode / 検証                                                                                                       | draft-01 との差                                                                                | 差分 ID                |
| --- | ---------------------- | ------ | ----------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ---------------------- |
| 1   | `namespace`            | 5.2.2  | Optional    | `namespace?: string` (117)                        | `pickIdentityFields` 130-138 で string 型のみ。形式・継承は未検証                                                   | 形式 MUST (1〜32 非空フィールド) と parser の invalid 判定が新設。`/` 区切りのマッピングが規定 | TRK-01, TRK-02         |
| 2   | `name`                 | 5.2.3  | Yes         | `name: string` (102)                              | `validateCatalogTrack` 375-379 で string 型のみ。空文字を拒否しない                                                 | 非空 MUST を明文化。一意性の単位を Full Track Name に変更                                      | TRK-03                 |
| 3   | `packaging`            | 5.2.4  | Yes         | `packaging: PackagingType` (105)                  | 381-387 で string を cast するだけ。Table 5 の値集合を検査しない                                                    | `catalog` が追加 (5 → 6 値)                                                                    | TRK-04                 |
| 4   | `packagingMetadata`    | 5.2.5  | Optional    | **型なし**                                        | 未知保持 (検証なし)                                                                                                 | 新規                                                                                           | TRK-05, TRK-06         |
| 5   | `eventType`            | 5.2.6  | Conditional | `eventType?: string` (120)                        | 160-179 で型 + `packaging !== "eventtimeline"` のとき MUST NOT。eventtimeline では必須                              | 本文は同一。eventtimeline の catalog 要件 (§8.3) から `depends` / `mimeType` が外れた          | TRK-24                 |
| 6   | `isLive`               | 5.2.8  | Yes         | `isLive: boolean` (114)                           | 389-395 で boolean 型のみ                                                                                           | "in a catalog update" が明記され、False→True 禁止の対象が catalog 更新であることが明確化       | TRK-10                 |
| 7   | `targetLatency`        | 5.2.9  | Optional    | `targetLatency?: number` (123)                    | 182-207 で number + 有限 + `buffers` との排他                                                                       | 意味が「符号化された時刻」から「encoder に入った時刻」基準に変更 (フィールド形状は同じ)        | TRK-25                 |
| 8   | `buffers`              | 5.2.10 | Optional    | `buffers?: Buffers` (126)                         | 182-207, 550-574 で object + `target`/`min`/`max` の number + 有限 + 未知キー無視 + `targetLatency` との排他        | 文言のみ ("MUST be buffered" → "needs to be buffered")                                         | TRK-26                 |
| 9   | `role`                 | 5.2.7  | Optional    | `role?: TrackRole` (129)                          | 139-147 で string 型のみ (custom role 許容のため値集合は検査しない)                                                 | Table 7 に `data` が追加                                                                       | TRK-23                 |
| 10  | `label`                | 5.2.11 | Optional    | `label?: string` (132)                            | 148-156 で string 型                                                                                                | なし                                                                                           | -                      |
| 11  | `renderGroup`          | 5.2.12 | Optional    | `renderGroup?: number` (135)                      | `pickOptionalNumber` 215 で number + 有限 (整数性は decode では見ない)                                              | なし                                                                                           | -                      |
| 12  | `altGroup`             | 5.2.13 | Optional    | `altGroup?: number` (138)                         | `pickOptionalNumber` 216 で number + 有限                                                                           | なし                                                                                           | -                      |
| 13  | `initRef`              | 5.2.14 | Optional    | `initRef?: string` (141)                          | 217 で string。参照解決は `assertInitRefResolvable` (catalogValidation.ts:234-259) で catalog 全体を見て実施        | 本文は同一 (draft-02 に解決 MUST の明記は無い)。実装は draft-01 から厳しめ                     | -                      |
| 14  | `depends`              | 5.2.15 | Optional    | `depends?: string[]` (144)                        | 226-232 で「string の配列」以外を reject。解決の検証は無い                                                          | String (track name) と Number (renderGroup) の両方を許容。全エントリ解決 MUST を追加           | TRK-07, TRK-08, TRK-09 |
| 15  | `template`             | 5.2.16 | Optional    | `template?: MediaTimelineTemplate` (147)          | 233-235, 615-642 で 6 要素・型・順序・Location の precision loss を検証                                             | draft-01 の表に無かっただけで、本文 (§5.2.15) と §7.4 は同一                                   | -                      |
| 16  | `temporalId`           | 5.2.17 | Optional    | `temporalId?: number` (150)                       | `pickOptionalNumber` 244                                                                                            | なし                                                                                           | -                      |
| 17  | `spatialId`            | 5.2.18 | Optional    | `spatialId?: number` (153)                        | `pickOptionalNumber` 245                                                                                            | なし                                                                                           | -                      |
| 18  | `codec`                | 5.2.19 | Conditional | `codec?: string` (156)                            | 246 で string。role=video/audio のとき MUST (`validateRoleSpecificRules` 403-414)                                   | Table 6 により (packaging, role) ごとの必須が明示された                                        | TRK-11                 |
| 19  | `mimeType`             | 5.2.20 | Optional    | `mimeType?: string` (159)                         | 247 で string。**さらに** mediatimeline / eventtimeline で `"application/json"` を必須にしている (459-465, 476-482) | §7.2 / §8.3 から mimeType 要件が削除された (A.1.4 5470-5471)                                   | TRK-12                 |
| 20  | `framerate`            | 5.2.21 | Optional    | `framerate?: number` (162)                        | `pickOptionalNumber` 248                                                                                            | Table 6 で loc+video / loc+signlanguage の必須に                                               | TRK-11                 |
| 21  | `timescale`            | 5.2.22 | Optional    | `timescale?: number` (165)                        | `pickOptionalNumber` 249                                                                                            | なし                                                                                           | -                      |
| 22  | `bitrate`              | 5.2.23 | Conditional | `bitrate?: number` (168)                          | 250 で number。role=video/audio で MUST                                                                             | Table 6 でも loc+audio / loc+video の必須 (一致)                                               | -                      |
| 23  | `avgBitrate`           | 5.2.24 | Optional    | `avgBitrate?: number` (171)                       | `pickOptionalNumber` 251                                                                                            | なし                                                                                           | -                      |
| 24  | `maxGopDuration`       | 5.2.25 | Optional    | `maxGopDuration?: number` (174)                   | `pickOptionalNumber` 252                                                                                            | なし                                                                                           | -                      |
| 25  | `maxGroupDuration`     | 5.2.26 | Optional    | `maxGroupDuration?: number` (177)                 | `pickOptionalNumber` 253                                                                                            | なし                                                                                           | -                      |
| 26  | `width`                | 5.2.27 | Optional    | `width?: number` (180)                            | `pickOptionalNumber` 254                                                                                            | なし                                                                                           | -                      |
| 27  | `height`               | 5.2.28 | Optional    | `height?: number` (183)                           | `pickOptionalNumber` 255                                                                                            | なし                                                                                           | -                      |
| 28  | `samplerate`           | 5.2.29 | Conditional | `samplerate?: number` (186)                       | 256 で number。audio codec のとき MUST (`validateAudioCodecRules` 429-443)                                          | Table 6 で loc+audio / loc+audiodescription の必須に                                           | TRK-11                 |
| 29  | `channelConfig`        | 5.2.30 | Conditional | `channelConfig?: string` (189)                    | 257 で string。audio codec のとき MUST                                                                              | 同上                                                                                           | TRK-11                 |
| 30  | `displayWidth`         | 5.2.31 | Optional    | `displayWidth?: number` (192)                     | `pickOptionalNumber` 258                                                                                            | なし                                                                                           | -                      |
| 31  | `displayHeight`        | 5.2.32 | Optional    | `displayHeight?: number` (195)                    | `pickOptionalNumber` 259                                                                                            | なし                                                                                           | -                      |
| 32  | `lang`                 | 5.2.33 | Optional    | `lang?: string` (198)                             | 260 で string 型のみ (`[LANG]` の妥当性は見ない)                                                                    | Table 6 で loc+audiodescription の必須に                                                       | TRK-11                 |
| 33  | `parentName`           | 5.2.34 | Optional    | `parentName?: string` (201)                       | clone でのみ受理 (catalogValidation.ts:450-455)。それ以外では reject (405-409)                                      | 使用可能な operation が `clone` から `clone or update` に拡大                                  | TRK-14                 |
| 34  | `parentNamespace`      | 5.2.35 | Optional    | `parentNamespace?: string` (204)                  | clone でのみ受理 (459-467)。それ以外では reject (410-414)                                                           | 同上。構文・制約は §5.2.2 と同じと明記                                                         | TRK-14                 |
| 35  | `trackDuration`        | 5.2.36 | Optional    | `trackDuration?: number` (207)                    | 264-284 で number + 有限 + `isLive === true` のとき MUST NOT                                                        | なし                                                                                           | -                      |
| 36  | `connectionURI`        | 5.2.37 | Optional    | `PublishTrack.connectionUri?: string` (236)       | publishTracks でのみ受理 (327-340)。それ以外は reject (417-428)                                                     | **JSON 名が `connectionURI`**。Table 4 に追加。examples が `moqt://` のみに                    | TRK-16                 |
| 37  | `encryptionScheme`     | 5.2.38 | Optional    | `encryptionScheme?: string` (210)                 | 292 で string                                                                                                       | "The default and RECOMMENDED value" → "The RECOMMENDED value" (文言のみ)                       | -                      |
| 38  | `cipherSuite`          | 5.2.39 | Conditional | `cipherSuite?: CipherSuite` (213)                 | 293 で string。`encryptionScheme` があれば無条件に MUST (296-301)                                                   | **`encryptionScheme` が `moq-secure-objects` のときだけ MUST** に緩和                          | TRK-17                 |
| 39  | `keyId`                | 5.2.40 | Optional    | `keyId?: string` (216)                            | 294 で string のみ                                                                                                  | 本文は同一。§4.4.3 が scheme 使用時の MUST を追加                                              | TRK-18                 |
| 40  | `trackBaseKey`         | 5.2.41 | Optional    | `trackBaseKey?: string` (219)                     | 295 で string のみ (Base64 妥当性は見ない)                                                                          | 同上                                                                                           | TRK-18                 |
| 41  | `authInfo`             | 5.2.42 | Optional    | `authInfo?: AuthInfo` (222)                       | 310-320 で object 型のみ。scheme ごとの値は検証しない                                                               | Table 8 → Table 10 (番号のみ)。`c4m` → `cat` の改名が関連                                      | TRK-19                 |
| 42  | `accessibility`        | 5.2.44 | Optional    | `accessibility?: AccessibilityDescriptor[]` (225) | 321-323, 576-605 で配列 + 各要素の `scheme` / `value` が string                                                     | Table 9 → Table 11 (番号のみ)                                                                  | TRK-20                 |
| 43  | `accessibleWindowTime` | 5.2.45 | Optional    | **型なし**                                        | 未知保持 (検証なし)                                                                                                 | 新規                                                                                           | TRK-21                 |
| 44  | `keyframeSpacing`      | 5.2.46 | Optional    | **型なし**                                        | 未知保持 (検証なし)                                                                                                 | 新規                                                                                           | TRK-22                 |

### `eventType` の値集合について (変更なし)

依頼文の論点 10 のうち「値の集合」は、draft-02 では規定されない。

- §5.2.6 1238-1242「Types are defined by the application provider and are not centrally registered.」— 値は任意の文字列。Reverse Domain Name Notation は「encouraged」であって MUST ではない。
- §8.5 3680-3692 の "MSF Event Timeline Types" レジストリは「has no initial entries」であり、登録は各 event type の仕様が行う (§14.2 5002 で新設)。
- 実装は `pickEventType` 160-179 で「string であること」と「packaging が eventtimeline のときだけ使えること」を検証しており、値集合は検査しない。これは仕様どおりである (変更不要)。
- 変わったのは eventtimeline の catalog 要件 (§8.3) から `depends` / `mimeType` が外れた点だけで、これは TRK-24 / TRK-12 で扱う。

### 削除されたフィールド

| JSON 名 | draft-01            | draft-02                               | 実装の現状                                                                                                                                      |
| ------- | ------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `token` | §5.2.37 (1304-1311) | 廃止 (Table 4 に無い。A.1.3 5444-5445) | `PublishTrack.token?: string` (types.ts:239)、publishTracks でのみ受理 (catalogTrackValidation.ts:341-349)、変数置換対象 (variables.ts:200-206) |

### JSON 名の綴り確認

| 仕様 (draft-02 Table 4)                                                                                   | 実装のキー       | 判定                                                                  |
| --------------------------------------------------------------------------------------------------------- | ---------------- | --------------------------------------------------------------------- |
| `mimeType`                                                                                                | `mimeType`       | 一致。ただし小文字 `mimetype` を**明示的に reject** している (TRK-13) |
| `maxGopDuration`                                                                                          | `maxGopDuration` | 一致                                                                  |
| `channelConfig`                                                                                           | `channelConfig`  | 一致                                                                  |
| `samplerate`                                                                                              | `samplerate`     | 一致 (`sampleRate` ではない)                                          |
| `connectionURI`                                                                                           | `connectionUri`  | **不一致** (TRK-16)                                                   |
| `packagingMetadata`                                                                                       | (未知保持)       | 未実装                                                                |
| `accessibleWindowTime`                                                                                    | (未知保持)       | 未実装                                                                |
| `keyframeSpacing`                                                                                         | (未知保持)       | 未実装                                                                |
| `initRef` / `altGroup` / `avgBitrate` / `maxGroupDuration` / `temporalId` / `spatialId` / `trackDuration` | 同名             | 一致                                                                  |

### 実測した現行挙動 (draft-02 の正しい catalog をどう扱うか)

読み取り専用の一時スクリプトで確認した結果である (`decodeCatalogMessage` に JSON を渡した結果)。

| 入力 (draft-02 として妥当か)                                                                         | 現行の結果                                                                                          |
| ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `version: "draft-02"` (妥当)                                                                         | **reject**: `unsupported MSF version 'draft-02'`                                                    |
| `namespace: ""` (不正)                                                                               | 受理                                                                                                |
| `namespace: "a//b"` (不正)                                                                           | 受理                                                                                                |
| `namespace` = 33 フィールド (不正)                                                                   | 受理                                                                                                |
| `packagingMetadata` / `accessibleWindowTime` / `keyframeSpacing` 付き (妥当)                         | 受理。3 フィールドは未知フィールドとして保持され、再 encode でもそのまま出る (検証・解釈はされない) |
| `depends: [1]` (妥当)                                                                                | **reject**: `depends must be an array of strings per §5.2.14`                                       |
| `depends: ["nope"]` (解決しないので不正)                                                             | 受理                                                                                                |
| `name: ""` (不正)                                                                                    | 受理                                                                                                |
| `packaging: "catalog"` (妥当)                                                                        | 受理 (未知扱いで規則なし)                                                                           |
| `packaging: "bogus"` (不正)                                                                          | 受理                                                                                                |
| `connectionURI` を publishTracks に (妥当)                                                           | 受理されるが `PublishTrack.connectionUri` には入らない (未知保持のみ)                               |
| `token` を publishTracks に (draft-02 では不正)                                                      | 受理し `PublishTrack.token` に入る                                                                  |
| eventtimeline で `depends` / `mimeType` 無し (妥当)                                                  | **reject** (depends が先に落ちる)                                                                   |
| mediatimeline で `mimeType` 無し (妥当)                                                              | **reject**: `must have mimeType='application/json'`                                                 |
| `encryptionScheme: "com.example.custom"` で `cipherSuite` 無し (draft-02 では妥当)                   | **reject**                                                                                          |
| `moq-secure-objects` + `cipherSuite` のみで `keyId` / `trackBaseKey` 無し (§4.4.3 では不正)          | 受理                                                                                                |
| loc + `role: "audio"` + audio でない codec で `samplerate` / `channelConfig` 無し (Table 6 では不正) | 受理                                                                                                |
| loc + `role: "video"` で `framerate` 無し (Table 6 では不正)                                         | 受理                                                                                                |
| loc + `role: "audiodescription"` で `lang` 無し (Table 6 では不正)                                   | 受理                                                                                                |
| loc + `role: "signlanguage"` で `framerate` 無し (Table 6 では不正)                                  | 受理                                                                                                |
| `role: "data"` (妥当)                                                                                | 受理 (型は string のため)                                                                           |
| `mimetype` (小文字、§5 の ignore unknown 対象)                                                       | **reject**                                                                                          |
| `op: "update"` の delta (draft-02 では妥当)                                                          | **reject** (delta 側の担当だが、`parentName` の条件と `isLive` 検査に影響)                          |
| 独立 catalog で `isLive: false` → 次の独立 catalog で `true` (禁止)                                  | 検出しない                                                                                          |
| `depends` を持たない track を clone で作り、参照先 track を remove                                   | 検出しない                                                                                          |

---

## 2. 仕様の表の書き出し

### Table 5: Allowed packaging values (1132-1148)

| Name           | Value           | Reference    |
| -------------- | --------------- | ------------ |
| LOC            | `loc`           | [LOC]        |
| Media Timeline | `mediatimeline` | Section 7    |
| Event Timeline | `eventtimeline` | Section 8    |
| MoQ Log        | `moqlog`        | [MOQLOG]     |
| MoQ Metrics    | `moqmetrics`    | [MOQMETRICS] |
| Catalog        | `catalog`       | Section 5    |

draft-01 の Table 4 (849-872) は `catalog` を除く 5 値。`data` は **packaging ではなく role** である (依頼文の「packaging に data 等が増えたか」への回答: packaging に `data` は増えていない。増えたのは `catalog`)。

### Table 6: Required track fields per (packaging, role) (1181-1197)

| Packaging       | Role               | Also required                             |
| --------------- | ------------------ | ----------------------------------------- |
| `loc`           | `audio`            | codec, bitrate, samplerate, channelConfig |
| `loc`           | `video`            | codec, bitrate, framerate                 |
| `loc`           | `audiodescription` | codec, samplerate, channelConfig, lang    |
| `loc`           | `signlanguage`     | codec, framerate                          |
| `eventtimeline` | `eventtimeline`    | eventType                                 |

§5.2.4.1 の本文 (1155-1164, 1199-1203):

- "trackName Section 5.2.3, packaging Section 5.2.4, and isLive Section 5.2.8 are required on every track." (1155-1156)
- "A track without a namespace Section 5.2.2 inherits the namespace of the catalog." (1156-1157)
- "Table 6 lists the fields that MUST also be present for each (packaging, role) pair. Fields not listed remain OPTIONAL. Where an individual field definition sets a stricter constraint (e.g. Conditional), that constraint wins." (1158-1161)
- "Fields with no meaning for a given pair SHOULD NOT be included; parsers ignore fields they do not understand." (1163-1164)
- "Packaging and role combinations not listed in the table above have no required fields beyond those required on every track." (1199-1200)
- "Specifications defining new packaging values extend this table with their own per-role rows." (1202-1203)

draft-01 にはこの表が無い (新設)。

### 依頼文の前提の訂正

依頼文には「`template` は 6 要素配列、media timeline track でのみ必須」とあるが、正本はそう定めていない。

- §5.2.16 1480-1494 は `template` を Optional とし、「A media timeline template for tracks with fixed-duration segments」とだけ書く。packaging の条件は無い。
- §7.4 3452-3458「When the relationship between media time, MOQT Location and wallclock time follows a regular, predictable pattern, a media timeline template MAY be used **instead of** an explicit media timeline track.」— つまり media timeline track の**代わり**であり、media timeline track に必須ではない。
- §7.2 3421-3438 が media timeline track に MUST とするのは `packaging: "mediatimeline"` と `depends` だけ。
- 6 要素・順序・型は §7.4.1 3462-3491。実装 (`validateMediaTimelineTemplate` 615-642) はこれを満たしているので、`template` に関する変更は無い。

### Table 7: Reserved track roles (1283-1326)

| Role               | Description                                                       |
| ------------------ | ----------------------------------------------------------------- |
| `audiodescription` | An audio description for visually impaired users                  |
| `video`            | Visual content                                                    |
| `audio`            | Audio content                                                     |
| `mediatimeline`    | An MSF media timeline Section 7                                   |
| `eventtimeline`    | An MSF event timeline Section 8                                   |
| `caption`          | A textual representation of the audio track                       |
| `subtitle`         | A transcription of the spoken dialogue                            |
| `signlanguage`     | A visual track for hearing impaired users.                        |
| `log`              | A log publishing track per [MOQLOG].                              |
| `metrics`          | A metrics publishing track per [MOQMETRICS].                      |
| `data`             | A generic descriptor for tracks carrying application-defined data |

draft-01 の Table 4 (908-956 の値列) との差は **`data` の追加のみ**。表の外の文 "Custom roles MAY be used as long as they do not collide with the specified roles." は両版にあり (draft-02 1328-1329)。

### Table 8: Defined encryption schemes (1726-1730)

| Name               | Value                | Reference       |
| ------------------ | -------------------- | --------------- |
| MoQ Secure Objects | `moq-secure-objects` | [SecureObjects] |

draft-01 (1324-1330) と同内容。draft-02 は本文から "The default and RECOMMENDED" の "default" が消え、RECOMMENDED のみ (draft-02 1721-1722)。

### Table 9: Cipher suites for moq-secure-objects (1754-1768)

| Name                       | Value                        | Tag Size |
| -------------------------- | ---------------------------- | -------- |
| AES-128-GCM-SHA256         | `aes-128-gcm-sha256`         | 128 bits |
| AES-256-GCM-SHA512         | `aes-256-gcm-sha512`         | 128 bits |
| AES-128-CTR-HMAC-SHA256-80 | `aes-128-ctr-hmac-sha256-80` | 80 bits  |

"Implementations MUST support `aes-128-gcm-sha256`. Implementations SHOULD support `aes-128-ctr-hmac-sha256-80`" は両版同じ (draft-02 1770-1773)。実装の `KNOWN_CIPHER_SUITES` (`version.ts:86-90`) と一致。

### Table 10: Defined Authorization Schemes (1838-1842)

| Scheme       | Value          | Reference         |
| ------------ | -------------- | ----------------- |
| Privacy Pass | `privacy-pass` | [PrivacyPassAuth] |
| CAT          | `cat`          | [C4M]             |

draft-01 の Table 8 (1435 付近) と同内容。文言だけ "Registered schemes" → "Allowed schemes"、"configuration objects" → "configuration JSON elements" (draft-02 1830-1832)。

### Table 11: Defined accessibility schemes (1911-1917)

| Scheme                          | Description             |
| ------------------------------- | ----------------------- |
| `urn:scte:dash:cc:cea-608:2015` | CEA-608 closed captions |
| `urn:scte:dash:cc:cea-708:2015` | CEA-708 closed captions |

draft-01 の Table 9 と同内容。descriptor は "A required 'scheme' field (String)" と "A required 'value' field (String)" (draft-02 1893-1897)。

---

## 3. §5.2.4.1 の必須フィールド表 vs 実装検証 (両方向)

実装の検証は `catalogTrackValidation.ts` の `validatePackagingSpecificRules` (449-513)、`validateRoleSpecificRules` (403-414)、`validateAudioCodecRules` (429-443) の 3 つで構成される。

### 3.1 実装が要求していない (仕様では MUST)

| Table 6 のセル                              | 仕様 | 実装                                                                                          | 判定                                         |
| ------------------------------------------- | ---- | --------------------------------------------------------------------------------------------- | -------------------------------------------- |
| (loc, audio) codec                          | MUST | role=audio で必須                                                                             | 充足                                         |
| (loc, audio) bitrate                        | MUST | role=audio で必須                                                                             | 充足                                         |
| (loc, audio) samplerate                     | MUST | **codec が audio codec の接頭辞のときだけ**必須 (`isAudioCodec` 384-386)                      | 不足 (codec が `opus`/`mp4a` 以外なら抜ける) |
| (loc, audio) channelConfig                  | MUST | 同上                                                                                          | 不足 (同上)                                  |
| (loc, video) codec                          | MUST | role=video で必須                                                                             | 充足                                         |
| (loc, video) bitrate                        | MUST | role=video で必須                                                                             | 充足                                         |
| (loc, video) framerate                      | MUST | **要求しない**                                                                                | 不足                                         |
| (loc, audiodescription) codec               | MUST | **要求しない** (role が video/audio でないため)                                               | 不足                                         |
| (loc, audiodescription) samplerate          | MUST | codec 依存で条件付き                                                                          | 不足                                         |
| (loc, audiodescription) channelConfig       | MUST | codec 依存で条件付き                                                                          | 不足                                         |
| (loc, audiodescription) lang                | MUST | **要求しない**                                                                                | 不足                                         |
| (loc, signlanguage) codec                   | MUST | **要求しない**                                                                                | 不足                                         |
| (loc, signlanguage) framerate               | MUST | **要求しない**                                                                                | 不足                                         |
| (eventtimeline, eventtimeline) eventType    | MUST | packaging=eventtimeline で必須                                                                | 充足 (role を見ない分は過剰)                 |
| 全 track: name / packaging / isLive         | MUST | `validateCatalogTrack` 375-395                                                                | 充足                                         |
| 全 track: namespace 未指定は catalog を継承 | 継承 | 検証時は未解決 (TRK-02)。`assertTrackNameUnique` は `catalogNamespace` 引数がある経路だけ解決 | 不足                                         |

### 3.2 実装が要求している (仕様では任意・または MUST NOT が無い)

| 実装の規則                                                | 仕様                                                                                                                        | 判定                     |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| mediatimeline に `mimeType: "application/json"` (459-465) | §7.2 (3421-3436) に mimeType 要件は無い。A.1.4 5470-5471 が「mimeType 要件の削除」と明記                                    | **過剰** (TRK-12)        |
| eventtimeline に `mimeType: "application/json"` (476-482) | §8.3 (3645-3658) に mimeType 要件は無い。A.1.5 5496-5497 が「depends と mimeType は不要になった」と明記                     | **過剰** (TRK-12)        |
| eventtimeline に `depends` 必須 (473-475)                 | §8.3 は「index が media timeline を参照する場合、その media timeline track を depends に列挙 MUST」であり、常時必須ではない | **過剰** (TRK-24)        |
| `mimetype` (小文字) を reject (398-402)                   | §5 745 の "A parser MUST ignore fields it does not understand." に反する                                                    | **過剰** (TRK-13)        |
| `encryptionScheme` があれば `cipherSuite` 必須 (296-301)  | §5.2.39 1749-1751 は `moq-secure-objects` のときだけ MUST                                                                   | **過剰** (TRK-17)        |
| `connectionUri` を publishTracks 以外で reject (417-428)  | Table 4 に載る track field。MUST NOT は無い                                                                                 | **過剰** (TRK-16)        |
| `token` を publishTracks で受理                           | draft-02 で廃止                                                                                                             | **過剰 (受理)** (TRK-15) |
| 未知の `packaging` 値を受理                               | Table 5 は allowed values を列挙。拡張の余地もあるため仕様は parser の扱いを明記しない                                      | 保留 (TRK-04 で扱う)     |
| `role=video`/`audio` の codec / bitrate                   | §5.2.19 / §5.2.23 と Table 6 に一致                                                                                         | 充足                     |

### 3.3 実装が仕様より厳しいが、正当化できるもの (維持候補)

| 実装                                                                    | 仕様                                                                                    | 扱い                                                                                                    |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `initRef` の参照切れを reject (catalogValidation.ts:234-259)            | §5.2.14 (1447-1459) は参照先の存在を MUST と明記しない                                  | 維持してよい (参照切れは復号器初期化に失敗する)。根拠コメントは「本ライブラリの厳格化」であることを維持 |
| `targetLatency` と `buffers` の排他 (189-193)                           | §5.2.9 1374-1375 / §5.2.10 1415-1416 の MUST NOT                                        | 充足                                                                                                    |
| `trackDuration` を `isLive=true` で reject (277-281)                    | §5.2.36 1697-1698 の MUST NOT                                                           | 充足                                                                                                    |
| `eventType` を eventtimeline 以外で reject (173-177, 508-512)           | §5.2.6 1243-1246 の MUST NOT                                                            | 充足                                                                                                    |
| moqlog / moqmetrics の role MUST (483-501)                              | §9.4 3855-3868 / §10.4 3935-3948                                                        | 充足                                                                                                    |
| catalog 内 (tracks + publishTracks) の (name, namespace) 一意 (178-218) | draft-01 は "unique per namespace"。draft-02 は Full Track Name 一意 (§5.2.3 1109-1115) | 概ね充足。TRK-03 の残りを参照                                                                           |

### 3.4 参考: 実装が要求していない既存の MUST (draft-02 由来ではない)

| 仕様                                                                                                                       | 実装                                                                                                                                      |
| -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| §9.4 3855-3857 / §10.4 3935-3937 "A log track MUST be declared in the publishTracks array of the catalog" (metrics も同様) | `tracks` に moqlog / moqmetrics を置いても受理する。draft-01 §9.4 (3155) / §10.4 (3233) から同じ MUST があり、draft-02 固有の後退ではない |

---

## 4. 差分 ID 一覧

各差分は「仕様要件 (引用 + 行) / draft-01 での扱い / 現行実装 / 必要な変更 / 互換性影響 / 優先度」で示す。

### TRK-01 namespace に `/` 区切りの形式検証が無い (P0)

- 仕様要件: §5.2.2 1085-1092。「The string MUST yield between 1 and 32 fields, and every field MUST be non-empty」「A parser that encounters a value that is not a string, an empty string, a string yielding more than 32 fields, or a string yielding an empty field MUST treat the catalog as invalid.」。区切りは U+002F で、JSON デコード後の値に対して行う (1069-1080)。`"example.com/live/channel1"` は 3 フィールド (1082-1083)。各フィールドは §11.2 の規則で UTF-8 バイトに変換する (1074-1076)。namespace は任意で、宣言が無ければ catalog track の namespace を継承する (1094-1096)。
- draft-01: §5.2.2 822-831 は「The name space under which the track name is defined」だけで、形式の制約も文字列→フィールドの対応も規定しない。実装は draft-01 の空白を「`/` 連結」という独自規約で埋めていた (`src/codec/types.ts:363-373` に明記)。
- 現行実装: `pickIdentityFields` 130-138 は string 型だけ見る。`catalogValidation.ts` にも検証は無い。実測で `""` / `"a//b"` / 33 フィールドをすべて受理した。
- 必要な変更:
  1. `src/msf/` に「catalog namespace 文字列 → フィールド配列」の変換 + 検証を 1 箇所で実装する (`parseCatalogTrackNamespace(value: string): string[]` のような純関数)。U+002F で split し、長さ 1〜32、各要素 1 文字以上を検査する。
  2. 文字列→バイトの制約 (§11.2.1) も同時に検査する: 孤立サロゲート (U+D800〜U+DFFF) と U+0000 を含む値は catalog invalid (4319-4326)。JS 文字列では `value.isWellFormed()` と `value.includes("\u0000")` で判定できる。
  3. 既存の `createTrackNamespace` (`src/message/parameter/trackNamespace.ts:323-329`、`assertTrackNamespaceTuple` 141-160 で 0〜32 フィールド・非空・4096 バイトを検証) を再利用し、MSF 固有の下限 1 フィールドだけ上乗せする。MOQT は 0 フィールドを許す (§8.7) が MSF §5.2.2 は 1 以上を MUST とする。
  4. `parentNamespace` (§5.2.35 1685-1686 "with the same syntax and constraints as Section 5.2.2") にも同じ検証を適用する。
  5. 型は文字列のまま (`namespace?: string`) でよい。バイト列や配列に変える必要はない。ただし内部で「解決済み namespace」を持つなら `string[]` を別に持つ。
- 互換性影響: これまで受理していた `namespace: ""` / `"a//b"` / `"/a"` / `"a/"` / 33 フィールド / 数値以外は reject になる。`src/createMediaSubscriber.catalog.test.ts:256` の「空文字 namespace」テストは削除または不正として reject するテストに変わる。破壊的変更だが CODEBASE.md の方針 (破壊的変更を恐れない / 最新ドラフトに準拠) に沿う。
- 優先度: P0 (parser の MUST 違反。正しい publisher が送る値を誤って拒否はしないが、壊れた catalog を受理し、後段で namespace 不一致の事故になる)。

### TRK-02 namespace 継承の解決と、購読に使う namespace が catalog の `namespace` を無視している (P0)

- 仕様要件: §5.2.2 1094-1098。「If it is not declared within a track object, then the track MUST inherit the Track Namespace of the catalog track, that is, the Track Namespace under which the catalog itself was subscribed. A namespace declared in a track object replaces (and does not extend) any inherited namespace.」。§5.2.3 1109-1115 は「すべての比較は §11.2 のバイト比較で行う」。§11.2.2 4332-4343、§11.2.3 4345-4357 は「MOQT の制御メッセージから得た名前は生バイトで比較する」。
- draft-01: §5.2.2 827-831 に「each track MUST inherit the namespace of the catalog track」「overrides any inherited name space」があり、継承・置換の規則自体は同じ。文字列→フィールドの対応が無かった点だけが違う。
- 現行実装:
  - 検証: `validateCatalog` は catalog namespace を知らないため継承を解決しない (`catalogValidation.ts:171-176` に既知の制限として明記)。`assertTrackNameUnique` は省略可能な `catalogNamespace` を渡されたときだけ解決する (190)。`applyCatalogDelta` は subscriber が渡す `catalogNamespace` で解決する (`catalogDelta.ts:47, 191-198`)。
  - 購読: **subscriber は catalog の track の `namespace` を一切使わず、常に `options.namespace` で SUBSCRIBE する** (`createMediaSubscriber.ts:2119` `const namespace = this.options.namespace`、`mediaSubscriber/catalogSubscription.ts:205` も同じ)。catalog track も同じ namespace で購読している (`createMediaSubscriber.ts:2432-2439` で `namespace.join("/")` を `catalogNamespace` として渡す)。
  - 結果: draft-02 の catalog が track ごとに異なる namespace を宣言しても、moqt-js は catalog の namespace で購読してしまい DOES_NOT_EXIST になる。
- 必要な変更:
  1. `decodeCatalogMessage` / `validateCatalog` に catalog namespace (フィールド配列) を渡せるようにし、継承を解決した Full Track Name で一意性を検査する。subscriber は既に catalog namespace を知っている (`this.options.namespace`)。
  2. 音声・映像トラックの購読で、`track.namespace` があればそれを §5.2.2 の規則でフィールド配列へ変換して SUBSCRIBE に使う。無ければ `options.namespace` を使う。`getAudioTracks` / `getVideoTracks` の結果に対して namespace を解決する helper を追加するのが自然。
  3. `assertTrackNameUnique` の「namespace 未指定どうし」の別バケット運用 (191-197) を、解決後の値で比較する形に一本化する。
- 互換性影響: namespace を宣言する catalog (draft-02 の §5.6.1 の例: `"namespace": "conference.example.com/conference123/alice"`) を正しく購読できるようになる。逆に、catalog namespace と異なる namespace を宣言した track を「同じ namespace で購読する」既存挙動は壊れる (が、それは現状のバグ)。
- 優先度: P0 (draft-02 の例がそのまま動かない)。

### TRK-03 `name` の非空 MUST と Full Track Name 一意性の未解決部分 (P1)

- 仕様要件: §5.2.3 1106-1107「A Track Name MUST NOT be the empty string.」、1109-1115「the combination of Track Namespace and Track Name (the Full Track Name) MUST be unique」「exact comparison of the mapped bytes ... never by comparison of the JSON source text」。§11.2.1 4319-4326 で孤立サロゲートと NUL を含む名前は catalog invalid。
- draft-01: §5.2.3 832-848「Within the catalog, track names MUST be unique per namespace.」のみで、非空 MUST は無かった。実装の一意性検査 (name, namespace タプル) は draft-01 の規則そのもの。
- 現行実装: `validateCatalogTrack` 375-379 は string 型だけ見る。実測で `name: ""` を受理。一意性は `assertTrackNameUnique` (178-218) が `(namespace ?? catalogNamespace, name)` のタプルで判定する。ネストした Map/Set を使い文字列連結の衝突は避けている (185-210) ので、namespace 文字列が有効になった後は「UTF-8 バイト比較」と同値になる (有効な namespace 文字列 → フィールド列は単射。`/` は必ず区切りで、フィールドに現れない)。
- 必要な変更:
  1. `name` の非空検査を `validateCatalogTrack` (と clone / add / update の各経路) に追加する。
  2. `name` / `namespace` / `parentName` / `parentNamespace` と `depends` の String 要素に、孤立サロゲート・NUL の検査 (§11.2.1) を追加する。純関数を 1 つ作り、トラック名・namespace・比較対象に共通適用する。
  3. catalog namespace 未解決のまま一意性を判定している箇所 (TRK-02 の 1.) を解決後の値に置き換える。
- 互換性影響: `name: ""` を組み立てていた利用者 (devtools の入力欄など) は `createCatalog` の時点でエラーになる。妥当な破壊的変更。
- 優先度: P1 (不正 catalog の受理。相互接続の失敗には直結しにくいが、MUST なので追従必須)。

### TRK-04 `packaging` の値集合に `catalog` が無く、実行時の値検査も無い (P1)

- 仕様要件: §5.2.4 1129-1130「Allowed values are strings as defined in Table 5.」、Table 5 1145 に `catalog`。§5 693「catalog track MAY reference other catalog tracks.」、695-696「The top-level catalog track MUST have a case-sensitive Track Name of "catalog".」、A.1.3 5398-5400。
- draft-01: Table 4 (849-872) は 5 値で `catalog` は無い。catalog の参照機能自体が無い。
- 現行実装: `PackagingType = "loc" | "mediatimeline" | "eventtimeline" | "moqlog" | "moqmetrics"` (`version.ts:44`)。`validateCatalogTrack` 381-387 は string を `PackagingType` に cast するだけで値集合を検査しない。実測で `packaging: "catalog"` も `"bogus"` も受理。
- 必要な変更:
  1. `PackagingType` に `"catalog"` を追加する。
  2. 実行時の値集合検査を追加するかどうかを決める。仕様は「allowed values」と書くだけで parser の扱いを明記しない。`Table 6` の "Specifications defining new packaging values extend this table" (1202-1203) を考慮すると、未知値を拒否すると将来の拡張で壊れる。本ライブラリは MSF 専用なので **既知 6 値のみ受理 + それ以外は reject** が一貫する (「最新ドラフトに準拠」)。ただしカスタム packaging を使う相手とは接続できなくなるため、判断は親エージェントに委ねる。
  3. `packaging: "catalog"` の track を catalog の参照として扱う機能 (購読して catalog を辿る、参照循環の検出) は §13.7 4943-4945「Subscribers MUST detect reference cycles」がある。トップレベル以外の catalog track 名は任意 (Table 5 と §5 695-696)。本ライブラリは catalog 参照を実装しないなら、「catalog packaging の track は catalog として辿らない」ことを明記し、少なくとも decode は通す。
- 互換性影響: `PackagingType` の追加は型利用者に影響する (追加のみなので通常は非破壊)。値集合検査を入れると未知 packaging の catalog を拒否するようになる (破壊的)。
- 優先度: P1 (draft-02 の catalog を参照する catalog を正しく表現できない)。

### TRK-05 `packagingMetadata` が未実装 (P1)

- 仕様要件: §5.2.5 1205-1223。String。`key1=v1;key2=v2` 形式 (1209-1210)。「Keys and values are case-sensitive and MUST NOT contain whitespace, = or ;.」(1211-1212)。「Subscribers MUST ignore any key that is not defined for the current packaging value.」(1215-1216)「If the same key appears more than once, the first occurrence is used.」(1216-1217)。`loc` では `streamMapping` のみ定義 (1219-1223)。
- draft-01: フィールド自体が無い。
- 現行実装: 型なし。`KNOWN_TRACK_FIELDS` に無いため未知フィールドとして保持される (実測で decode → encode の round-trip は保持)。値の解釈・検証は一切しない。
- 必要な変更:
  1. `CatalogTrack.packagingMetadata?: string` を追加し、`KNOWN_TRACK_FIELDS` に登録する。
  2. decode は「仕様に従い未知キーを無視する」ため、厳格な構文 reject はしない (MUST は producer 側の "MUST NOT contain whitespace, = or ;")。ただし `;` で split し最初の `=` で key/value に分ける純関数を用意し、`streamMapping` だけ意味付けする (`group` / `object`、未知値は無視して既定 `group`)。
  3. encode (publisher / createCatalog) では key/value に空白・`=`・`;` を含めないことを検証する。
  4. 未知キーは保持するか捨てるかを決める。§5.2.5 は「MUST ignore」なので、`buffers` (§5.2.10) と同じ「捨てる」方針が一貫する。ただし他の track 未知フィールドは保持方針なので、`packagingMetadata` の未知キーだけ捨てる理由をコメントに残す。
- 互換性影響: 追加のみ。ただし publisher が `packagingMetadata` を出すようになると、draft-01 しか解釈しない相手には未知フィールドとして無視される (§5 の ignore unknown により安全)。
- 優先度: P1 (`streamMapping` の解釈は TRK-06)。

### TRK-06 `streamMapping` の解釈と `object` モード受信 (P1)

- 仕様要件: §4.1.1 479-527。「MSF publishers using LOC packaging MUST select one of the mapping modes listed below, and subscribers MUST be prepared to consume both of them. The chosen mode is signaled per-track via the Section 5.2.5 field using the streamMapping key.」(481-486)。Table 1 (509-522): `group` = 1 Group の全 Object を 1 Subgroup に Object ID 順、`object` = Object ごとに別 Subgroup。`group` が既定 (523-525)。§4.1 470-471「All MOQT Objects SHOULD be placed on MOQT Subgroup 0 unless streamMapping indicates otherwise.」A.1.2 5383-5388。
- draft-01: この概念が無く、draft-01 §4.1 (366-376) は「each EncodedAudioChunk or EncodedVideoChunk sample is placed in a separate MOQT Object」だけで、Subgroup の扱いは規定しない (A.1.2 5383-5386 が「-01 の『各 Object を新しい MOQT Stream に載せる』要求を置き換える」と説明)。
- 現行実装:
  - publisher は video で `subgroupId = objectId` (先頭 Object 基準、`src/publisher.ts:1053`) を使い、Group 内のキーフレーム後のフレームは同じ Subgroup を再利用する (`publisher.ts:1009-1017`)。video の各 Group は Object ID 0 のキーフレームから始まる (`createMediaPublisher.ts:420-434` の `allocateVideoObject`) ので、実質 **group モード (Subgroup 0)** である。audio は 1 Object = 1 Group (`createMediaPublisher.ts:393-403`、`allocateAudioObject`)、catalog は Object ID 0 (`createMediaPublisher.ts:1994-2000`)。
  - `packagingMetadata` を出していない。§4.1.1 の「If packagingMetadata is absent ... group MUST be assumed」(523-525) により既定は group なので、省略でも意味は通る。ただし §4.1.1 の「MUST select one of the mapping modes」を明示シグナリングと読むなら、`streamMapping=group` を載せるのが安全。
  - subscriber は `packagingMetadata` を解釈しない。`object` モード (Object ごとに別 Subgroup) の受信は、data stream 層が Subgroup を汎用に処理し (`src/dataStream/subgroup.ts`)、`videoGroupGate` は `(groupId, subgroupId)` 単位で扱う (`createMediaSubscriber.ts:2850, 2857`) ため、複数 Subgroup でも原理的には処理できる。ただし object モード専用のテストは無く、**未確認**。
- 必要な変更:
  1. TRK-05 の `streamMapping` パースを実装し、subscriber は `group` / `object` のどちらでも受信できることをテストで固定する (object モードは「1 Subgroup 1 Object」のデータ stream を流すテストを追加)。
  2. publisher は catalog に `packagingMetadata: "streamMapping=group"` を載せる (既定と同じだが明示する)。既存の Subgroup 0 動作を変える必要はない。
- 互換性影響: 追加のみ。publisher の catalog にフィールドが 1 つ増える。
- 優先度: P1 (subscribers MUST be prepared to consume both)。

### TRK-07 `depends` が Number (renderGroup) を受け付けない (P0)

- 仕様要件: §5.2.15 1465-1478。「Each element can be either a track name Section 5.2.3 or renderGroup Section 5.2.12. To assist parsers in determining the type of each element, any entry with a JSON type of String MUST reference a track name and any entry with a JSON type of Number MUST reference a renderGroup.」(1467-1472)。A.1.3 5422-5424。§7.2 3424-3429 も「an array of any track names and renderGroups」。
- draft-01: §5.2.14 1069-1078「Dependencies holds an array of track names on which the current track is dependent.」で、String のみ。namespace は「track の namespace と同じとみなす」。
- 現行実装: `pickDependsAndTemplate` 228-231 が「すべて string」でなければ reject。型は `depends?: string[]` (types.ts:144)。変数置換も string 前提 (variables.ts:166-171)。実測で `depends: [1]` を reject。
- 必要な変更:
  1. 型を `depends?: (string | number)[]` にする。
  2. decode は String / Number の混在を許し、それ以外 (boolean / null / object / array) は reject する。
  3. 変数置換は string 要素だけに適用する。
  4. 重複除去や順序の正規化はしない (仕様に規定なし)。
- 互換性影響: `depends` を読む利用者 (`CatalogTrack.depends` の型) に破壊的変更。moqt-js 内の consumer は検証と変数置換だけなので影響は小さい。
- 優先度: P0 (draft-02 の正しい catalog を拒否する)。

### TRK-08 `depends` の解決検証が無い (P1)

- 仕様要件: §5.2.15 1474-1478。「each String element MUST match the Track Name of exactly one other track object in the catalog. Each Number element MUST match the renderGroup identifier of exactly one renderGroup in the catalog. A catalog in which a dependency does not resolve is invalid.」。A.1.3 5423-5424。
- draft-01: 解決 MUST は無い (§5.2.14 1069-1078 は「namespace は同じとみなす」だけ)。
- 現行実装: 解決検証は無い。実測で `depends: ["nope"]` を受理。
- 必要な変更: catalog 全体を見る検証 (`assertTrackNameUnique` と同じ層) を追加する。
  1. String 要素: catalog 内の他 track の `name` と一致するか (namespace 継承を解決した Full Track Name で比較するか、draft-02 が「Track Name of exactly one other track object」と書くため name 比較か、§11.2 のバイト比較かは要判断。§11.2 4280-4281 が §5.2.15 を「namespace/name を持つフィールド」として列挙しているので、**解決後の名前空間も含めた比較**が安全)。
  2. Number 要素: catalog 内のいずれかの track の `renderGroup` と同じ値が**ちょうど 1 つの renderGroup** として存在するか。「exactly one renderGroup」は「同じ番号の group が 1 つ」であり、同じ renderGroup 番号を持つ track が複数あることは正常 (§5.2.12 は同時描画する track の集合)。
  3. delta 適用後にも再検証する (`applyCatalogDelta` の `assertInitRefResolvable` と同列)。
  4. `%var%` を含む値は置換前なので対象外にする (`initRef` の既存方針 234-259 と同じ)。
- 互換性影響: `depends` を持つ catalog で参照先が無いものを拒否するようになる (破壊的。devtools の event timeline track は audio/video 名を積むので、片方だけ配信する設定では参照切れになり得るため、devtools 側の生成ロジックも見直しが必要)。
- 優先度: P1 (catalog invalid の MUST。TRK-07 と同時に実装するのが自然)。

### TRK-09 `depends` の renderGroup 参照規則と、参照先 track 消滅時の更新 MUST (P2)

- 仕様要件: §7.2 3421-3438。「A media timeline track MUST carry a 'depends' attribute which contains an array of any track names and renderGroups to which the media timeline track applies. If all tracks in a renderGroup match the media timeline, then the renderGroup MUST be referenced and the individual track names MUST NOT be referenced. If only a subset of tracks in the renderGroup match the media timeline, then the renderGroup MUST NOT be referenced and the individual tracks MUST be referenced.」(3426-3431)「If multiple tracks are referenced and then one of those tracks ceases publication, the publisher MUST produce a catalog update which removes the 'depends' reference of the track that ceased publication.」(3433-3435)。A.1.4 5473-5475。
- draft-01: §7.2 (2869-2875) は「A media timeline track MUST carry a 'depends' attribute」だけで、renderGroup の使い分けも更新 MUST も無い。
- 現行実装: `depends` の存在だけを必須にし (456-458)、中身の規則は見ない。publisher は catalog の更新 (delta) を一切送らない (`createMediaPublisher.ts:1953-1963` の buildCatalog、送り直しは同じ instance)。
- 必要な変更:
  1. mediatimeline の `depends` について「renderGroup を参照するか個別 track 名を参照するか」を catalog 全体で検査する。これは「ある renderGroup の全 track が同じ media timeline を持つか」を判定する必要があり、media timeline の内容 (§7.3) と突き合わせないと厳密には決まらない。**実装するなら「同じ depends を持つ mediatimeline track が複数あるか」の範囲で近似**し、厳密判定は将来に回す。
  2. publisher 側で「参照先 track が止まったら delta を出す」機能は未実装。delta 送信機能自体が無いため、**制限として docs に明記**する (本ライブラリの publisher は tracks の追加・削除を行わない)。
- 互換性影響: なし (検証を足す場合のみ)。
- 優先度: P2 (publisher の更新機能が無いため、現状は仕様の対象外)。

### TRK-10 `isLive` の False→True を検出しない (P1)

- 仕様要件: §5.2.8 1354-1355「A True value MUST NOT follow a False value in a catalog update.」。False の意味は「publisher が track を終了した」または「VOD で一度も live でなかった」(1351-1354)。
- draft-01: §5.2.7 957-967「A True value MUST never follow a False value.」で、"in a catalog update" の限定が無い。
- 現行実装: boolean 型だけ検証。delta の add は既存名を `assertTrackNameUnique` で弾くため、既存 track の `isLive` を false→true に変える経路は現状無い (実測: 同名 add は重複で reject)。一方、**独立 catalog の差し替えでは比較しない** (`processCatalogPayload` 399-427 は `kind: "full"` で単純に置換する)。`op: "update"` は未実装 (delta 側の担当)。
- 必要な変更:
  1. subscriber が独立 catalog で `receivedCatalog` を差し替えるとき、Full Track Name が一致する track について `false → true` を検出して catalog を invalid として扱う (`onError`)。`applyCatalogDelta` には既に `current` が渡るため、`update` op 実装時に同じ検査を入れる。
  2. `clone` は新しい track を作る操作なので、親の false を継承しない限り false→true の禁止に当たらない (実測: clone で `isLive: true` を上書きすると新しい track は true になるが、これは「同じ track の更新」ではないため許容)。
- 互換性影響: 不正な catalog 更新を拒否するようになる。
- 優先度: P1 (catalog 更新の MUST。subscriber 側で検出可能)。

### TRK-11 §5.2.4.1 Table 6 の必須フィールドが不足 (P2)

- 仕様要件: §5.2.4.1 1155-1164, 1199-1203、Table 6 1181-1197。`loc`+`video` は framerate、`loc`+`signlanguage` は codec と framerate、`loc`+`audiodescription` は codec / samplerate / channelConfig / lang が MUST。A.1.3 5413-5414。
- draft-01: 表自体が無い。Conditional MUST は個別フィールドの節 (§5.2.18 codec / §5.2.22 bitrate / §5.2.28 samplerate / §5.2.29 channelConfig) にのみあった。
- 現行実装: `validateRoleSpecificRules` 403-414 は role=video / audio の codec と bitrate のみ。`validateAudioCodecRules` 429-443 は codec が audio codec の接頭辞のときだけ samplerate / channelConfig。framerate と lang は誰も要求しない。実測で (loc, video, framerate 無し)、(loc, audiodescription, lang 無し)、(loc, signlanguage, codec 無し) をすべて受理。
- 必要な変更: `validatePackagingSpecificRules` に (packaging, role) の表を実装する。少なくとも次の 5 行をデータとして持ち、`loc` の 4 role と `eventtimeline` の 1 role を検査する。

  | packaging     | role             | 必須                                      |
  | ------------- | ---------------- | ----------------------------------------- |
  | loc           | audio            | codec, bitrate, samplerate, channelConfig |
  | loc           | video            | codec, bitrate, framerate                 |
  | loc           | audiodescription | codec, samplerate, channelConfig, lang    |
  | loc           | signlanguage     | codec, framerate                          |
  | eventtimeline | eventtimeline    | eventType                                 |

  個別フィールドがより厳しい条件を持つ場合はそちらを優先する (§5.2.4.1 1160-1161)。たとえば §5.2.23 bitrate は「audio と video の track に MUST」であり、`loc` 以外の packaging でも role=audio/video なら必須 (現行の `validateRoleSpecificRules` はこの一般則として妥当なので残す)。

- 互換性影響: 既存の catalog 生成が拒否される可能性がある (devtools の event timeline track は `loc` ではないので影響なし。audio/video は framerate / samplerate / channelConfig を既に載せている: `createMediaPublisher.ts:2127-2160`)。ただし role を明示しない track や custom role には影響しない。
- 優先度: P2 (実装が緩い方向。受信側で落ちる実害は小さいが、仕様追従として必要)。

### TRK-12 mimeType の必須要件が撤廃された (P0)

- 仕様要件: §5.2.20 1532-1537 は「A string defining the mime type [MIME] of the track.」だけで条件が無い。§7.2 3421-3436 に mimeType は無い。§8.3 3645-3658 に mimeType は無い。A.1.4 5470-5471「Catalog requirements now use the packaging field and drop the mimeType requirement.」A.1.5 5496-5497。
- draft-01: 実装が参照している draft-01 §7.2 (2869-2875) と §8.2 (3010-3030) には mimeType の MUST があった (実装のエラーメッセージ "per §7.2" / "per §8.2" はこれに由来)。
- 現行実装: `validatePackagingSpecificRules` 459-465 (mediatimeline) と 476-482 (eventtimeline) が `mimeType === "application/json"` を必須にしている。実測でも mimeType 無しを reject。
- 必要な変更: 両方の検査を削除する。`mimeType` は任意の string として型だけ検証する (現行 247 のまま)。devtools の event timeline track は `mimeType: "application/json"` を載せ続けてもよい (任意フィールドなので仕様違反ではない) が、必須ではないことをコメントに反映する。
- 互換性影響: draft-01 準拠の catalog では mimeType を載せていたものが多いが、無くても受理するようになる (緩和)。逆に「mimeType が application/json でないことを拒否する」テストは削除。
- 優先度: P0 (draft-02 の正しい catalog を拒否する)。

### TRK-13 小文字 `mimetype` の明示 reject が §5 の ignore unknown に反する (P1)

- 仕様要件: §5 745「A parser MUST ignore fields it does not understand.」。§5 742-743「Custom field names MUST NOT collide with field names described in this draft.」。Table 4 の名前は `mimeType` (995)。
- draft-01: 同じ "parser MUST ignore fields" が draft-01 §5 542 にあった。つまり draft-01 の時点でもこの reject は仕様に反していた (実装が「typo 検出」のために意図的に厳しくしたもの)。
- 現行実装: `validateCatalogTrack` 398-402 と `validateCloneCatalogTrack` 469-474 が `"mimetype" in obj` で reject。実測でも reject。
- 必要な変更: reject を削除し、`mimetype` は未知フィールドとして無視 (保持) する。typo 検出を残したいなら、**エラーではなく警告ログ** (devtools の Tracks カード) に落とす。`KNOWN_TRACK_FIELDS` に `mimetype` を入れないことで未知フィールド保持の対象になる。
- 互換性影響: これまで拒否していた catalog を受理する (緩和)。
- 優先度: P1 (parser の MUST 違反。draft-02 でも直っていない)。

### TRK-14 `parentName` / `parentNamespace` の "clone or update" 対応 (P2)

- 仕様要件: §5.2.34 1663-1666「This field MUST only be included inside a 'clone' or 'update' operation in a delta update Section 5.1.6.」、§5.2.35 1685-1690 (同様 + 「If this field is missing from a clone operation, then the namespace of the catalog is assumed.」)。§5.1.6 875-880 に `update` op が追加 (A.1.3 5406-5411)。
- draft-01: §5.2.33 1253-1259 / §5.2.34 1261-1269 は `clone` のみ。
- 現行実装: clone のみ許可し、それ以外で reject (`catalogValidation.ts:405-414`)。`update` op 自体が無い (`catalogCodec.ts:400-419` は add / remove / clone のみ。実測で `op: "update"` を reject)。
- 必要な変更: `update` op の実装 (delta 側の担当) に合わせて、`parentName` / `parentNamespace` を update でも受理する。`update` は「parent の属性を継承し、宣言したフィールドだけ上書き」であり、`clone` と違って name の変更を伴わない。`parentName` が更新対象の特定に使われる。
- 互換性影響: `update` 導入そのものが破壊的変更 (delta の受理範囲が広がる)。
- 優先度: P2 (§5.2 のフィールド条件としては小さい。delta 側の実装に従属)。

### TRK-15 track-level `token` の廃止 (P1)

- 仕様要件: Table 4 に `token` が無い (929-1039)。A.1.3 5444-5445「The track-level token field was removed. Publish tracks now use authInfo.」。§5.2.43 1863-1884 は URI 経由のトークン配送 (authInfo の変数置換) のみ。§9.4 3871-3876 / §10.4 3948-3952 は publish track の認可に authInfo (§5.2.42) を使うと明記。
- draft-01: §5.2.37 1304-1311 に `token` があった。ただし draft-01 の Table 3 には載っていない (表の漏れ)。
- 現行実装: `PublishTrack.token?: string` (types.ts:239)、publishTracks でのみ受理 (catalogTrackValidation.ts:341-349)、`KNOWN_TRACK_FIELDS` に登録 (70)、変数置換対象 (variables.ts:200-206)、docs に記載 (docs/MSF.md:26、docs/IMPLEMENTATION_STATUS.md:175)。実測で `token` を受理。
- 必要な変更: `PublishTrack.token` を削除する。`KNOWN_TRACK_FIELDS` から外し、変数置換から外す。`token` を持つ catalog は未知フィールドとして無視される (受理はされるが値は使わない)。publish 認可は `authInfo` で表現する。
- 互換性影響: `PublishTrack.token` の型利用者に破壊的。`token` を送っていた publisher は (draft-02 の相手には) 認可情報が届かなくなるため、authInfo へ移行が必要。
- 優先度: P1 (draft-02 で削除されたフィールドを公開型として残すと、利用者が誤った catalog を作る)。

### TRK-16 `connectionURI` の JSON 名と所在 (P0)

- 仕様要件: Table 4 1038「Connection URI | connectionURI」。§5.2.37 1700-1714 (String、publish track 用の MOQT エンドポイント URI、"The URI MUST be a valid MOQT endpoint URI as defined by [MOQT], Section 6.1")。A.1.3 5444-5446「The connectionURI and encryption fields were added to the track field table.」。§9.4 3871-3876 / §10.4 3948-3952 が log / metrics の publish track で §5.2.37 を MAY とする。
- draft-01: §5.2.36 1278-1302 に本文はあるが、draft-01 の表 (728-815) には載っていない。JSON 名は本文の見出しが "Connection URI" で、実装が `connectionUri` と綴っていた。examples は `https://logs.example.com/moqt` も許していた (1300-1302)。draft-02 の examples は `moqt://...` のみ (1710-1714)。
- 現行実装: `PublishTrack.connectionUri?: string` (types.ts:236)、publishTracks でのみ受理 (catalogTrackValidation.ts:327-340、catalogValidation.ts:417-428)、変数置換対象 (variables.ts:193-199)。実測: `connectionURI` を渡すと未知フィールドとして保持されるが `PublishTrack.connectionUri` は undefined のまま。
- 必要な変更:
  1. JSON 名を `connectionURI` に変更する (ワイヤ名)。実装内部のプロパティ名も `connectionURI` に揃える (どちらかに統一しないと、decode した object のフィールド名とワイヤ名がずれる)。
  2. 所在: Table 4 は「track object のフィールド」として定義している。§5.2.37 の文面は "for the publish track" なので、publishTracks 専用のままでも意味は通る。ただし **draft-02 には「publishTracks 以外で MUST NOT」という文が無い**ため、通常 track で `connectionURI` を reject するのは仕様に無い制限である。推奨は「型は `CatalogTrack.connectionURI?: string` に置き、decode はどこでも受理する。意味付け (新規接続) は publishTracks のみ」。
  3. §5.2.37 の「subscriber MUST establish a new MOQT connection to this URI」は、本ライブラリでは publishTracks を使った逆方向 publish の機能自体が無いため未実装である (docs に明記)。
  4. URI の妥当性検査 (`moqt://` スキーム) は、既存の URI parser (`src/moqtUri` / `connect`) を再利用して publisher 側の生成時に検証するのが望ましい (§5.2.37 の MUST は producer 側の値の要求)。
- 互換性影響: **ワイヤ名の変更なので破壊的**。`connectionUri` を送っていた実装は draft-02 の相手に無視される。`PublishTrack` の型利用者も壊れる。
- 優先度: P0 (wire 名の不一致は相互接続に直結する)。

### TRK-17 `cipherSuite` の必須条件が緩和された (P1)

- 仕様要件: §5.2.39 1749-1751「A string identifying the AEAD cipher suite used for encryption. This field MUST be present when the encryptionScheme is "moq-secure-objects".」。A.1.3 5452-5453。
- draft-01: §5.2.39 1349-1351「This field MUST be present when encryptionScheme is specified.」— scheme が何であっても必須。
- 現行実装: `pickEncryptionFields` 296-301 が `encryptionScheme !== undefined && cipherSuite === undefined` で reject。実測で custom scheme + cipherSuite 無しを reject。
- 必要な変更: 条件を `encryptionScheme === "moq-secure-objects"` に限定する。custom scheme では `cipherSuite` 任意。
- 互換性影響: custom encryption scheme を使う catalog を受理するようになる (緩和)。
- 優先度: P1 (正しい catalog の拒否)。

### TRK-18 `keyId` / `trackBaseKey` の必須条件 (P2, 要判断)

- 仕様要件: §4.4.3 651-659「When using the "moq-secure-objects" scheme: The cipherSuite field MUST be present ... The keyId field MUST be present ... The trackBaseKey field MUST be present ...」。一方でフィールド単体の Required は `keyId` Optional (1776) / `trackBaseKey` Optional (1806)。§5.2.4.1 1160-1162 は「individual field definition sets a stricter constraint ... that constraint wins」と書くが、§4.4.3 はフィールド定義ではなく scheme の要件である。
- draft-01: §4.3.3 (460-475) は cipherSuite のみを MUST とし、keyId / trackBaseKey の MUST は無かった。
- 現行実装: `keyId` / `trackBaseKey` は string 型だけ (294-295)。実測で `moq-secure-objects` + cipherSuite のみを受理。
- 必要な変更: 仕様内で矛盾している (§4.4.3 の MUST と §5.2.40/§5.2.41 の Optional) ため、**親エージェントの判断が必要**。選択肢:
  - (a) §4.4.3 を採り、`encryptionScheme === "moq-secure-objects"` なら `keyId` / `trackBaseKey` も要求する。
  - (b) フィールド定義の Optional を採り、要求しない (現状維持)。
  - 推奨は (a)。暗号化された track を復号するには鍵素材が要り、`trackBaseKey` が無い catalog は実質使えない。ただし **moqt-js は暗号化 track の復号を実装していない** (`encryptionScheme` を扱うコードは `src/msf/` の検証以外に無い) ため、検証を厳しくしても動作は変わらない。
- 互換性影響: (a) を採ると、鍵を別経路で配る運用 (keyId だけ載せる) の catalog を拒否する。§4.4.3 は "MUST be present" なので (a) が仕様準拠。
- 優先度: P2 (暗号化機能自体が未実装のため、いま厳しくしても実利が無い)。

### TRK-19 `authInfo` の変数参照とトークン配送 (`c4m` → `cat`) (P1)

- 仕様要件: §5.2.42 1820-1862 (scheme は Table 10 の `privacy-pass` / `cat`。値は scheme 固有の JSON)。§5.2.43 1863-1884 (fragment のパラメータを `%name%` で catalog に埋め込む。例は `"authInfo": {"cat": "%token%"}`)。§11.1.1 Table 12 4098-4112 で予約キーは `cat` (旧 `c4m`)。A.1.7 5530-5532「The reserved fragment parameter "c4m" was renamed "cat".」。§11.5.1 4458-4464 (authInfo を見て認可要否を判断)。
- draft-01: §5.2.42 1421-1466 / §5.2.43 1467-1488。予約キーは `c4m`。実装の `catalogAuthInfoForSetupToken` は `{"cat": "%c4m%"}` を返す (authInfo.ts:14, 23, 58)。
- 現行実装: `authInfo` は object 型だけ検証 (310-320)。`catalogAuthInfoForSetupToken` は CAT の SETUP トークンのとき `{"cat": "%c4m%"}` を返す。subscriber は `getAuthorizationToken(authInfo)` の戻り値を使い (trackSubscriptions.ts:92-113)、変数置換は行わない。`resolveCatalogVariables` は公開関数だが高レベル API からは呼ばれていない。
- 必要な変更:
  1. `catalogAuthInfoForSetupToken` の変数参照を `%cat%` に変更する (fragment キーが `cat` になったため)。`%c4m%` のままだと、視聴側が `cat` パラメータを渡しても置換されない。
  2. 高レベル subscriber が catalog の変数置換を行うかどうかを決める。現状は行わないため、publisher が `%cat%` を載せても subscriber の `getAuthorizationToken` には未置換の文字列が渡る。少なくとも「変数置換は利用者の責務」であることを docs に明記する。実装するなら `processCatalogPayload` の後に `resolveCatalogVariables` を通す (変数は URI fragment から取る)。
  3. `authInfo` の値のうち string は変数置換の対象にする (現行 variables.ts:180-190 は値を走査するが、呼ばれていない)。
  4. 予約キーの改名 (`c4m` → `cat`) は fragment 側 (`src/msf/c4m.ts`, `src/msf/fragment.ts`) の担当だが、authInfo の生成側と必ず同時に直す。
- 互換性影響: publisher が載せる authInfo の変数名が変わる (破壊的)。catalog は全視聴者に届くため、トークンそのものを載せない方針 (現行コメント authInfo.ts:35-37) は維持する。
- 優先度: P1 (draft-02 の認可経路が動かない)。

### TRK-20 `accessibility` は仕様変更なし (差分なし、P2 は保持方針のみ)

- 仕様要件: §5.2.44 1885-1926。descriptor は `scheme` (String, required) と `value` (String, required)。Table 11 の 2 scheme。`value` の形式は [SCTE214-1]。
- draft-01: §5.2.44 1489-1534 と同内容 (表番号が Table 9 → Table 11)。
- 現行実装: 配列 + 各要素の `scheme` / `value` を string として検証 (576-605)。`{ scheme, value }` に再構築するため、descriptor 内の未知フィールドは落ちる。
- 必要な変更: なし。ただし descriptor 内の未知フィールドを落とすのは、track 直下の「未知フィールドを保持する」方針と不揃いである。§5 の "MUST ignore" は保持を要求しないため仕様違反ではないが、round-trip の一貫性のために方針をコメントで明示する。
- 優先度: P2。

### TRK-21 `accessibleWindowTime` が未実装 (P1)

- 仕様要件: §5.2.45 1927-1947。Number (wallclock ミリ秒)。live edge から遡って content が残る時間 (DVR ウィンドウ)。「Tracks assigned to the same alternate group Section 5.2.13 MUST carry the same accessibleWindowTime value.」(1946-1947)。A.1.3 5437-5438。A.1.4 5477-5478「Publishers SHOULD trim timelines to the accessible window, and subscribers MUST apply accessibleWindowTime constraints.」(本文 §5.2.45 には subscriber の MUST は書かれておらず、付録の要約にのみ現れる)。
- draft-01: フィールド自体が無い。
- 現行実装: 型なし。未知フィールドとして保持されるだけ (実測)。`altGroup` 内の一致検査も無い。
- 必要な変更:
  1. `CatalogTrack.accessibleWindowTime?: number` を追加し、`KNOWN_TRACK_FIELDS` に登録。decode は number + 有限 (負値を許すかは要判断。仕様は範囲を定めない。0 以上を推奨)。
  2. catalog 全体で「同じ `altGroup` の track は同じ値」を検査する (`assertTrackNameUnique` と同じ層)。片方だけ宣言している場合も不一致として扱う (MUST の "same value")。
  3. subscriber 側で DVR ウィンドウを適用する。本ライブラリは media timeline を購読していない (`createMediaSubscriber` は catalog から音声・映像の 2 トラックだけを購読する) ため、「timeline の古い Group を捨てる」実装は無い。少なくとも `accessibleWindowTime` を持つ catalog を受理し、将来の timeline 購読で使えるよう型と検証だけ先に入れる。
  4. publisher 側で宣言する API を追加するかは要判断 (moqt-js publisher は DVR を提供しないので不要)。
- 互換性影響: 追加のみ。検証を入れると altGroup 内で値が揃っていない catalog を拒否する (破壊的)。
- 優先度: P1 (新規フィールド。decode して型で見せるところまでが最低線)。

### TRK-22 `keyframeSpacing` が未実装 (P2)

- 仕様要件: §5.2.46 1949-1974。Number。1 keyframe interval あたりの Object 数 (15 なら keyframe + 14 predicted)。ABR の switch point 計算に使う。§4.3 565-584「When publishing multiple tracks within an alternate group that have dissimilar keyframe intervals (different GOP sizes), publishers MUST follow these requirements ... The keyframeSpacing Section 5.2.46 catalog field MUST be specified for each track, indicating the number of objects per keyframe interval.」。A.1.3 5440。
- draft-01: フィールド自体が無い。
- 現行実装: 型なし。未知フィールドとして保持されるだけ (実測)。ABR 切り替え機能自体が無い (`selectTrackByMaxBitrate` などの選択 helper はあるが、再生中の切り替えはしない)。
- 必要な変更:
  1. `CatalogTrack.keyframeSpacing?: number` を追加し、`KNOWN_TRACK_FIELDS` に登録。decode は number + 有限 + 整数 + 1 以上を推奨 (仕様は「number」。0 は「keyframe のみ」の意味になり得るため、仕様の例 (15 / 600) に合わせて 1 以上を推奨)。
  2. §4.3 (565-584) の MUST は「alternate group 内で keyframe 間隔が異なる場合」の条件付きなので、catalog 全体の検査として「同じ altGroup の track に keyframeSpacing が揃っているか」を警告または reject するかは要判断。**異なる値は許容される** (それが ABR の目的) ため、reject してはいけない。検査するのは「keyframe 間隔が異なるのに keyframeSpacing が欠けている」ケースだが、catalog だけでは keyframe 間隔は分からない (`maxGopDuration` はヒント) ため、**検証不能**。型と値の範囲だけ検証する。
  3. publisher は `keyframeInterval` (秒) と `framerate` から `keyframeSpacing = keyframeInterval * framerate` を算出して載せられる (`createMediaPublisher.ts:436-450` に keyframe 間隔の解決がある)。ただし可変フレームレートでは近似になるため、載せるかは要判断。
- 互換性影響: 追加のみ。
- 優先度: P2 (ABR 切り替えを実装しない限り使わない)。

### TRK-23 role `data` の追加 (P2)

- 仕様要件: Table 7 1320-1322「data | A generic descriptor for tracks carrying application-defined data」。A.1.3 5442。「Custom roles MAY be used」は両版 (1328-1329)。
- draft-01: Table 4 (888-956 の値列) に `data` は無い。
- 現行実装: `TrackRole = string` (`version.ts:55`) なので `data` は型として通る (実測で受理)。`RESERVED_TRACK_ROLES` (61-72) に `data` が無い。role を定数で typo 検出する用途 (docs の説明) には未登録。
- 必要な変更: `RESERVED_TRACK_ROLES` に `"data"` を追加する。Table 6 に `data` の行は無いので必須フィールドは増えない。`getVideoTracks` / `getAudioTracks` の対象外であることも変わらない。
- 互換性影響: なし (定数の追加のみ)。
- 優先度: P2。

### TRK-24 eventtimeline の `depends` 必須が過剰 (P0)

- 仕様要件: §8.3 3645-3658「An event timeline track MUST carry: a 'packaging' attribute with a value of "eventtimeline". an 'eventType' attribute ... If an Event Timeline track has an index reference which refers to one or more Media Timeline tracks, then those Media Timeline tracks MUST be listed in a 'depends' field within the Event Timeline track definition.」(3647-3658)。つまり depends は「index が media timeline を参照する場合」だけ。A.1.5 5496-5497「depends and mimeType are no longer required. depends MUST list any media timeline tracks that the index references.」
- draft-01: §8.2 3010-3030 は「An event timeline track MUST carry: packaging=eventtimeline, eventType, depends, mimeType=application/json」だった (実装のメッセージ "per §8.2" はこれ)。
- 現行実装: `validatePackagingSpecificRules` 467-482 が eventtimeline で `eventType` / `depends` / `mimeType` の 3 つを必須にする。実測で depends 無しを reject。
- 必要な変更: `depends` の必須を削除する。ただし「index が media timeline を参照する場合」の検査は、event timeline の payload (§8.1 の index) を見ないと判定できない。**catalog だけでは判定不能**であるため、`depends` は任意として受理し、index と depends の整合性検査は timeline 解析側 (event timeline の担当) に委ねる。
- 互換性影響: depends を持たない event timeline の catalog を受理する (緩和)。
- 優先度: P0 (draft-02 の正しい catalog を拒否する)。

### TRK-25 `targetLatency` の定義変更 (P2, 文書)

- 仕様要件: §5.2.9 1357-1376。「Target latency is defined as the offset in wallclock time between when content entered the encoder and when it is displayed to the end user.」(1361-1363)。A.1.3 5455-5456「targetLatency and timeline wallclock values are now defined relative to when content entered the encoder.」
- draft-01: §5.2.8 968-985 は「offset in wallclock time between when content was encoded and when it is displayed」。
- 現行実装: フィールド形状・解決規則 (同じ renderGroup / altGroup で同一値、isLive=false なら無視) は同じ (`tracks.ts:138-206`、`codec/types.ts:305-320`)。定義の文言だけが違う。
- 必要な変更: コード変更なし。JSDoc / docs の「符号化された時刻」を「encoder に入った時刻」に直す。publisher の `targetLatency` オプションの意味も同じ。
- 互換性影響: なし。
- 優先度: P2。

### TRK-26 `buffers` を消費する実装が無い (P2)

- 仕様要件: §5.2.10 1377-1417。「Buffer is defined as the duration of media data that needs to be buffered before decoding commences.」(1381-1383)。「Players SHOULD attempt to stabilize playback at this value.」(1388-1390)。「Unknown keys in the target buffer object MUST be ignored.」(1405-1406)。`isLive` false なら無視 (1408-1409)。同じ renderGroup / altGroup で同一値 (1409-1411)。`targetLatency` と排他 (1415-1416)。
- draft-01: §5.2.9 987-1025 と同内容 (「MUST be buffered」が「needs to be buffered」に変わっただけ)。
- 現行実装: 検証のみ (`validateBuffers` 550-574)。購読側の再生 (playout) は `targetLatency` だけを使い (`playout/mediaPlayout.ts:213-221, 438-472`)、`buffers` は使わない。
- 必要な変更: 仕様は SHOULD なので必須ではない。`buffers` を持つ catalog を受理し、`targetLatency` と排他であることは検証済み。将来 `buffers` を再生に使う場合は `mediaPlayout` の初期バッファに反映する。現状は「解釈しない」ことを docs に明記する。
- 優先度: P2。

### TRK-27 namespace 文字列テンプレート (`observabilityNamespaceTemplate`) の形式 (P1, 要判断)

- 仕様要件: §5.2.2 1069-1080 (catalog の namespace 文字列は `/` 区切り。各フィールドは §11.2 で UTF-8 バイトに変換)。§11.2.4 4373-4380「The hyphen-and-period serialization defined in [MOQT], Section 8.8 and used in MSF URL fragments (Section 11.1.2) is an encoding of the byte values produced by this section, not of the JSON source text. To render a catalog Full Track Name in that form, an implementation first maps each namespace element and the track name to bytes as defined above, then applies the MOQT encoding to those bytes.」。§9.2 3835-3838 / §10.2 3900-3903「The log track's namespace is defined by the Section 5.2.2 field and converted to bytes according to Section 11.2.」。A.1.6 5511-5513「Namespaces are now taken from the catalog namespace field via the standard name mapping.」
- draft-01: §5.2.2 に文字列→フィールドの対応が無く、実装は「MOQT §8.8 の表現」を catalog の namespace 文字列として使う独自規約を採っていた (`src/observability.ts:110-125`、`src/codec/types.ts:363-373`)。moq-log-04 §6 (refs/moq/draft-jennings-moq-log-04.txt:565-573) も `logs.2emoq.2earpa-v1-%resourceId%` という §8.8 形式を publishTracks の namespace として指定している。
- 現行実装: `observabilityNamespaceTemplate` は `formatTrackNamespace(prefix) + "-%resourceId%"` を返す (`observability.ts:123-125`)。`MOQLOG_NAMESPACE_TEMPLATE = "logs.2emoq.2earpa-v1-%resourceId%"` (moqlog.ts:357-362)、`MOQMETRICS_NAMESPACE_TEMPLATE = "metrics.2emoq.2earpa-v1-%resourceId%"` (moqmetrics.ts:736-742)。テストで文字列を固定している (moqlog.test.ts:414、moqmetrics.test.ts:587、observability.test.ts:76)。
- 問題: draft-02 §5.2.2 の下では、この文字列は **1 フィールドの namespace** (`logs.2emoq.2earpa-v1-...`) になる。moq-log-04 §5.1 / MSF §9.2 が求める 3 フィールド (`logs.moq.arpa` / `v1` / resourceId) とは一致しない。§11.2.4 は「§8.8 形式はバイト値の表現であり、JSON のソース文字列ではない」と明記している。
- 必要な変更: **仕様同士が衝突している**ため親エージェントの判断が必要。
  - (a) MSF-02 §5.2.2 を優先し、catalog の namespace 文字列を `logs.moq.arpa/v1/%resourceId%` にする (`observabilityNamespaceTemplate` を `/` 区切りに変える)。§9.2 の「§5.2.2 の field」と整合する。
  - (b) moq-log-04 §6 を優先し、§8.8 形式を維持する (§9.2 の「3 field」と矛盾する)。
  - 推奨は (a)。catalog の JSON は §5.2.2 が唯一のマッピングを定めており、§11.2.4 が §8.8 形式の用途を限定している。
- 互換性影響: `MOQLOG_NAMESPACE_TEMPLATE` / `MOQMETRICS_NAMESPACE_TEMPLATE` の公開文字列が変わる (破壊的)。テストも更新が必要。
- 優先度: P1 (要判断。log / metrics の担当エージェントと調整する)。

### TRK-28 節番号のずれの一括更新 (P2, 文書)

- 仕様要件: 本レポート §0 の対応表。
- 現行実装: `src/msf/` と高レベル API、devtools の JSDoc が `draft-ietf-moq-msf-01 §5.2.x` を大量に引用している。`grep` 相当の調査で `draft-ietf-moq-msf-01|MSF-01|msf-01|draft-01` を含むファイルは 110 個あった。
- 必要な変更: §0 の対応表に従って引用を更新する。特に `§5.2.5` (eventType) → `§5.2.6`、`§5.2.6` (role) → `§5.2.7`、`§5.2.7` (isLive) → `§5.2.8`、`§5.2.8` (targetLatency) → `§5.2.9`、`§5.2.9` (buffers) → `§5.2.10`、`§5.2.11` (renderGroup) → `§5.2.12`、`§5.2.13` (initRef) → `§5.2.14`、`§5.2.14` (depends) → `§5.2.15`、`§5.2.15` (template) → `§5.2.16`、`§5.2.18` (codec) → `§5.2.19`、`§5.2.19` (mimeType) → `§5.2.20`、`§5.2.22` (bitrate) → `§5.2.23`、`§5.2.24` (maxGopDuration) → `§5.2.25`、`§5.2.28` (samplerate) → `§5.2.29`、`§5.2.29` (channelConfig) → `§5.2.30`、`§5.2.33` (parentName) → `§5.2.34`、`§5.2.35` (trackDuration) → `§5.2.36`、`§5.2.36` (connection URI) → `§5.2.37`、`§5.2.37` (token) は削除。`§8.2` (event timeline catalog requirements) → `§8.3`。
- 優先度: P2。

---

## 5. 新規フィールドの型・範囲制約・検証の設計案

| フィールド             | draft-02 の型                          | 推奨する内部型 | decode の検証                                                                                                        | encode の検証                                                               | catalog 全体の検証                                                                    |
| ---------------------- | -------------------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `packagingMetadata`    | String (`key=value;...`)               | `string`       | string 型。`;` split + 最初の `=` で分割。`streamMapping` のみ解釈し、未知キーは無視。同一キーは最初のみ (1216-1217) | key / value に空白・`=`・`;` を含まないこと (1211-1212)。重複キーを作らない | なし                                                                                  |
| `accessibleWindowTime` | Number (wallclock ms)                  | `number`       | number + 有限。負値は reject を推奨 (DVR ウィンドウとして無意味)                                                     | 有限・0 以上                                                                | 同じ `altGroup` の track で同一値 (1946-1947)                                         |
| `keyframeSpacing`      | Number (objects per keyframe interval) | `number`       | number + 有限 + 整数 + 1 以上を推奨                                                                                  | 同上                                                                        | 検証不能 (§4.3 の条件は catalog から判定できない)。同 `altGroup` で値が違うことは許容 |

`depends` の Number は `renderGroup` の値と一致する必要があるため、catalog 全体での解決検証 (TRK-08) とセットで実装する。

---

## 6. 付録 A: §5.2.4.1 の必須フィールド表 vs 実装検証の突き合わせ (セル単位)

凡例: 「実装」列は現行の検証関数で、要求しているかを示す。`loc` 以外の packaging 行は Table 6 に無いため省略。

| Table 6 のセル                                       | 仕様                              | 実装                                     | 判定                         | 差分 ID        |
| ---------------------------------------------------- | --------------------------------- | ---------------------------------------- | ---------------------------- | -------------- |
| 全 track: `name`                                     | MUST (1155)                       | string 型のみ (375-379)                  | 型は充足。非空は不足         | TRK-03         |
| 全 track: `packaging`                                | MUST (1155)                       | string 型のみ (381-387)                  | 型は充足。値集合は未検査     | TRK-04         |
| 全 track: `isLive`                                   | MUST (1156)                       | boolean 型 (389-395)                     | 充足                         | -              |
| 全 track: namespace 未指定 → catalog を継承          | MUST (1156-1157)                  | 検証時に未解決                           | 不足                         | TRK-02         |
| (loc, audio) `codec`                                 | MUST (1184)                       | role=audio で必須 (408-410)              | 充足                         | -              |
| (loc, audio) `bitrate`                               | MUST (1184)                       | role=audio で必須 (411-413)              | 充足                         | -              |
| (loc, audio) `samplerate`                            | MUST (1184)                       | audio codec のときのみ (434-439)         | 不足 (codec 依存)            | TRK-11         |
| (loc, audio) `channelConfig`                         | MUST (1184)                       | audio codec のときのみ (440-442)         | 不足 (codec 依存)            | TRK-11         |
| (loc, video) `codec`                                 | MUST (1187)                       | role=video で必須 (408-410)              | 充足                         | -              |
| (loc, video) `bitrate`                               | MUST (1187)                       | role=video で必須 (411-413)              | 充足                         | -              |
| (loc, video) `framerate`                             | MUST (1187)                       | 要求しない                               | 不足                         | TRK-11         |
| (loc, audiodescription) `codec`                      | MUST (1189)                       | 要求しない                               | 不足                         | TRK-11         |
| (loc, audiodescription) `samplerate`                 | MUST (1189)                       | audio codec のときのみ                   | 不足                         | TRK-11         |
| (loc, audiodescription) `channelConfig`              | MUST (1189)                       | audio codec のときのみ                   | 不足                         | TRK-11         |
| (loc, audiodescription) `lang`                       | MUST (1189)                       | 要求しない                               | 不足                         | TRK-11         |
| (loc, signlanguage) `codec`                          | MUST (1192)                       | 要求しない                               | 不足                         | TRK-11         |
| (loc, signlanguage) `framerate`                      | MUST (1192)                       | 要求しない                               | 不足                         | TRK-11         |
| (eventtimeline, eventtimeline) `eventType`           | MUST (1194)                       | packaging=eventtimeline で必須 (468-472) | 充足 (role を見ない点は過剰) | -              |
| (eventtimeline, eventtimeline) `depends`             | 任意 (3655-3658)                  | 必須 (473-475)                           | 過剰                         | TRK-24         |
| (eventtimeline, eventtimeline) `mimeType`            | 任意 (§8.3 に記載なし)            | `application/json` 必須 (476-482)        | 過剰                         | TRK-12         |
| (mediatimeline, *) `depends`                         | MUST (§7.2 3424-3431)             | 必須 (456-458)                           | 充足 (中身の規則は未検証)    | TRK-09         |
| (mediatimeline, *) `mimeType`                        | 任意 (§7.2 に記載なし)            | `application/json` 必須 (459-465)        | 過剰                         | TRK-12         |
| (moqlog, log) の role                                | MUST (§9.4 3855-3868)             | 必須 (483-491)                           | 充足                         | -              |
| (moqmetrics, metrics) の role                        | MUST (§10.4 3935-3948)            | 必須 (492-500)                           | 充足                         | -              |
| `packaging` が `loc` の track に `packagingMetadata` | 任意 (ただし §4.1.1 のモード選択) | 未実装                                   | 不足                         | TRK-05, TRK-06 |

---

## 7. 付録 B: draft-01 の挙動を固定していて更新が必要なテスト一覧

行番号は現行ファイルのもの。「固定している内容」は、draft-02 で変わる前提をテストが固定している箇所。

| ファイル:行                                                    | テスト名 (要約)                                                              | 固定している内容                                                                | 必要な更新                                                                              | 関連                   |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ---------------------- |
| `src/msf.test.ts:88`                                           | MSF_VERSION: encode 時は draft-01                                            | `MSF_VERSION === "draft-01"`                                                    | `"draft-02"` へ                                                                         | 全体 (root 担当)       |
| `src/msf.test.ts:92`                                           | MSF_KNOWN_VERSIONS: draft-01 と 1                                            | 受理集合                                                                        | `"draft-02"` の扱いを決めて更新                                                         | 全体                   |
| `src/msf.test.ts:102`                                          | フルカタログ round-trip (draft-01)                                           | `version: "draft-01"`                                                           | `"draft-02"` へ                                                                         | 全体                   |
| `src/msf.test.ts:112`                                          | 文字列 1 を decode 受理                                                      | `"1"` の受理                                                                    | 受理集合の設計に合わせる                                                                | 全体                   |
| `src/msf.test.ts:618`                                          | §7.2 / §8.2 の depends / mimeType MUST                                       | mediatimeline / eventtimeline の mimeType 必須、eventtimeline の depends 必須   | mimeType 検査のテストを削除。eventtimeline の depends 必須テストを削除                  | TRK-12, TRK-24         |
| `src/msf.test.ts:666`                                          | tracks 内 (name, namespace) 重複 reject                                      | `namespace: "room1"` が単一フィールドとして有効                                 | そのまま通るはず。namespace 形式の追加テストを足す                                      | TRK-01                 |
| `src/msf.test.ts:677`                                          | tracks / publishTracks をまたぐ重複                                          | `(no namespace)` バケットの文言                                                 | catalog namespace 解決を入れると文言が変わる可能性                                      | TRK-02                 |
| `src/msf.test.ts:692`                                          | namespace が異なれば同名を受理                                               | `room1` / `room2`                                                               | 形式検証を入れても通る (各 1 フィールド)                                                | TRK-01                 |
| `src/msf.test.ts:812`                                          | moqlog の track でも audio codec なら samplerate MUST                        | publishTracks 側の audio codec 条件                                             | 維持 (仕様は audio codec 条件を残す §5.2.29)                                            | TRK-11                 |
| `src/msf.test.ts:827`                                          | role=audiodescription + audio codec で samplerate MUST                       | codec 条件                                                                      | 維持 + `lang` 必須のテストを追加                                                        | TRK-11                 |
| `src/msf.test.ts:848`                                          | role 未指定 + audio codec で channelConfig MUST                              | codec 条件                                                                      | 維持                                                                                    | -                      |
| `src/msf.test.ts:867`                                          | custom role + audio codec で samplerate MUST                                 | codec 条件                                                                      | 維持                                                                                    | -                      |
| `src/msf.test.ts:890`                                          | role=audio でも audio codec でなければ samplerate / channelConfig を課さない | **Table 6 と矛盾**する緩い挙動                                                  | `loc` + role=audio は codec が audio でなくても samplerate / channelConfig 必須に変える | TRK-11                 |
| `src/msf.test.ts:1105`                                         | targetLatency と buffers の併存 reject                                       | 排他                                                                            | 維持                                                                                    | -                      |
| `src/msf.test.ts:1124`                                         | eventtimeline で eventType 欠落 reject                                       | depends / mimeType を揃えている                                                 | depends / mimeType の前提を外す                                                         | TRK-12, TRK-24         |
| `src/msf.test.ts:1141`                                         | eventtimeline 以外で eventType reject                                        | draft-01 §5.2.5 の MUST NOT                                                     | 維持 (節番号を §5.2.6 に)                                                               | TRK-28                 |
| `src/msf.test.ts:1152`                                         | mediatimeline で depends 欠落 reject                                         | depends 必須                                                                    | 維持 (§7.2)                                                                             | -                      |
| `src/msf.test.ts:1163`                                         | mediatimeline で mimeType ≠ application/json reject                          | mimeType 必須                                                                   | 削除                                                                                    | TRK-12                 |
| `src/msf.test.ts:1182`                                         | eventtimeline の depends / mimeType / eventType の MUST                      | 3 つ揃わないと reject                                                           | depends / mimeType を外す                                                               | TRK-12, TRK-24         |
| `src/msf.test.ts:1202`                                         | encryptionScheme 指定時に cipherSuite 欠落 reject                            | 任意 scheme で必須                                                              | `moq-secure-objects` に限定。custom scheme で受理するテストを追加                       | TRK-17                 |
| `src/msf.test.ts:1220`                                         | mimetype (小文字) は reject                                                  | 小文字 reject                                                                   | 削除し、未知フィールドとして無視するテストに変更                                        | TRK-13                 |
| `src/msf.test.ts:1231`                                         | parentName を clone 外で reject                                              | clone 専用                                                                      | `update` を追加したら update でも許可                                                   | TRK-14                 |
| `src/msf.test.ts:1242`                                         | connectionUri / token を root tracks で reject                               | publishTracks 専用                                                              | `connectionURI` に改名。通常 track で受理するか要判断                                   | TRK-16                 |
| `src/msf.test.ts:1253`                                         | publishTracks で connectionUri を許可                                        | `connectionUri` の綴り                                                          | `connectionURI` に変更                                                                  | TRK-16                 |
| `src/msf.test.ts:1343`                                         | trackDuration を isLive=true で reject                                       | MUST NOT                                                                        | 維持                                                                                    | -                      |
| `src/msf.test.ts:1354`                                         | 未知ルートフィールドを保持                                                   | 保持方針                                                                        | `packagingMetadata` 等を既知にした後も保持方針が変わらないことを確認                    | -                      |
| `src/msf.test.ts:1553`                                         | delta 合成後の重複 reject                                                    | `applyCatalogDelta` の一意性                                                    | 維持 + catalog namespace 解決後の比較を追加                                             | TRK-02                 |
| `src/msf.test.ts:1599`                                         | clone 合成後の audio codec で samplerate MUST                                | draft-01 §5.2.28                                                                | 維持 (節番号を §5.2.29 に)                                                              | TRK-28                 |
| `src/msf.test.ts:1693`                                         | clone 合成後は packaging 別 MUST が role 条件より先                          | エラー順                                                                        | Table 6 を入れると順序が変わる可能性                                                    | TRK-11                 |
| `src/msf.test.ts:1716`                                         | clone 合成後の role 条件付き MUST                                            | draft-01 §5.2.18                                                                | 維持 (節番号を §5.2.19 に)                                                              | TRK-28                 |
| `src/msf.test.ts:1768`                                         | clone で eventType を継承し packaging を loc に                              | draft-01 §5.2.5 の MUST NOT                                                     | 維持 (節番号を §5.2.6 に)                                                               | TRK-28                 |
| `src/msf.test.ts:1799`                                         | clone で packaging を mediatimeline に + depends 欠落                        | §7.2                                                                            | 維持                                                                                    | -                      |
| `src/msf.test.ts:1892`                                         | delta add の round-trip (draft-01)                                           | `version: "draft-01"`                                                           | バージョン更新                                                                          | 全体                   |
| `src/msf.test.ts:2892`                                         | getVideoTracks / getAudioTracks が role でフィルタ                           | role の集合                                                                     | `data` を足しても挙動が変わらないことを確認                                             | TRK-23                 |
| `src/msf.test.ts:2947`                                         | effectiveTargetLatencyMs が isLive=false を無視                              | §5.2.8                                                                          | 維持 (節番号を §5.2.9 に)                                                               | TRK-28                 |
| `src/msf.test.ts:2995`                                         | 同じ render group で targetLatency 不一致を通知                              | §5.2.8                                                                          | 維持                                                                                    | -                      |
| `src/msf.prop.ts:37`                                           | (arbitrary 定義) draft-01 reserved 値                                        | packaging / role の集合                                                         | `catalog` / `data` を追加                                                               | TRK-04, TRK-23         |
| `src/msf.prop.ts:187`                                          | `catalogTrackArb` の namespace 生成                                          | `fc.option(fc.string({ maxLength: 32 }))` は空文字・`/` 始まり・`//` を含み得る | §5.2.2 の形式を満たす generator に変える                                                | TRK-01                 |
| `src/msf.prop.ts:433`                                          | decode 後の version は常に draft-01                                          | `MSF_VERSION`                                                                   | バージョン更新                                                                          | 全体                   |
| `src/msf.prop.ts:989`                                          | packagingArb: Table 4 reserved 値を網羅                                      | 5 値のリスト                                                                    | `catalog` を追加                                                                        | TRK-04                 |
| `src/msf.prop.ts:1024` 以降                                    | 仕様書例 (§5.6.x)                                                            | 例の本文 (version, mimeType, depends)                                           | draft-02 の §5.6 例に差し替え                                                           | TRK-12, TRK-24         |
| `src/msf/tracks.test.ts:27`                                    | effectiveTargetLatencyMs: isLive false を無視                                | draft-01 §5.2.8                                                                 | 維持 (節番号を §5.2.9 に)                                                               | TRK-28                 |
| `src/createMediaSubscriber.catalog.test.ts:256`                | 空文字 namespace と未宣言 namespace を別物として受理                         | namespace `""` の受理                                                           | 空文字は catalog invalid に変更                                                         | TRK-01                 |
| `src/moqlog.test.ts:414`                                       | MOQLOG_NAMESPACE_TEMPLATE の文字列                                           | `logs.2emoq.2earpa-v1-%resourceId%`                                             | `/` 区切りに変えるか要判断                                                              | TRK-27                 |
| `src/moqmetrics.test.ts:587`                                   | MOQMETRICS_NAMESPACE_TEMPLATE の文字列                                       | `metrics.2emoq.2earpa-v1-%resourceId%`                                          | 同上                                                                                    | TRK-27                 |
| `src/observability.test.ts:76`                                 | observabilityNamespaceTemplate の文字列                                      | §8.8 形式                                                                       | 同上                                                                                    | TRK-27                 |
| `src/mediaSubscriber/catalogSubscription.ts` のテスト (未確認) | track.namespace を使った購読                                                 | 現状は options.namespace 固定                                                   | track.namespace の解決を足したら追加                                                    | TRK-02                 |
| `devtools/src/hooks/usePublisher.test.ts`                      | devtools の catalog 生成 (mimeType / depends)                                | event track に mimeType を載せる                                                | 必須ではなくなる。depends は index 参照時のみ                                           | TRK-12, TRK-24         |
| `devtools/src/hooks/useSubscriber.test.ts`                     | devtools の catalog 表示                                                     | フィールド一覧                                                                  | 新規フィールドの表示を追加                                                              | TRK-05, TRK-21, TRK-22 |

補足: `src/msf.prop.ts` の `catalogTrackArb` は `packaging` に `moqlog` / `moqmetrics` を含めて `tracks` 配列に入れている。§9.4 / §10.4 は publishTracks を MUST とするため、この generator 自体が仕様違反の catalog を作っている。追従のついでに publishTracks 側へ寄せるべき (draft-02 固有の後退ではない)。

---

## 8. 付録 C: docs で更新が必要な記述

| ファイル:行                                          | 現在の記述                                                                                      | 更新内容                                                                               | 関連                   |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ---------------------- |
| `docs/MSF.md:10`                                     | 正本は `draft-ietf-moq-msf-01.txt`                                                              | `-02` に差し替え                                                                       | 全体                   |
| `docs/MSF.md:11`                                     | 公開版リンクが `draft-ietf-moq-msf-01`                                                          | `-02` に                                                                               | 全体                   |
| `docs/MSF.md:16`                                     | "MSF-01 §5 は ... Joining FETCH"                                                                | draft-02 §5 の記述に更新 (Joining FETCH の要求は draft-02 §5 にも残る。733-735 で確認) | 全体                   |
| `docs/MSF.md:23`                                     | `authInfo` を持つ track の購読でトークン付与 (§11.4.3)                                          | §11.5.3 (4515-4528) に節番号変更                                                       | TRK-19                 |
| `docs/MSF.md:26`                                     | `catalogAuthInfoForSetupToken` は `{"cat": "%c4m%"}`                                            | `%cat%` に変更 (予約キー改名)                                                          | TRK-19                 |
| `docs/MSF.md:28`                                     | "現行 Timeline encode/decode は無圧縮 JSON のみ。MSF_COMPRESSION (未実装)"                      | 変更なし                                                                               | -                      |
| `docs/MSF.md:29`                                     | "draft-00 の Catalog wire 形式 ... とは非互換"                                                  | draft-01 との非互換も追記するか要判断                                                  | 全体                   |
| `docs/IMPLEMENTATION_STATUS.md:143-145`              | 正本リンク `draft-ietf-moq-msf-01`                                                              | `-02` に                                                                               | 全体                   |
| `docs/IMPLEMENTATION_STATUS.md:156`                  | Track: namespace / name / packaging / isLive                                                    | namespace の形式制約、name 非空を追記                                                  | TRK-01, TRK-03         |
| `docs/IMPLEMENTATION_STATUS.md:157`                  | packaging: loc / mediatimeline / eventtimeline / moqlog / moqmetrics                            | `catalog` を追加                                                                       | TRK-04                 |
| `docs/IMPLEMENTATION_STATUS.md:158-160`              | role / label / lang / eventType                                                                 | role に `data` を追加                                                                  | TRK-23                 |
| `docs/IMPLEMENTATION_STATUS.md:161`                  | targetLatency / buffers / trackDuration                                                         | 変更なし (定義の文言は注記)                                                            | TRK-25                 |
| `docs/IMPLEMENTATION_STATUS.md:162`                  | initRef / template                                                                              | 変更なし                                                                               | -                      |
| `docs/IMPLEMENTATION_STATUS.md:163`                  | parentName / parentNamespace                                                                    | `clone` に加えて `update` (未実装である旨)                                             | TRK-14                 |
| `docs/IMPLEMENTATION_STATUS.md:164`                  | renderGroup / altGroup / depends                                                                | depends の Number 対応と解決 MUST を追記                                               | TRK-07, TRK-08         |
| `docs/IMPLEMENTATION_STATUS.md:166`                  | codec / mimeType                                                                                | mimeType が任意になったことを注記                                                      | TRK-12                 |
| `docs/IMPLEMENTATION_STATUS.md:173`                  | authInfo / accessibility                                                                        | authInfo の `%cat%`、accessibility は変更なし                                          | TRK-19                 |
| `docs/IMPLEMENTATION_STATUS.md:175`                  | connectionUri / token                                                                           | `connectionURI` に改名、token を削除                                                   | TRK-15, TRK-16         |
| `docs/IMPLEMENTATION_STATUS.md` の MSF 節 (Track)    | packagingMetadata / accessibleWindowTime / keyframeSpacing が無い                               | 3 フィールドを未対応として明記                                                         | TRK-05, TRK-21, TRK-22 |
| `docs/HIGH_LEVEL_API.md:115`                         | `targetLatency?: number; // draft-ietf-moq-msf-01 §5.2.8`                                       | §5.2.9 に                                                                              | TRK-28                 |
| `docs/HIGH_LEVEL_API.md:119`                         | `renderGroup` の §5.2.11                                                                        | §5.2.12 に                                                                             | TRK-28                 |
| `docs/HIGH_LEVEL_API.md:125`                         | authInfo の §5.2.42                                                                             | 変更なし                                                                               | -                      |
| `docs/HIGH_LEVEL_API.md:148`                         | "draft-ietf-moq-msf-01 由来であり、将来の draft 改版で変わる"                                   | draft-02 の節番号に                                                                    | TRK-28                 |
| `docs/HIGH_LEVEL_API.md:163`                         | `channelConfig` の §5.2.28 / §5.2.29                                                            | §5.2.29 / §5.2.30 に                                                                   | TRK-28                 |
| `docs/HIGH_LEVEL_API.md:1234`                        | targetLatency / renderGroup の §5.2.8 / §5.2.11                                                 | §5.2.9 / §5.2.12 に                                                                    | TRK-28                 |
| `docs/HIGH_LEVEL_API.md:1588`                        | `"authInfo": {"cat": "%c4m%"}`                                                                  | `%cat%` に                                                                             | TRK-19                 |
| `docs/LOW_LEVEL_API.md:109-110`                      | catalog の authInfo とトークン付与                                                              | 節番号 (§11.5.3) と変数名                                                              | TRK-19                 |
| `src/codec/types.ts:363-373`                         | 「catalog の namespace 文字列とフィールド列の対応は仕様で定まっていない ... 本実装は "/" 連結」 | draft-02 §5.2.2 が "/" 区切りを定めたため、独自規約の注記を削除して仕様引用に置換      | TRK-01, TRK-02         |
| `src/msf.ts:1-10`                                    | "本モジュールは draft-01 全面追従"                                                              | draft-02 に                                                                            | 全体                   |
| `src/msf/types.ts:1-8` ほか各フィールドの JSDoc      | `draft-ietf-moq-msf-01 §5.2.x`                                                                  | §0 の対応表で置換                                                                      | TRK-28                 |
| `src/msf/version.ts:1-5, 12-25, 39-53, 75-85`        | draft-01 の節番号と値集合                                                                       | `draft-02`, `catalog`, `data`                                                          | TRK-04, TRK-23         |
| `src/msf/catalogTrackValidation.ts:1-10` ほか        | 各フィールドの節番号                                                                            | §0 の対応表で置換                                                                      | TRK-28                 |
| `src/msf/catalogValidation.ts:346-359`               | clone / publishTracks の説明                                                                    | `update` の追加、connectionURI の扱い                                                  | TRK-14, TRK-16         |
| `src/msf/catalogCodec.ts:37-51, 178-205`             | initDataList の MUST 順序                                                                       | SHOULD に緩和 (緩和しても現行の出力は SHOULD を満たす)                                 | - (root 担当)          |
| `src/createMediaPublisher.ts:2095-2110`              | targetLatency / renderGroup の §5.2.8 / §5.2.11                                                 | §5.2.9 / §5.2.12                                                                       | TRK-28                 |
| `src/createMediaPublisher.ts:24`                     | "draft-ietf-moq-msf-01"                                                                         | draft-02                                                                               | 全体                   |
| `devtools/src/hooks/usePublisher.ts:300-320`         | catalog 生成の節番号と mimeType の説明                                                          | mimeType 任意、depends の条件、新規フィールド                                          | TRK-12, TRK-24         |
| `devtools/src/components/TrackDeclaration.tsx:20-45` | catalog の生の値を表示                                                                          | 新規フィールドを表示対象に追加                                                         | TRK-05, TRK-21, TRK-22 |
| `src/moqmetrics.ts:17-18`                            | "同じ namespace の catalog を同じ connectionUri / token で公開する"                             | `connectionURI` / authInfo に                                                          | TRK-15, TRK-16         |

補足: `CHANGES.md` は CODEBASE.md の「MOQT RFC ドラフト中の特別ルール」により更新しない。

---

## 9. 未確認事項

以下は本調査では確認できていない。実装前に別途確認が必要。

1. `object` モード (`streamMapping=object`) のデータ stream を moqt-js の購読側が正しく処理できるか。`src/dataStream/subgroup.ts` は汎用に Subgroup をパースし、`videoGroupGate` は `(groupId, subgroupId)` 単位で扱う (`createMediaSubscriber.ts:2850, 2857`) が、object モード専用のテストは無い。実リレー / 実 publisher での確認が必要。
2. `§4.3` の「alternate group 内で keyframe 間隔が異なる場合」の判定を catalog だけで行えるか。`maxGopDuration` と `keyframeSpacing` から近似できる可能性はあるが、仕様は「MUST be specified」の条件を publisher の運用に委ねている。
3. §11.6 の wallclock 定義 (POSIX ms) と `targetLatency` / `accessibleWindowTime` の解釈の整合。`src/playout` の時刻軸は `performance.now()` と `Date.now()` を併用しており、catalog の wallclock 値との厳密な対応は本調査では追っていない。
4. `Connection URI` を通常 track で受理すべきか。仕様に MUST NOT が無いため「受理する」が安全と判断したが、意味付けは publishTracks のみであり、実装者の意図を確認したい。
5. `§4.4.3` の `keyId` / `trackBaseKey` MUST と §5.2.40 / §5.2.41 の Optional の矛盾の解釈。
6. moq-log-04 §6 の namespace テンプレート (§8.8 形式) と MSF-02 §5.2.2 (`/` 区切り) の衝突の解釈 (TRK-27)。
7. `authInfo` の `%cat%` 置換を高レベル subscriber が行うか。現状は `getAuthorizationToken` の利用者責務であり、ライブラリが置換しない。
8. `depends` の解決検証で、String 要素を Full Track Name (namespace 込み) で比較するか Track Name だけで比較するか。§5.2.15 は「Track Name of exactly one other track object」と書くが、§11.2 は §5.2.15 を namespace/name フィールドとして列挙する。
9. devtools の catalog 生成 (event timeline) を draft-02 の §8.3 に合わせる具体的な形 (depends を media timeline の参照にするか、index を持たないなら depends 無しにするか)。event timeline の担当エージェントの結論待ち。
