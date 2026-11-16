# MSF draft-01 から draft-02 への追従差分調査

- 調査日: 2026-11-16
- 対象: `refs/moq/draft-ietf-moq-msf-02.txt` (5600 行) と moqt-js の現行実装 (draft-01 準拠)
- 目的: draft-02 に追従するために必要な差分を、仕様の規範要件と実装の実挙動の両面から洗い出す
- 本調査ではコードを変更していない。実装は別途行う
- 付録として領域別の詳細レポート 5 本を同ディレクトリに置く (末尾の一覧を参照)

## 決定事項

本調査の後に、draft-01 との互換性を維持しないことが決まった。本レポートはこの決定を前提に読む。

- catalog の `version` は `"draft-02"` のみを受理する。`"draft-01"` と `"1"` は明示的に拒否する (§6.1 は決定済み)
- draft-01 の wire 表現を受理する移行措置は入れない。予約パラメータ `c4m`、`connectionUri` の綴り、小文字の Event Timeline index key、`-` 区切りの log / metrics namespace、track-level の `token` はすべて廃止し、代替の綴りだけを実装する
- draft-01 の挙動を固定しているテストと fixture は、互換のための分岐を足さず単純に書き換える
- 公開 API の破壊的変更も許容する (CODEBASE.md の「破壊的変更は積極的に行う」に従う)
- draft-00 形式の delta update (`addTracks` / `removeTracks` / `cloneTracks`) を検出して拒否する既存コードは、draft-01 互換を前提にした防御なので削除してよい (`src/msf/catalogCodec.ts:294-300`)
- MOQT RFC ドラフト中のため CHANGES.md は更新しない (CODEBASE.md の特別ルール)。破壊的変更の周知は、README と `docs/` の対応版の記述で行う

この決定により、各詳細レポートの「互換性影響」欄にある「両方を受ける」「移行期は `c4m` も受理する」「後方互換になる」といった選択肢は採らない。詳細レポートは調査時点の記録として残すが、実装時は本節を優先する。

### 決定で単純になること

- `MSF_VERSION` の型が `"draft-02"` の 1 リテラルになり、受理集合も 1 要素になる。version ごとの検証分岐が不要になる
- `CatalogDelta` に version を持たせない前提を、互換のための保持処理なしで実装できる
- `EventTimelineEntry` は `T` / `L` / `M` だけを扱えばよく、小文字との union や変換層が不要になる
- 予約パラメータ、JSON フィールド名、namespace 表現、index key のいずれも 1 つの綴りだけを実装すればよい
- draft-01 の fixture を残す必要が無いため、テストは旧形式の受理を検証するケースを削除して置き換えられる

### 決定では解決しないこと

次の 3 点は互換性の問題ではなく、仕様の解釈または実装方針の問題である。決定後も判断が要る。

- `mimetype` (小文字) を明示的に拒否するか (D-45)。§5 の「未知フィールドを無視 MUST」との整合の問題
- `moq-secure-objects` のときに `keyId` / `trackBaseKey` を必須にするか (D-52)。§4.4.3 と §5.2.40 / §5.2.41 の条件の突き合わせ
- MSF 本文 (§9.1 / §9.3 / §10.1 / §10.3) と companion draft の記述が食い違う箇所で、どちらに従うか (D-32)

## 0. 用語と参照方法

- `msf-02:行番号` は `refs/moq/draft-ietf-moq-msf-02.txt` の行番号である
- `msf-01:行番号` は draft-01 のテキストの行番号である。draft-01 のテキストは本調査時点でリポジトリから削除されているため、次のコマンドで復元して読む

  ```console
  git show bc7abdbf^:refs/moq/draft-ietf-moq-msf-01.txt > /tmp/draft-ietf-moq-msf-01.txt
  ```

- `path:行番号` は実装のファイルと行番号である
- 差分 ID は `D-xx` (統合) と、領域別の詳細 ID (`CAT-xx` / `TRK-xx` / `MED-xx` / `TL-xx` / `WF-xx` / `LOG-xx` / `MET-xx` / `PROP-xx`) の 2 系統を使う。統合表から詳細レポートへ辿れるようにしてある

## 1. 判定の基準

優先度は「draft-02 準拠の相手と相互接続できるか」を基準に決めた。

- P0: draft-02 の正しい入力を現行実装が拒否する、または現行実装の出力が draft-02 で不正になる。1 つでも残ると draft-02 準拠の publisher / subscriber と接続できない。最初の追従リリースに必須
- P1: 仕様の MUST または SHOULD だが、該当機能を使わない限り顕在化しない。または新規機能で、実装しないと一部ユースケースが成立しない
- P2: 文書、コメント、節番号の更新、任意機能、仕様が SHOULD のみの項目

## 2. 結論

現行実装は draft-01 に忠実であり、draft-02 の catalog を 1 件も受理できない。理由は 1 つではなく、catalog の version 受理集合、delta update の構造、track フィールドの条件付き MUST が同時に変わっているためである。したがって追従は部分修正ではなく、Catalog 層を中心とした一括の移行になる。

差分は 53 件に整理できた。内訳は P0 が 12 件、P1 が 26 件、P2 が 15 件である。このうち P0 の大半は、`verify.mjs` の 21 ケースとして実行で再現できる (3 章)。

draft-01 との互換性は維持しない方針が決まったため、version の受理集合、旧綴りの受理、旧 index key の受理といった移行措置は実装しない。詳細は冒頭の「決定事項」と 6 章を参照する。この決定により、実装は「draft-02 だけを読む」前提で単純化できる。逆に、draft-01 を話す相手とは接続できないことを利用者向けに明示する必要がある。

最も影響が大きいのは次の 4 点である。

1. `version` の受理集合と出力値。`"draft-02"` の catalog は decode 時点で捨てられる
2. delta update の再設計。`generatedAt` 必須化、他ルートフィールドの禁止、`update` operation の追加、操作の逐次正当性検査
3. track フィールドの条件付き MUST の組み替え。`depends` の Number 対応、`mimeType` 必須の撤廃、Event Timeline の index key の大文字化、`connectionURI` への改名
4. namespace の文字列表現。draft-02 は `/` 区切りの 1 文字列と定義したが、実装は不透明な文字列として保持し、購読時には catalog の `namespace` を一切使っていない

## 3. 実測で確認した P0

`docs/investigations/msf-draft-02-diff/verify.mjs` に再現スクリプトを置いた。`pnpm run build` の後に `node docs/investigations/msf-draft-02-diff/verify.mjs` を実行すると、21 ケースすべてが draft-02 の期待と一致しないことを確認できる。

```console
pnpm run build
node docs/investigations/msf-draft-02-diff/verify.mjs
```

実測結果の要点は次のとおりである。

| 入力                                                                 | draft-02 の期待        | 現行実装の挙動                                                             |
| -------------------------------------------------------------------- | ---------------------- | -------------------------------------------------------------------------- |
| `"version": "draft-02"` の catalog                                   | 受理                   | `unsupported MSF version 'draft-02', expected one of [draft-01, 1]` で拒否 |
| `generatedAt` の無い delta update                                    | 拒否                   | 受理                                                                       |
| `publishTracks` を持つ delta update                                  | 拒否                   | 受理 (未知フィールドとして保持)                                            |
| `"op": "update"` の delta update                                     | 受理                   | `unknown op 'update', expected one of [add, remove, clone]` で拒否         |
| `"depends": [1]` (renderGroup 参照)                                  | 受理                   | `depends must be an array of strings` で拒否                               |
| `mimeType` の無い `mediatimeline`                                    | 受理                   | `mediatimeline track must have mimeType='application/json'` で拒否         |
| `depends` の無い `eventtimeline`                                     | 受理                   | `eventtimeline track must include depends` で拒否                          |
| 空文字列の `name`                                                    | 拒否                   | 受理                                                                       |
| `"namespace": "a//b"`                                                | 拒否                   | 受理                                                                       |
| `connectionURI` (draft-02 の JSON 名)                                | 型付きフィールドに入る | 未知フィールドとして保持され、`connectionUri` は未設定                     |
| `encryptionScheme` が `moq-secure-objects` 以外で `cipherSuite` 無し | 受理                   | `cipherSuite must be present when encryptionScheme is specified` で拒否    |
| BOM で始まる catalog document                                        | 拒否                   | 受理 (BOM は `TextDecoder` が除去)                                         |
| 孤立サロゲートを含む Track Name                                      | 拒否                   | 受理                                                                       |
| NUL を含む Track Name                                                | 拒否                   | 受理                                                                       |
| 不正な UTF-8 バイト列を含む catalog document                         | 拒否                   | 受理 (U+FFFD に置換)                                                       |
| Event Timeline の index key `T` / `L` / `M`                          | 受理                   | `invalid event timeline entry` で拒否                                      |
| Event Timeline の index key `t`                                      | 拒否                   | 受理                                                                       |

## 4. 差分一覧

### 4.1 P0 (相互接続に必須)

| ID   | 差分                                                                                                           | draft-02 の根拠                                                                    | 現行実装                                                                                                                                                                                                                                                                              | 詳細 ID                           |
| ---- | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| D-01 | catalog の `version` が `"draft-01"` 固定で、`"draft-02"` を受理しない                                         | §5.1.1 (msf-02:772-791)、全 16 例が `"draft-02"`、A.1.1 (msf-02:5364-5365)         | `MSF_VERSION = "draft-01"`、受理集合は `draft-01` と `1` (`src/msf/version.ts:22-33`)、`src/msf/catalogValidation.ts:46-60`。決定により、書き換え後は `"draft-02"` のみ受理し `"draft-01"` と `"1"` を拒否する                                                                        | CAT-01, MED-01, TL-24, X-02       |
| D-02 | delta update は `generatedAt` を MUST で含み、他の Root Catalog fields を MUST NOT で含む                      | §5.3 (msf-02:1976-2020)、A.1.3 (msf-02:5412-5417)                                  | `generatedAt` は任意、`publishTracks` や `isComplete` を未知フィールドとして受理し保持する (`src/msf/catalogCodec.ts:239-249, 312-372`)                                                                                                                                               | CAT-05                            |
| D-03 | delta update に `update` operation が追加された                                                                | §5.1.6 (msf-02:830-881)、A.1.3 (msf-02:5406-5411)                                  | `add` / `remove` / `clone` のみ受理し、`update` を unknown op として拒否 (`src/msf/catalogCodec.ts:400-419`)                                                                                                                                                                          | CAT-06                            |
| D-04 | `depends` の要素は String (Track Name) と Number (renderGroup) の両方を取り、すべて解決 MUST                   | §5.2.15 (msf-02:1461-1479)、§7.2 (msf-02:3421-3438)                                | `depends?: string[]` 固定で Number を拒否 (`src/msf/types.ts:143-144`、`src/msf/catalogTrackValidation.ts:226-232`)                                                                                                                                                                   | TRK-07, TL-05                     |
| D-05 | `mediatimeline` と `eventtimeline` の `mimeType="application/json"` 必須が撤廃された                           | §7.2 (msf-02:3421-3438)、§8.3 (msf-02:3645-3658)、A.1.4 / A.1.5 (msf-02:5466-5497) | 両 packaging で `mimeType="application/json"` を必須にしている (`src/msf/catalogTrackValidation.ts:459-465, 476-482`)                                                                                                                                                                 | TRK-12, TL-04, TL-16              |
| D-06 | `eventtimeline` の `depends` 必須が条件付きに変わった                                                          | §8.3 (msf-02:3655-3658)。index が media timeline track を参照する場合のみ MUST     | `depends` を無条件で必須にしている (`src/msf/catalogTrackValidation.ts:473-475`)                                                                                                                                                                                                      | TRK-24, TL-15                     |
| D-07 | Event Timeline の index key が `t` / `l` / `m` から `T` / `L` / `M` になった                                   | §8.2 (msf-02:3613-3643)、A.1.5 (msf-02:5482-5483)                                  | encode / decode / 検証すべて小文字固定 (`src/msf/timeline.ts:111-122, 154-172, 195-219`)、公開型 `EventTimelineEntry` も小文字 (`src/msf/types.ts:380-392`)                                                                                                                           | TL-12                             |
| D-08 | catalog JSON 名が `connectionUri` から `connectionURI` になった                                                | §5.2.37 と Table 4 (msf-02:1020、1700-1713)                                        | `connectionUri` を読む (`src/msf/types.ts:234-240`、`src/msf/catalogTrackValidation.ts:326-340`)                                                                                                                                                                                      | TRK-16                            |
| D-09 | catalog の `namespace` は `/` 区切りの 1〜32 非空フィールドで、malformed は catalog 無効                       | §5.2.2 (msf-02:1046-1098)、§11.2 (msf-02:4278-4331)                                | 単一の不透明な文字列として保持し、形式検証が無い (`src/msf/types.ts:117`、`src/msf/catalogTrackValidation.ts:130-138`)。購読時は catalog の `namespace` を使わず `options.namespace` で SUBSCRIBE する (`src/createMediaSubscriber.ts:2119`)                                          | TRK-01, TRK-02, CAT-14            |
| D-10 | 予約 fragment パラメータ `c4m` が `cat` に改名された                                                           | §11.1.1 Table 12 (msf-02:4093-4175)、A.1.7 (msf-02:5529-5531)                      | `getC4mParameter` が `"c4m"` 完全一致 (`src/msf/c4m.ts:80-89`)、`resolveMsfAuthorizationToken` も `c4m` のみ (`src/msf/c4mAuthorization.ts:89-108`)、catalog の `authInfo` は `{"cat": "%c4m%"}` を返す (`src/msf/authInfo.ts:23`)。決定により、`c4m` は受理せず `cat` だけを実装する | WF-01, TRK-19                     |
| D-11 | 変数名の文字制約が撤廃され、変数値に `+`、`/`、`=`、`.` が追加された。fragment の pair は最初の `=` で分割する | §5.4.1 / §5.4.2 (msf-02:2029-2076)、A.1.3 (msf-02:5458-5463)                       | 変数名を `[A-Za-z0-9_-]+`、値を `[A-Za-z0-9_@-]*` に制限している (`src/msf/variables.ts:21-23, 67-79`)                                                                                                                                                                                | CAT-11, WF-02                     |
| D-12 | `MSF_COMPRESSION` に Track / Object property の 0x78 が割り当てられ、GZIP 対応が MUST になった                 | §5.5 (msf-02:2077-2087)、§12.1 (msf-02:4583-4679)、A.1.8 (msf-02:5509-5515)        | algorithm 定数のみで Property ID を定義せず、「IANA 未割当のため未実装」としている (`src/properties.ts:24-45`)。GZIP payload の encode / decode 経路が無い                                                                                                                            | CAT-18, PROP-01, PROP-02, PROP-03 |

### 4.2 P1 (条件付き MUST、SHOULD、新機能)

| ID   | 差分                                                                                                                                              | draft-02 の根拠                                                                            | 現行実装                                                                                                                                                                                                                                                                                                   | 詳細 ID                        |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| D-13 | illogical operation (既存名の add、未知 track の remove / update、既存名への clone) は catalog 拒否 MUST                                          | §5.3 (msf-02:1999-2001)                                                                    | `remove` の未知 track と clone の親不存在は検出するが、`add` の既存名は同一 delta 内で remove すれば通る (逐次適用の正当性を検査していない)。実測で確認済み                                                                                                                                                | CAT-07                         |
| D-14 | remove は `name` と `namespace` のみ、clone / update は `parentName` を MUST、`parentNamespace` を MAY とする                                     | §5.1.6 (msf-02:848-881)、§5.2.34 / §5.2.35                                                 | remove の制約は実装済み。clone は実装済みだが `update` が無い。`parentName` は clone 専用として検証している (`src/msf/catalogValidation.ts:404-414`)                                                                                                                                                       | CAT-08, TRK-14                 |
| D-15 | catalog object は Subgroup 0、Group 内 Object ID 0 は independent MUST、1 以上は delta MUST、independent 生成時は新 Group の先頭                  | §5 (msf-02:710-731)                                                                        | 購読側は Object ID の規則を検証せず、届いた順に適用する (`src/mediaSubscriber/catalogSubscription.ts`)。publisher は Object ID 0 のみ送る (`src/createMediaPublisher.ts:1994-2000`)                                                                                                                        | CAT-03                         |
| D-16 | catalog track は配下 track より高い publisher priority SHOULD、購読は高い subscriber priority SHOULD                                              | §5 (msf-02:709-714)、A.1.3 (msf-02:5402-5404)                                              | catalog Object は priority 0 で送るが track 既定の publisher priority は未指定 (128) で、映像キーフレームも 0 のため「すべての track より高い」状態ではない。購読側は `subscriberPriority` を指定していない (`src/createMediaPublisher.ts:69, 1998`、`src/mediaSubscriber/catalogSubscription.ts:242-254`) | CAT-04                         |
| D-17 | initDataList に `track-property` / `object-property` type が追加され、配置は tracks の後が SHOULD に緩和された                                    | §5.1.7 (msf-02:882-926)、§12.2 (msf-02:4680-4724)                                          | type は任意文字列として受理するが解釈しない。配置は encode で tracks の後に固定しており MUST 相当                                                                                                                                                                                                          | CAT-10, PROP-04, PROP-05       |
| D-18 | 変数置換後の catalog を MUST で検証する。fragment の変数が高レベル API から供給されない                                                           | §11.5.2 (msf-02:4485-4512)、§13.5 (msf-02:4858-4889)                                       | `resolveCatalogVariables` は initRef の参照切れだけを見て、catalog 全体を再検証しない。公開 API (`src/index.ts`) に無く、高レベル購読からも呼ばれない                                                                                                                                                      | CAT-12, WF-12, WF-13           |
| D-19 | catalog の名前フィールドは UTF-8、BOM 禁止、孤立サロゲートと NUL 禁止、バイト完全一致で比較                                                       | §11.2 (msf-02:4278-4411)、§13.9 (msf-02:4962-4971)                                         | 非 fatal な `TextDecoder` で decode し (`src/msf/catalogCodec.ts:272-274`)、BOM を除去し、不正 UTF-8 を U+FFFD に置換する。孤立サロゲートと NUL も受理する。比較は JS 文字列 (`src/fullTrackName.ts:35-44`)                                                                                                | CAT-13, WF-03, WF-04, TRK-03   |
| D-20 | `packagingMetadata` を追加し、LOC の `streamMapping` を解釈する。購読側は `group` と `object` の両モードに対応 MUST                               | §5.2.5 (msf-02:1205-1223)、§4.1.1 (msf-02:479-529)                                         | フィールドの型もパーサも無い。publisher は group モード相当で動作するがシグナリングしない                                                                                                                                                                                                                  | TRK-05, TRK-06, MED-02, MED-16 |
| D-21 | `object` モードでは Object ごとに Subgroup が分かれ、Group 内の到着順が保証されない                                                               | §4.1.1 (msf-02:483-517)、§6 (msf-02:3265-3270)                                             | Subgroup は解決できるが、同一 Group 内で Object ID が飛ぶと映像を欠落扱いにする (`src/videoDecodeOrder.ts:126-132`)                                                                                                                                                                                        | MED-03                         |
| D-22 | `keyframeSpacing` (objects per keyframe interval) を追加                                                                                          | §5.2.46 (msf-02:1949-1974)、§4.3 (msf-02:565-587)                                          | フィールドが無く、値の保証も無い (キーフレームは経過時間ベースで、落としたフレームは Object に数えない)                                                                                                                                                                                                    | TRK-22, MED-09                 |
| D-23 | alternate group 内の multi-variant packaging 要件 (Group 先頭キーフレーム、1 Group 1 キーフレーム、object 境界での時間整合、開始 Group ID の一致) | §4.3 (msf-02:565-587)                                                                      | `altGroup` を catalog に出さず、開始 Group ID もトラックごとに独立に払い出す (`src/createMediaPublisher.ts:287-317, 2107-2163`)                                                                                                                                                                            | MED-08                         |
| D-24 | Multi-Variant Fast Track Switching の手順と switch point 計算 `(G * S + N) / T`                                                                   | §6.3 (msf-02:3293-3328)                                                                    | トラック切替機能が無い。`groupSwitchGate` と `videoDecodeOrder` は同一トラック内の順序制御である                                                                                                                                                                                                           | MED-10                         |
| D-25 | `accessibleWindowTime` (DVR 窓) を追加し、購読側は取得前に適用 MUST                                                                               | §5.2.45 (msf-02:1927-1947)、§7 (msf-02:3330-3345)、A.1.4 (msf-02:5466-5469)                | フィールドが無く、適用も無い                                                                                                                                                                                                                                                                               | TRK-21, TL-10                  |
| D-26 | 暗号化 object の復号と、`moq-secure-objects` のときだけ `cipherSuite` を MUST とする条件                                                          | §4.4 (msf-02:589-681)、§5.2.39 (msf-02:1745-1772)                                          | `cipherSuite` は任意の scheme で必須にしており過剰。復号処理は無く、暗号文を復号器へ渡す                                                                                                                                                                                                                   | MED-13, MED-14, TRK-17         |
| D-27 | track-level `token` を廃止し、publish track の認可は `authInfo` を使う                                                                            | §5.2.42 / §5.2.43 (msf-02:1820-1884)、A.1.3 (msf-02:5446-5449)                             | `PublishTrack.token` が型、検証、変数置換、docs に残っている (`src/msf/types.ts:238-240`、`src/msf/catalogTrackValidation.ts:341-349`、`src/msf/variables.ts:200-206`)                                                                                                                                     | TRK-15, WF-14                  |
| D-28 | `trackBaseKey` は E2E 暗号化された catalog でのみ運ぶ MUST NOT                                                                                    | §13.2 (msf-02:4785-4804)                                                                   | 検証が無く、平文 catalog でも受け入れる                                                                                                                                                                                                                                                                    | CAT-15                         |
| D-29 | 展開後 object サイズの上限、catalog 参照の循環検出、variable 置換後の検証                                                                         | §13.5 / §13.7 (msf-02:4858-4952)                                                           | いずれも無い                                                                                                                                                                                                                                                                                               | CAT-16                         |
| D-30 | `MSF_EVENT_TIMELINE_HEADER` (0x7B) を追加し、購読側は payload 解釈前に有無を確認 MUST                                                             | §8.1 (msf-02:3554-3570)、§12.3.1 (msf-02:4728-4742)                                        | property 定義も header と payload を組にした API も無い                                                                                                                                                                                                                                                    | PROP-06, TL-14                 |
| D-31 | log / metrics の publishTracks は catalog の `namespace` を `/` 区切りで表す                                                                      | §5.2.2、§5.6.17 の例 (msf-02:3165-3262)、§9.2 (msf-02:3833-3841)、§10.2 (msf-02:3898-3907) | template が `logs.2emoq.2earpa-v1-%resourceId%` 形式 (MOQT §8.8 の `-` 区切り) で、`/` を含まない (`src/observability.ts:117-126`、`src/moqlog.ts:362`、`src/moqmetrics.ts:741`)                                                                                                                           | LOG-02, MET-02, TRK-27         |
| D-32 | log / metrics の payload と Group / Object の契約が companion draft と食い違う                                                                    | §9.1 / §9.3 / §10.1 / §10.3 (msf-02:3821-3853, 3886-3932)                                  | companion draft (log-04、metrics-03) に従っており、MSF 本文の記述とは一致しない                                                                                                                                                                                                                            | LOG-03, LOG-04, MET-03         |
| D-33 | catalog の取得は SUBSCRIBE + Joining FETCH (offset = 0) MUST                                                                                      | §5 (msf-02:733-737)                                                                        | `subscribe()` + `fetch()` の 2 リクエストで代替。draft-23 に Joining FETCH が無いため fill fetch 化は未実装 (`docs/MSF.md:16`)                                                                                                                                                                             | CAT-19                         |
| D-34 | 再起動で Group ID の gap が分かる場合、`PRIOR_GROUP_ID_GAP` property で通知 SHOULD                                                                | §6.1 (msf-02:3284-3286)                                                                    | 送出しない。property の encode / decode 自体はある (`src/properties.ts:334`)                                                                                                                                                                                                                               | MED-11                         |
| D-35 | 認可失敗時の再取得、backoff、authInfo の scheme 選択                                                                                              | §11.5.4 (msf-02:4541-4563)                                                                 | 再試行も backoff も無く、SETUP のトークンを既定で使う                                                                                                                                                                                                                                                      | WF-19, WF-20                   |
| D-36 | wallclock-range / mediatime-range / location-range の適用と union MUST                                                                            | §11.1.1 (msf-02:4093-4175)                                                                 | parse helper のみで、高レベル API が範囲を適用しない                                                                                                                                                                                                                                                       | WF-05                          |
| D-37 | `connectionURI` は MOQT endpoint URI として妥当 MUST。publish track の endpoint ポリシーとレート制限                                              | §5.2.37、§13.6 (msf-02:4890-4912)                                                          | URI 検証が無く、`connectionURI` を消費する経路も無い                                                                                                                                                                                                                                                       | WF-15                          |
| D-38 | publish track を購読側が生成 / 消費する経路 (log / metrics の送出)                                                                                | §5.1.5、§9.4、§10.4                                                                        | 高レベル API に publishTracks を扱う経路が無い                                                                                                                                                                                                                                                             | LOG-06, MET-06, WF-11          |

### 4.3 P2 (文書、コメント、任意機能)

| ID   | 差分                                                                                                                                                                                                                                                                                   | 詳細 ID                   |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| D-39 | 節番号が全体的に 1 つ繰り下がった (`eventType` §5.2.5→§5.2.6、`renderGroup` §5.2.11→§5.2.12、`depends` §5.2.14→§5.2.15、`template` §5.2.15→§5.2.16、`targetLatency` §5.2.8→§5.2.9、`trackDuration` §5.2.35→§5.2.36 など)。JSDoc、エラーメッセージ、テストの期待値、docs を一括更新する | CAT-20, TRK-28, TL-23     |
| D-40 | `docs/MSF.md`、`docs/IMPLEMENTATION_STATUS.md`、`docs/HIGH_LEVEL_API.md`、`README.md`、`docs/proposals/` の draft-01 参照と壊れたリンクを更新する                                                                                                                                      | WF (docs 表)              |
| D-41 | `targetLatency` の基準が「符号化後」から「エンコーダーに入った時刻」に変わった。実装の時刻源は適合しており、文言のみ修正                                                                                                                                                               | TRK-25, MED-07, TL-22     |
| D-42 | `packaging` の許容値に `catalog` と `data` role が追加された。実装は packaging 値を実行時に検証していないため、型のみ追加しても実行時挙動は変わらない                                                                                                                                  | TRK-04, TRK-23, CAT-02    |
| D-43 | `isLive` の `false` から `true` への遷移を catalog 更新で検出する                                                                                                                                                                                                                      | TRK-10                    |
| D-44 | §5.2.4.1 Table 6 の (packaging, role) 必須フィールドのうち、`loc` + `video` の `framerate`、`loc` + `audiodescription` の 4 項目、`loc` + `signlanguage` の `codec` と `framerate` を実装が要求していない                                                                              | TRK-11                    |
| D-45 | 小文字 `mimetype` を明示的に拒否している。§5 の「未知フィールドを無視 MUST」とは整合しない                                                                                                                                                                                             | TRK-13                    |
| D-46 | 「Subgroup 0 に置く SHOULD」に対し、Subgroup ID が Group 途中参加時に 0 以外になり得る                                                                                                                                                                                                 | MED-05                    |
| D-47 | `buffers` は検証のみで再生に消費されない (仕様は SHOULD のため必須ではない)                                                                                                                                                                                                            | TRK-26                    |
| D-48 | `accessibility` descriptor 内の未知フィールドを破棄しており、未知フィールド保持の方針と不揃い                                                                                                                                                                                          | TRK-20                    |
| D-49 | `template` を publisher が生成せず、subscriber も再生に使わない (任意機能)                                                                                                                                                                                                             | MED-17                    |
| D-50 | MSF は Datagram 配送を規定しない。音声の既定 Datagram は仕様違反ではないが、docs に明記する余地がある                                                                                                                                                                                  | MED-18                    |
| D-51 | `depends` が renderGroup を参照する場合の規則 (renderGroup 全体が一致するなら個別 track を MUST NOT 参照) と、参照先 track の終了時の catalog 更新 MUST                                                                                                                                | TRK-09                    |
| D-52 | `moq-secure-objects` のときの `keyId` / `trackBaseKey` MUST (§4.4.3) を実装が要求しない。§5.2.40 / §5.2.41 の条件と突き合わせて判断する                                                                                                                                                | TRK-18                    |
| D-53 | `MSF_COMPRESSION` を FETCH_OK でも運べる点、および property scope / 重複検証テーブルへの追加                                                                                                                                                                                           | PROP-07, PROP-09, PROP-10 |

### 4.4 変更不要と確認できた項目

差分を洗う過程で「draft-01 と draft-02 で実質同じ」と確認できた項目を残す。実装を触る必要はないが、引用の文言だけは更新対象になる。

- §4.2 Time-alignment: 文言が `must be provided` から `needs to be provided` に変わっただけ (MED-06)
- §6.2 Object Numbering: 文面が同一。実装は Group 先頭 Object ID 0 と +1 増加を満たす (MED-12)
- clone operation の属性継承と上書き: 仕様どおり (CAT-09)
- §7.3 / §8.4 の更新規則のうち media timeline 側: 変更なし (TL-07)
- §7.4.1 template の 6 要素と §7.4.2 の不変性: 変更なし (TL-08, TL-09)
- Event Timeline の `data` が任意の JSON 値: draft-01 から変更なし。実装も `unknown` で一致 (TL-13)
- §3 Scope: 参照名と入れ子構造の変更のみで、規範内容の変更なし (MED-15)
- §11.5.3 の Presenting Authorization: 文面は §11.4.3 から同一。実装は SUBSCRIBE、SUBSCRIBE_NAMESPACE、FETCH、REQUEST_UPDATE、PUBLISH、PUBLISH_NAMESPACE にトークンを付与済み (WF-10)
- §11.4 Ending a live broadcast の `PUBLISH_DONE`: 実装は draft-23 の `PUBLISH_DONE` を使う (WF-09)
- §11.6 wallclock: POSIX ミリ秒で UTC 由来。実装の時刻源は適合 (WF-16)
- fragment type `msf` の登録内容: 変更なし (WF-17)
- `connection=q|wt` の解釈: 変更なし (WF-06)
- log / metrics の track name が ASCII 10 進: 実装は既に一致 (LOG-01, MET-01)
- `moqlog` + `role="log"`、`moqmetrics` + `role="metrics"` の MUST: 実装済み (LOG-05, MET-04)
- draft-01 の「each Object を新しい MOQT Stream にマップする」MUST の撤廃: 実装は元から Group 単位で stream を共有しており、draft-02 の `group` モードに一致する (MED-04)

## 5. 領域別の要点

### 5.1 Catalog の骨格

Catalog は draft-02 で「複数の catalog を参照できる構造」になった。top-level の Track Name は `"catalog"` 固定のままだが、`packaging: "catalog"` の track が別 catalog を指せる (Table 5、§5 冒頭)。このため `PackagingType` に `catalog` の追加と、参照先 catalog の解決方針の決定が要る。

delta update は処理モデルが変わった。draft-01 は「track 属性は宣言後に変更しない」という前提だったが、draft-02 は `update` operation で属性を変更できる。代わりに、操作の逐次正当性 (存在しない track の remove / update、既存名の add、既存名への clone) を厳格に検査する MUST が入った。実装は操作を「配列全体を適用してから一意性を検査する」方式なので、途中の不正を検出できない。

variable substitution は制約が緩み、値に URI 的な文字 (`+`、`/`、`=`、`.`) が使えるようになった。catalog の `namespace` に `%resourceId%` を埋めて配信する例が §5.6.17 にあり、購読側が置換する前提になっている。実装は置換関数を持つが、公開 API にも高レベルの購読経路にも繋がっていない。

### 5.2 Track フィールド

44 フィールドのうち、draft-02 で意味が変わったものは 3 つ、追加されたものは 3 つ、削除されたものは 1 つ、JSON 名が変わったものは 1 つである。

- 追加: `packagingMetadata` (§5.2.5)、`accessibleWindowTime` (§5.2.45)、`keyframeSpacing` (§5.2.46)
- 削除: `token` (§5.2.37、draft-01)
- 改名: `connectionUri` → `connectionURI`
- 意味変更: `depends` の Number 許容、`cipherSuite` の条件緩和、`namespace` の `/` 区切り化

実装が仕様より厳しいため正しい catalog を拒否する箇所が 5 つある (`depends` の Number、`mediatimeline` の `mimeType`、`eventtimeline` の `depends` と `mimeType`、`cipherSuite`)。逆に仕様より緩いため不正な catalog を受理する箇所が 4 つある (空の `name`、malformed な `namespace`、`isLive` の遷移、`depends` の未解決)。

§5.2.4.1 の Table 6 は (packaging, role) の組ごとに必須フィールドを定める新しい表である。実装の role ベースの検証 (`codec` と `bitrate`) は §5.2.19 / §5.2.23 の条件付き MUST に対応するが、Table 6 が追加で要求する `framerate`、`lang`、`channelConfig` の一部を満たしていない。

### 5.3 Media packaging と伝送

実装は draft-01 の「Object ごとに新しい Stream」に従っておらず、Group 単位で 1 本の Subgroup stream を使っていた。これは draft-02 の `group` モードと一致するため、撤廃による破壊はない。むしろ group モードを明示的にシグナリングする `packagingMetadata` の送出と、`object` モードの受信対応が新規に必要になる。

`object` モードは、Object ごとに Subgroup が分かれるため Group 内の到着順が保証されない。実装の映像経路は Object ID の飛びを欠落として扱い、次のキーフレームまで待つ。そのため `object` モードの publisher と接続すると、Group 内で順序が入れ替わった時点で映像が途切れる。

multi-variant 切替は publisher と subscriber の双方に新しい要件を課す。publisher 側は `altGroup`、開始 Group ID の一致、`keyframeSpacing`、Group 先頭の単一キーフレームが必要である。subscriber 側は `(G * S + N) / T` で切替先 Group を計算し、その Group の Object 0 から購読する。draft-23 の SUBSCRIBE Location Filter (絶対開始) で表現できるため、transport 仕様とは矛盾しない。

### 5.4 Timeline

Media Timeline は payload 自体の変更が小さい。混在禁止が明文化され、media time 順が明記され、`accessibleWindowTime` による trim と適用が入った。catalog 側は `mimeType` 必須が消え、`depends` が renderGroup を参照できるようになった。

Event Timeline は wire 互換性の破壊がある。index key が小文字から大文字に変わった。`EventTimelineEntry` は公開型なので、TypeScript の API としても破壊的変更になる。加えて、header data を `MSF_EVENT_TIMELINE_HEADER` property で運ぶ仕組みが入り、購読側は payload 解釈前に property を確認する MUST がある。

MSF Properties は、draft-01 で IANA 未割当だった `MSF_COMPRESSION` に 0x78 が割り当てられたことで、実装上のブロッカーが解消した。GZIP 対応は MUST である。`MSF_EVENT_TIMELINE_HEADER` は 0x7B で、こちらも追加が必要である。

### 5.5 Workflow、URL、認可、Log、Metrics

URL fragment の予約パラメータ `c4m` が `cat` に改名された。実装は `c4m` 完全一致で探すため、draft-02 の URL `#msf:namespace--name&cat=...` ではトークンを取り出せない。catalog の `authInfo` が返す変数名も `%c4m%` のままで、draft-02 の予約パラメータからは供給されない。

Log と Metrics は、namespace の表し方が `-` 区切り (MOQT §8.8 の文字列表現) から `/` 区切り (catalog §5.2.2) に変わる。既存の template は 1 フィールドの namespace として解釈されるため、`/` 区切りに直す必要がある。payload と Group / Object の契約は companion draft と MSF 本文で食い違っており、実装は companion draft に従っている。この食い違いは draft-01 から続く既知の問題である。

### 5.6 名前マッピング (§11.2)

§11.2 は draft-02 で新設された節で、「catalog の文字列を MOQT のバイト列へどう写すか」を初めて規範的に定めた。要点は次の 5 つである。

- JSON のエスケープを解決した後で UTF-8 エンコードする
- 正規化も大小文字変換もしない
- 孤立サロゲートと NUL を禁止し、消費側は catalog を invalid としなければならない
- catalog document は UTF-8 で、BOM で始まってはならない
- MOQT から受けた名前は raw バイトと比較し、UTF-8 にデコードして文字列比較してはならない

実装は JS 文字列を識別子にしているため、最後の 1 点が構造的に満たせない。MOQT 側の名前を文字列として保持する設計 (`src/fullTrackName.ts:35-44`) は draft-23 対応の前提でもあるため、比較の段階だけでもバイト列に寄せるかどうかの判断が要る。

## 6. 設計判断が必要な論点

実装を進める前に決めるべき事項を挙げる。draft-01 互換を維持しない決定により、6.1、6.3、6.8 は決定済みである。残る 6.2、6.4、6.5、6.6、6.7 は、仕様が一意に決めていないか、遅延とメモリのトレードオフがあるため実装方針の判断が要る。

### 6.1 `draft-01` の catalog を受理し続けるか (決定済み)

決定: 受理しない。draft-01 との互換性は維持しない。

§5.1.1 は「理解できない version を parse してはならない」としか定めていないため、`draft-01` を残す余地は仕様上ある。しかし draft-01 の delta update は track 属性の不変を前提にしており、draft-02 の `update` operation と意味が衝突する。両方を受理すると version ごとに検証規則を切り替える構造が必要になり、得られる相互接続の利得に対して実装と試験のコストが見合わない。

実装は次のとおりにする。

- `MSF_VERSION` を `"draft-02"` にする
- 受理集合を `{"draft-02"}` だけにし、`"draft-01"` と `"1"` を削除する。エラー文言の期待値一覧も 1 要素になる
- version による分岐をコードに持たせない。delta update の検証は draft-02 の規則だけを実装する
- draft-00 形式の delta update 検出 (`addTracks` / `removeTracks` / `cloneTracks`) は、draft-01 以前との互換のための防御なので削除する

`"1"` は draft-01 の例が使っていた名残であり、draft-02 の例 16 件はすべて `"draft-02"` である。したがって `"1"` を残す理由も無い。

### 6.2 `namespace` をどう保持するか

draft-02 は `namespace` を `/` 区切りの文字列と定めた。draft-01 互換を持たないため、どちらの表現も残す必要はない。実装は 2 つの選択肢を取れる。

1. wire の文字列をそのまま保持し、MOQT の namespace 配列が要る箇所で分割する
2. decode 時に分割して配列として保持し、encode 時に `/` で連結する

2 のほうが Full Track Name の比較と購読に素直で、`/` 区切り文字列と配列の二重管理を避けられる。`CatalogTrack.namespace` は公開型なので破壊的変更になるが、この決定により許容される。決めるべき残余は、catalog の `namespace` を購読に使う経路をどうするかである。現状は `createMediaSubscriber` の `namespace` オプションだけで SUBSCRIBE しており、catalog が宣言した namespace を無視している。catalog の namespace を優先するか、オプションを上書きするかの規則を決める必要がある。

### 6.3 `EventTimelineEntry` の index key をどう移行するか (決定済み)

決定: 型ごと `T` / `L` / `M` に変える。小文字 key の受理は残さない。

draft-01 互換を持たないため、union で両方を受ける案と、内部表現だけ小文字にしておく案は採らない。`EventTimelineEntry` を `T` / `L` / `M` に変更し、encode も decode も大文字だけを扱う。公開型の破壊的変更になるが、この決定により許容される。devtools の表示コード (`devtools/src/utils/eventTimeline.ts`、`devtools/src/components/MessageList.tsx`) も同時に直す。

### 6.4 MOQT の名前比較をバイト列に寄せるか

§11.2.3 は raw バイト比較を MUST とする。実装は Track Namespace Field と Track Name を JS 文字列で保持しており、`fullTrackNameKey` は UTF-16 のコードユニット数で長さ付きキーを作る。孤立サロゲートを含む名前は `TextEncoder` が U+FFFD に置換するため、異なる 2 つの名前が同じキーになり得る。

対応案は 3 つある。

1. `fullTrackNameKey` を UTF-8 バイト列ベースにする。比較の一意性は保証できるが、全比較経路の変更になる
2. 名前を受け取る入口で孤立サロゲートと NUL を拒否する。実装が扱う名前の集合を狭める
3. 両方を行う

2 だけでも §11.2 の禁止事項は満たせる。1 は「MOQT から受けた名前が不正な UTF-8 だった場合に catalog のどのエントリとも一致しない」ことを保証するために要る。

### 6.5 GZIP 対応をどの層に入れるか

`MSF_COMPRESSION` は Track Property と Object Property の両方で運べる。Track Property なら SUBSCRIBE_OK / FETCH_OK / PUBLISH の受信時に、Object Property なら Object 受信時に判定する。圧縮対象は catalog、media timeline、event timeline の payload である。

現行の `properties.ts` は Property Type の scope 表を持つため、0x78 を `both` として追加できる。ただし 0x78 は「Track Property なら全 Object が圧縮」「Object Property なら個々の Object」という排他の意味を持つため、両方が同時に来た場合の扱いを決める必要がある (仕様は両方の併用を MUST NOT とする)。

### 6.6 `object` モードの受信をどこまで保証するか

§4.1.1 は購読側に両モード対応を MUST とする。実装は Subgroup を区別して受信できるが、同一 Group 内の Object 順序の入れ替えを吸収しない。吸収するには Subgroup をまたぐ並べ替えバッファが必要になり、遅延とメモリのトレードオフが生じる。

候補は次の 3 案である。

1. `group` モードだけを実装し、`object` モードの catalog は明示的に非対応として失敗させる
2. Group 内の Object を Object ID 順に並べ替えるバッファを入れる
3. `object` モードでも Group 内の全 Object が同じ Subgroup に来ると仮定し、順序の入れ替えは欠落として扱う (現状と同じ)

draft-01 互換を切る決定は、この選択肢を狭めない。`group` と `object` はどちらも draft-02 の要件であり、draft-01 の表現ではない。§4.1.1 が購読側に両モード対応を MUST とする以上、1 と 3 は仕様違反になる。実装するなら 2 を選ぶことになる。

### 6.7 `update` operation の適用意味論

`update` は「既存 track の一部フィールドを上書きする」操作である。`parentName` で対象を指定し、宣言したフィールドだけを上書きする。実装では次の 3 点を決める必要がある。

- 上書き後の track に対して、packaging / role の条件付き MUST を再検証するか (clone では再検証している)
- `name` 自体を変更できるか (仕様は「属性を上書きする」とだけ書いており、Track Name の変更を禁じていない)
- `depends` の参照や `initRef` の参照が、update によって壊れた場合の扱い

### 6.8 log / metrics の namespace template をどう直すか (決定済み)

決定: catalog 用の文字列は `/` 区切りに一本化し、`-` 区切りの表現は持たない。

`MOQLOG_NAMESPACE_TEMPLATE` と `MOQMETRICS_NAMESPACE_TEMPLATE` は `-` 区切りの MOQT §8.8 表現である。draft-02 の catalog は `/` 区切りなので、両方を提供すると利用者が取り違える。draft-01 互換を持たないため、旧形式を残す理由も無い。

MOQT の SUBSCRIBE に渡す namespace は配列であり、catalog の文字列とは別の表現である。役割を分けて次の 2 つを提供する。

- catalog の `namespace` に書く文字列 (`/` 区切り、`%resourceId%` を保持する)
- その文字列から MOQT の namespace 配列を作る関数 (分割と `%resourceId%` の展開)

MOQT §8.8 の `-` 区切り表現は、ログ表示や fragment のように MOQT の直列化が要求される箇所でだけ使う。

## 7. 作業分割案

1 つの巨大な変更にせず、相互接続の成立を最優先にして段階を切る案である。issue の粒度は 1 つの検証可能な振る舞いを単位にした。

### 第 1 段階: draft-02 の catalog を読めるようにする

- Catalog の version を draft-02 のみに絞る (`MSF_VERSION` の変更と受理集合の削減。draft-00 形式 delta の検出コードも削除する) (D-01)
- delta update のルートフィールド拘束と `update` operation を実装する (D-02、D-03、D-13、D-14)
- `depends` の Number 対応と解決検証を実装する (D-04、D-51)
- `mimeType` 必須の撤廃と `eventtimeline` の `depends` 条件化 (D-05、D-06)
- Event Timeline の index key を大文字化する (D-07)
- `connectionURI` への改名と `token` の削除 (D-08、D-27)
- namespace の `/` 区切り対応と検証 (D-09)
- §11.2 の名前マッピング検証 (D-19)

### 第 2 段階: URL と認可

- fragment の `cat` 対応 (`c4m` は実装しない) と `%cat%` への移行 (D-10)
- 変数置換の文字制約の更新と、fragment から変数への配線 (D-11、D-18)
- `connectionURI` の URI 検証 (D-37)

### 第 3 段階: 圧縮と properties

- `MSF_COMPRESSION` (0x78) の Track / Object property 対応と GZIP (D-12)
- `MSF_EVENT_TIMELINE_HEADER` (0x7B) と header data (D-30)
- initDataList の `track-property` / `object-property` (D-17)

### 第 4 段階: media packaging と伝送

- `packagingMetadata` と `streamMapping` (D-20)
- `object` モード受信 (D-21)
- `keyframeSpacing` と multi-variant packaging (D-22、D-23)
- Multi-Variant Fast Track Switching (D-24)

### 第 5 段階: 残りの MUST / SHOULD

- `accessibleWindowTime` (D-25)
- 暗号化 (D-26) と `trackBaseKey` の制約 (D-28)
- 資源防御 (D-29)
- catalog の Group / Object 規則と priority (D-15、D-16)
- fill fetch (D-33)、`PRIOR_GROUP_ID_GAP` (D-34)
- log / metrics の namespace 形式 (D-31、D-32) と publishTracks 経路 (D-38)

### 第 6 段階: 文書と仕上げ

- 節番号と docs の一括更新 (D-39、D-40)
- targetLatency の文言 (D-41)
- 残りの P2 (D-42 から D-53)

## 8. 影響を受けるテストとドキュメント

領域別レポートに全件を列挙してある。特に影響が大きいものだけ挙げる。

### テスト

- `src/msf.test.ts`: `MSF_VERSION` と受理集合 (`"draft-01"` と `"1"` を受理するケースは削除する)、`depends` の型、`mimeType` 要求、Event Timeline の key
- `src/msf.prop.ts`: fixture の version が `draft-01` 固定。draft-01 と `"1"` の受理を前提にした生成ケースは削除し、`draft-02` に置き換える
- `src/msf/tracks.test.ts`: `targetLatency` と Group ID の JSDoc 引用
- `src/createMediaSubscriber.catalog.test.ts`: catalog fixture の version
- `src/createMediaPublisher.test.ts`: `allocateInitialGroupId` の独立性、`targetLatency` / `renderGroup` の出力
- `src/moqlog.test.ts` / `src/moqmetrics.test.ts`: namespace template の期待値 (`logs.2emoq.2earpa-v1-%resourceId%` などを直接固定している)
- `src/msf.test.ts` の fragment 関連: `c4m` を前提にしたケース

### ドキュメント

- `docs/MSF.md`: 正本のパスと公開リンク、節番号の引用
- `docs/IMPLEMENTATION_STATUS.md`: `draft-01` の実装状況、未実装フィールドの追記
- `docs/HIGH_LEVEL_API.md`: `targetLatency` と `renderGroup` の節番号
- `docs/MEDIA_PLAYOUT.md`、`docs/PLAYOUT.md`、`docs/PLAYOUT_DELAY.md`: `targetLatency` の定義
- `docs/ARCHITECTURE.md`: catalog の Group / Object 採番
- `docs/proposals/FETCH_GAP_RECOVERY.md`、`docs/proposals/AUDIO_FEC.md`: draft-01 への参照
- `README.md`: MSF の対応版

### コード内のコメント

`src/` と `devtools/src/` で `draft-ietf-moq-msf-01` を引く行が 375 行、91 ファイルある (テストを含む。リポジトリ全体では issues を除いて 418 行)。節番号の繰り下げと version 表記を一括で直す必要がある。`src/msf/tracks.ts:213-217` には仕様に存在しない文の引用があり、`src/msf/tracks.ts:225` は仕様が SHOULD とする箇所を MUST と書いている。文言の修正だけでなく引用の正否も確認する。

## 9. 付録: 領域別の詳細レポート

| ファイル                                       | 範囲                                                  | 差分 ID                                                                  |
| ---------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------ |
| [catalog.md](catalog.md)                       | §5 冒頭、§5.1、§5.3、§5.4、§5.5、§11.2、§13           | CAT-01 から CAT-20                                                       |
| [track-fields.md](track-fields.md)             | §5.2 全体 (44 フィールド、Table 4 から Table 11 まで) | TRK-01 から TRK-28                                                       |
| [media-transmission.md](media-transmission.md) | §3、§4、§6                                            | MED-01 から MED-18                                                       |
| [timeline.md](timeline.md)                     | §7、§8、§12、§14                                      | TL-01 から TL-24、PROP-01 から PROP-10                                   |
| [workflow.md](workflow.md)                     | §9、§10、§11、§13.4、§13.6、§14.1                     | WF-01 から WF-20、LOG-01 から LOG-06、MET-01 から MET-06、X-01 から X-03 |
| [verify.mjs](verify.mjs)                       | P0 の実測スクリプト                                   | 3 章の表に対応                                                           |

各詳細レポートは、仕様要件の引用 (行番号つき)、draft-01 での扱い、現行実装の挙動 (file:line)、必要な変更、互換性影響、優先度を差分ごとに書いている。実装に着手するときは、本レポートの 4 章で当たりを付け、詳細レポートで根拠を確認する順で読むとよい。
