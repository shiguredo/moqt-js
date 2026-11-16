# MSF draft-02 追従調査レポート: Workflow / Log / Metrics

> **決定事項 (本レポートの後に確定)**: draft-01 との互換性は維持しない。
> したがって、本レポートの「互換性影響」欄にある「両方を受ける」「移行期は旧綴りも受理する」
> 「後方互換になる」といった選択肢は採らない。実装時は [README.md](README.md) 冒頭の決定事項を優先する。

- 対象リポジトリ: `/home/shiguredo/shiguredo/moqt-js` (TypeScript / pnpm / MOQT クライアントライブラリ)
- 正本: `refs/moq/draft-ietf-moq-msf-02.txt` (以下 MSF-02、5600 行)
- 比較用: `refs/moq/draft-ietf-moq-msf-01.txt` (以下 MSF-01、4144 行)
- 調査担当範囲: MSF-02 §9 (Log track)、§10 (Metrics track)、§11 (Workflow)、§13.4、§13.6、§14.1、および付録 A.1.6 / A.1.7 / A.1.8
- 調査方針: リポジトリ内のファイルは一切変更していない。仕様は `refs/moq/draft-ietf-moq-msf-02.txt:行`、実装は `path:行` で引用する。推測は書かず、未確認は「未確認」と明記する。
- 実装の全文を読んだファイル: `src/msf/fragment.ts`、`src/msf/c4m.ts`、`src/msf/c4mAuthorization.ts`、`src/msf/authInfo.ts`、`src/msf/variables.ts`、`src/msf/version.ts`、`src/msf/types.ts`、`src/msf/tracks.ts`、`src/msf/catalogTrackValidation.ts`、`src/msf/catalogValidation.ts`、`src/moqtUri.ts`、`src/fullTrackName.ts`、`src/connect.ts`、`src/moqlog.ts`、`src/moqlog.prop.ts`、`src/moqmetrics.ts`、`src/moqmetrics.prop.ts`、`src/observability.ts`、`src/msf.ts`。`src/session/params.ts`、`src/session/requests.ts`、`src/session/incomingPublish.ts`、`src/session/namespaces.ts`、`src/createMediaPublisher.ts`、`src/createMediaSubscriber.ts` は担当範囲の指定に従い authorization token / authInfo / publish / fragment 経路を読んだ。
- テスト: `src/msf.test.ts` の fragment / c4m / log / metrics 関連、`src/moqlog.test.ts`、`src/moqmetrics.test.ts`、`src/moqtUri.test.ts`、`src/connect.test.ts` を読んだ。

## 0. 結論サマリ

MSF-01 → MSF-02 の変更のうち、本担当範囲で実装に影響するものは次の 4 系統である。

1. fragment の予約パラメータ `c4m` が `cat` に改名された (MSF-02:5530-5531)。現行の公開 API と URL 解釈は `c4m` 固定であり、P0 の対応が必要である。
2. 予約パラメータの値の文法は変わらない (`-` 区切り、`.` 区切り、inclusive、open range、複数指定は union)。ただし variable substitution の値の文字集合が広がり (`+`、`/`、`=`、`.`)、変数名の制限が撤廃された (MSF-02:5459-5462)。`cat` の Base64 を catalog に代入する経路が現行実装では通らない。
3. §11.2「catalog 文字列 → MOQT バイト値の写像」が新設され、UTF-8、正規化なし、byte-exact 比較、孤立サロゲートと NUL の禁止、BOM 禁止、raw MOQT バイトとの比較が MUST になった (MSF-02:4278-4411、A.1.7:5519-5529)。現行実装は文字列比較と非 fatal な UTF-8 デコードに依存しており、未充足の箇所がある。
4. §9 / §10 は companion draft (MOQLOG-04 / MOQMETRICS-03) の参照に更新されたが、本文の payload / Group ID / Object ID の記述は companion draft と矛盾したままである。現行実装は companion draft 側に従っており、MSF-02 の文言に合わせると後退する。仕様間矛盾の判断が必要である。

上記に加えて、catalog の `namespace` が MSF-02 §5.2.2 で「`/` 区切りの 1 文字列」と明確化されたため、現行の log / metrics の publishTracks 用 namespace template (`-` と `.HH` の MOQT §8.8 形式) は MSF-02 の catalog としては不正になる。これは catalog のワイヤ互換性を壊すため、本レポートで最も重要な発見の一つである。

### 0.1 差分 ID 一覧

| ID     | 分類              | 1 行サマリ                                                                                                                                                 | 優先度 |
| ------ | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| WF-01  | §11.1.1           | 予約 fragment パラメータ `c4m` を `cat` に改名する。URL・公開 API・エラーメッセージ・変数参照が影響する                                                    | P0     |
| WF-02  | §5.4 / §11.1.1    | variable の値に `+` `/` `=` `.` を許可し、変数名の制限を撤廃する。fragment の pair は最初の `=` で分割する                                                 | P1     |
| WF-03  | §11.2.1 / §11.2.2 | catalog の命名 field に孤立サロゲートと NUL を拒否し、UTF-8 を strict に扱い、空 Track Name と namespace 形式を検証する                                    | P1     |
| WF-04  | §11.2.3           | MOQT から受けた名前は raw バイトで catalog の写像バイトと比較する。テキストへデコードして比較しない                                                        | P1     |
| WF-05  | §11.1.1           | `wallclock-range` / `mediatime-range` / `location-range` を高レベル API で適用し、複数指定の union を実装する                                              | P1     |
| WF-06  | §11.1.1           | `connection=q\|wt` は変更なし。現行の検証を維持する                                                                                                        | P2     |
| WF-07  | §11.1 / §11.1.2   | fragment ABNF が許す `pct-encoded` と `%3F` の扱いが実装と仕様で食い違う。仕様の解釈確定が必要                                                             | P2     |
| WF-08  | §11.3             | 開始手順 (§11.2 から §11.3 へ移動) は内容変更なし。catalog 先行 publish は実装済み                                                                         | P2     |
| WF-09  | §11.4             | 終了手順 (§11.3 から §11.4 へ移動)。`SUBSCRIBE_DONE` → `PUBLISH_DONE` と status code 0x2 の明記削除。実装は `PUBLISH_DONE` 済み。最終 catalog 更新は未実装 | P2     |
| WF-10  | §11.5             | Authorization (§11.4 から §11.5 へ移動)。SETUP / SUBSCRIBE / FETCH / REQUEST_UPDATE / PUBLISH / PUBLISH_NAMESPACE への付与は実装済み                       | P2     |
| WF-11  | §11.5.1 / §5.2.42 | URL fragment 由来のトークンで接続した場合、publisher の catalog に authInfo が載らない                                                                     | P1     |
| WF-12  | §5.4.2 / §11.5.1  | fragment パラメータから variables を作る経路が無く、`resolveCatalogVariables` は高レベル API から呼ばれない。`%c4m%` は未解決のまま                        | P1     |
| WF-13  | §13.5             | 置換後の catalog 全体の再検証が MUST。現行は initRef だけ。Connection URI への無条件置換は SHOULD NOT に反する                                             | P1     |
| WF-14  | §5.1.5 / §5.2.42  | draft-02 で track-level `token` field が廃止され authInfo に一本化された。実装は `PublishTrack.token` を残す                                               | P1     |
| WF-15  | §5.2.37 / §13.6   | `connectionUri` が MOQT endpoint URI として妥当か検証していない。publish endpoint のポリシーとレート制限も未実装                                           | P1     |
| WF-16  | §11.6             | wallclock は POSIX ms / UTC 由来。実装の時刻源は適合。NTP / PTP 同期はブラウザから強制できない                                                             | P2     |
| WF-17  | §14.1             | fragment type `msf` の登録内容は変更なし。実装は定数を持たず文字列で扱う                                                                                   | P2     |
| WF-18  | §11.1.3           | URL 例の更新 (`cat=`、query の `token=`)。実装の URL 分解は変更不要                                                                                        | P2     |
| WF-19  | §11.5.4           | 認可失敗時の再取得・exponential backoff は未実装 (SHOULD / MAY)                                                                                            | P2     |
| WF-20  | §11.5.1 / §5.2.42 | authInfo の scheme (`cat` / `privacy-pass` / custom) を選択・検証せず、同じ SETUP トークンを既定で使う                                                     | P2     |
| LOG-01 | §9.2              | track name は ASCII 10 進。現行実装は既に ASCII 10 進で変更不要 (MSF-01 の binary 1 バイトとは異なる)                                                      | P2     |
| LOG-02 | §9.2 / §5.2.2     | log の publishTracks namespace template が `-` / `.HH` 形式で、MSF-02 の `/` 区切り catalog namespace として不正                                           | P1     |
| LOG-03 | §9.3              | Group ID はマイクロ秒 62-bit、Object ID は同一マイクロ秒内の連番。実装は秒と秒内連番 (MOQLOG-04 §5.2)                                                      | P1     |
| LOG-04 | §9.1              | MSF-02 は JSON payload と `[MOQLOG] Section 4` を参照するが、MOQLOG-04 §4 は Resource ID、payload は §5.3 のバイナリ。実装は §5.3 準拠                     | P1     |
| LOG-05 | §9.4              | packaging `moqlog` + role `log` の MUST は実装済み。任意の connectionUri / authInfo も受理する。token は WF-14                                             | P2     |
| LOG-06 | §9.4              | publishTracks を生成・消費する高レベル API が無く、log track を配信する経路が無い                                                                          | P2     |
| MET-01 | §10.2             | track name は ASCII 10 進。現行実装は一致                                                                                                                  | P2     |
| MET-02 | §10.2 / §5.2.2    | metrics の publishTracks namespace template が `/` 区切りでなく、MSF-02 の catalog namespace として不正                                                    | P1     |
| MET-03 | §10.3             | MSF-02 の Object 0 / Object 1+ の記述は MOQMETRICS-03 §5.4 と矛盾。実装は §5.4 準拠                                                                        | P1     |
| MET-04 | §10.4             | packaging `moqmetrics` + role `metrics` の MUST は実装済み。token は WF-14                                                                                 | P2     |
| MET-05 | §10.2             | metrics の catalog track name `catalog` の helper は実装済み。MSF-02 に追加要求なし                                                                        | P2     |
| MET-06 | §10.4             | publishTracks を生成・消費する高レベル API が無く、metrics track を配信する経路が無い                                                                      | P2     |
| X-01   | §5.2.4            | packaging 値 `catalog` が `PackagingType` に無い (別担当の catalog 範囲)                                                                                   | P1     |
| X-02   | §5.1.1            | MSF_VERSION が `draft-01` のまま。draft-02 の catalog を encode できない (別担当の catalog 範囲)                                                           | P0     |
| X-03   | §12.1 / §14.3     | MSF_COMPRESSION の Property Type 0x78 が未実装 (別担当の properties 範囲)                                                                                  | P1     |

### 0.2 最重要 5 件

1. **WF-01 (`c4m` → `cat`)**: 予約パラメータ名の変更。`connect()` の URL 解釈、公開関数 `getC4mParameter`、`resolveMsfAuthorizationToken`、catalog の `%c4m%`、エラーメッセージ、devtools、テストがすべて影響する。既存の pre-authorized URL は strict に改名すると認可できなくなる。
2. **LOG-02 / MET-02 (namespace template の形式)**: MSF-02 §5.2.2 は catalog の namespace を `/` 区切りの 1 文字列と定義した。現行の `MOQLOG_NAMESPACE_TEMPLATE` / `MOQMETRICS_NAMESPACE_TEMPLATE` は `logs.2emoq.2earpa-v1-%resourceId%` の形で、`/` を含まないため 1 field の namespace として解釈される。catalog のワイヤ互換性が壊れる。
3. **WF-12 / WF-02 / WF-11 (fragment トークンの連鎖)**: fragment の `cat` を variables に変換する経路が無く、`resolveCatalogVariables` は高レベル API から呼ばれない。`%c4m%` → `%cat%` の変更だけでは認可は通らず、値の文字集合の緩和と publisher の authInfo 生成元の修正までが必要である。
4. **LOG-03 / LOG-04 / MET-03 (MSF-02 と companion draft の矛盾)**: MSF-02 §9.1 / §9.3 / §10.1 / §10.3 の本文は MOQLOG-04 / MOQMETRICS-03 と矛盾する。現行実装は companion draft に従っており、MSF-02 の文言どおりに直すと後退する。どちらを正とするかの判断が必要である。
5. **WF-03 / WF-04 (§11.2 の byte-exact 写像)**: 孤立サロゲート・NUL の拒否、strict UTF-8、raw バイト比較が未実装。catalog と MOQT の名前比較がテキスト比較になっており、MUST に反する。

## 1. 節番号・テーブル番号の対応 (引用更新の基礎)

MSF-02 は catalog の track field が 1 つ増えたため、§5.2.5 以降の節番号が 1 ずつ繰り下がっている。引用を更新するときは次の対応を使う。

| MSF-01                                   | MSF-02                                            | 備考                                |
| ---------------------------------------- | ------------------------------------------------- | ----------------------------------- |
| §5.2.2 Track namespace                   | §5.2.2                                            | 内容が「`/` 区切り」に明確化        |
| §5.2.3 Track name                        | §5.2.3                                            | 空文字の禁止が明記                  |
| §5.2.4 Packaging                         | §5.2.4                                            | `catalog` が追加                    |
| §5.2.5 Event timeline type               | §5.2.6                                            |                                     |
| §5.2.6 Track role                        | §5.2.7                                            |                                     |
| §5.2.7 Is Live                           | §5.2.8                                            |                                     |
| §5.2.8 Target latency                    | §5.2.9                                            |                                     |
| §5.2.9 Buffers                           | §5.2.10                                           |                                     |
| §5.2.10 Track label                      | §5.2.11                                           |                                     |
| §5.2.11 Render group                     | §5.2.12                                           |                                     |
| §5.2.12 Alternate group                  | §5.2.13                                           |                                     |
| §5.2.13 Initialization reference         | §5.2.14                                           |                                     |
| §5.2.14 Dependencies                     | §5.2.15                                           |                                     |
| §5.2.15 Template                         | §5.2.16                                           |                                     |
| §5.2.16 Temporal ID                      | §5.2.17                                           |                                     |
| §5.2.17 Spatial ID                       | §5.2.18                                           |                                     |
| §5.2.18 Codec                            | §5.2.19                                           |                                     |
| §5.2.19 Mimetype                         | §5.2.20                                           |                                     |
| §5.2.20 Framerate                        | §5.2.21                                           |                                     |
| §5.2.21 Timescale                        | §5.2.22                                           |                                     |
| §5.2.22 Maximum Bitrate                  | §5.2.23                                           |                                     |
| §5.2.23 Average Bitrate                  | §5.2.24                                           |                                     |
| §5.2.24 Maximum GOP Duration             | §5.2.25                                           |                                     |
| §5.2.25 Maximum Group Duration           | §5.2.26                                           |                                     |
| §5.2.26 Width                            | §5.2.27                                           |                                     |
| §5.2.27 Height                           | §5.2.28                                           |                                     |
| §5.2.28 Audio sample rate                | §5.2.29                                           |                                     |
| §5.2.29 Channel configuration            | §5.2.30                                           |                                     |
| §5.2.30 Display width                    | §5.2.31                                           |                                     |
| §5.2.31 Display height                   | §5.2.32                                           |                                     |
| §5.2.32 Language                         | §5.2.33                                           |                                     |
| §5.2.33 Parent name                      | §5.2.34                                           |                                     |
| §5.2.34 Parent namespace                 | §5.2.35                                           |                                     |
| §5.2.35 Track duration                   | §5.2.36                                           |                                     |
| §5.2.36 Connection URI                   | §5.2.37                                           |                                     |
| §5.2.37 Token                            | (廃止)                                            | authInfo に一本化 (A.1.3:5444-5446) |
| §5.2.38 Encryption scheme                | §5.2.38                                           |                                     |
| §5.2.39 Cipher suite                     | §5.2.39                                           |                                     |
| §5.2.40 Key ID                           | §5.2.40                                           |                                     |
| §5.2.41 Track Base Key                   | §5.2.41                                           |                                     |
| §5.2.42 Authorization Info               | §5.2.42                                           |                                     |
| §5.2.43 Token Delivery via URI           | §5.2.43                                           |                                     |
| §5.2.44 Accessibility                    | §5.2.44                                           |                                     |
| (なし)                                   | §5.2.45 Accessible Window Time                    | 新設                                |
| (なし)                                   | §5.2.46 Keyframe spacing                          | 新設                                |
| §6.1 / §6.2                              | §6.1 / §6.2                                       | 変更なし。§6.3 が新設               |
| §7.1〜§7.4                               | §7.1〜§7.4                                        | 変更なし                            |
| §8.1 Event Timeline data format          | §8.2                                              | §8.1 は header data に新設          |
| §8.2 Event Timeline Catalog requirements | §8.3                                              |                                     |
| §8.3 Event Timeline track updating       | §8.4                                              |                                     |
| §8.4 Event timeline examples             | §8.6                                              | §8.5 は well-known event types      |
| §11.1 / §11.1.1〜§11.1.3                 | §11.1 / §11.1.1〜§11.1.3                          | 番号は同じ。`c4m` → `cat`           |
| §11.2 Initiating a broadcast             | §11.3                                             |                                     |
| §11.3 Ending a live broadcast            | §11.4                                             | `PUBLISH_DONE`                      |
| §11.4 Authorization                      | §11.5                                             |                                     |
| §11.4.1〜§11.4.4                         | §11.5.1〜§11.5.4                                  |                                     |
| (なし)                                   | §11.2 Mapping catalog strings to MOQT byte values | 新設                                |
| (なし)                                   | §11.6 Wallclock time                              | 新設                                |
| §12.1 Compression Signaling              | §12.1                                             | §12.1.1 / §12.1.2 は同じ            |
| (なし)                                   | §12.2 Initialization properties                   | 新設                                |
| (なし)                                   | §12.3 Event Timeline Track properties             | 新設                                |
| §14.1 MOQT URI Fragment Types            | §14.1                                             | 登録内容は同じ                      |
| §14.2 MSF Event Timeline Types           | §14.2                                             | 初期値が空に変更                    |
| §14.3 MSF_COMPRESSION Track Property     | §14.3 MSF Property Type values                    | Property Type 0x78                  |
| §14.4 MSF_COMPRESSION Object Property    | §14.4 MSF Compression Algorithms                  | レジストリ化                        |

テーブル番号も変わる。本担当範囲で参照するものは次のとおり。

| 内容                         | MSF-01              | MSF-02   |
| ---------------------------- | ------------------- | -------- |
| root catalog fields          | Table 1 / Table 2   | Table 2  |
| track fields                 | Table 2 / Table 3   | Table 4  |
| packaging 値                 | Table 3 / Table 4   | Table 5  |
| role 値                      | Table 4 / Table 5   | Table 7  |
| encryption scheme            | Table 5             | Table 8  |
| cipher suite                 | Table 6             | Table 9  |
| authInfo scheme              | Table 7             | Table 10 |
| accessibility scheme         | Table 6 / Table 9   | Table 11 |
| reserved fragment parameters | Table 8 / Table 10  | Table 12 |
| MSF_COMPRESSION 値           | Table 11            | Table 14 |
| MOQT URI Fragment Types      | Table 12            | Table 15 |
| MSF Compression Algorithms   | Table 14 / Table 15 | Table 16 |

## 2. Workflow (§11) の差分

### 2.0 §11.1.1 予約 fragment パラメータの全体像

MSF-02 Table 12 (MSF-02:4095-4112) の予約 key は次の 5 つである。いずれも URL に「必ず入れる」ものではなく、出現した場合の意味が予約されている。key は case-sensitive (MSF-02:4095-4096)。

| key               | 意味 (MSF-02)                                               | 出現 | 文法                                                                                                                                          | 現行実装                                               | 判定                             |
| ----------------- | ----------------------------------------------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | -------------------------------- |
| `wallclock-range` | wallclock 時刻の範囲による subclip (MSF-02:4101、4115-4118) | 任意 | start と end を `-` で区切る。end と dash は省略可 (open range)。inclusive。単位は §11.6 の POSIX ms                                          | parse helper のみ (`src/msf/c4m.ts:36-40`)。適用先なし | 文法は一致。適用が未実装 (WF-05) |
| `mediatime-range` | media time の範囲による subclip (MSF-02:4103、4120-4123)    | 任意 | start と end を ms の `-` で区切る。end と dash は省略可。inclusive                                                                           | parse helper のみ (`src/msf/c4m.ts:42-51`)             | 文法は一致。適用が未実装 (WF-05) |
| `location-range`  | MOQT Location の範囲による subclip (MSF-02:4105、4125-4132) | 任意 | `Group.Object` を `.`、範囲を `-` で区切る。end Location / end Object ID は省略可。第 2 値を省略するときは `.` と `-` を MUST omit。inclusive | parse helper のみ (`src/msf/c4m.ts:53-72`)             | 文法は一致。適用が未実装 (WF-05) |
| `cat`             | Base64 でエンコードされた C4M token (MSF-02:4107、4134)     | 任意 | [C4M] の Base64                                                                                                                               | `c4m` のみ (`src/msf/c4m.ts:74-89`)                    | 未対応 (WF-01, P0)               |
| `connection`      | 接続種別の強制 (MSF-02:4109、4136-4140)                     | 任意 | `q` (Native QUIC MUST) または `wt` (WebTransport MUST)                                                                                        | 実装済み (`src/msf/fragment.ts:132-171`)               | 一致 (WF-06)                     |

補足:

- 範囲の区切りは `-` であり、カンマ区切りではない。複数範囲は同じ key を複数回書く (`wallclock-range=a-b&wallclock-range=c-d`)。同じ key の複数指定は union を MUST で処理する (MSF-02:4149-4151)。現行実装は配列で返すが、union を適用する消費者がいない (WF-05)。
- 文法は MSF-01 から変わっていない (MSF-01:3424-3466、union は MSF-01:3472-3474)。`wallclock-range` の説明に §11.6 への参照が追加された点だけが異なる。
- 実装の `getConnectionParameter` は最初の `connection` だけを見て、不正値なら `undefined` を返す (`src/msf/fragment.ts:132-142`)。複数の `connection` が矛盾する場合の扱いは仕様に無い。

### WF-01: 予約 fragment パラメータ `c4m` → `cat` (P0)

**仕様要件 (MSF-02)**

- 変更履歴: "The reserved fragment parameter "c4m" was renamed "cat"." (MSF-02:5530-5531)
- Table 12 の予約 key は `wallclock-range` / `mediatime-range` / `location-range` / `cat` / `connection` の 5 つ (MSF-02:4095-4112)
- `cat` の意味: "a base64 encoded token, as defined by [C4M]." (MSF-02:4134)
- 予約 key は case-sensitive (MSF-02:4095-4096)
- §11.5.2 の例も `&cat=eyJhbGciOiJFZERTQSJ9...` を使う (MSF-02:4507)

**MSF-01 での扱い**

- Table 10 の row は `c4m`、意味は "A base64 encoded C4M token" (MSF-01:3435-3436)
- `c4m` の説明は "a base64 encoded token, as defined by [C4M]" (MSF-01:3461)
- URL 例も `&c4m=` (MSF-01:3566-3575)

**現行実装**

- `getC4mParameter` は key が完全一致 `"c4m"` の最初の値を返す (`src/msf/c4m.ts:80-89`)
- `resolveMsfAuthorizationToken` は `getC4mParameter` の結果だけを見て SETUP 用トークンを作る (`src/msf/c4mAuthorization.ts:89-108`)
- 復号失敗時のエラーメッセージが `"msf fragment c4m must be a Base64 encoded C4M token (draft-ietf-moq-msf-01 Section 11.1.1)"` (`src/msf/c4mAuthorization.ts:102-107`)
- `connect()` は `options.authorizationToken ?? resolveMsfAuthorizationToken(fragment)` で fragment を読む (`src/connect.ts:66-77`)
- `catalogAuthInfoForSetupToken` は `{"cat": "%c4m%"}` を返す (`src/msf/authInfo.ts:23`、`:43-59`)。key の `cat` は認可 scheme 名、値の `%c4m%` は fragment の `c4m` を指す変数参照
- 公開 facade は `getC4mParameter` を再輸出する (`src/msf.ts:79-86`)
- テストは `c4m` を前提に固定している (`src/connect.test.ts:163-257`、`src/msf.test.ts:3208-3228`、`:3317-3441`)
- devtools も `c4m` を独立に解析する (`devtools/src/utils/c4m.ts:103-137`、`:197-225`)

**必要な変更**

1. fragment の予約 key 判定を `cat` に変える。`getC4mParameter` は `getCatParameter` に改名し、`cat` を返す。
2. `resolveMsfAuthorizationToken` は `cat` を読む。後方互換を採る場合は `cat` を優先し、`c4m` も受理する。両方ある場合は `cat` を優先する (予約 key としての意味が draft-02 で `cat` に移ったため)。
3. エラーメッセージを `cat` と MSF-02 §11.1.1 に更新する。
4. `catalogAuthInfoForSetupToken` の変数参照を `%cat%` にする。catalog の authInfo の scheme key は `cat` のまま (MSF-02 Table 10:1826-1842)。
5. 公開 API の互換性のため `getC4mParameter` を deprecated alias として残すか、メジャー変更として削除するかを決める。`src/msf.ts` の export と `docs/MSF.md:21` / `docs/LOW_LEVEL_API.md:95` を更新する。
6. devtools の `extractC4mBase64` / `maskC4mValue` も `cat` に対応する。UI 文言 (`devtools/src/components/ConnectionSettings.tsx:148`、`:161`、`:1038`) を更新する。

**互換性影響**

- 既存の `&c4m=` 付き URL は、strict に `cat` だけを受けると SETUP にトークンが載らなくなり、認可が必要な relay で接続が失敗する。pre-authorized playback link、ブラウザ履歴、ブックマーク、共有リンクが該当する。
- `%c4m%` を含む既存 catalog は、variables に `c4m` が無いと未定義変数として空文字になる (`src/msf/variables.ts:112-123`)。authInfo の値が `""` になり、視聴側のトークン解決が失敗する。
- 後方互換を採る場合のリスクは、draft-02 では `c4m` が予約外の通常 key になるため、アプリが独自の `c4m` パラメータを使っている URL を token と誤解する可能性である。誤解を避けるには、`cat` が無いときだけ `c4m` を読む。

**優先度**: P0。改名そのものは小さいが、URL と認可の互換性に直結する。

### WF-02: variable substitution の構文緩和 (P1)

**仕様要件 (MSF-02)**

- 変数名は case-sensitive。文字集合の制限は撤廃された (MSF-02:2031-2033、A.1.3:5459-5460)
- 変数値は "alphanumeric characters, hyphens, underscores, plus sign, forward slash, equals, period and the at sign (@)" のみ (MSF-02:2038-2044)
- fragment は `&` 区切りで key-value pair にし、各 pair を「最初の `=`」で分割する (MSF-02:2060-2063、A.1.3:5461)
- 写像 (§11.2) は置換後に適用する (MSF-02:2045-2046、A.1.3:5462)
- §13.5 は置換後の catalog 検証を MUST とする (MSF-02:4874-4877)

**MSF-01 での扱い**

- 変数名は "alphanumeric characters, hyphens, and underscores" のみ (MSF-01:1592-1594)
- 変数値は "alphanumeric characters, hyphens, underscores, and the at sign (@)" のみ (MSF-01:1600-1605)
- pair の分割は "using & as delimiter and = as separator" で、最初の `=` とは書かれていない (MSF-01:1625-1628)

**現行実装**

- `VARIABLE_NAME_PATTERN = /^[A-Za-z0-9_-]+$/` (`src/msf/variables.ts:21`)
- `VARIABLE_VALUE_PATTERN = /^[A-Za-z0-9_@-]*$/` (`src/msf/variables.ts:22`)
- `VARIABLE_REFERENCE_PATTERN = /%([A-Za-z0-9_-]+)%/g` (`src/msf/variables.ts:23`)
- 値の検証は `resolveCatalogVariables` の入口で行う (`src/msf/variables.ts:67-79`)
- fragment の pair 分割は `seg.indexOf("=")` で最初の `=` を使う (`src/msf/fragment.ts:107-122`)。こちらの半分は既に draft-02 と同じ
- `%` は置換後に残ると reject する (`src/msf/variables.ts:124-130`)

**必要な変更**

1. `VARIABLE_VALUE_PATTERN` に `+`、`/`、`=`、`.` を追加する。標準 Base64 の C4M トークン (`+`、`/`、`=` を含み得る) を `cat` から catalog へ代入できるようにするため、これは WF-01 と一体で対応する。
2. 変数名の制限を撤廃する。`%...%` の内側を `%` 以外の任意文字として扱う (`/%([^%]+)%/g` 相当)。ただし fragment の `param-name` は ABNF 上 `pchar-no-amp / "/"` であり、`%` は pct-encoded の一部として現れ得る点に注意する。
3. 変数名の case-sensitive 比較を維持する。
4. 置換後の `%` reject は維持する (§5.4.1 の MUST)。

**互換性影響**

- 受理範囲を広げるだけなので、既存の catalog / URL は壊れない。
- 変数名の制限撤廃により、`%a+b%` のような参照が可能になる。`%` を name の区切りに使う既存実装との相互運用は、両者が同じ規則を実装している限り問題ない。

**優先度**: P1。`cat` の Base64 を catalog に代入する用途に直結する。

### WF-03: §11.2.1 / §11.2.2 の string → byte 写像と検証 (P1)

**仕様要件 (MSF-02)**

- catalog の JSON 文字列を UTF-8 のバイト列に写像する (MSF-02:4291-4299)
- Unicode 正規化 (NFC / NFD / NFKC / NFKD)、case folding、その他の変換を適用しない (MSF-02:4301-4306)
- 孤立サロゲート (U+D800〜U+DFFF) を含む JSON 文字列を producer は出してはならず、consumer は catalog を invalid として扱う MUST (MSF-02:4317-4323)
- U+0000 (NUL) を naming field に出してはならない (MSF-02:4324-4328)
- catalog は UTF-8 で、先頭に BOM を置いてはならない (MSF-02:4330-4331)
- 名前の比較は写像後のバイト列の完全一致。locale-aware / case-insensitive / normalization-aware 比較は MUST NOT (MSF-02:4332-4343)
- §11.2 の対象 field は §5.2.2、§5.2.3、§5.2.15、§5.2.34、§5.2.35 (MSF-02:4282-4287)
- §5.2.3 は Track Name の空文字を MUST NOT とし、Full Track Name の一意性をバイト比較で判定する (MSF-02:1100-1114)
- §5.2.2 は namespace を `/` 区切りの 1 文字列とし、1〜32 field、各 field 非空を MUST とする (MSF-02:1046-1082)

**MSF-01 での扱い**

- 対応する節は無い。§11.1.2 は URL 上の表現だけを定め、catalog 文字列との関係は規定しない (MSF-01:3520-3542)
- §5.2.2 は namespace の文字列形式を定めず、単に「namespace の下」とだけ書く (MSF-01:822-829)
- §5.2.3 は Track Name の空文字を禁止しない (MSF-01:832-838)

**現行実装**

- `validateCatalogTrack` は `name` を「文字列であること」だけ検証し、空文字・サロゲート・NUL を見ない (`src/msf/catalogValidation.ts:366-372`)。namespace も `src/msf/catalogTrackValidation.ts:128-138` で型だけを検証する
- `validateCatalog` の `generatedAt` などの数値検証はあるが、命名 field の文字種検証は無い (`src/msf/catalogValidation.ts:86-149`)
- `decodeCatalogMessage` は `new TextDecoder()` (非 fatal) で JSON をデコードする (`src/msf/catalogCodec.ts:272-274`)。不正な UTF-8 は U+FFFD に置換されて JSON として受理され得る
- `encodeCatalog` は `JSON.stringify` → `TextEncoder` で UTF-8 にする (`src/msf/catalogCodec.ts:253-260`)。BOM は付けない
- `fullTrackName.ts` は孤立サロゲートを `TextEncoder` が U+FFFD に置換することをコメントで認めている (`src/fullTrackName.ts:46-48`、`:228-230`)
- catalog の空 Track Name は `validateCatalogTrack` で reject されない (テストにも無い)

**必要な変更**

1. §11.2 の対象 field (`name`、`namespace`、`depends`、`parentName`、`parentNamespace`) について、孤立サロゲートと U+0000 を reject する検証を `validateCatalogTrack` / `validateCloneCatalogTrack` に追加する。
2. catalog の Track Name が空文字なら reject する (§5.2.3 MUST)。
3. `namespace` を §5.2.2 に従って検証する。`/` で分割し、1〜32 field、各 field 非空、先頭・末尾・連続 `/` の禁止を確認する。これは X-01 (catalog 担当) と重なるが、§9.2 / §10.2 の namespace の前提でもある。
4. `decodeCatalogMessage` を `new TextDecoder("utf-8", { fatal: true })` に変え、不正な UTF-8 を拒否する。BOM は現状 `JSON.parse` が失敗するため実質拒否だが、明示的なテストを追加する。
5. `formatFullTrackName` / `fullTrackNameKey` は、孤立サロゲートを入力に受けた場合に U+FFFD へ置換して別名に衝突し得る。命名 field の検証を上流で行い、ここでは「検証済みの文字列のみ受ける」契約にするか、関数内でも reject する。

**互換性影響**

- これまで受理していた不正な catalog (空 name、空 namespace field、サロゲート、NUL、不正 UTF-8) が reject される。仕様の MUST に合わせる破壊的変更である。
- 正しい catalog には影響しない。

**優先度**: P1。

### WF-04: §11.2.3 raw MOQT バイトとの比較 (P1)

**仕様要件 (MSF-02)**

- MOQT の制御メッセージから得た名前を catalog と比較するときは、raw MOQT バイトを catalog 文字列の写像バイトと比較する MUST。MOQT バイトを UTF-8 にデコードしてテキストとして比較してはならない (MSF-02:4345-4356)
- UTF-8 として不正な名前は catalog のどの entry とも一致しない (MSF-02:4356-4358)
- MSF publisher は UTF-8 として妥当で §11.2 の制約を満たす名前だけを publish する MUST (MSF-02:4359-4371)

**MSF-01 での扱い**

- 対応する節は無い。

**現行実装**

- 受信 PUBLISH の Track Name を `new TextDecoder()` (非 fatal) で文字列化し、`fullTrackNameKey` で比較する (`src/session/incomingPublish.ts:644-647`、`:1273`)
- Publish Skipped の Track Name も同様 (`src/session/namespaceLoops.ts:1503`)
- `fullTrackNameKey` は UTF-16 の string を長さ付きで連結した比較キーであり、バイト列ではない (`src/fullTrackName.ts:35-44`)
- `publishedTracks` / `subscriber` / `fetcher` の比較も同じキーを使う (`src/session/publishedTracks.ts:139`、`src/subscriber.ts:441`、`src/fetcher.ts:185`)
- `trackNamespaceToStrings` も各 field を TextDecoder で文字列化している (呼び出しは `src/session/incomingPublish.ts:646`、`:1271`)

**必要な変更**

1. catalog と MOQT の名前を比較する経路では、raw バイト列 (`Uint8Array` の連結または長さ付きキー) で比較する。少なくとも `incomingPublish` の PUBLISH / PUBLISH_SKIPPED の名前照合はバイト比較にする。
2. 文字列化が必要な箇所 (ログ、UI 表示) は `TextDecoder("utf-8", { fatal: true })` を使い、不正 UTF-8 を「catalog と一致しない」として扱う。
3. `fullTrackNameKey` の doc に「catalog との比較には使わない」と明記するか、バイト版のキー関数を追加する。

**互換性影響**

- 不正 UTF-8 の Track Name を持つ PUBLISH は、これまで U+FFFD 置換で偶然一致することがあった。修正後は一致しなくなる。仕様の MUST に沿う。

**優先度**: P1。ただし影響範囲は session 内部の名前照合であり、高レベル API の通常経路 (catalog の name を subscribe に使う) では名前は文字列から生成されるため、実害は publishTracks / incoming PUBLISH の照合に限られる。

### WF-05: range パラメータの適用と union (P1)

**仕様要件 (MSF-02)**

- Table 12 の予約 key は 5 つ (MSF-02:4095-4112)
- `wallclock-range` は start と end を `-` で区切る。end と dash は省略可 (open range)。inclusive (MSF-02:4115-4118)
- `mediatime-range` は ms の start と end を `-` で区切る。end と dash は省略可。inclusive (MSF-02:4120-4123)
- `location-range` は Group ID と Object ID を `.` で区切り、範囲を `-` で区切る。end の Location は省略可、end の Object ID も省略可。第 2 値を省略するときは `.` と `-` を MUST omit (MSF-02:4125-4132)
- 同じ URL に同じパラメータの範囲が複数ある場合、client は union を処理する MUST (MSF-02:4149-4151)
- 例: `wallclock-range=1761759637565-1761759836189`、`mediatime-range=0-13421`、`location-range=34.0-2145.16`、`location-range=16.24`、`location-range=16-24` (MSF-02:4155-4174)

**MSF-01 での扱い**

- 予約 key と文法は同じ。`wallclock-range` の説明だけ「each expressed as milliseconds since Unix Epoch」と書き方が違う (MSF-01:3424-3466)
- union MUST も同じ (MSF-01:3472-3474)

**現行実装**

- `getWallclockRanges` / `getMediatimeRanges` / `getLocationRanges` が parse する (`src/msf/c4m.ts:36-72`、`:94-210`)
- 文法は `-` 区切り、`.` 区切りの Group.Object、open range に対応する (`src/msf/c4m.ts:113-210`)
- 同じ key の複数指定は配列で返す (`src/msf/c4m.ts:94-107`)
- 不正値は `undefined` としてスキップする (`src/msf/c4m.ts:110-142`、`:144-178`)
- **これらの helper は `src/msf.ts:79-86` で再輸出されるだけで、src 内のどこからも呼ばれていない** (`rg` の結果、利用は export とテストのみ)。`connect()` は `connection` と `c4m` だけを処理する (`src/connect.ts:66-77`)。高レベル publisher / subscriber は range を解釈しない

**必要な変更**

1. `location-range` を低レベル API の Location Filter に変換して SUBSCRIBE / FETCH に適用する。start と end の Group / Object の省略を、既存の `LocationFilter` の表現に写像する。
2. `wallclock-range` / `mediatime-range` は、catalog の media timeline (`template` の wallclock / mediaTime) を引いて Location に変換する必要がある。timeline を購読していない場合は適用不能であるため、少なくとも「未対応」を明示して黙殺しない (throw するか、警告を返す API にする)。
3. 複数範囲の union を処理する。`LocationFilter` が単一範囲しか表せない場合は、複数の SUBSCRIBE / FETCH に分けるか、サポートしない範囲を reject する。
4. 現状の「不正値を黙ってスキップ」は、タイポした range が無視されて全範囲が配信されるため危険である。仕様は不正値の扱いを定めていないが、安全側では reject する。

**互換性影響**

- range 付き URL の挙動が変わる (現在は無視、変更後は適用または reject)。利用者にとっては改善だが、挙動変更として CHANGES に記載が必要である。

**優先度**: P1。仕様の MUST (union の処理) を満たしていない。ただし現状も満たしていないため、draft-01 → draft-02 の回帰ではない。

### WF-06: `connection` パラメータ (P2、変更なし)

**仕様要件 (MSF-02)**

- `connection` は client に接続種別を強制する。値は `"q"` (Native QUIC MUST) または `"wt"` (WebTransport MUST) (MSF-02:4136-4140)
- 例: `connection=q`、`connection=wt` (MSF-02:4157-4158)

**MSF-01 での扱い**

- 同一 (MSF-01:3463-3466)

**現行実装**

- `getConnectionParameter` は最初の `connection` を見て `"q"` / `"wt"` 以外は `undefined` (`src/msf/fragment.ts:132-142`)
- `assertMsfConnectionSupported` は `q` を Native QUIC 未実装として throw し、`wt` / 欠如 / 不正値は許可する (`src/msf/fragment.ts:156-171`)
- `connect()` が WebTransport を作る前に呼ぶ (`src/connect.ts:66-70`)

**必要な変更**

- なし。仕様も実装も同じ。

**優先度**: P2 (コメントの節番号は §11.1.1 のままで良い)。

### WF-07: fragment ABNF の `pct-encoded` と `%3F` の曖昧さ (P2)

**仕様要件 (MSF-02)**

- `track-identifier = 1*( pchar-no-amp / "/" )` で、`pchar-no-amp` は `unreserved / pct-encoded / sub-delims-no-amp / ":" / "@"` (MSF-02:4038-4078)
- `?` は `%3F` に percent-encode する MUST (MSF-02:4048-4051)
- §11.1.2 は、`[A-Za-z0-9_]` 以外のバイトを `.` + 小文字 16 進 2 桁で表す MUST とする (MSF-02:4191-4208)

**MSF-01 での扱い**

- ABNF は同一 (MSF-01:3340-3380 付近)

**現行実装**

- `parseMsfFragmentValue` は `?` を含む入力を reject する (`src/msf/fragment.ts:56-59`)
- `parseFullTrackNameSegment` は `%` を literal として認めず、`.` + hex 以外の文字を reject する (`src/fullTrackName.ts:199-206`)。したがって `%3F` も reject される
- つまり「`?` は `%3F` にせよ」という仕様の指示に従った URL も、実装では parse できない

**必要な変更**

- 仕様の解釈を確定する必要がある。案 A: `track-identifier` を URI として percent-decode してから §11.1.2 の `.HH` 表現を parse する (二重エンコードの禁止が必要)。案 B: `pct-encoded` は ABNF の一般規則であり、MSF の namespace-name 文字列では使わないと解釈し、現行の reject を維持する。案 B を採るなら、仕様の `%3F` の記述との矛盾をコメントに残す。
- 現状は案 B に近いが、エラーメッセージが `?` だけを特別扱いしており、`%` 一般の reject と整合していない。

**優先度**: P2。draft-01 から変わっておらず、実運用の URL では `%` を使う例が無い。

### WF-08: 開始手順 (§11.2 → §11.3) (P2、機能変更なし)

**仕様要件 (MSF-02)**

- "An MSF publisher MUST publish a catalog track object before publishing any media track objects." (MSF-02:4412-4416)

**MSF-01 での扱い**

- 同一の MUST が §11.2 (MSF-01:3589-3592)

**現行実装**

- `createMediaPublisher` は catalog publisher を先に作り、`publishCatalog` の後に音声・映像を publish する (`src/createMediaPublisher.ts:1810-1900`)。テストも catalog 先行を固定している (`src/createMediaPublisher.test.ts:3445` 付近)
- 低レベル API では順序を強制しない (利用者の責務)。

**必要な変更**

- コメントの節番号を §11.3 に更新する (例: `src/createMediaPublisher.ts:1915`)。

**優先度**: P2。

### WF-09: 終了手順 (§11.3 → §11.4、`PUBLISH_DONE`) (P2)

**仕様要件 (MSF-02)**

- `PUBLISH_DONE` をすべての active track に送る (MSF-02:4436-4438)
- VOD 化する場合: 独立した (delta でない) catalog update で各 track の `isLive` を FALSE にし、`trackDuration` を追加する (MSF-02:4440-4443)
- 恒久終了する場合: 独立した catalog update で `isComplete` を TRUE にし、`tracks` を空にする (MSF-02:4445-4448)

**MSF-01 での扱い**

- `SUBSCRIBE_DONE` を status code 0x2 Track Ended で送る (MSF-01:3601-3603)
- 2 番目・3 番目の手順は同じ。ただし field の節番号が `isLive` §5.2.7 / `trackDuration` §5.2.35 (MSF-01:3604-3608)

**現行実装**

- メッセージは既に `PUBLISH_DONE` (draft-ietf-moq-transport-23 の名称) を使っており、`Publisher.done()` の既定 status は `TRACK_ENDED` (`src/publisher.ts:447-457`、`:1562`)
- `createMediaPublisher` の解放処理は catalog / 音声 / 映像の publisher に対して `done()` を呼ぶ (`src/createMediaPublisher.ts:2917-2945`)。これで「すべての active track に PUBLISH_DONE」を満たす
- library は終了時に complete catalog (`isComplete: true` + 空 tracks) を自動 publish しない。`createCompleteCatalog` は helper として存在する (`src/msf/tracks.ts:109-120`) が、`disposeAllResources` からは呼ばれない
- devtools は停止時に complete catalog を送る (`devtools/src/hooks/usePublisher.ts:2680-2705`)
- 2 番目の VOD 化手順に相当する helper は無い

**必要な変更**

1. メッセージ名と status code は変更不要。コメントと docs の `SUBSCRIBE_DONE` / §11.3 の引用を `PUBLISH_DONE` / §11.4 に更新する。
2. 高レベル publisher の `stop()` / `close()` で complete catalog を送るかどうかを決める。仕様の手順は「can deliver ... by taking the following steps」であり MUST ではないため、必須ではない。ただし「deterministic signal」を提供するなら、PUBLISH_DONE だけでなく catalog の `isComplete` も更新するのが望ましい。
3. VOD 化 (`isLive: false` + `trackDuration`) は現状未対応。必要なら API を追加する。

**互換性影響**

- メッセージ名の変更は無い。complete catalog を自動送信すると、catalog の final update が増える。購読側は `isComplete` を受けると以降の track 追加を拒否するため、`stop()` 後に同じ publisher を再 start する用途では注意が必要である。

**優先度**: P2。

### WF-10: Authorization (§11.4 → §11.5) の実装カバレッジ (P2)

**仕様要件 (MSF-02)**

- §11.5.1: 視聴側は catalog の `authInfo` を見て認可要否を判断する (MSF-02:4458-4483)
- §11.5.2: トークン取得は out of scope。接続 URI のパラメータでもよい (MSF-02:4485-4511)
- §11.5.3: SETUP または制御メッセージの AUTHORIZATION TOKEN で提示する。track に紐づくトークンは、AUTHORIZATION TOKEN を受け付けるその track に関係するすべての制御メッセージに MUST 付与する。end subscriber は SUBSCRIBE / SUBSCRIBE_NAMESPACE / FETCH / REQUEST_UPDATE、original publisher は PUBLISH / PUBLISH_NAMESPACE (MSF-02:4513-4539)
- §11.5.4: 認可失敗時の再取得・backoff など (SHOULD / MAY) (MSF-02:4541-4563)

**MSF-01 での扱い**

- `authInfo` / SETUP / 制御メッセージの要件は同一。節番号だけ §11.4.x (MSF-01:3614-3723)
- 例の URL は `&token=` (MSF-01:3667)、draft-02 は `&cat=` (MSF-02:4507)

**現行実装**

- SETUP: `connect()` が options か fragment からトークンを解決し、`session.initialize` に渡す (`src/connect.ts:66-77`、`:148-179`)
- SETUP トークンの保持: `Session.setupAuthorizationToken` (`src/session.ts:203-212`、`:794-802`)
- catalog の SUBSCRIBE / FETCH: `catalogAuthorizationToken()` が setup token を返し、両方に付与する (`src/mediaSubscriber/catalogSubscription.ts:147-157`、`:250`、`:313`)
- 音声 / 映像の SUBSCRIBE: `resolveAuthorizationToken(authInfo, getAuthorizationToken, setupAuthorizationToken)` が authInfo の有無を見て付与する (`src/mediaSubscriber/trackSubscriptions.ts:76-121`、`:251-255`)。SETUP トークンは `this.session?.setupAuthorizationToken` から渡す (`src/createMediaSubscriber.ts:2157-2163`、`:2210-2214`)
- REQUEST_UPDATE: `Subscriber.setAuthorizationToken` が保持し、`requestUpdate` で付与する (`src/subscriber.ts:188`、`:354`、`src/session/namespaces.ts:229`、`:347`)
- PUBLISH / PUBLISH_NAMESPACE: `setupAuthorizationTokenOptions()` を PUBLISH と PUBLISH_NAMESPACE の両方に渡す (`src/createMediaPublisher.ts:1574-1579`、`:1816`、`:1846`、`:1870`、`:1898`、`:1143`)
- 低レベル `Session.publish` / `subscribe` / `fetch` / `publishNamespace` は、呼び出し側が渡した `authorizationToken` をそのまま使う。setup token の自動付与はしない (例: `src/session/namespaces.ts:820-835`)
- SUBSCRIBE_NAMESPACE: 低レベル API は options の token を付与する (`src/session/namespaces.ts:211`)。高レベル subscriber は SUBSCRIBE_NAMESPACE を使わない
- §11.5.4 の再試行 / backoff は実装していない。`REQUEST_ERROR` は error コールバックで通知する

**判定**

- §11.5.3 の MUST は、高レベル API の経路では満たしている。低レベル API は「呼び出し側がトークンを渡す」契約であり、setup token の自動付与は高レベル API の役割である。
- SUBSCRIBE_NAMESPACE は low-level のみで、setup token の既定付与が無い。namespace 購読にトークンが紐づく場合、呼び出し側が明示しないと MUST を満たせない。P2 の改善候補である。
- §11.5.4 は SHOULD / MAY のため未実装でも違反ではない。P2。

**必要な変更**

- コメントと docs の §11.4.3 → §11.5.3 の更新。
- 必要なら `Session.subscribeNamespace` に setup token の既定付与を追加する (低レベル API の暗黙挙動を増やすため、慎重に判断する)。

**優先度**: P2。

### WF-11: URL fragment 由来トークン時の publisher catalog authInfo 欠落 (P1)

**仕様要件 (MSF-02)**

- `authInfo` は track の認可が必要なことを視聴側に示す (MSF-02:1820-1861)
- 視聴側は catalog の `authInfo` を見てトークンを得る (MSF-02:4458-4465)

**MSF-01 での扱い**

- 同じ。

**現行実装**

- `createCatalogTracks` は `catalogAuthInfoForSetupToken(this.options.authorizationToken)` で authInfo を決める (`src/createMediaPublisher.ts:2123`)
- ここで使う `this.options.authorizationToken` は `MediaPublisherOptions.authorizationToken` であり、`connect()` が fragment から解決したトークン (`session.setupAuthorizationToken`) ではない (`src/createMediaPublisher.ts:1628-1629`、`src/createMedia/connect.ts:57-81`)
- そのため、利用者が `options.authorizationToken` を指定せず URL の `c4m` (将来は `cat`) だけで接続した場合、SETUP と PUBLISH にはトークンが載るが、catalog の音声・映像 track には authInfo が載らない
- `MediaPublisherOptions.authorizationToken` の JSDoc は「省略した場合、MOQT URI の msf fragment の c4m を SETUP に載せ、同じトークンを catalog / 音声 / 映像の PUBLISH にも付与する」と書く (`src/codec/types.ts:320-329`)。catalog の authInfo については、この記述と実装が一致していない
- テストは options にトークンを渡す経路だけを固定している (`src/createMediaPublisher.test.ts:6798-6840`)。fragment 経由の authInfo を検証するテストは無い

**必要な変更**

- `createCatalogTracks` で、`this.options.authorizationToken ?? this.session?.setupAuthorizationToken` を使う。あるいは `buildCatalog()` の時点で session の setup token を参照する。
- fragment 経由のトークンで catalog に authInfo が載るテストを追加する。

**互換性影響**

- authInfo が増える方向の変更であり、既存の視聴側は「認可が必要」と解釈する。fragment トークンで接続している配信では、視聴側も同じトークンを提示できる必要がある。仕様の意図どおりである。

**優先度**: P1。認可付き配信の相互運用に影響する。

### WF-12: fragment → variables の連携不在 (P1)

**仕様要件 (MSF-02)**

- 変数は catalog 取得に使った URI の fragment から解決する (MSF-02:2048-2063)
- §5.2.43 は fragment parameter を catalog field に代入する例を示す (MSF-02:1863-1883)
- §11.5.1 は catalog の authInfo から認可要件を知るとする (MSF-02:4458-4465)
- A.1.7 は §11.1.2 が catalog 文字列との関係を明確にしたとする (MSF-02:5530-5531)

**MSF-01 での扱い**

- 同じ仕組みが §5.4.2 にある (MSF-01:1610-1628)。ただし「最初の `=` で分割」は明記されていない

**現行実装**

- `resolveCatalogVariables(catalog, variables)` は実装されている (`src/msf/variables.ts:63-105`)。置換後に initRef の参照切れだけを検証する (`src/msf/variables.ts:102-104`)
- **`resolveCatalogVariables` は `src/msf.ts:66` で再輸出されるだけで、src 内のどこからも呼ばれていない** (`rg` の結果)。`createMediaSubscriber` は catalog を decode してそのまま track 情報を取り出す (`src/createMediaSubscriber.ts:2432-2436` 付近)
- fragment の parameters (`ReadonlyArray<[string, string]>`) を `Record<string, string>` に変換する helper は無い (`src/msf/fragment.ts:20-31` の型だけ)
- `catalogAuthInfoForSetupToken` は `%c4m%` を書く (`src/msf/authInfo.ts:23`、`:58`)。視聴側は置換しないため、authInfo の値は `%c4m%` のまま残る。`resolveAuthorizationToken` は値を見ずに「authInfo が非空」だけでトークン要否を決めるため、moqt-js 同士では偶然動くが、他の実装や変数を使う catalog では解決できない

**必要な変更**

1. fragment parameters から variables を作る helper を追加する (例: `msfFragmentVariables(parameters): Record<string, string>`)。
2. catalog を受信したら `resolveCatalogVariables` を呼び、置換後の catalog を検証してから track 解決に使う。
3. `%c4m%` → `%cat%` に変更し、`cat` の値を variables に含める。両対応するなら `c4m` も variables に入れる。
4. `resolveCatalogVariables` の入力 `variables` の出所 (§11.5.2 の query は MUST NOT) を呼び出し側で保証する。

**互換性影響**

- catalog の `%name%` が初めて実際に解決される。未定義変数が空文字になる挙動 (`src/msf/variables.ts:112-123`) は、置換後の検証 (WF-13) と合わせて見直す必要がある。
- 既存の catalog で `%` を含む値があると、これまで素通りしていたものが reject され得る。仕様の MUST に沿う。

**優先度**: P1。認可 token の配布と personalized catalog の基盤であり、draft-02 の §11.2 / §11.5 と直結する。

### WF-13: 置換後の再検証 MUST と Connection URI 置換の SHOULD NOT (P1)

**仕様要件 (MSF-02)**

- Subscribers は置換後の catalog を検証する MUST。置換された名前・namespace に §11.2 を適用する (MSF-02:4874-4877)
- Connection URI のような network endpoint を決める field への変数置換は、URI の出所を明示的に信頼しない限り SHOULD NOT (MSF-02:4879-4884)
- 変数値の制限は構造注入を防ぐが、置換値は攻撃者が制御し得る (MSF-02:4858-4872)

**MSF-01 での扱い**

- Security Considerations が `ToDo` で、§13.5 に相当する規定は無い (MSF-01:3830-3834)

**現行実装**

- `resolveCatalogVariables` は置換後の `initRef` の参照切れだけを検証し、catalog 全体は再検証しない。意図はコメントに明記されている (`src/msf/variables.ts:49-58`)
- `connectionUri` も無条件に置換する (`src/msf/variables.ts:191-199`)
- `token` も置換する (`src/msf/variables.ts:200-206`)。draft-02 では token field 自体が廃止 (WF-14)

**必要な変更**

1. 置換後に `validateCatalog` 相当の検証を再実行する。少なくとも §11.2 の命名 field 検証 (WF-03) と、role / packaging の条件付き MUST を含める。
2. `connectionUri` への置換を既定で行わない。アプリが明示的に許可した場合だけ置換する (オプション引数)。
3. `token` の置換は field 廃止に伴い削除する。

**互換性影響**

- 置換後の catalog が厳格に検証されるため、これまで通っていた catalog が reject され得る。仕様の MUST に沿う。
- `connectionUri` の置換を止めると、template を使った publish endpoint の配布ができなくなる。必要なら明示 opt-in にする。

**優先度**: P1。

### WF-14: track-level `token` field の廃止 (P1)

**仕様要件 (MSF-02)**

- "The track-level token field was removed. Publish tracks now use authInfo." (A.1.3:5444-5446)
- §5.2.43 の例も `authInfo` を使う (MSF-02:1873-1881)
- §5.2.37 は Connection URI であり、token field は存在しない (MSF-02:1700-1713)
- §9.4 / §10.4 も publish authorization に §5.2.42 (`authInfo`) を挙げる (MSF-02:3871-3876、:3945-3950)

**MSF-01 での扱い**

- `token` は §5.2.37 の field で、publishTracks 専用 (MSF-01:1304-1311)。§9.4 / §10.4 も §5.2.37 を publish authorization に挙げる (MSF-01:3164-3167、:3250-3253)

**現行実装**

- `PublishTrack.token?: string` が残る (`src/msf/types.ts:229-240`)
- `validateCatalogTrack` は publishTracks で `token` を受理する (`src/msf/catalogValidation.ts:416-426`、`src/msf/catalogTrackValidation.ts:326-349`)
- `resolveCatalogVariables` は `token` を置換する (`src/msf/variables.ts:200-206`)
- catalog の encode で `token` が出力される (`src/msf/catalogCodec.ts:158-217` の serialize)
- テストが `token` の round-trip を固定している (`src/msf.test.ts:1253-1269`)
- 高レベル API は publishTracks を生成しないため、library が `token` を載せた catalog を送る経路は無い

**必要な変更**

1. `PublishTrack.token` を削除するか deprecated にする。draft-02 の catalog を送る場合は出力しない。
2. 代わりに `authInfo` を使う。publishTracks の authInfo は §5.2.42 の scheme 形式である。
3. `token` を含む既存 catalog を受信した場合の扱いを決める (未知 field として保持するか、reject するか)。draft-02 §5.2.42 は authInfo を使うが、`token` を明示的に禁止してはいない。後方互換のため受信は許容し、送信はしないのが妥当である。
4. テスト `src/msf.test.ts:1253-1269` を authInfo ベースに更新する。

**互換性影響**

- 既存の `token` を使うアプリは authInfo に移行する必要がある。API の破壊的変更である。
- catalog の wire から `token` が消えるため、draft-01 の購読者とは相互運用できなくなる (draft-02 の仕様変更)。

**優先度**: P1。catalog 担当と調整が必要である。

### WF-15: connectionUri の検証と §13.6 のポリシー (P1 / P2)

**仕様要件 (MSF-02)**

- Connection URI は "[MOQT], Section 6.1" の valid な MOQT endpoint URI でなければならない MUST (MSF-02:1700-1713)
- Subscribers は local application policy が許可する endpoint にだけ publish する SHOULD、policy を満たさない publish track は無視する SHOULD (MSF-02:4890-4906)
- log / metrics track への publish は rate-limit する SHOULD (MSF-02:4903-4906)
- log / metrics data は必要最小限にし、同意を得て、直接的な個人識別子を名前・payload に含めない SHOULD (MSF-02:4908-4911)

**MSF-01 での扱い**

- 対応する Security Considerations は無い (`ToDo`、MSF-01:3830-3834)

**現行実装**

- `connectionUri` は「文字列であること」だけ検証する (`src/msf/catalogTrackValidation.ts:326-349`)。`normalizeMoqtUri` は呼ばない
- 高レベル subscriber は publishTracks を消費しない。`createMediaSubscriber` は audio / video の track だけを扱う (`src/createMediaSubscriber.ts:2119-2220`)
- publishTracks を使った log / metrics の publish 経路は無い (LOG-06 / MET-06)
- rate-limit の仕組みも無い

**必要な変更**

1. `connectionUri` を `normalizeMoqtUri` で検証し、`moqt://` scheme と authority を持つことを確認する。`https://` は Connection URI としては不可 (MOQT endpoint URI ではない)。
2. publishTracks を将来サポートするときは、endpoint policy のフックと rate-limit を API に含める。
3. 現時点では「publishTracks を消費しない」ことで §13.6 のリスクを回避している。この方針を docs に明記する。

**互換性影響**

- 不正な `connectionUri` を含む catalog が reject される。仕様の MUST に沿う。ただし、これまで受理していた catalog が落ちるため、既存の devtools の自由入力に影響する可能性がある (devtools は `connectionUri` を生成するか未確認)。

**優先度**: P1 (MUST の検証)、P2 (policy / rate-limit)。

### WF-16: §11.6 Wallclock time (P2)

**仕様要件 (MSF-02)**

- wallclock は Unix epoch からの経過ミリ秒 (leap second を除く)。POSIX の "Seconds Since the Epoch" を ms に scale したもの。UTC 由来 (MSF-02:4564-4571)
- 時計は NTP または PTP で UTC に同期する SHOULD (MSF-02:4571-4574)

**MSF-01 での扱い**

- 対応する節は無い。`wallclock` の定義は各所に散在し、`targetLatency` の「符号化から表示までの wallclock の差」などは同じ ms だった

**現行実装**

- catalog の `generatedAt`: `createMediaPublisher.buildCatalog()` が `Date.now()` を渡す (`src/createMediaPublisher.ts:1952-1962`)。`Date.now()` は POSIX ms
- Group ID の初期値: `createInitialGroupId()` が `BigInt(Date.now())` を返す (`src/msf/tracks.ts:213-220`)
- 受信の到着時刻: `performance.timeOrigin + performance.now()` (Unix epoch ms) (`src/createMediaSubscriber.ts:2535`、`:2554`、`:2647`)
- LOC の壁時計 TIMESTAMP: `toUnixEpochMicroseconds()` が `performance.timeOrigin` を起点に換算する (`src/loc.ts:325-343`)、`WallClockMapper` も同じ (`src/mediaClock.ts:41-80`)
- event timeline の `T` / media timeline の wallclock は encode / decode するだけで、library は生成しない (`src/msf/timeline.ts:19-179`)

**判定**

- 時刻源は POSIX ms / UTC 由来の要件を満たす。`Date.now()` と `performance.timeOrigin` は UTC 由来である。
- `performance.timeOrigin + performance.now()` はページ読み込み時の原点に固定された単調時計であり、その後のシステム時計の変更 (NTP の step、手動変更) には追随しない。仕様の SHOULD (NTP / PTP 同期) はブラウザから保証できない。ドリフトや step がある環境では、到着時刻と wallclock の差がずれる。
- `catalog generatedAt` は catalog を組み立てた時刻で固定され、送り直しでも更新されない (`src/createMediaPublisher.ts:1952-1957` のコメント)。仕様は「この catalog instance を生成した時刻」であり、同じ instance を送り直すなら妥当である。

**必要な変更**

- コード変更は不要。`performance.timeOrigin` ベースの時刻が NTP step に追随しない制約を docs に書く。
- `wallclock-range` の値を `Number` で parse している (`src/msf/c4m.ts:121-141`)。整数 ms を想定するなら、指数表記や小数を reject するか、仕様の範囲を確認する。仕様は「milliseconds」とだけ書き、整数を明記しない。未確認とする。

**優先度**: P2。

### WF-17: §14.1 "MOQT URI Fragment Types" registry (P2)

**仕様要件 (MSF-02)**

- `msf` を "MOQT URI Fragment Types" registry に登録する。Description は "MOQT Streaming Format"、Specification は "This document" (MSF-02:4989-5000)

**MSF-01 での扱い**

- 同じ entry。参照する MOQT の節が "Sect 14.3" から "Section 16.3" に変わった (MSF-01:3838-3852)

**現行実装**

- `parseFragment` は type を汎用に受け付け、`type` が `"msf"` のときだけ MSF の解釈をする (`src/moqtUri.ts:56-79`、`src/msf/fragment.ts:156-171`、`src/connect.ts:66-77`)
- `msf` の文字列定数は無く、各所に literal がある (`src/msf/fragment.ts:162`、`src/connect.ts` は `assertMsfConnectionSupported` 経由)

**必要な変更**

- 機能変更は不要。必要なら `MSF_FRAGMENT_TYPE = "msf"` を定義して literal を減らす。P2。

**優先度**: P2。

### WF-18: §11.1.3 の URL 例 (P2)

**仕様要件 (MSF-02)**

- catalog track の例: `moqt://example.com/server/config?a=1&b=2#msf:customer-livestream-123--catalog` (MSF-02:4231-4240)
- `connection=q|wt` の例 (MSF-02:4242-4252)
- `location-range` の例 (MSF-02:4254-4257)
- `cat` の例 (MSF-02:4259-4266)
- query の `token=` と fragment の `cat=` を併用する例 (MSF-02:4268-4277)

**MSF-01 での扱い**

- 同じ例で `c4m` を使う (MSF-01:3546-3578)

**現行実装**

- `normalizeMoqtUri` は query を `https://` URL に残し、fragment を分離する (`src/moqtUri.ts:100-147`)
- `parseMsfFragmentValue` は `cat` / `c4m` を含む parameter をそのまま返す (`src/msf/fragment.ts:107-124`)
- query の `token` は server 向けであり、client は解釈しない (`src/moqtUri.ts` は query をそのまま渡す)

**必要な変更**

- WF-01 の `cat` 対応以外は不要。

**優先度**: P2。

### WF-19: 認可失敗時の再取得・backoff (P2)

**仕様要件 (MSF-02)**

- SUBSCRIBE / FETCH が invalid / expired な認可で拒否された場合、fresh token を取得して retry してもよい (MAY) (MSF-02:4546-4549)
- scope 不足で拒否された場合、同じ token で retry してはならない (SHOULD NOT) (MSF-02:4550-4552)
- 対話的アプリでは再認証を促してもよい (MAY) (MSF-02:4553-4555)
- 失敗した認可の retry には exponential backoff を実装する SHOULD (MSF-02:4556-4558)

**MSF-01 での扱い**

- 同じ (MSF-01:3703-3718)

**現行実装**

- `REQUEST_ERROR` は `Subscriber` / `Fetcher` の error コールバックで通知し、自動 retry はしない (`src/createMediaSubscriber.ts` の error 通知、`src/session/requests.ts` の REQUEST_ERROR 処理)
- `getAuthorizationToken` コールバックは購読開始時に 1 回だけ呼ばれ、購読中の token 更新や retry は行わない (`src/mediaSubscriber/trackSubscriptions.ts:93-121`)
- backoff の仕組みは無い

**必要な変更**

- SHOULD / MAY のため必須ではない。実装するなら、REQUEST_ERROR の status code を見て retry 可否を決め、exponential backoff と再認証フックを提供する。scope 不足 (同じ token での retry 禁止) の判定は scheme 依存であり、[C4M] / [PrivacyPassAuth] の error code を参照する必要がある。

**優先度**: P2。

### WF-20: authInfo の scheme 選択と検証 (P2)

**仕様要件 (MSF-02)**

- authInfo の key は authorization scheme identifier。定義済みは `privacy-pass` (PrivacyPassAuth) と `cat` (C4M)。custom scheme も使える (MSF-02:1820-1861)
- 視聴側は field に列挙された scheme の 1 つについて適切な credential を取得する (MSF-02:4458-4465)

**MSF-01 での扱い**

- 同じ。

**現行実装**

- `AuthInfo = Record<string, unknown>` (`src/msf/types.ts:52-58`)。key の検証は無い
- `resolveAuthorizationToken` は authInfo が非空ならトークンを要求するが、key (`cat` / `privacy-pass` / custom) を見ない (`src/mediaSubscriber/trackSubscriptions.ts:93-121`)
- `getAuthorizationToken` コールバックには authInfo 全体が渡るため、利用者は scheme を見て選択できる。コールバックが無い場合は SETUP トークンをそのまま使う
- `catalogAuthInfoForSetupToken` は CAT のときだけ `cat` scheme を書く (`src/msf/authInfo.ts:43-59`)

**判定**

- scheme ごとの適切な credential の選択は、コールバックを提供する利用者の責務になっている。既定の SETUP トークンは scheme を問わず使われるため、`privacy-pass` の track に CAT のトークンを送る可能性がある。ただし MSF-02 は「one of the schemes listed」とだけ書き、既定の選択規則を定めていない。
- custom scheme 名の Reverse DNS 規則 (§5.2.42) の検証は無い。catalog 検証の範囲 (X-01) と合わせて検討する。

**必要な変更**

- 既定のトークンを使う前に、`cat` scheme なら CAT token か、`privacy-pass` なら Privacy Pass token かを確認する仕組みを検討する。少なくともコールバックに scheme を明示する API を推奨する。
- 必須ではない。

**優先度**: P2。

### X-01 〜 X-03: 範囲外だが関連する差分

本担当範囲の外だが、§9 / §10 / §11 の前提に影響するため記録する。

| ID   | 内容                                           | 根拠                                                                                                                                                           | 現行実装                                                                                                                                 | 優先度               |
| ---- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| X-01 | packaging 値 `catalog` が無い                  | MSF-02 Table 5 は `catalog` を含む (MSF-02:1125-1148)。A.1.3 も catalog が他の catalog を参照できるとする (MSF-02:5421-5425)                                   | `PackagingType = "loc" \| "mediatimeline" \| "eventtimeline" \| "moqlog" \| "moqmetrics"` (`src/msf/version.ts:39-44`)                   | P1 (catalog 担当)    |
| X-02 | catalog version が `draft-01` のまま           | MSF-02 の例は `draft-02` を使う (MSF-02:5360-5362)。§5.1.1 は `draft-XX` の規約を定める                                                                        | `MSF_VERSION = "draft-01"`、`MSF_KNOWN_VERSIONS = {"draft-01", "1"}` (`src/msf/version.ts:22-33`)。テスト fixture も 161 行が `draft-01` | P0 (catalog 担当)    |
| X-03 | MSF_COMPRESSION の Property Type 0x78 が未実装 | MSF-02 §12.1.1 / §12.1.2 / §14.3 は Track / Object property type 0x78 を割り当てる (MSF-02:4627-4629、:4661-4663、:5065-5082)。A.1.8 も同じ (MSF-02:5536-5539) | `MsfCompressionAlgorithm` の値だけあり、Property ID と encode/decode は未実装 (`src/properties.ts:24-44`)                                | P1 (properties 担当) |

X-01 と X-02 は catalog の decode / encode に直接影響する。X-03 は §12 の担当範囲だが、catalog / timeline の圧縮シグナリングと、draft-02 §9 / §10 の track には影響しない (log / metrics の payload 圧縮は規定されていない)。

## 3. Log track (§9) の差分

### LOG-01: track name の ASCII 10 進化 (P2、実装変更なし)

**仕様要件 (MSF-02)**

- Track Name は log priority level の ASCII 10 進表現 (例: Informational は `"6"`)。§11.2 に従ってバイトに写像する。level は 0 (Emergency) 〜 7 (Debug) (MSF-02:3833-3841)
- A.1.6 も「Track names are the ASCII decimal priority or granularity level (previously a single binary byte)」と明記する (MSF-02:5509-5515)

**MSF-01 での扱い**

- Track Name は "a single byte containing the log priority level in binary" (MSF-01:3130-3132)
- namespace は `(moq://moq-syslog.arpa/logs-v1/),(resourceID)` の固定形 (MSF-01:3126-3129)

**現行実装**

- `observabilityTrackName` は `0x30 + level` の 1 バイト、つまり ASCII 数字を返す (`src/observability.ts:38-53`)
- `logTrackName` はその wrapper (`src/moqlog.ts:365-375`)
- テストは ASCII 数字 1 バイトを固定している (`src/moqlog.test.ts:460-469`、`src/moqlog.prop.ts:35-44`)
- 実装は log-04 §5.1 (Track Name は single ASCII digit) に従っており、MSF-02 の記述と一致する

**必要な変更**

- なし。MSF-01 の "binary" 記述とは既に異なるが、MSF-02 で ASCII 10 進が明記されたため、実装は正しい。コメントの「draft-ietf-moq-msf-01 §9」を -02 に更新する。
- 注意: MSF-01 準拠を名乗る実装との相互運用では、0x06 と 0x36 が衝突する。本リポジトリは既に 0x36 を送るため、MSF-01 の実装とは元から非互換である。MSF-02 への追従で新たに壊れるものではない。

**優先度**: P2 (ドキュメントのみ)。

### LOG-02: namespace は catalog の §5.2.2 field から導出。template が `/` 区切りでない (P1)

**仕様要件 (MSF-02)**

- Log track の namespace は catalog の §5.2.2 field で定義され、§11.2 に従ってバイトに変換する (MSF-02:3833-3837)
- §5.2.2: namespace は `/` を区切りとする 1 つの JSON 文字列。`/` で分割した substring が Track Namespace Field に対応する。1〜32 field、各 field 非空 (MSF-02:1046-1082)
- A.1.6: "Namespaces are now taken from the catalog namespace field via the standard name mapping." (MSF-02:5509-5513)

**MSF-01 での扱い**

- `[MOQLOG] Section 3` の形式に従い、`(moq://moq-syslog.arpa/logs-v1/),(resourceID)` の固定形を MUST としていた (MSF-01:3121-3132)
- catalog の `namespace` の文字列形式自体は規定されていなかった (MSF-01:822-829)

**現行実装**

- `MOQLOG_NAMESPACE_PREFIX = ["logs.moq.arpa", "v1"]` (`src/moqlog.ts:337-342`)
- `logTrackNamespace(resourceId)` は 3 field の tuple を返す (`src/moqlog.ts:344-354`)。これは MOQT の Track Namespace tuple としては正しい
- `MOQLOG_NAMESPACE_TEMPLATE = "logs.2emoq.2earpa-v1-%resourceId%"` (`src/moqlog.ts:356-362`、`src/observability.ts:111-126`)。これは MOQT §8.8 の serialization 形式であり、`/` を含まない
- `moqlog.test.ts` はこの template を publishTracks の namespace として使い、`resolveCatalogVariables` で `%resourceId%` を置換して 3 field に展開できることを固定している (`src/moqlog.test.ts:412-459`)
- `resolveCatalogVariables` は namespace 文字列を置換するだけで、`/` 分割はしない (`src/msf/variables.ts:142-165` の stringFields に `namespace` を含む)
- catalog の namespace を検証する処理は無い (WF-03)

**判定**

MSF-02 の catalog では、`namespace` は `/` で field を区切る。`logs.2emoq.2earpa-v1-%resourceId%` は `/` を含まないため、1 field の Track Namespace として解釈される。これは log-04 §6 が「§8.8 の形式で書く」としているのとは異なる。MSF-02 §9.2 は catalog の §5.2.2 を正とするため、MSF の catalog としては次の形が正しい。

```
"namespace": "logs.moq.arpa/v1/%resourceId%"
```

つまり、3 field の tuple を catalog の namespace 文字列にするには、`formatTrackNamespace` (MOQT §8.8) ではなく、field を `/` で連結する必要がある。

**必要な変更**

1. `MOQLOG_NAMESPACE_TEMPLATE` を `"logs.moq.arpa/v1/%resourceId%"` に変更する。
2. `observabilityNamespaceTemplate` の doc と実装を、catalog 用の `/` 区切りに合わせる (`src/observability.ts:111-126`)。MOQT の serialization (§8.8) が必要なのはログ表示や URL fragment であり、catalog の namespace ではない。
3. `moqlog.test.ts` の template テストを `/` 区切りに更新する。
4. log-04 §6 の「§8.8 で書く」という記述との矛盾をコメントに残す。MSF-02 の catalog が優先である。
5. draft-02 の catalog 例は `"moq-syslog.arpa/logs-v1/%resourceId%"` という古い prefix を使っている (MSF-02:3225-3229)。これは log-04 §5.1 の `logs.moq.arpa/v1` と矛盾する。実装は log-04 §5.1 の prefix を維持し、区切りだけ `/` にするのが妥当である。

**互換性影響**

- 既存の catalog は `namespace: "logs.2emoq.2earpa-v1-<resourceId>"` を 1 field の namespace として宣言していたことになる。MSF-01 の実装 (namespace の文字列形式を規定しない) では 3 field と解釈する実装もあり得たため、相互運用は元から曖昧だった。
- MSF-02 に追従すると、catalog の namespace 文字列が変わる。これは catalog のワイヤ互換性を壊す変更である。

**優先度**: P1。

### LOG-03: Group ID / Object ID が MSF-02 §9.3 と一致しない (P1)

**仕様要件 (MSF-02)**

- Group ID は log entry の capture 時刻を「Unix epoch からのマイクロ秒を 62-bit のバイナリ整数に truncate したもの」とする (MSF-02:3843-3849)
- Object ID は同一マイクロ秒に複数の log が無ければ 0。複数ある場合は increment する (MSF-02:3851-3853)

**MSF-01 での扱い**

- §9.3 は MSF-02 と同一 (MSF-01:3141-3151)。draft-01 → draft-02 で変更されていない

**現行実装**

- `logGroupId(timestampMicros)` は `timestampMicros / 1_000_000n` を返す。つまり **秒** である (`src/moqlog.ts:277-301`)
- `logObjectId(sequenceInSecond)` は秒内の 0 始まり連番を返す (`src/moqlog.ts:303-318`)
- End of Group は「最終 log の次の Object ID」で、Group 内の連番の続きである (`src/moqlog.ts:300-332`、`src/observabilityGap.ts`)
- コメントで「msf-01 §9.3 はマイクロ秒 62-bit の Group ID を MSF 自身が定義しているが、本モジュールは log-04 §5.2 に従う」と明記している (`src/moqlog.ts:9-14`)
- テストは秒 / 秒内連番を固定している (`src/moqlog.test.ts:301-399`)

**判定**

MSF-02 §9.3 の明文と実装は一致しない。実装は MOQLOG-04 §5.2 (Group ID は Unix epoch 秒、Object ID は秒内の連番) に従っている。MSF-02 は payload を [MOQLOG] に委ねているが、Group ID / Object ID は MSF 自身の §9.3 で定義しており、companion draft と矛盾する。

**選択肢**

- 案 A (現状維持): MOQLOG-04 §5.2 を正とする。MSF-02 §9.3 の文言は古いものとして、仕様作者に修正を求める。既存のログ購読者・End of Group・Prior Group ID Gap の実装とテストは変更不要。
- 案 B (MSF-02 に合わせる): `logGroupId` をマイクロ秒に変更し、62-bit の上限チェックを追加する。`logObjectId` は「同一マイクロ秒内の連番」に変更する。End of Group の意味と Prior Group ID Gap の計算も変わる。既存の log track のワイヤ互換性は壊れる。
- 案 A を採る場合でも、ms と µs の取り違えを防ぐため、関数名と doc に「MOQLOG-04 の秒」であることを明記する。

**互換性影響**

- 案 B は既存の log track の Location filter、Prior Group ID Gap、End of Group の前提を壊す。MSF-01 の購読者とも相互運用できなくなる。
- 案 A は MSF-02 の §9.3 を読んだ実装との相互運用ができない。

**優先度**: P1 (仕様判断が必要)。draft-01 から変わっていないため、draft-02 追従のための回帰ではない。

### LOG-04: payload の JSON 記述と [MOQLOG] 参照の矛盾 (P1)

**仕様要件 (MSF-02)**

- Log track の payload は [MOQLOG] で定義される。各 MOQT Object は 1 つの JSON log entry を含む。severity、timestamp、hostname、application name、process ID、message ID、message などの optional field を持つ (MSF-02:3821-3831)
- "Implementations MUST follow the object payload format specified in [MOQLOG], Section 4." (MSF-02:3830-3831)
- 参照する [MOQLOG] は draft-jennings-moq-log-04 (2026-11-02) (MSF-02:5168-5172)
- A.1.6 は payload 形式の変更を挙げていない (names / track name / authInfo のみ) (MSF-02:5509-5515)

**MSF-01 での扱い**

- §9.1 は同じ文言で、[MOQLOG] は draft-jennings-moq-log-03 (2025-10-20) を参照する (MSF-01:3111-3118、参照は MSF-01:3990-3996)
- log-03 §4 は JSON 形式だったため、MSF-01 の「JSON」と「Section 4」は当時は整合していた

**現行実装**

- `src/moqlog.ts` は log-04 §5.3 のバイナリ Log Record を encode / decode する (`src/moqlog.ts:141-267`)
- payload の field は Timestamp Offset / Facility / 長さ付き ASCII 4 field / 長さ付き UTF-8 message / 属性数 / 属性 (key-value) である (`src/moqlog.ts:166-185`)
- コメントで「msf-01 §9.1 は旧 log-03 §4 の JSON 形式を参照している。本モジュールは log-04 §5.3 のバイナリ Log Record に従う」と明記している (`src/moqlog.ts:5-18`)
- テストはバイナリの固定ワイヤを検証する (`src/moqlog.test.ts:58-282`)

**判定**

MOQLOG-04 の §4 は "Resource ID" であり、payload の節ではない (refs/moq/draft-jennings-moq-log-04.txt:229-243)。payload は §5.3 のバイナリ Log Record である (同:359-422)。MSF-02 の「JSON」および「Section 4」は、[MOQLOG] を log-04 に更新した際に追従されなかった古い記述である。MSF-02 の MUST を文字どおり実装すると、[MOQLOG] §5.3 のバイナリと矛盾する JSON を送ることになり、log-04 準拠の購読者と相互運用できない。

**必要な変更**

- 実装は現状維持 (log-04 §5.3 のバイナリ)。MSF-02 の文言の修正を仕様作者に求める。
- どうしても MSF-02 の文言に合わせる必要があるなら、JSON payload の encode / decode を追加し、packaging `moqlog` の catalog でどちらを使うかを交渉する必要がある。現実的ではない。
- docs / コメントに、MSF-02 §9.1 の「JSON」「Section 4」が log-04 と矛盾していることを明記する。

**優先度**: P1 (仕様判断が必要)。実装は既に companion draft に追従している。

### LOG-05: §9.4 catalog requirements (P2)

**仕様要件 (MSF-02)**

- publishTracks に packaging が `moqlog` の track を MUST で宣言する (MSF-02:3855-3877)
- role が `log` の track を MUST とする (MSF-02:3860-3873、§5.2.7 Table 7)
- logs を別 endpoint に publish する場合は §5.2.37 (Connection URI) を MAY で含む (MSF-02:3871-3872)
- publish authorization には §5.2.42 (`authInfo`) を MAY で含む (MSF-02:3874-3875)

**MSF-01 での扱い**

- 同じ構造だが、role の節が §5.2.6、connection の節が §5.2.36、authorization が §5.2.37 (token) (MSF-01:3153-3167)

**現行実装**

- `catalogTrackValidation` は packaging が `moqlog` のとき role が `log` であることを検証する (`src/msf/catalogTrackValidation.ts:483-490`)
- publishTracks では `connectionUri` と `authInfo` を受理する (`src/msf/catalogTrackValidation.ts:326-349`、`src/msf/catalogValidation.ts:416-426`)
- role `log` は `RESERVED_TRACK_ROLES` に含まれる (`src/msf/version.ts:61-72`)
- テストは role 欠落 / role 違いを reject する (`src/msf.test.ts:1274-1307`、`:315-347`、`:1821-1842`)
- `token` も受理する (WF-14)

**必要な変更**

- role の MUST は実装済み。`token` の扱いを WF-14 に合わせる。
- §9.4 が参照する節番号 (§5.2.4 / §5.2.7 / §5.2.37 / §5.2.42) は draft-02 でも同じである。コメントの「§5.2.6」等を更新する。

**優先度**: P2。

### LOG-06: publishTracks を生成・消費する高レベル API が無い (P2)

**仕様要件 (MSF-02)**

- Log track は catalog の publishTracks に宣言する (MSF-02:3855-3859)
- log track の payload / Group / Object は §9.1〜§9.3 (MSF-02:3821-3853)

**現行実装**

- `MOQLOG` namespace として payload helper を公開する (`src/index.ts:166-170`)。`encodeLogRecord` / `decodeLogRecord` / `logGroupId` / `logObjectId` / `logTrackNamespace` / `logTrackName` / `MOQLOG_NAMESPACE_TEMPLATE` など (`src/moqlog.ts:141-375`)
- 高レベル `createMediaPublisher` は audio / video / catalog の track だけを publish し、publishTracks を生成しない (`src/createMediaPublisher.ts:2107-2220` の `createCatalogTracks`)
- 高レベル `createMediaSubscriber` は publishTracks を読まず、log / metrics の track を publish しない (`src/createMediaSubscriber.ts:2119-2220` は audio / video のみ)

**必要な変更**

- 仕様追従の必須要件ではない (実装範囲の問題)。ただし §9.4 / §10.4 の catalog requirements を満たす track を配信するには、利用者が手動で catalog と publisher を組む必要がある。API を提供するなら、publishTracks の生成、connectionUri の尊重、authInfo の提示、rate-limit を含める。
- 当面は docs に「log / metrics の publishTracks は payload helper のみで、高レベル API は未対応」と明記する。

**優先度**: P2。

## 4. Metrics track (§10) の差分

### MET-01: track name の ASCII 10 進化 (P2、実装変更なし)

**仕様要件 (MSF-02)**

- Track Name は granularity level の ASCII 10 進表現。0 (Emergency) 〜 7 (Debug) (MSF-02:3898-3907)
- A.1.6 も同じ (MSF-02:5509-5515)

**MSF-01 での扱い**

- Track Name は `(<granularity-level>)` の single tuple で、明確なバイト規則は無かった (MSF-01:3202-3210)

**現行実装**

- `metricsTrackName` は ASCII 数字 1 バイトを返す (`src/moqmetrics.ts:745-756`、`src/observability.ts:48-53`)
- テストは ASCII 数字を固定する (`src/moqmetrics.test.ts:622-631`、`src/moqmetrics.prop.ts:131-140`)
- 実装は metrics-03 §5.2 に従っており、MSF-02 と一致する

**必要な変更**

- なし。コメントの節番号を更新する。

**優先度**: P2。

### MET-02: namespace template が `/` 区切りでない (P1)

**仕様要件 (MSF-02)**

- Metrics track の namespace は catalog の §5.2.2 field で定義され、§11.2 に従ってバイトに変換する (MSF-02:3898-3902)
- §5.2.2 の `/` 区切り、1〜32 field、各 field 非空 (MSF-02:1046-1082)

**MSF-01 での扱い**

- `[MOQMETRICS] Section 3` の形式に従い、`(moq://metrics.moq.arpa/v1/),(resourceID)` の固定形 (MSF-01:3197-3204)

**現行実装**

- `MOQMETRICS_NAMESPACE_PREFIX = ["metrics.moq.arpa", "v1"]` (`src/moqmetrics.ts:716-721`)
- `metricsTrackNamespace(resourceId)` は 3 field の tuple (`src/moqmetrics.ts:723-733`)
- `MOQMETRICS_NAMESPACE_TEMPLATE = "metrics.2emoq.2earpa-v1-%resourceId%"` (`src/moqmetrics.ts:735-743`)。`/` を含まないため、MSF-02 の catalog では 1 field の namespace になる
- テストは template を publishTracks の namespace として固定している (`src/moqmetrics.test.ts:585-621`)

**必要な変更**

- LOG-02 と同じ。template を `"metrics.moq.arpa/v1/%resourceId%"` にする。
- draft-02 の catalog 例は `"metrics.moq.arpa/metrics-v1/%resourceId%"` であり、metrics-03 §5.1 の `metrics.moq.arpa/v1` と矛盾する (MSF-02:3213-3219)。実装は metrics-03 §5.1 の prefix を維持し、区切りだけ `/` にする。

**互換性影響**

- LOG-02 と同じ。catalog の wire 互換性が壊れる。

**優先度**: P1。

### MET-03: Object 0 / Object 1+ の記述が MOQMETRICS-03 §5.4 と矛盾 (P1)

**仕様要件 (MSF-02)**

- Group ID は capture 時刻の Unix epoch ミリ秒 (MSF-02:3909-3916)
- Object ID 0 は「Unix epoch のナノ秒の capture timestamp」と optional attributes を持つ (MSF-02:3925-3928)
- Object ID 1 以上は各 metric を name-value pair として持つ (MSF-02:3930-3932)
- payload は [MOQMETRICS] の object payload format に従う MUST。参照は [MOQMETRICS], Section 3 (MSF-02:3886-3896)
- 参照する [MOQMETRICS] は draft-jennings-moq-metrics-03 (2026-11-02) (MSF-02:5174-5180)

**MSF-01 での扱い**

- §10.3 は MSF-02 と同じ (MSF-01:3212-3228)。[MOQMETRICS] は metrics-02 を参照していた (MSF-01:4000-4010)

**現行実装**

- `MetricsCaptureInfo` は `timestampOffset` (Group の ms に足すナノ秒、0〜10^6-1) と `catalogVersion` (catalog の Group ID) を持つ (`src/moqmetrics.ts:80-95`)
- `encodeMetricsCaptureInfo` / `decodeMetricsCaptureInfo` はこの 2 field を vi64 で encode / decode する (`src/moqmetrics.ts:417-475`)
- data Object N (N>0) は catalog の Object N の `MetricDescription` に従う `MetricValue` で、name は payload に含まない (`src/moqmetrics.ts:97-103`、`:477-589`)
- catalog は metrics-03 §5.3 の Header / Metric Description を持つ (`src/moqmetrics.ts:105-380`)
- テストは Capture Info と Metric Value のバイナリを固定する (`src/moqmetrics.test.ts:338-540`)
- コメントで「msf-01 §10.1 が参照する旧版の JSON 形式と §10.3 の Object 0 の timestamp / attributes は旧契約であり、本実装とは一致しない」と明記する (`src/moqmetrics.ts:5-8`)

**判定**

MOQMETRICS-03 §5.4 の Object 0 は Capture Info (Timestamp Offset + Catalog Version) であり、attributes は catalog の Header にある。Object N (N>0) は catalog の Object N で説明される Metric Value であり、name は payload に含まない (refs/moq/draft-jennings-moq-metrics-03.txt:517-594)。MSF-02 §10.3 の「Unix epoch ナノ秒の timestamp + attributes」「name-value pair」は metrics-02 の古い契約である。MSF-02 は [MOQMETRICS] を -03 に更新しながら、§10.3 の本文を更新していない。

**必要な変更**

- 実装は現状維持 (metrics-03 §5.4)。MSF-02 §10.3 の文言の修正を仕様作者に求める。
- MSF-02 の §10.1 の "Section 3" も metrics-03 §3 (Architecture Overview) を指しており、payload の節ではない。§5.4 を指すべきである。
- docs に矛盾を明記する。

**優先度**: P1 (仕様判断が必要)。

### MET-04: §10.4 catalog requirements (P2)

**仕様要件 (MSF-02)**

- publishTracks に packaging が `moqmetrics` の track を MUST で宣言する (MSF-02:3935-3950)
- role が `metrics` の track を MUST とする (MSF-02:3940-3945)
- connection は §5.2.37、authorization は §5.2.42 (MSF-02:3946-3949)

**MSF-01 での扱い**

- role の節が §5.2.6、connection が §5.2.36、authorization が §5.2.37 (token) (MSF-01:3231-3253)

**現行実装**

- `catalogTrackValidation` は packaging が `moqmetrics` のとき role が `metrics` であることを検証する (`src/msf/catalogTrackValidation.ts:491-499`)
- テストは role 欠落 / role 違いを reject する (`src/msf.test.ts:1309-1341`、`:315-347`、`:1843-1863`)
- connectionUri / authInfo を publishTracks で受理する (`src/msf/catalogTrackValidation.ts:326-349`)
- `token` も受理する (WF-14)

**必要な変更**

- role の MUST は実装済み。`token` の扱いを WF-14 に合わせる。

**優先度**: P2。

### MET-05: metrics catalog track name の helper (P2)

**仕様要件 (MSF-02)**

- MSF-02 §10 は metrics の catalog track 自体を定義しない。MOQMETRICS-03 §5.1 / §5.3 が `catalog` という Track Name の catalog track を定義する (refs/moq/draft-jennings-moq-metrics-03.txt:310-383)
- MSF-02 §10.4 の publishTracks は data track の宣言であり、catalog track は同じ namespace に別途 publish する (metrics-03 §6)

**現行実装**

- `metricsCatalogTrackName()` が ASCII `"catalog"` を返す (`src/moqmetrics.ts:758-765`)
- `CATALOG_TRACK_NAME` は `"catalog"` (`src/msf/version.ts:35-36`)

**必要な変更**

- なし。MSF-02 の範囲外だが、metrics-03 に整合している。

**優先度**: P2。

### MET-06: publishTracks を生成・消費する高レベル API が無い (P2)

- LOG-06 と同じ。metrics の payload helper は `MOQMETRICS` namespace として公開される (`src/index.ts:170`)。高レベル API は publishTracks を扱わない。
- 優先度: P2。

## 5. §13.4 / §13.6 / §14.1 の規範要件

### §13.4 Authorization tokens (MSF-02:4826-4857)

要件の要旨:

- トークンは authInfo、URI fragment、MOQT 制御メッセージに現れ得る。場所ごとにリスクが異なる (MSF-02:4826-4833)
- catalog に直接書いたトークンは cache する relay と全 subscriber に見える。per-subscriber の credential を cacheable catalog に置く SHOULD NOT。variable substitution か out-of-band で供給する SHOULD。catalog に置くトークンは狭い scope と短い寿命にする SHOULD (MSF-02:4835-4843)
- fragment のトークンは browser history / log / bookmark / 共有リンクに残る。短寿命で対象 content に scope する SHOULD (MSF-02:4845-4849)
- 制御メッセージのトークンは relay に見える。relay は信頼される (MSF-02:4851-4855)
- bearer token は replay され得る。選択した scheme の replay 保護に従う (MSF-02:4857)

現行実装との対応:

- `catalogAuthInfoForSetupToken` はトークンそのものを書かず、`%c4m%` の変数参照を書く (`src/msf/authInfo.ts:26-38`)。catalog に credential を直接書かない方針は §13.4 の SHOULD NOT に適合する
- ただし WF-12 のとおり、変数置換が高レベル API で行われない。publisher が書いた `%c4m%` を解決するのは視聴側の実装責務であり、moqt-js の視聴側は解決しない
- `PublishTrack.token` は catalog にトークンを直接書く経路であり、§13.4 の SHOULD NOT と A.1.3 の token 廃止に反する (WF-14)
- fragment のトークンは `connect()` がローカルで消費し、サーバーへ送らない (`src/connect.ts:66-77`、`src/moqtUri.ts:92-98`)。§11.5 / §13.4 の前提どおりである

### §13.6 Publish tracks and connection URIs (MSF-02:4890-4911)

要件の要旨:

- publishTracks と Connection URI は subscriber に新しい接続と upload を指示できる。悪意ある catalog は任意 host への接続、第三者への負荷、client data の exfiltration に使える (MSF-02:4890-4899)
- Subscribers は local application policy が許可する endpoint にだけ publish する SHOULD。policy を満たさない publish track は無視する SHOULD (MSF-02:4901-4905)
- log / metrics track への publish は rate-limit する SHOULD (MSF-02:4905-4906)
- log / metrics data は必要最小限にし、同意を得て、直接的な個人識別子を名前・payload に含めない SHOULD (MSF-02:4908-4911)
- Connection URI は valid な MOQT endpoint URI でなければならない MUST (§5.2.37、MSF-02:1700-1713)

現行実装との対応:

- 高レベル API は publishTracks を消費しないため、悪意ある catalog による新規接続・upload のリスクは現状無い (LOG-06 / MET-06)
- `connectionUri` の形式検証は無い (`src/msf/catalogTrackValidation.ts:326-349`)。catalog を受信するだけで接続はしないが、将来 publishTracks を実装する前提として MUST の検証が必要 (WF-15)
- rate-limit、endpoint policy、PII の抑制は未実装。publishTracks を実装するときの必須事項として記録する

### §14.1 MOQT URI Fragment Types registry (MSF-02:4989-5000)

要件の要旨:

- `msf` を "MOQT URI Fragment Types" registry (MOQT §16.3) に登録する。Description は "MOQT Streaming Format"、Specification は "This document" (MSF-02:4989-5000)
- MSF-01 は "Sect 14.3" を参照していた (MSF-01:3838-3852)。機能的な差分は無い

現行実装との対応:

- `parseFragment` は type を汎用に扱い、`"msf"` のときだけ MSF の解釈をする (`src/moqtUri.ts:56-79`、`src/msf/fragment.ts:162`、`src/connect.ts:70`)。registry の entry を定数として持つ必要は無い
- 変更は不要。P2。

## 6. 仕様間の矛盾の整理

本担当範囲で見つかった、MSF-02 の本文と参照先 draft の矛盾をまとめる。実装判断の前提になる。

| 論点                                  | MSF-02 の記述                                                 | 参照先の記述                                                       | 現行実装                  | 推奨                                   |
| ------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------- | -------------------------------------- |
| log payload                           | JSON、[MOQLOG] Section 4 (MSF-02:3821-3831)                   | log-04 §4 は Resource ID、payload は §5.3 のバイナリ Log Record    | log-04 §5.3 のバイナリ    | 実装維持。MSF の文言修正を待つ         |
| log Group ID                          | Unix epoch マイクロ秒の 62-bit (MSF-02:3843-3849)             | log-04 §5.2 は Unix epoch 秒                                       | 秒                        | 仕様判断。実装維持を推奨               |
| log Object ID                         | 同一マイクロ秒内の連番、通常 0 (MSF-02:3851-3853)             | log-04 §5.2 は秒内の 0 始まり連番                                  | 秒内連番                  | 仕様判断。実装維持を推奨               |
| metrics payload                       | [MOQMETRICS] Section 3 (MSF-02:3886-3896)                     | metrics-03 §3 は Architecture Overview、payload は §5.4            | metrics-03 §5.4           | 実装維持。MSF の文言修正を待つ         |
| metrics Object 0                      | Unix epoch ナノ秒の timestamp + attributes (MSF-02:3925-3928) | metrics-03 §5.4 は Capture Info (timestampOffset + catalogVersion) | metrics-03 §5.4           | 実装維持。MSF の文言修正を待つ         |
| metrics Object 1+                     | name-value pair (MSF-02:3930-3932)                            | metrics-03 §5.4 は catalog の Object N が説明する Metric Value     | metrics-03 §5.4           | 実装維持。MSF の文言修正を待つ         |
| publishTracks namespace               | `/` 区切りの 1 文字列 (MSF-02:1046-1082)                      | log-04 §6 / metrics-03 §6 は §8.8 の serialization                 | §8.8 の template          | `/` 区切りに変更 (LOG-02 / MET-02)     |
| publishTracks の log namespace 例     | `moq-syslog.arpa/logs-v1/%resourceId%` (MSF-02:3225-3229)     | log-04 §5.1 は `logs.moq.arpa/v1`                                  | `logs.moq.arpa` / `v1`    | 実装は log-04 §5.1。例の修正を待つ     |
| publishTracks の metrics namespace 例 | `metrics.moq.arpa/metrics-v1/%resourceId%` (MSF-02:3213-3219) | metrics-03 §5.1 は `metrics.moq.arpa/v1`                           | `metrics.moq.arpa` / `v1` | 実装は metrics-03 §5.1。例の修正を待つ |
| `connectionURI` の表記                | 例は `"connectionURI"` (MSF-02:3231-3233)                     | フィールド表は `connectionUri` (§5.2.37)                           | `connectionUri`           | 例の誤記。実装は `connectionUri`       |
| authInfo の scheme 名                 | `cat` / `privacy-pass` (Table 10)                             | C4M / PrivacyPassAuth                                              | `cat` を出力              | 変更なし                               |

**注目点**: 上記のうち log payload / Group ID / metrics payload は、MSF-01 から MSF-02 で「参照先 draft の版が上がった」ことによる新しい矛盾である。MSF-02 の本文が旧版のまま残っている。実装は既に新しい companion draft に追従しているため、MSF-02 の文言に合わせると後退する。この点は仕様作者へのフィードバック対象である。

## 7. 実装対応マトリクス (§9 / §10 / §11)

| 仕様項目                          | MSF-02             | MSF-01                 | 現行実装                                                                                                             | 判定                                  |
| --------------------------------- | ------------------ | ---------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| fragment type `msf`               | §11.1 / §14.1      | 同じ                   | `parseFragment` が汎用に受理、`assertMsfConnectionSupported` が msf のときだけ解釈                                   | 対応済み                              |
| `connection=q\|wt`                | §11.1.1            | 同じ                   | `getConnectionParameter` / `assertMsfConnectionSupported` (`src/msf/fragment.ts:132-171`)                            | 対応済み (`q` は未実装で throw)       |
| `wallclock-range`                 | §11.1.1            | 同じ文法               | parse のみ (`src/msf/c4m.ts:36-40`)                                                                                  | 未適用 (WF-05)                        |
| `mediatime-range`                 | §11.1.1            | 同じ文法               | parse のみ (`src/msf/c4m.ts:42-51`)                                                                                  | 未適用 (WF-05)                        |
| `location-range`                  | §11.1.1            | 同じ文法               | parse のみ (`src/msf/c4m.ts:53-72`)                                                                                  | 未適用 (WF-05)                        |
| `cat`                             | §11.1.1            | `c4m`                  | `c4m` のみ (`src/msf/c4m.ts:74-89`)                                                                                  | 未対応 (WF-01, P0)                    |
| 複数 range の union               | §11.1.1            | 同じ                   | 配列で返すのみ。適用先なし                                                                                           | 未適用 (WF-05)                        |
| namespace-name encoding           | §11.1.2            | 同じ                   | `parseMsfFragmentValue` / `parseFullTrackNameSegment` (`src/msf/fragment.ts:52-125`、`src/fullTrackName.ts:169-215`) | 対応済み (pct-encoded の解釈は WF-07) |
| catalog 文字列 → バイト写像       | §11.2              | なし                   | 文字列のまま。UTF-8 は TextEncoder に依存                                                                            | 未対応 (WF-03 / WF-04)                |
| 開始 (catalog 先行)               | §11.3              | §11.2                  | `createMediaPublisher` が catalog を先に publish                                                                     | 対応済み                              |
| 終了 (`PUBLISH_DONE`)             | §11.4              | `SUBSCRIBE_DONE` + 0x2 | `Publisher.done()` は既定 `TRACK_ENDED`                                                                              | 対応済み (complete catalog は未実装)  |
| SETUP token                       | §11.5.3            | 同じ                   | `connect()` (`src/connect.ts:66-77`)                                                                                 | 対応済み                              |
| SUBSCRIBE / FETCH token           | §11.5.3            | 同じ                   | catalogSubscription / trackSubscriptions                                                                             | 対応済み                              |
| REQUEST_UPDATE token              | §11.5.3            | 同じ                   | `src/subscriber.ts:354`、`src/session/namespaces.ts:229`                                                             | 対応済み                              |
| PUBLISH / PUBLISH_NAMESPACE token | §11.5.3            | 同じ                   | `src/createMediaPublisher.ts:1143`、`:1816`、`:1870`、`:1898`                                                        | 対応済み                              |
| authInfo の生成                   | §5.2.42            | 同じ                   | `catalogAuthInfoForSetupToken` (`src/msf/authInfo.ts:43-59`)                                                         | fragment 由来のトークンで欠落 (WF-11) |
| 認可失敗時の再試行                | §11.5.4            | 同じ                   | 未実装                                                                                                               | 未実装 (P2)                           |
| wallclock POSIX ms                | §11.6              | なし                   | `Date.now()` / `performance.timeOrigin + performance.now()`                                                          | 時刻源は適合                          |
| log track name ASCII 10 進        | §9.2               | binary 1 バイト        | ASCII 数字 (`src/observability.ts:48-53`)                                                                            | 対応済み                              |
| log namespace                     | §9.2               | 固定 namespace         | 固定 prefix + resourceId (`src/moqlog.ts:337-354`)。template は §8.8 形式                                            | 要変更 (LOG-02)                       |
| log payload                       | §9.1 (JSON / §4)   | JSON / log-03 §4       | log-04 §5.3 バイナリ                                                                                                 | 仕様矛盾 (LOG-04)                     |
| log Group / Object ID             | §9.3 (µs / 62-bit) | 同じ                   | 秒 / 秒内連番                                                                                                        | 不一致 (LOG-03)                       |
| log catalog requirements          | §9.4               | 同じ構造               | role 検証あり                                                                                                        | 対応済み                              |
| metrics track name                | §10.2              | single tuple           | ASCII 数字                                                                                                           | 対応済み                              |
| metrics namespace                 | §10.2              | 固定 namespace         | 固定 prefix + resourceId。template は §8.8 形式                                                                      | 要変更 (MET-02)                       |
| metrics payload                   | §10.1 / §10.3      | metrics-02             | metrics-03 §5.3 / §5.4                                                                                               | 仕様矛盾 (MET-03)                     |
| metrics Group ID                  | §10.3 (ms)         | 同じ                   | ms (`src/moqmetrics.ts:591-609`)                                                                                     | 対応済み                              |
| metrics catalog requirements      | §10.4              | 同じ構造               | role 検証あり                                                                                                        | 対応済み                              |

## 8. draft-01 の挙動を固定していて更新が必要なテスト一覧

以下は「draft-01 の挙動 (または draft-01 当時の参照先) を固定しており、draft-02 追従で更新が必要になる」テストである。仕様判断待ちのものは条件付きで示す。

### 8.1 `c4m` を固定しているテスト (WF-01、必ず更新)

| テスト                                                                | 固定している挙動                                                                                       |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `src/connect.test.ts:163-180`                                         | `#msf:...&c4m=...` を SETUP の AUTHORIZATION TOKEN にする                                              |
| `src/connect.test.ts:181-195`                                         | `c4m` 付き URI でも fragment を WebTransport に渡さない                                                |
| `src/connect.test.ts:196-206`                                         | `c4m` が無い URI では token を送らない (cat でも同じテストが必要)                                      |
| `src/connect.test.ts:207-232`                                         | `options.authorizationToken` が URI の `c4m` より優先する                                              |
| `src/connect.test.ts:233-257`                                         | 復号できない `c4m` のエラーメッセージ (`draft-ietf-moq-msf-01 Section 11.1.1`) を固定                  |
| `src/msf.test.ts:3208-3228`                                           | `getC4mParameter` の名前と `c4m` key                                                                   |
| `src/msf.test.ts:3317-3441`                                           | `resolveMsfAuthorizationToken` / `createC4mAuthorizationToken` が `c4m` を読む。エラーメッセージも固定 |
| `src/msf.test.ts:3238-3317`                                           | `catalogAuthInfoForSetupToken` が `{"cat": "%c4m%"}` を返す                                            |
| `src/createMediaPublisher.test.ts:6798-6840`                          | catalog の authInfo が `{"cat": "%c4m%"}` である                                                       |
| `devtools/src/utils/c4m.test.ts:24-143`                               | `extractC4mBase64` / `maskC4mValue` が `c4m` を探す                                                    |
| `devtools/src/utils/c4m.prop.ts:352`                                  | `c4m` の Base64 前提の property test                                                                   |
| `devtools/src/hooks/usePublisher.test.ts:1071-1079`                   | authInfo が `{"cat": "%c4m%"}`                                                                         |
| `tests/e2e/devtools-authorization-token.spec.ts`                      | UI が `c4m` を読み込む e2e                                                                             |
| `devtools/src/components/ConnectionSettings.tsx:148`、`:161`、`:1038` | UI 文言が `c4m`                                                                                        |

### 8.2 namespace template を固定しているテスト (LOG-02 / MET-02、必ず更新)

| テスト                           | 固定している挙動                                                                                                                           |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/moqlog.test.ts:412-459`     | `MOQLOG_NAMESPACE_TEMPLATE` が `logs.2emoq.2earpa-v1-%resourceId%` で、`resolveCatalogVariables` 後に 3 field に展開できる                 |
| `src/moqmetrics.test.ts:585-621` | `MOQMETRICS_NAMESPACE_TEMPLATE` が `metrics.2emoq.2earpa-v1-%resourceId%` で、同様                                                         |
| `src/moqlog.test.ts:402-411`     | `formatTrackNamespace(logTrackNamespace(...))` が §8.8 形式である (これは表示用として妥当。catalog namespace とは別物であることを明示する) |
| `src/moqmetrics.test.ts:575-585` | 同上                                                                                                                                       |

### 8.3 log の Group ID / Object ID を固定しているテスト (LOG-03、仕様判断待ち)

| テスト                       | 固定している挙動                                             |
| ---------------------------- | ------------------------------------------------------------ |
| `src/moqlog.test.ts:301-335` | `logGroupId` がマイクロ秒を秒へ切り捨てる                    |
| `src/moqlog.test.ts:336-348` | `logObjectId` が秒内の 0 始まり連番                          |
| `src/moqlog.test.ts:349-370` | `logPriorGroupIdGap` が秒差 - 1                              |
| `src/moqlog.test.ts:371-399` | End of Group が「最終 log + 1」の Object ID                  |
| `src/moqlog.prop.ts:26-44`   | LogRecord の round-trip と ASCII track name (後者は変更不要) |

MSF-02 §9.3 に合わせる場合、上記に加えて `logObjectId` の引数意味 (秒内連番 → マイクロ秒内連番) と End of Group の計算を変更する必要がある。MOQLOG-04 を維持するなら変更不要である。

### 8.4 catalog version / catalog field を固定しているテスト (X-02、catalog 担当と調整)

| テスト / ファイル                                                                                                                                               | 固定している挙動                                                                   |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `src/msf.test.ts:88-128`                                                                                                                                        | `MSF_VERSION` が `draft-01`、`MSF_KNOWN_VERSIONS` が `draft-01` / `1`              |
| `src/msf.test.ts` 内の 140 行                                                                                                                                   | `version: "draft-01"` の catalog fixture                                           |
| `src/msf.prop.ts`、`src/moqlog.test.ts`、`src/moqmetrics.test.ts`、`src/createMediaSubscriber.catalog.test.ts`、`src/testSupport/mediaSubscriberTestSupport.ts` | 合計 161 行の `version: "draft-01"` fixture (`rg -c 'version: "draft-01"'` の結果) |
| `devtools/src/signals/statsSnapshot.test.ts`、`devtools/src/signals/debugExport.test.ts`                                                                        | 同上                                                                               |

draft-02 の catalog を encode するなら `MSF_VERSION` を `"draft-02"` にし、`MSF_KNOWN_VERSIONS` は後方互換のため `"draft-01"` も受理する、という設計が考えられる。これは catalog 担当の判断である。

### 8.5 引用だけの更新で済むテスト (挙動は draft-02 と一致)

- `src/msf.test.ts:2596-2704` の fragment テスト (connection / range / literal / hex / empty field)。文法は draft-02 で変わっていない。
- `src/msf.test.ts:1274-1341`、`:1821-1863` の log / metrics の role MUST。draft-02 でも同じ。
- `src/moqmetrics.test.ts:497-541` の metrics Group ID / Prior Group Gap。MSF-02 §10.3 の ms と一致する。
- `src/moqmetrics.test.ts:338-495` の Capture Info / Metric Value。metrics-03 §5.4 と一致する。
- `src/moqtUri.test.ts` の fragment 分離テスト。fragment type の扱いは変わらない。

## 9. docs / コメントの引用更新が必要な箇所

### 9.1 件数

`rg "draft-ietf-moq-msf-01"` の結果 (リポジトリ全体、`node_modules` / `coverage` / `dist` を除外):

- マッチ行数: 588 行
- 出現数: `rg -o` で 601 (13 行は 1 行に 2 回出現する)
- ファイル数: 194 (うち `issues/**` と `refs/**` を除くと 109 ファイル、418 行、421 出現)

`issues/**` は過去の記録であり、引用更新の対象外とする。`refs/**` は他 draft が MSF-01 を参照しているものであり、更新対象外である (ただし `refs/moq/draft-ietf-moq-msf-02.txt` 自身の参照リストは MSF-02 内の記述)。

ファイル別の件数は付録 A の先頭に一覧を置く。全 418 行の `file:line:本文` は付録 A.2 に置く。

### 9.2 docs の全行

`rg -n "draft-ietf-moq-msf-01" docs README.md` は 33 行。下表は、これに加えて節番号だけを引用している行 (同じファイル内) も含む。

| ファイル:行                                    | 現在の引用                                                    | 更新内容                                                                                                  |
| ---------------------------------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `README.md:45`                                 | `https://datatracker.ietf.org/doc/html/draft-ietf-moq-msf-01` | `-02` へ                                                                                                  |
| `docs/MSF.md:10`                               | `refs/moq/draft-ietf-moq-msf-01.txt`                          | `-02` へ (ファイル名も `refs/moq/draft-ietf-moq-msf-02.txt`)                                              |
| `docs/MSF.md:11`                               | datatracker `-01`                                             | `-02` へ                                                                                                  |
| `docs/MSF.md:16`                               | "MSF-01 §5 は ... Joining FETCH ..."                          | MSF-02 §5 も Joining FETCH の MUST を維持している (MSF-02:733)。文言の `MSF-01` を `MSF-02` に。§5 は同じ |
| `docs/MSF.md:21`                               | `c4m` の説明と `§11.1.1`                                      | `cat` に変更。§11.1.1 は同じ                                                                              |
| `docs/MSF.md:22`                               | §11.1                                                         | 節番号は同じ。`draft-ietf-moq-msf-01` を `-02` に                                                         |
| `docs/MSF.md:23`                               | §11.4.3                                                       | §11.5.3 に                                                                                                |
| `docs/MSF.md:24`                               | §11.4.3                                                       | §11.5.3 に                                                                                                |
| `docs/MSF.md:26`                               | §5.2.42、`{"cat": "%c4m%"}`                                   | §5.2.42 は同じ。`%c4m%` を `%cat%` に                                                                     |
| `docs/MSF.md:28`                               | MSF_COMPRESSION (未実装)                                      | draft-02 で Property Type 0x78 が割当済み。実装状況の記述を更新                                           |
| `docs/HIGH_LEVEL_API.md:115`                   | §5.2.8 (targetLatency)                                        | §5.2.9 に                                                                                                 |
| `docs/HIGH_LEVEL_API.md:119`                   | §5.2.11 (renderGroup)                                         | §5.2.12 に                                                                                                |
| `docs/HIGH_LEVEL_API.md:125`                   | §5.2.42 (authInfo)                                            | 同じ                                                                                                      |
| `docs/HIGH_LEVEL_API.md:139`                   | §5.2.8 の MUST                                                | §5.2.9 に                                                                                                 |
| `docs/HIGH_LEVEL_API.md:148`                   | "draft-ietf-moq-msf-01 由来"                                  | `-02` に                                                                                                  |
| `docs/HIGH_LEVEL_API.md:163`                   | §5.2.28 / §5.2.29                                             | §5.2.29 / §5.2.30 に                                                                                      |
| `docs/HIGH_LEVEL_API.md:230`                   | §11.4.3                                                       | §11.5.3 に                                                                                                |
| `docs/HIGH_LEVEL_API.md:338`                   | §5                                                            | 同じ                                                                                                      |
| `docs/HIGH_LEVEL_API.md:348`                   | §5                                                            | 同じ                                                                                                      |
| `docs/HIGH_LEVEL_API.md:351`                   | §6.1 / §6.2                                                   | 同じ                                                                                                      |
| `docs/HIGH_LEVEL_API.md:363`                   | §11.2 の MUST                                                 | 開始手順は §11.3 に                                                                                       |
| `docs/HIGH_LEVEL_API.md:760`                   | §11.1.1 / §11.4.3                                             | §11.1.1 / §11.5.3 に。`c4m` は `cat` に                                                                   |
| `docs/HIGH_LEVEL_API.md:763`                   | §11.4.3                                                       | §11.5.3 に                                                                                                |
| `docs/HIGH_LEVEL_API.md:1234-1235`             | §5.2.8 / §5.2.11                                              | §5.2.9 / §5.2.12 に                                                                                       |
| `docs/HIGH_LEVEL_API.md:1588-1593`             | §5.2.42 / §11.4.1、`%c4m%` / `c4m`                            | §11.5.1、`%cat%` / `cat` に。Table 7 → Table 10                                                           |
| `docs/LOW_LEVEL_API.md:95`                     | §11.1.1 / §11.4.2 / §11.4.3                                   | §11.1.1 / §11.5.2 / §11.5.3 に                                                                            |
| `docs/LOW_LEVEL_API.md:104`                    | §11.4.3                                                       | §11.5.3 に                                                                                                |
| `docs/LOW_LEVEL_API.md:702`                    | §5 の Joining FETCH                                           | §5 は同じ。`-02` に                                                                                       |
| `docs/IMPLEMENTATION_STATUS.md:143`            | datatracker `-01`                                             | `-02` に                                                                                                  |
| `docs/IMPLEMENTATION_STATUS.md:145`            | "MSF-01 §5 ..."                                               | `MSF-02` に                                                                                               |
| `docs/IMPLEMENTATION_STATUS.md:185`            | "MSF-01 §9.2 / §10.2 は旧版を参照..."                         | draft-02 では §9.2 / §10.2 が ASCII 10 進と catalog namespace を定めるため、記述を全面改訂                |
| `docs/IMPLEMENTATION_STATUS.md:188-194`        | log-04 / metrics-03 の節引用                                  | MSF-02 の §9 / §10 との矛盾 (LOG-03 / LOG-04 / MET-03) を明記                                             |
| `docs/ARCHITECTURE.md:141`                     | §6.2 / §4.1                                                   | §6.2 は同じ。§4.1 は §4.1.1 (LOC stream mapping) を確認。少なくとも `-02` に                              |
| `docs/ARCHITECTURE.md:187`                     | §5 / §6.1 / §6.2                                              | 節番号は同じ。`-02` に                                                                                    |
| `docs/MEDIA_PLAYOUT.md:245`                    | §5.2.8                                                        | §5.2.9 に                                                                                                 |
| `docs/proposals/FETCH_GAP_RECOVERY.md:102`     | `refs/moq/draft-ietf-moq-msf-01.txt`                          | `-02` に                                                                                                  |
| `docs/proposals/NAMESPACE_ANNOUNCEMENT.md:58`  | §11.4.3                                                       | §11.5.3 に                                                                                                |
| `docs/proposals/NAMESPACE_ANNOUNCEMENT.md:276` | §11.4.3                                                       | §11.5.3 に                                                                                                |
| `docs/proposals/AUDIO_FEC.md:163`              | §5                                                            | 同じ                                                                                                      |
| `docs/proposals/AUDIO_FEC.md:269`              | `refs/moq/draft-ietf-moq-msf-01.txt` §5                       | `-02` に                                                                                                  |

**リンク切れ**: `refs/moq/draft-ietf-moq-msf-01.txt` はリポジトリに存在しない (`refs/moq/` にあるのは `draft-ietf-moq-msf-02.txt` のみ)。`docs/MSF.md:10` の相対リンク、`docs/proposals/FETCH_GAP_RECOVERY.md:102`、`docs/proposals/AUDIO_FEC.md:269` のファイル参照は現時点で壊れている。`docs/MSF.md:11` の datatracker リンクも `-01` のままである。これらは `-02` のファイル名と URL に更新する。

### 9.3 src / devtools の引用更新の代表例

全件は付録 A.2 を参照。節番号が変わるものを中心に、修正内容を分類する。

- `§11.4.3` → `§11.5.3` (Authorization): `src/subscriber.ts:188`、`:354`、`src/session.ts:207`、`:292`、`:296`、`:312`、`:374`、`:798`、`src/session/namespaces.ts:211`、`:229`、`:347`、`src/session/connection.ts:153`、`:356`、`src/session/requests.ts:604`、`src/session/incomingPublish.ts:965`、`src/session/publicTypes.ts:206`、`:534`、`:799`、`:952`、`:1064`、`:1216`、`src/mediaSubscriber/trackSubscriptions.ts:76`、`:251`、`src/mediaSubscriber/catalogSubscription.ts:147`、`:250`、`:313` など
- `§5.2.8` (targetLatency) → `§5.2.9`: `src/codec/types.ts:304`、`:314`、`src/createMediaPublisher.ts:2095`、`:2104`、`src/mediaSubscriber/catalogSubscription.ts:372`、`:402`、`:525`、`src/playout/timeline.ts:4`、`:770`、`src/playout/mediaPlayout.ts:215`、`src/msf/tracks.ts:130`、`:153`、`:172`、`src/createMediaSubscriber.playout.test.ts` の複数行、`docs/HIGH_LEVEL_API.md` の複数行
- `§5.2.6` (role) → `§5.2.7`: `src/msf/version.ts:47`、`src/msf.test.ts:825`、`src/mediaSubscriber/catalogSubscription.ts:549`
- `§5.2.11` (renderGroup) → `§5.2.12`: `src/codec/types.ts:314`、`src/mediaSubscriber/catalogSubscription.ts:525`、`src/playout/timeline.ts:770`、`docs/HIGH_LEVEL_API.md:119`、`:1234`
- `§5.2.28` / `§5.2.29` → `§5.2.29` / `§5.2.30`: `src/msf/catalogTrackValidation.ts:418`、`:438-441`、`src/msf/timeline.ts`、`src/codec/config.ts:101`、`src/createMedia/settings.ts:145`、`docs/HIGH_LEVEL_API.md:163`
- `§5.2.36` / `§5.2.37` → `§5.2.37` / (token 廃止): `src/msf/types.ts:229-240`、`src/msf/catalogValidation.ts:416-426`、`src/msf/catalogTrackValidation.ts:326-349`
- `§11.2` (開始) → `§11.3`: `src/createMediaPublisher.ts:1915`、`docs/HIGH_LEVEL_API.md:363`
- `§11.3` (終了) → `§11.4`: 該当する src コメントは無い (実装は `PUBLISH_DONE` を使う)
- `§8.1` / `§8.2` / `§8.3` → `§8.2` / `§8.3` / `§8.4`: `src/msf/timeline.ts:2`、`:19`、`:39`、`:102`、`:132`、`:179`、`src/msf/catalogTrackValidation.ts:2`、`src/msf/types.ts:375`、`devtools/src/utils/eventTimeline.test.ts:28`、`:56`
- `§14.3` / `§14.4` (compression) → `§14.3` (Property Type) / `§14.4` (registry): `src/properties.ts:24`、`:36-40`、`src/msf.test.ts:2707`
- テーブル番号: `Table 3` / `Table 4` (packaging) → `Table 5`、`Table 5` (role) → `Table 7`、`Table 7` (authInfo) → `Table 10`、`Table 15` (compression) → `Table 16`: `src/msf/version.ts:39`、`:47`、`src/msf/types.ts:52`、`:98`、`src/msf/authInfo.ts:13`、`src/msf.test.ts:825`、`:2707`
- `draft-01 Table 3` という文字列 (mimetype のエラー): `src/msf/catalogValidation.ts:400`、`:472`、`src/msf.test.ts:1220`、`:1227`。draft-02 の track field table は Table 4 である

### 9.4 付録 A の読み方

付録 A.1 はファイル別件数、A.2 は全 418 行の `file:line:本文` である。行の本文には、その行で参照している節番号と `draft-ietf-moq-msf-01` の文字列が含まれる。節番号が変わっていない行でも、`draft-ietf-moq-msf-01` の文字列自体を `-02` に更新する必要がある。節番号の対応は §1 の表を使う。

## 10. URL 互換性が壊れる変更の一覧

| 変更                                                                                | 壊れるもの                                                                               | 影響                                                                                                   | 対応                                                                     |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| `c4m` → `cat` (WF-01)                                                               | 既存の `&c4m=` 付き URL、pre-authorized link、bookmark、共有リンク、devtools の URL 入力 | strict に改名すると SETUP にトークンが載らず認可失敗。`c4m` を独自 parameter に使う URL は誤解のリスク | `cat` を優先し、`c4m` も一定期間受理する。エラーメッセージと docs を更新 |
| `%c4m%` → `%cat%` (WF-01 / WF-12)                                                   | 既存の catalog の authInfo 変数参照                                                      | 変数が未定義になり空文字になる                                                                         | 両方の変数を variables に入れる。catalog の publisher は `%cat%` を出力  |
| log / metrics の publishTracks namespace template の `/` 区切り化 (LOG-02 / MET-02) | 既存の publishTracks の namespace 文字列                                                 | MSF-02 の購読者は 1 field の namespace として解釈し、意図した 3 field と一致しない                     | template を `/` に変更。既存の catalog は migration が必要               |
| variable 値の文字集合の拡大 (WF-02)                                                 | なし (受理範囲の拡大)                                                                    | 既存の URL は引き続き受理される                                                                        | なし                                                                     |
| variable 名の制限撤廃 (WF-02)                                                       | なし (受理範囲の拡大)                                                                    | 既存の catalog は引き続き受理される                                                                    | なし                                                                     |
| `connection` の挙動                                                                 | なし                                                                                     | 文法・意味とも変更なし                                                                                 | なし                                                                     |
| range の文法                                                                        | なし                                                                                     | `-` 区切り、`.` 区切り、inclusive、open range、union とも変更なし                                      | なし                                                                     |
| range の適用開始 (WF-05)                                                            | range 付き URL の現在の挙動 (無視)                                                       | これまで全範囲が配信されていた URL が部分配信になる                                                    | CHANGES に記載。未対応 range は reject する                              |
| catalog version `draft-01` → `draft-02` (X-02)                                      | 既存の catalog を decode する相手                                                        | `MSF_KNOWN_VERSIONS` が `draft-02` を知らない購読者は parse を拒否する                                 | 後方互換のため `draft-01` / `draft-02` の両方を受理する                  |
| `connectionUri` の検証追加 (WF-15)                                                  | 不正な URI を含む既存 catalog                                                            | decode が reject する                                                                                  | 仕様の MUST に沿う。移行期間を設けるか検討                               |
| track-level `token` の廃止 (WF-14)                                                  | `token` を使う既存 catalog / アプリ                                                      | catalog の wire から token が消える。draft-01 の購読者と非互換                                         | authInfo へ移行。受信は許容し、送信しない                                |

**URL の解釈で注意する点**:

- `cat` の値は標準 Base64 であり、`+`、`/`、`=` を含み得る。fragment の ABNF は `pchar-no-amp` と `/` を許すため、URL としては valid である (MSF-02:4038-4078)。`=` は parameter の最初の `=` で分割されるため、値の中の `=` は保持される (`src/msf/fragment.ts:110-121`)
- `normalizeMoqtUri` は `new URL()` で fragment を取り出す (`src/moqtUri.ts:133-147`)。`cat` の Base64 に含まれる `+` が URL パーサで空白に変換されないことは、`new URL` の hash が percent-decode されない性質に依存する。テストで `+` / `/` / `=` を含む `cat` を固定する必要がある (現状の `c4m` テストは base64url と `//8=` の一部のみ。`src/connect.test.ts:163` は base64url、`src/msf.test.ts:3325-3365` は標準 Base64 の復号を直接テストするが、URL 経由の `+` は未確認)
- query の `token=` は server 向けであり、client の variable には使わない (MSF-02:2055-2057)。`normalizeMoqtUri` は query を保持する (`src/moqtUri.ts:133-147`)。この挙動は仕様に適合する

## 11. 未確認事項

以下は本調査で確認できなかった、または仕様の解釈が確定できない事項である。

1. MSF-02 §9.3 / §10.3 の本文と MOQLOG-04 / MOQMETRICS-03 のどちらを正とするか。仕様作者の意図は未確認である。変更履歴 (A.1.6) は payload / Group ID の変更を挙げていないため、MSF-02 の本文が旧版のまま残った可能性が高い。
2. `cat` の Base64 に含まれる `+` を `new URL()` 経由の fragment で取得した場合に、値がそのまま保持されるか。ブラウザ実装依存の可能性がある。実機確認が必要である。
3. `resolveCatalogVariables` を高レベル API に組み込む場合、置換後の catalog をどの時点で検証するか (受信直後 / track 解決直前 / encode 直前)。既存の initRef 検証との順序を含め、設計判断が必要である。
4. `wallclock-range` / `mediatime-range` を media timeline に写像する方法。catalog の media timeline を購読していない場合の挙動は仕様に明記が無い。
5. MSF-02 の catalog 例が `connectionURI` (大文字 URI) と `connectionUri` のどちらを正とするか。フィールド表 (§5.2.37) は `connectionUri` であり、例の誤記と判断したが、仕様作者の確認は未確認である。
6. `draft-02` の catalog version 文字列を `MSF_VERSION` に採用するか。A.1.1 は「catalog examples now use "draft-02" as the version string」と書くが、これは例の記述であり、normative な要求かは §5.1.1 の "draft-XX" の解釈に依存する。catalog 担当の判断が必要である。
7. 本レポートの「P0 / P1 / P2」は、仕様の MUST / SHOULD と相互運用影響を基準にした本調査担当の判断であり、リリース計画の優先度ではない。

## 付録 A. `draft-ietf-moq-msf-01` 引用の全リスト

### A.1 ファイル別件数 (109 ファイル、418 行)

`node_modules`、`coverage`、`dist`、`issues/**`、`refs/**` を除外した。`issues/**` は過去の記録、`refs/**` は他 draft の参照リストであり、更新対象外である。形式は `ファイル:マッチ行数`。

```text
devtools/src/components/CatalogTracks.tsx:2
devtools/src/components/ConnectionSettings.tsx:6
devtools/src/components/TrackDeclaration.tsx:1
devtools/src/hooks/usePublisher.test.ts:21
devtools/src/hooks/usePublisher.ts:21
devtools/src/hooks/useSubscriber.test.ts:3
devtools/src/hooks/useSubscriber.ts:13
devtools/src/signals/connectionSettings.test.ts:3
devtools/src/signals/connectionSettings.ts:8
devtools/src/signals/publisher.ts:2
devtools/src/signals/statsSnapshot.test.ts:1
devtools/src/signals/statsSnapshot.ts:1
devtools/src/signals/subscriber.ts:1
devtools/src/utils/c4m.prop.ts:1
devtools/src/utils/c4m.test.ts:1
devtools/src/utils/c4m.ts:5
devtools/src/utils/catalogValue.test.ts:1
devtools/src/utils/catalogValue.ts:1
devtools/src/utils/eventTimeline.test.ts:2
devtools/src/utils/eventTimeline.ts:2
devtools/src/utils/msfFragment.test.ts:1
devtools/src/utils/msfFragment.ts:2
devtools/src/utils/publishTracks.test.ts:3
devtools/src/utils/publishTracks.ts:3
devtools/src/utils/serverUrlStore.ts:2
devtools/src/utils/trackAuthorization.test.ts:1
devtools/src/utils/trackAuthorization.ts:1
docs/ARCHITECTURE.md:2
docs/HIGH_LEVEL_API.md:15
docs/IMPLEMENTATION_STATUS.md:1
docs/LOW_LEVEL_API.md:3
docs/MEDIA_PLAYOUT.md:1
docs/MSF.md:5
docs/proposals/AUDIO_FEC.md:2
docs/proposals/FETCH_GAP_RECOVERY.md:1
docs/proposals/NAMESPACE_ANNOUNCEMENT.md:2
README.md:1
src/catalogRepublish.prop.ts:1
src/catalogRepublish.test.ts:1
src/catalogRepublish.ts:1
src/codec/config.test.ts:1
src/codec/config.ts:1
src/codec/types.ts:6
src/connect.test.ts:2
src/connect.ts:2
src/createMediaPublisher.test.ts:10
src/createMediaPublisher.ts:24
src/createMedia/settings.ts:1
src/createMediaSubscriber.catalog.test.ts:6
src/createMediaSubscriber.lifecycle.test.ts:1
src/createMediaSubscriber.media.test.ts:2
src/createMediaSubscriber.playout.test.ts:8
src/createMediaSubscriber.ts:6
src/fullTrackName.prop.ts:2
src/fullTrackName.test.ts:1
src/fullTrackName.ts:3
src/mediaSubscriber/catalogSubscription.ts:9
src/mediaSubscriber/trackSubscriptions.ts:2
src/moqlog.prop.ts:1
src/moqlog.test.ts:1
src/moqlog.ts:1
src/moqmetrics.prop.ts:1
src/moqmetrics.test.ts:1
src/moqmetrics.ts:3
src/msf/authInfo.ts:5
src/msf/c4mAuthorization.ts:5
src/msf/c4m.ts:7
src/msf/catalogCodec.ts:7
src/msf/catalogDelta.ts:3
src/msf/catalogTrackValidation.ts:5
src/msf/catalogValidation.ts:9
src/msf/fragment.ts:7
src/msf/json.ts:1
src/msf/ownFields.ts:1
src/msf.prop.ts:9
src/msf.test.ts:7
src/msf/timeline.ts:7
src/msf/tracks.test.ts:2
src/msf/tracks.ts:9
src/msf.ts:14
src/msf/types.ts:15
src/msf/variables.ts:3
src/msf/version.ts:8
src/observability.ts:1
src/playout/mediaPlayout.ts:1
src/playout/timeline.ts:2
src/properties.ts:2
src/session/bidiSendNamespaceRequestUpdate.test.ts:2
src/session/bidi.ts:3
src/session/connection.ts:2
src/session/incomingPublish.ts:1
src/session/namespaces.ts:3
src/session/params.test.ts:2
src/session/params.ts:4
src/session.prop.ts:1
src/session/publicTypes.ts:6
src/session/requests.ts:1
src/session.test.ts:3
src/session.ts:6
src/session/types.ts:2
src/subscriber.ts:2
tests/e2e/devtools-authorization-token.spec.ts:2
tests/e2e/devtools-tracks-declaration.spec.ts:2
tests/e2e/relay/audio-capture-fallback.spec.ts:1
tests/e2e/relay/audio-capture-format.spec.ts:1
tests/e2e/relay/devtools-audio-publish.spec.ts:1
tests/e2e/relay/fetch.spec.ts:1
tests/e2e/relay/namespace-discovery-subscribe.spec.ts:1
tests/e2e/relay/pubsub.spec.ts:1
```

合計: 109 ファイル、418 行。リポジトリ全体 (`issues/**` / `refs/**` を含む) では 194 ファイル、588 行 (601 出現)。

### A.2 全行リスト (418 行)

形式は `ファイル:行:本文`。本文は長い場合があるため、そのまま収録する。各行の `draft-ietf-moq-msf-01` を `draft-ietf-moq-msf-02` に更新し、同じ行または近傍の `§` 引用を §1 の対応表で更新する。

```text
README.md:45:  - [MOQT Streaming Format](https://datatracker.ietf.org/doc/html/draft-ietf-moq-msf-01)
docs/IMPLEMENTATION_STATUS.md:143:[draft-ietf-moq-msf-01](https://datatracker.ietf.org/doc/html/draft-ietf-moq-msf-01) の機能実装状況である。
tests/e2e/devtools-authorization-token.spec.ts:9:// c4m の Base64 トークン (draft-ietf-moq-msf-01 §11.1.1 / draft-ietf-moq-c4m-02 §2)
tests/e2e/devtools-authorization-token.spec.ts:70:// (draft-ietf-moq-msf-01 §11.1.1 / §11.4.3)。
docs/ARCHITECTURE.md:141:  - Object ID 0 が Group 先頭であることは draft-ietf-moq-msf-01 §6.2、同一 GOP のサンプルが同一 Group に置かれることは同 §4.1 が MUST で定める。Group 先頭が IDR であることは draft-ietf-moq-loc-05 §4.2 (Examples) に依拠する
docs/ARCHITECTURE.md:187:- Catalog: 開始時に初期 groupId を割り当て、送り直しのたびに +1、objectId は常に 0 (draft-ietf-moq-msf-01 §5 / §6.1 / §6.2)
src/createMediaSubscriber.playout.test.ts:43:// 音声と映像の表示時刻（draft-ietf-moq-msf-01 §5.2.8 / §5.2.11、
src/createMediaSubscriber.playout.test.ts:155: * draft-ietf-moq-msf-01 §5.2.8:
src/createMediaSubscriber.playout.test.ts:179: * draft-ietf-moq-msf-01 §5.2.8:
src/createMediaSubscriber.playout.test.ts:203: * draft-ietf-moq-msf-01 §5.2.8:
src/createMediaSubscriber.playout.test.ts:224: * draft-ietf-moq-msf-01 §5.2.8:
src/createMediaSubscriber.playout.test.ts:245: * draft-ietf-moq-msf-01 §5.2.8:
src/createMediaSubscriber.playout.test.ts:266: * draft-ietf-moq-msf-01 §5.2.8:
src/createMediaSubscriber.playout.test.ts:317: * draft-ietf-moq-msf-01 §5.2.8:
docs/MSF.md:10:- 正本: [`refs/moq/draft-ietf-moq-msf-01.txt`](../refs/moq/draft-ietf-moq-msf-01.txt)
docs/MSF.md:11:- 公開版: [draft-ietf-moq-msf-01](https://datatracker.ietf.org/doc/html/draft-ietf-moq-msf-01)
docs/MSF.md:22:- msf fragment の track-identifier（MSF namespace-name）を解析して Track Namespace、Track Name、parameter を取り出す（draft-ietf-moq-msf-01 §11.1）: `parseMsfFragmentValue` / `MsfFragmentValue`（`src/msf/fragment.ts`）
docs/MSF.md:23:- `SETUP` に載せたトークンを、catalog の `SUBSCRIBE` / `FETCH` と `authInfo` を持つトラックの `SUBSCRIBE` / `REQUEST_UPDATE` へ付与する（draft-ietf-moq-msf-01 §11.4.3）: [`createMediaSubscriber`](HIGH_LEVEL_API.md)
docs/MSF.md:24:- `SETUP` に載せたトークンを `PUBLISH` / `PUBLISH_NAMESPACE` へ付与する（draft-ietf-moq-msf-01 §11.4.3）: [`createMediaPublisher`](HIGH_LEVEL_API.md) / [`connect()`](LOW_LEVEL_API.md)
src/properties.ts:24: * MSF_COMPRESSION の Compression Algorithm 値 (draft-ietf-moq-msf-01 §12.1 / §14.4 Table 15)
src/properties.ts:36: * 注: MSF_COMPRESSION の Track / Object Property ID 自体は draft-ietf-moq-msf-01
devtools/src/hooks/usePublisher.test.ts:166:  // LOC パッケージングの live な映像トラックとして宣言する (draft-ietf-moq-msf-01 §5.2)
devtools/src/hooks/usePublisher.test.ts:182:// (draft-ietf-moq-msf-01 §5.1 の wire format との往復)。
devtools/src/hooks/usePublisher.test.ts:210:// キーフレームは新しい Group の先頭 Object になる (draft-ietf-moq-msf-01 §6.1)。
devtools/src/hooks/usePublisher.test.ts:645:// 空名のトラックは接続の前に拒否する (draft-ietf-moq-msf-01 §5.2.3)。
devtools/src/hooks/usePublisher.test.ts:826:// draft-ietf-moq-msf-01 §5.2.3: name は Required で、catalog の中で namespace ごとに
devtools/src/hooks/usePublisher.test.ts:836:    /track name must not be empty per draft-ietf-moq-msf-01 §5\.2\.3/,
devtools/src/hooks/usePublisher.test.ts:845:    /track names must be unique per namespace per draft-ietf-moq-msf-01 §5\.2\.3/,
devtools/src/hooks/usePublisher.test.ts:854:    /track names must be unique per namespace per draft-ietf-moq-msf-01 §5\.2\.3/,
devtools/src/hooks/usePublisher.test.ts:863:// event timeline トラック (draft-ietf-moq-msf-01 §5.2.5 / §8.2)
devtools/src/hooks/usePublisher.test.ts:905:// Catalog の targetLatency / renderGroup (draft-ietf-moq-msf-01 §5.2.8 / §5.2.11)
devtools/src/hooks/usePublisher.test.ts:929:// draft-ietf-moq-msf-01 §5.2.8: 同じ render group と alternate group の track は同一の
devtools/src/hooks/usePublisher.test.ts:964:// draft-ietf-moq-msf-01 §5.2.8: 宣言が無く isLive が true のときは購読側が表示の遅れを
devtools/src/hooks/usePublisher.test.ts:1063:// draft-ietf-moq-msf-01 §5.2.42: authInfo は track の認可が必要なことを視聴側に示す。
devtools/src/hooks/usePublisher.test.ts:1143:// draft-ietf-moq-msf-01 §5.2.8: 宣言が無く isLive が true のときは購読側が表示の遅れを
devtools/src/hooks/usePublisher.test.ts:1180:// 指定した値は音声と映像の両方の track に同じ値で載る (draft-ietf-moq-msf-01 §5.2.8 の
devtools/src/hooks/usePublisher.test.ts:1415:// (draft-ietf-moq-msf-01 §5.2.3) は配信の直前 (buildPublisherCatalog) だけが行う
devtools/src/hooks/usePublisher.test.ts:1425:    /track name must not be empty per draft-ietf-moq-msf-01 §5\.2\.3/,
devtools/src/hooks/usePublisher.test.ts:1436:    /track names must be unique per namespace per draft-ietf-moq-msf-01 §5\.2\.3/,
devtools/src/hooks/usePublisher.test.ts:1562: * draft-ietf-moq-msf-01 §6.1: Group ID は track ごとに一意で単調増加することが MUST で
devtools/src/hooks/usePublisher.test.ts:1603: * draft-ietf-moq-msf-01 §6.1: 配信を再開したときの開始 Group ID は、同一 track で以前に
devtools/src/hooks/usePublisher.test.ts:1762:// PUBLISH と共用する (draft-ietf-moq-msf-01 §11.4.3)。停止では確立した告知の done() を
docs/MEDIA_PLAYOUT.md:245:(draft-ietf-moq-msf-01 §5.2.8) を解決した値を渡す。同じ render group と alternate group の
src/moqlog.prop.ts:3: * draft-jennings-moq-log-04 ([MOQLOG]) / draft-ietf-moq-msf-01 §9 (Log track)
devtools/src/hooks/usePublisher.ts:150:   * draft-ietf-moq-msf-01 §5.2.8 (targetLatency)。
devtools/src/hooks/usePublisher.ts:159:   * draft-ietf-moq-msf-01 §5.2.11 (renderGroup)。
devtools/src/hooks/usePublisher.ts:167:   * draft-ietf-moq-msf-01 §5.2.42 (authInfo)。
devtools/src/hooks/usePublisher.ts:198:  /** 目標遅延 (ms)。未指定は null (catalog に載せない。draft-ietf-moq-msf-01 §5.2.8) */
devtools/src/hooks/usePublisher.ts:310: * draft-ietf-moq-msf-01 §5.2.8: 同じ render group と alternate group の track は同一の
devtools/src/hooks/usePublisher.ts:407: * draft-ietf-moq-msf-01 §5.1 の full catalog を生成する。映像トラックと音声トラックは
devtools/src/hooks/usePublisher.ts:437:  // (draft-ietf-moq-msf-01 §5.2.3: name は Required、namespace ごとに一意 MUST)
devtools/src/hooks/usePublisher.ts:513: * Group / Object ID (draft-ietf-moq-msf-01 §6.1):
devtools/src/hooks/usePublisher.ts:814:// catalog の送り直し (draft-ietf-moq-msf-01 Section 5)
devtools/src/hooks/usePublisher.ts:934: * draft-ietf-moq-msf-01 §6.1: Group ID は track ごとに一意で単調増加することを MUST とし、
devtools/src/hooks/usePublisher.ts:1316:      // draft-ietf-moq-msf-01 §11.4.3: track に紐づくトークンは PUBLISH にも MUST 付与する
devtools/src/hooks/usePublisher.ts:1898:        // draft-ietf-moq-msf-01 §11.4.3: track に紐づくトークンは PUBLISH にも MUST 付与する
devtools/src/hooks/usePublisher.ts:2003:        // draft-ietf-moq-msf-01 §11.4.3: track に紐づくトークンは PUBLISH にも MUST 付与する
devtools/src/hooks/usePublisher.ts:2054:  // event timeline に載せる履歴。配信を始めるたびに空にする (draft-ietf-moq-msf-01 §8.3)
devtools/src/hooks/usePublisher.ts:2238:  // 進めて行う (draft-ietf-moq-msf-01 §6.1)。Object ID は Group の先頭 Object の
devtools/src/hooks/usePublisher.ts:2283:   * draft-ietf-moq-msf-01 §8.3: Group の先頭 Object には、それまでに蓄積されアクセス
devtools/src/hooks/usePublisher.ts:2369:      // 配信する予定のトラック名を接続の前に検証する (draft-ietf-moq-msf-01 §5.2.3)。
devtools/src/hooks/usePublisher.ts:2455:          // draft-ietf-moq-msf-01 §11.4.3: track に紐づくトークンは PUBLISH にも MUST 付与する
devtools/src/hooks/usePublisher.ts:2484:      // (draft-ietf-moq-msf-01 §6.1。理由は applyPublishStartGroupIds を参照)
devtools/src/hooks/usePublisher.ts:2496:      // catalog が relay の cache から落ちる前に送り直す (draft-ietf-moq-msf-01 Section 5)
devtools/src/hooks/usePublisher.ts:2671:        // よる Catalog の送り直しと Group ID が衝突し得る (draft-ietf-moq-msf-01 §6.1)。
docs/proposals/FETCH_GAP_RECOVERY.md:102:- [MSF draft-01](../../refs/moq/draft-ietf-moq-msf-01.txt): トラックと Group の構造
tests/e2e/relay/fetch.spec.ts:71:  // 初期 Group ID は 0 ではない (draft-ietf-moq-msf-01 §6.1 の単調増加の起点)
docs/proposals/NAMESPACE_ANNOUNCEMENT.md:58:- draft-ietf-moq-msf-01 §11.4.3: original publisher のトークンは `PUBLISH` と
docs/proposals/NAMESPACE_ANNOUNCEMENT.md:276:- draft-ietf-moq-msf-01 §11.4.3 (Presenting Authorization)
src/fullTrackName.prop.ts:170: * draft-ietf-moq-transport-23 §8.8 と draft-ietf-moq-msf-01 §11.1.2:
src/fullTrackName.prop.ts:188: * draft-ietf-moq-transport-23 §8.8 と draft-ietf-moq-msf-01 §11.1.2:
docs/proposals/AUDIO_FEC.md:163:- 告知の方法。MoQ の draft 群に FEC の規定が無いため独自方式になる。Catalog は「知らないフィールドは無視する」と定められているため (draft-ietf-moq-msf-01 §5)、別トラックとして告知するのが最も安全である
docs/proposals/AUDIO_FEC.md:269:| MoQ 仕様               | `refs/moq/draft-ietf-moq-transport-23.txt` §5.1.1、§10.4、§14.1.2、`refs/moq/draft-ietf-moq-msf-01.txt` §5、`refs/moq/draft-ietf-moq-loc-05.txt` §4.1                                                 |
devtools/src/hooks/useSubscriber.ts:144: * draft-ietf-moq-msf-01 の catalog は映像トラックを必須としないため、音声だけを広告する
devtools/src/hooks/useSubscriber.ts:166: * packaging が "eventtimeline" の最初のトラックだけを対象にする (draft-ietf-moq-msf-01
devtools/src/hooks/useSubscriber.ts:765: * draft-ietf-moq-msf-01 では `initData` (旧 §5.1.20) が `Catalog.initDataList` (§5.1.7) +
devtools/src/hooks/useSubscriber.ts:1672:   * render group / alternate group のトラックで値が異なるとき (draft-ietf-moq-msf-01
devtools/src/hooks/useSubscriber.ts:1709:   * 時間軸へ渡し、音声と映像で同じ表示時刻の式を使う (draft-ietf-moq-msf-01 §5.2.8)。
devtools/src/hooks/useSubscriber.ts:1941:   * 置き換えで履歴が揃う (draft-ietf-moq-msf-01 §8.3)。data の構造は catalog の
devtools/src/hooks/useSubscriber.ts:2348:    // 任せる。トークンは authInfo を持つ track には MUST 付与であり (draft-ietf-moq-msf-01
devtools/src/hooks/useSubscriber.ts:2456:    // 宣言され得る (draft-ietf-moq-msf-01 §5.2.8)
devtools/src/hooks/useSubscriber.ts:3044:              // draft-ietf-moq-msf-01 §5.1.6 wire format で deltaUpdate が array 形式の場合は
devtools/src/hooks/useSubscriber.ts:3137:                  // draft-ietf-moq-msf-01 §11.4.3: catalog に紐づくトークンは FETCH にも
devtools/src/hooks/useSubscriber.ts:3198:                // draft-ietf-moq-msf-01 §11.4.3: catalog に紐づくトークンは SUBSCRIBE にも
devtools/src/hooks/useSubscriber.ts:3345:      // draft-ietf-moq-msf-01 §5.2.13 (initRef) → §5.1.7 (initDataList) 経路で initData
devtools/src/hooks/useSubscriber.ts:3391:      // (draft-ietf-moq-msf-01 §11.4.3)、authInfo があるのに解決できるトークンが無い場合は、
tests/e2e/relay/namespace-discovery-subscribe.spec.ts:35: * draft-ietf-moq-msf-01 Section 5 (Catalog)
src/observability.ts:4: * draft-ietf-moq-msf-01 §9 (MOQLOG) と §10 (MOQMETRICS) は、syslog severity と
tests/e2e/devtools-tracks-declaration.spec.ts:46:  // draft-ietf-moq-msf-01 §5.2.8: 宣言が無く isLive が true のときは購読側が遅延を選んでよい MAY
tests/e2e/devtools-tracks-declaration.spec.ts:87:// draft-ietf-moq-msf-01 §5.2.8 / §5.2.11: targetLatency と renderGroup は音声と映像の
src/mediaSubscriber/trackSubscriptions.ts:76: * draft-ietf-moq-msf-01 §11.4.3: authInfo を持つ track には、その track に関係する
src/mediaSubscriber/trackSubscriptions.ts:251:  // draft-ietf-moq-msf-01 §11.4.3: authInfo を持つ track にはトークンを MUST 付与
tests/e2e/relay/audio-capture-fallback.spec.ts:26: * draft-ietf-moq-transport-23 §9.6 (SUBSCRIBE) / draft-ietf-moq-msf-01 Section 5 (Catalog)
src/mediaSubscriber/catalogSubscription.ts:147:   * draft-ietf-moq-msf-01 §11.4.3: track に紐づくトークンは、そのトラックに関係する
src/mediaSubscriber/catalogSubscription.ts:250:          // draft-ietf-moq-msf-01 §11.4.3: catalog に紐づくトークンは SUBSCRIBE にも MUST 付与
src/mediaSubscriber/catalogSubscription.ts:313:          // draft-ietf-moq-msf-01 §11.4.3: catalog に紐づくトークンは FETCH にも MUST 付与
src/mediaSubscriber/catalogSubscription.ts:372:   * targetLatency を決めて再生の入口へ渡す (draft-ietf-moq-msf-01 §5.2.8)。
src/mediaSubscriber/catalogSubscription.ts:402:    // 解決した track から targetLatency を決めて共有の時間軸へ渡す (draft-ietf-moq-msf-01 §5.2.8)
src/mediaSubscriber/catalogSubscription.ts:500:   * catalog トラックは 1 Subgroup の in-order 送出 (draft-ietf-moq-msf-01 §5)
src/mediaSubscriber/catalogSubscription.ts:525:   * group / alternate group の track で値が異なるとき (draft-ietf-moq-msf-01 §5.2.8 の
src/mediaSubscriber/catalogSubscription.ts:538:          `targetLatency differs between tracks in the same render group: audio ${effectiveTargetLatencyMs(this.state.audioTrackInfo)}, video ${effectiveTargetLatencyMs(this.state.videoTrackInfo)} (draft-ietf-moq-msf-01 Section 5.2.8)`,
src/mediaSubscriber/catalogSubscription.ts:549:   * 名前一致で探す (role は draft-ietf-moq-msf-01 §5.2.6 の optional
devtools/src/hooks/useSubscriber.test.ts:201:// width / height は Catalog の任意フィールドである (draft-ietf-moq-msf-01 §5.2.26 / §5.2.27)。
devtools/src/hooks/useSubscriber.test.ts:230:// description に復元しないと復号できない (draft-ietf-moq-msf-01 §5.1.7 + §5.2.13)。
devtools/src/hooks/useSubscriber.test.ts:850:// トラックを購読する (draft-ietf-moq-msf-01 §5.2.4)。event timeline を広告しない
tests/e2e/relay/pubsub.spec.ts:15:// draft-ietf-moq-msf-01 Section 5 (Catalog)
docs/HIGH_LEVEL_API.md:115:  targetLatency?: number; // draft-ietf-moq-msf-01 §5.2.8
docs/HIGH_LEVEL_API.md:119:  renderGroup?: number; // draft-ietf-moq-msf-01 §5.2.11
docs/HIGH_LEVEL_API.md:125:  // authInfo を載せる (draft-ietf-moq-msf-01 §5.2.42)
docs/HIGH_LEVEL_API.md:139:音声と映像で同じ値にするための宣言 (draft-ietf-moq-msf-01 §5.2.8 の MUST) であり、片方だけ
docs/HIGH_LEVEL_API.md:148:draft-ietf-moq-msf-01 由来であり、将来の draft 改版で変わる可能性がある。
docs/HIGH_LEVEL_API.md:163:`channelConfig` は draft-ietf-moq-msf-01 §5.2.28 / §5.2.29 が audio codec の track に
docs/HIGH_LEVEL_API.md:230:(draft-ietf-moq-msf-01 §11.4.3)。
docs/HIGH_LEVEL_API.md:338:新しい Group の先頭 Object として送り直す (draft-ietf-moq-msf-01 §5)。
docs/HIGH_LEVEL_API.md:348:  この予約が catalog を届ける (draft-ietf-moq-msf-01 §5)
docs/HIGH_LEVEL_API.md:351:増える (draft-ietf-moq-msf-01 §6.1)。Object ID は Group の先頭の 0 に固定する (§6.2)。
docs/HIGH_LEVEL_API.md:363:(draft-ietf-moq-msf-01 §11.2 の MUST) ため、`start()` は失敗する。送り直しの送信が失敗した
docs/HIGH_LEVEL_API.md:760:(draft-ietf-moq-msf-01 §11.1.1 / §11.4.3)。詳細は
docs/HIGH_LEVEL_API.md:763:`SETUP` に載せたトークンは、draft-ietf-moq-msf-01 §11.4.3 に従い次の制御メッセージへも付与する
docs/HIGH_LEVEL_API.md:1234:(draft-ietf-moq-msf-01 Section 5.2.8 / Section 5.2.11)。`isLive` が false の track の
docs/HIGH_LEVEL_API.md:1588:音声と映像の track に `"authInfo": {"cat": "%c4m%"}` を載せる。draft-ietf-moq-msf-01
tests/e2e/relay/audio-capture-format.spec.ts:28: * draft-ietf-moq-msf-01 §5.2.28 (samplerate) / §5.2.29 (channelConfig)。草案の改訂で節番号と
tests/e2e/relay/devtools-audio-publish.spec.ts:16: * draft-ietf-moq-msf-01 Section 5 (Catalog) / draft-ietf-moq-loc-05 §4.1 (Application with one
src/createMediaSubscriber.lifecycle.test.ts:3280:  // authInfo がある track は購読前にトークンの解決を要する (draft-ietf-moq-msf-01 §11.4.3)
docs/LOW_LEVEL_API.md:95:根拠は draft-ietf-moq-msf-01 §11.1.1 / §11.4.2 / §11.4.3、draft-ietf-moq-c4m-02 §2 / §8.2 Table 4 /
docs/LOW_LEVEL_API.md:104:draft-ietf-moq-msf-01 §11.4.3: track に紐づくトークンは、そのトラックに関係する
docs/LOW_LEVEL_API.md:702:Joining FETCH は draft-20 で削除された (draft-ietf-moq-transport-23 §A.4)。draft-23 では `FILL_PARAMETERS` (§9.19.15) を持つ SUBSCRIBE が fill fetch stream (§3.4) を開かせる形が正式な置換であり、MSF の catalog 取得 (draft-ietf-moq-msf-01 §5 の Joining FETCH (offset = 0)) も draft-23 前提ではこの fill fetch として解釈する。現状の実装は `subscribe()` (Next Object (`{ nextObject: true }`、Location Filter Type 0x05) の Location Filter) + `fetch()` (絶対開始の Location Filter) の 2 リクエストで代替しており (`createMediaSubscriber` の catalog 取得が該当し、要求範囲は `catalogFetchFilter` が決める)、catalog の fill fetch 化は未実装である。
src/createMediaSubscriber.catalog.test.ts:151:  // draft-ietf-moq-msf-01 §5.2.2: track が namespace を宣言しない場合は catalog track の
src/createMediaSubscriber.catalog.test.ts:345: * draft-ietf-moq-loc-05 §2.2 / §2.3.2.2 と draft-ietf-moq-msf-01 §6.2 / §4.1:
src/createMediaSubscriber.catalog.test.ts:346: * VIDEO_FRAME_MARKING は任意の Property であり、draft-ietf-moq-msf-01 も要求しない。無い場合は
src/createMediaSubscriber.catalog.test.ts:408:// resolveAuthorizationToken（draft-ietf-moq-msf-01 §5.2.42 / §11.4.2 / §11.4.4）
src/createMediaSubscriber.catalog.test.ts:454:// draft-ietf-moq-msf-01 §11.4.3: コールバックが無い場合は、SETUP Option (0x03) として
src/createMediaSubscriber.catalog.test.ts:792: * draft-ietf-moq-msf-01 §5.2.42 / §11.4.3:
src/session.ts:207:   * draft-ietf-moq-msf-01 §11.4.3: track に紐づくトークンは、そのトラックに関係する
src/session.ts:292:   * Authorization Token を渡した場合、draft-ietf-moq-msf-01 §11.4.3 の MUST に従い、
src/session.ts:296:   * @param options - オプション（authorizationToken: draft-ietf-moq-msf-01 §11.4.3 により SUBSCRIBE_NAMESPACE に MUST 付与）
src/session.ts:312:   * Authorization Token を渡した場合、draft-ietf-moq-msf-01 §11.4.3 の MUST に従い、
src/session.ts:374:   * draft-ietf-moq-msf-01 §11.4.3: track に紐づくトークンは、そのトラックに関係する
src/session.ts:798:  // draft-ietf-moq-msf-01 §11.4.3: SETUP に載せたトークンも、track に関係する
src/fullTrackName.test.ts:54: * 仕様の例 (draft-ietf-moq-msf-01 §11.1.3) をそのまま検証する。
src/subscriber.ts:188:  // draft-ietf-moq-msf-01 §11.4.3: track に関連するトークンは REQUEST_UPDATE にも MUST 付与。
src/subscriber.ts:354:   * draft-ietf-moq-msf-01 §11.4.3: 後続の REQUEST_UPDATE に同じトークンを MUST 付与する。
src/moqmetrics.prop.ts:3: * draft-jennings-moq-metrics-03 ([MOQMETRICS]) / draft-ietf-moq-msf-01 §10 (Metrics track)
src/msf/c4mAuthorization.ts:5: * - draft-ietf-moq-msf-01 §11.1.1 (Reserved fragment parameters): c4m は
src/msf/c4mAuthorization.ts:7: * - draft-ietf-moq-msf-01 §11.4.2 / §11.4.3 (Presenting Authorization): 接続 URI の
src/msf/c4mAuthorization.ts:40: * draft-ietf-moq-msf-01 §11.1.1 / draft-ietf-moq-c4m-02 §2:
src/msf/c4mAuthorization.ts:77: * draft-ietf-moq-msf-01 §11.1: fragment はサーバーへ送信されず、クライアントが
src/msf/c4mAuthorization.ts:105:      "msf fragment c4m must be a Base64 encoded C4M token (draft-ietf-moq-msf-01 Section 11.1.1)",
src/msf/fragment.ts:2: * MSF URI fragment 解析 (draft-ietf-moq-msf-01 §11.1)
src/msf/fragment.ts:4: * 参照: draft-ietf-moq-msf-01
src/msf/fragment.ts:13:// MSF URI fragment 解析 (draft-ietf-moq-msf-01 §11.1)
src/msf/fragment.ts:18: * (draft-ietf-moq-msf-01 §11.1)
src/msf/fragment.ts:34: * MSF URI fragment value をパースする (draft-ietf-moq-msf-01 §11.1)
src/msf/fragment.ts:128: * `connection` パラメータの値を取得する (draft-ietf-moq-msf-01 §11.1.1)
src/msf/fragment.ts:146: * (draft-ietf-moq-msf-01 §11.1.1)
src/msf/tracks.ts:3: * (draft-ietf-moq-msf-01 §5.1.7 / §5.2.13 / §6.1)
src/msf/tracks.ts:8: * 参照: draft-ietf-moq-msf-01
src/msf/tracks.ts:21: * (draft-ietf-moq-msf-01 §5.1.7 / §5.2.13)
src/msf/tracks.ts:109: * draft-ietf-moq-msf-01 §5.1.3 (Is Complete):
src/msf/tracks.ts:130: * draft-ietf-moq-msf-01 §5.2.8: `isLive` が false のトラックの `targetLatency` は
src/msf/tracks.ts:153: * draft-ietf-moq-msf-01 §5.2.8 の「同じ値でなければならない MUST」は同じ group の
src/msf/tracks.ts:172: * draft-ietf-moq-msf-01 §5.2.8:
src/msf/tracks.ts:213: * 最初の Group ID を生成する (draft-ietf-moq-msf-01 §6.1)
src/msf/tracks.ts:223: * 次の Group ID を計算する (draft-ietf-moq-msf-01 §6.1)
src/msf/version.ts:2: * MSF の定数 (draft-ietf-moq-msf-01 §5.1.1 / §5.2.4 / §5.2.6 / §5.2.39)
src/msf/version.ts:4: * 参照: draft-ietf-moq-msf-01
src/msf/version.ts:12: * MSF バージョン文字列の型 (draft-ietf-moq-msf-01 §5.1.1)
src/msf/version.ts:24:/** MSF バージョン (encode 時の値, draft-ietf-moq-msf-01 §5.1.1) */
src/msf/version.ts:35:/** Catalog トラック名 (固定, draft-ietf-moq-msf-01 §5) */
src/msf/version.ts:39: * パッケージング形式 (draft-ietf-moq-msf-01 §5.2.4, Table 4)
src/msf/version.ts:47: * トラックの役割 (draft-ietf-moq-msf-01 §5.2.6, Table 5)
src/msf/version.ts:75: * 暗号化スイート (draft-ietf-moq-msf-01 §5.2.39, Table 7)
src/msf/catalogTrackValidation.ts:2: * Catalog track の検証 (draft-ietf-moq-msf-01 §5.2 / §7.2 / §8.2 / §9.4 / §10.4)
src/msf/catalogTrackValidation.ts:9: * 参照: draft-ietf-moq-msf-01
src/msf/catalogTrackValidation.ts:389: * role に応じた Conditional MUST を検証する (draft-ietf-moq-msf-01 §5.2.18 / §5.2.22)
src/msf/catalogTrackValidation.ts:418: * (draft-ietf-moq-msf-01 §5.2.28 / §5.2.29)
src/msf/catalogTrackValidation.ts:608: * MediaTimelineTemplate を検証する (draft-ietf-moq-msf-01 §5.2.15 / §7.4.1)
src/msf/timeline.ts:2: * Media Timeline / Event Timeline の encode / decode (draft-ietf-moq-msf-01 §7.1 / §8.1)
src/msf/timeline.ts:8: * 参照: draft-ietf-moq-msf-01
src/msf/timeline.ts:19: * Media Timeline を JSON バイト列にエンコードする (draft-ietf-moq-msf-01 §7.1)
src/msf/timeline.ts:39: * JSON バイト列を Media Timeline にデコードする (draft-ietf-moq-msf-01 §7.1)
src/msf/timeline.ts:102: * Event Timeline を JSON バイト列にエンコードする (draft-ietf-moq-msf-01 §8.1)
src/msf/timeline.ts:132: * JSON バイト列を Event Timeline にデコードする (draft-ietf-moq-msf-01 §8.1)
src/msf/timeline.ts:179: * オブジェクトが Event Timeline エントリかどうかを検証する (draft-ietf-moq-msf-01 §8.1)
src/msf/catalogValidation.ts:2: * Catalog メッセージの検証 (draft-ietf-moq-msf-01 §5.1 / §5.2)
src/msf/catalogValidation.ts:8: * 参照: draft-ietf-moq-msf-01
src/msf/catalogValidation.ts:30: * unknown 値を `Catalog` として検証して返す (draft-ietf-moq-msf-01 §5.1)
src/msf/catalogValidation.ts:165: * (draft-ietf-moq-msf-01 §5.2.3)
src/msf/catalogValidation.ts:223: * draft-ietf-moq-msf-01 §5.2.13 (initRef) は initDataList (§5.1.7) のエントリを
src/msf/catalogValidation.ts:262: * `RemoveTrack` を検証する (draft-ietf-moq-msf-01 §5.1.6 "remove")
src/msf/catalogValidation.ts:313: * `InitDataEntry` を検証する (draft-ietf-moq-msf-01 §5.1.7)
src/msf/catalogValidation.ts:346: * unknown 値を `CatalogTrack` として検証して返す (draft-ietf-moq-msf-01 §5.2)
src/msf/catalogValidation.ts:436: * (draft-ietf-moq-msf-01 §5.1.6 "clone" + §5.2.33 / §5.2.34)
src/msf/json.ts:9: * 参照: draft-ietf-moq-msf-01 §5.1.2 / §5.2 / §7.4.1 / draft-ietf-moq-transport-23 §8
src/msf/c4m.ts:2: * MSF URI Fragment reserved key helpers (draft-ietf-moq-msf-01 §11.1.1)
src/msf/c4m.ts:6: * 参照: draft-ietf-moq-msf-01
src/msf/c4m.ts:10:// MSF URI Fragment reserved key helpers (draft-ietf-moq-msf-01 §11.1.1)
src/msf/c4m.ts:32: * draft-ietf-moq-msf-01 §11.1.1: range は inclusive。終端省略で open range MAY。
src/msf/c4m.ts:45: * draft-ietf-moq-msf-01 §11.1.1: wallclock-range と同じ形式。
src/msf/c4m.ts:56: * draft-ietf-moq-msf-01 §11.1.1: Group.Object を `.`、範囲を `-` で区切る。
src/msf/c4m.ts:77: * draft-ietf-moq-msf-01 §11.1.1: base64 文字列のまま返す。検証しない。
src/msf/catalogCodec.ts:2: * Catalog / Catalog Delta の encode / decode (draft-ietf-moq-msf-01 §5.1 / §5.1.6 / §5.3)
src/msf/catalogCodec.ts:8: * 参照: draft-ietf-moq-msf-01
src/msf/catalogCodec.ts:37: * draft-ietf-moq-msf-01 §5.1.7: The Initialization Data List, if present,
src/msf/catalogCodec.ts:179: * (draft-ietf-moq-msf-01 §5.1.6 / §5.3)
src/msf/catalogCodec.ts:265: * (draft-ietf-moq-msf-01 §5.1, §5.1.6, §5.3)
src/msf/catalogCodec.ts:308: * (draft-ietf-moq-msf-01 §5.1.6 / §5.3)
src/msf/catalogCodec.ts:376: * (draft-ietf-moq-msf-01 §5.1.6)
src/msf/variables.ts:3: * (draft-ietf-moq-msf-01 §5.4 / §5.2.13 / §5.1.7)
src/msf/variables.ts:9: * 参照: draft-ietf-moq-msf-01
src/msf/variables.ts:27: * (draft-ietf-moq-msf-01 §5.4)
src/msf/catalogDelta.ts:2: * Catalog 差分更新の適用 (draft-ietf-moq-msf-01 §5.1.6 / §5.3)
src/msf/catalogDelta.ts:4: * 参照: draft-ietf-moq-msf-01
src/msf/catalogDelta.ts:26: * (draft-ietf-moq-msf-01 §5.1.6 / §5.3)
src/msf/ownFields.ts:11: * MSF Catalog の未知フィールド保持 (draft-ietf-moq-msf-01 §5 / §5.4) のように、外部から
src/msf/authInfo.ts:2: * catalog の track に載せる Authorization Info (draft-ietf-moq-msf-01 §5.2.42)
src/msf/authInfo.ts:4: * 参照: draft-ietf-moq-msf-01, draft-ietf-moq-c4m-02
src/msf/authInfo.ts:13:/** draft-ietf-moq-msf-01 §5.2.42 Table 7 の CAT のスキーム名 */
src/msf/authInfo.ts:17: * draft-ietf-moq-msf-01 §11.1.1 の予約パラメータ `c4m` を指す変数参照 (§5.4 / §5.2.43)
src/msf/authInfo.ts:28: * draft-ietf-moq-msf-01 §5.2.42: authInfo は track の認可が必要なことを視聴側に示す
src/msf/tracks.test.ts:4: * catalog の `targetLatency` は Number とだけ定められており (draft-ietf-moq-msf-01
src/msf/tracks.test.ts:28:  // draft-ietf-moq-msf-01 §5.2.8 の MUST
src/catalogRepublish.ts:4: * draft-ietf-moq-msf-01 Section 5: "A catalog object SHOULD be published only when the
src/msf/types.ts:2: * MSF の型定義 (draft-ietf-moq-msf-01 §5)
src/msf/types.ts:7: * 参照: draft-ietf-moq-msf-01
src/msf/types.ts:17: * Buffers (draft-ietf-moq-msf-01 §5.2.9)
src/msf/types.ts:28: * Initialization Data List のエントリ (draft-ietf-moq-msf-01 §5.1.7)
src/msf/types.ts:42: * Accessibility descriptor (draft-ietf-moq-msf-01 §5.2.44)
src/msf/types.ts:52: * Authorization Info (draft-ietf-moq-msf-01 §5.2.42, Table 8)
src/msf/types.ts:60: * Media Timeline Template (draft-ietf-moq-msf-01 §5.2.15 / §7.4.1)
src/msf/types.ts:96: * Catalog トラック定義 (draft-ietf-moq-msf-01 §5.2)
src/msf/types.ts:229: * Publish track (draft-ietf-moq-msf-01 §5.1.5)
src/msf/types.ts:244: * (draft-ietf-moq-msf-01 §5.1.6 "remove")
src/msf/types.ts:258: * フルカタログ (draft-ietf-moq-msf-01 §5.1)
src/msf/types.ts:289: * 差分更新カタログの operation (draft-ietf-moq-msf-01 §5.1.6)
src/msf/types.ts:300: * 差分更新カタログ (draft-ietf-moq-msf-01 §5.1.6 / §5.3)
src/msf/types.ts:357: * Media Timeline エントリ (draft-ietf-moq-msf-01 §7.1)
src/msf/types.ts:375: * Event Timeline エントリ (draft-ietf-moq-msf-01 §8.1)
src/createMedia/settings.ts:145: * draft-ietf-moq-msf-01 §5.2.28 (samplerate) / §5.2.29 (channelConfig) は、audio codec の
src/createMediaPublisher.ts:285:// (draft-ietf-moq-msf-01 §6.1: 再開時の開始 Group ID は同一 track で以前に publish した
src/createMediaPublisher.ts:292: * draft-ietf-moq-msf-01 §6.1 (Group ID は track ごとに一意で単調増加が MUST、再開時の
src/createMediaPublisher.ts:322: * draft-ietf-moq-msf-01 §6.1 は、配信を再開したときの開始 Group ID が「同一 track で以前に
src/createMediaPublisher.ts:334:  // (draft-ietf-moq-msf-01 §6.1 の一意性 MUST に反する)
src/createMediaPublisher.ts:386: * 最大 Group ID を追跡できるようにする (draft-ietf-moq-msf-01 §6.1)。
src/createMediaPublisher.ts:414: * 最大 Group ID を追跡できるようにする (draft-ietf-moq-msf-01 §6.1)。
src/createMediaPublisher.ts:444: * 0 に特別な意味を持たせる根拠が MSF / LOC / WebCodecs に無い (draft-ietf-moq-msf-01
src/createMediaPublisher.ts:450: * 節番号は draft-ietf-moq-msf-01 由来であり、将来の draft 改版で変わる可能性がある。
src/createMediaPublisher.ts:777:  // 別の payload を載せない (draft-ietf-moq-transport-23 §2.1 / §7.1、draft-ietf-moq-msf-01 §5)。
src/createMediaPublisher.ts:922:    // draft-ietf-moq-msf-01 §6.1: 開始 Group ID は同一 track の
src/createMediaPublisher.ts:1053:      // Catalog を publish (取り出した形式を載せる)。draft-ietf-moq-msf-01 §11.2 は
src/createMediaPublisher.ts:1113:   * (draft-ietf-moq-msf-01 §11.4.3)。
src/createMediaPublisher.ts:1569:   * draft-ietf-moq-msf-01 §11.4.3: original publisher は track に紐づくトークンを
src/createMediaPublisher.ts:1814:    // draft-ietf-moq-msf-01 §11.4.3: publisher は track に紐づくトークンを PUBLISH に MUST 付与する。
src/createMediaPublisher.ts:1820:    // draft-ietf-moq-msf-01 §6.1: 開始 Group ID は同一 track の過去の全 Group ID を
src/createMediaPublisher.ts:1911:   * draft-ietf-moq-msf-01 §5: All catalog updates, both independent and delta,
src/createMediaPublisher.ts:1915:   * draft-ietf-moq-msf-01 §11.2: An MSF publisher MUST publish a catalog track
src/createMediaPublisher.ts:1936:    // objectId=0 は draft-ietf-moq-msf-01 §5 で MUST 規定 (独立した catalog は Group の
src/createMediaPublisher.ts:1952:   * 限り payload は同じでよい。draft-ietf-moq-msf-01 §5 はトラック構成が変わったときと
src/createMediaPublisher.ts:1972:   * 送信は Group の先頭 Object (Object ID 0) に固定する (draft-ietf-moq-msf-01 §5)。
src/createMediaPublisher.ts:1979:   * (draft-ietf-moq-msf-01 §5 は同じ Group の Object ID 1 以降を delta update とする MUST を
src/createMediaPublisher.ts:2008:   * (draft-ietf-moq-msf-01 §5 / §6.1。草案の改訂でこれらの規定が変わる可能性がある)。
src/createMediaPublisher.ts:2095:   * draft-ietf-moq-msf-01 §5.2.8: 同じ render group と alternate group の track は
src/createMediaPublisher.ts:2104:   * authInfo を載せ、視聴側に同じ方式のトークンの提示を求める (draft-ietf-moq-msf-01
src/session.prop.ts:71:  // draft-ietf-moq-msf-01 §11.4.3: PUBLISH に付与する認可トークン
src/fullTrackName.ts:132: * escapeFullTrackNameSegment の規則でエスケープする。draft-ietf-moq-msf-01
src/fullTrackName.ts:161: * §8.8 の規則は draft-ietf-moq-msf-01 §11.1.2 が MSF fragment の namespace-name
src/fullTrackName.ts:223: * 戻す。formatTrackNamespace の逆変換であり、draft-ietf-moq-msf-01 §11.1.2 の
src/connect.test.ts:4: * draft-ietf-moq-msf-01 §11.1.1 (c4m) / §11.4.2 / §11.4.3 (Presenting Authorization):
src/connect.test.ts:247:    "msf fragment c4m must be a Base64 encoded C4M token (draft-ietf-moq-msf-01 Section 11.1.1)",
src/moqmetrics.test.ts:3: * draft-jennings-moq-metrics-03 ([MOQMETRICS]) / draft-ietf-moq-msf-01 §10 (Metrics track)
devtools/src/signals/connectionSettings.ts:291:// ならない (draft-ietf-moq-msf-01 §5.2.3)。既定値は src/createMedia/settings.ts の
devtools/src/signals/connectionSettings.ts:374:// draft-ietf-moq-msf-01 §5.2.8 (targetLatency): 同じ render group と alternate group の
devtools/src/signals/connectionSettings.ts:379:// draft-ietf-moq-msf-01 §5.2.11 (renderGroup): 同じ group の track は同時に描画する SHOULD。
devtools/src/signals/connectionSettings.ts:433:// draft-ietf-moq-msf-01 §11.1.1 / draft-ietf-moq-c4m-02 §2
devtools/src/signals/connectionSettings.ts:527: * draft-ietf-moq-msf-01 §11.1.1: c4m は Base64 encoded C4M token。
devtools/src/signals/connectionSettings.ts:559: * Authorization Token として送る (draft-ietf-moq-msf-01 §11.1.1 / §11.4.3)。
devtools/src/signals/connectionSettings.ts:640: * draft-ietf-moq-msf-01 §11.1.2: msf fragment の track-identifier の `--` より左が
devtools/src/signals/connectionSettings.ts:1018: * (draft-ietf-moq-msf-01 §11.1.1)、msf fragment の namespace を取り出す。入力のたびに
src/connect.ts:68:  // draft-ietf-moq-msf-01 §11.1.1: connection=q|wt は transport 選択を強制する。
src/connect.ts:72:  // draft-ietf-moq-msf-01 §11.1.1 / §11.4.2 / §11.4.3:
src/playout/timeline.ts:4: * 同じ render group の track は同じ targetLatency を持ち (draft-ietf-moq-msf-01 §5.2.8)、
src/playout/timeline.ts:770:   * 同じ render group の track は同じ値でなければならない (draft-ietf-moq-msf-01 §5.2.8)
devtools/src/signals/statsSnapshot.test.ts:489:  // audio / video 以外のデータ (draft-ietf-moq-msf-01 §8) として受信した entry を
src/msf.test.ts:2: * MSF (MOQT Streaming Format) の単体テスト (draft-ietf-moq-msf-01 追従)
src/msf.test.ts:825:// (draft-ietf-moq-msf-01 §5.2.6 Table 5 の audio 系 role は audio と audiodescription で、
src/msf.test.ts:1273:// draft-ietf-moq-msf-01 §9.4: packaging="moqlog" の Log track は role="log" が MUST。
src/msf.test.ts:1308:// draft-ietf-moq-msf-01 §10.4: packaging="moqmetrics" の Metrics track は role="metrics" が MUST。
src/msf.test.ts:3229:// catalog の track に載せる Authorization Info (draft-ietf-moq-msf-01 §5.2.42)
src/msf.test.ts:3321:// draft-ietf-moq-msf-01 §11.1.1 (c4m) / §11.4.3 (Presenting Authorization)
src/msf.test.ts:3425:    "msf fragment c4m must be a Base64 encoded C4M token (draft-ietf-moq-msf-01 Section 11.1.1)",
src/msf.prop.ts:2: * MSF (MOQT Streaming Format) の PBT テスト (draft-ietf-moq-msf-01)
src/msf.prop.ts:48: * draft-ietf-moq-msf-01 §5.2.4 Table 4 の全 reserved 値:
src/msf.prop.ts:66: * draft-ietf-moq-msf-01 §5.2.6 Table 5 の全 reserved 値:
src/msf.prop.ts:1025:  // draft-ietf-moq-msf-01 §5.6.1
src/msf.prop.ts:1070:  // draft-ietf-moq-msf-01 §5.6.2
src/msf.prop.ts:1091:  // draft-ietf-moq-msf-01 §5.6.3
src/msf.prop.ts:1110:  // draft-ietf-moq-msf-01 §5.6.4 (draft-00 §5.3.4 から仕様変更)
src/msf.prop.ts:1151:  // draft-ietf-moq-msf-01 §5.6.5 (draft-00 §5.3.5 から仕様変更)
src/msf.prop.ts:1174:  // draft-ietf-moq-msf-01 §5.6.7 (draft-00 §5.3.7 から仕様変更)
src/createMediaSubscriber.ts:251: * (draft-ietf-moq-msf-01 §5)。したがって最新 Group の先頭から要求すれば完全な
src/createMediaSubscriber.ts:256: * 跨いだ単調増加 MUST (draft-ietf-moq-msf-01 §6.1) を満たすため Unix epoch
src/createMediaSubscriber.ts:292: * (§2.2 は LOC の拡張を optional metadata と定める)、draft-ietf-moq-msf-01 も
src/createMediaSubscriber.ts:296: * Object ID 0 が Group の先頭 Object であることは draft-ietf-moq-msf-01 §6.2 が
src/createMediaSubscriber.ts:313: * @param objectId Object の Object ID (Group 先頭は 0。draft-ietf-moq-msf-01 §6.2)
src/createMediaSubscriber.ts:387: * 常に `deltaUpdate: true`。wire の boolean 形式ではない。draft-ietf-moq-msf-01 §5.1.6）。
src/catalogRepublish.prop.ts:6: * (draft-ietf-moq-transport-23 Section 10.3、draft-ietf-moq-msf-01 Section 5)。
devtools/src/signals/subscriber.ts:335:  // その時点の全履歴を載せるため、受信のたびに置き換える (draft-ietf-moq-msf-01 §8.3)
src/catalogRepublish.test.ts:4: * draft-ietf-moq-msf-01 Section 5: catalog は配信網の cache から落ちうる時間が過ぎたら
src/moqlog.test.ts:3: * draft-jennings-moq-log-04 ([MOQLOG]) / draft-ietf-moq-msf-01 §9 (Log track)
devtools/src/signals/connectionSettings.test.ts:866:// 目標遅延 (draft-ietf-moq-msf-01 §5.2.8) と同時レンダリンググループ (§5.2.11) の既定は
devtools/src/signals/connectionSettings.test.ts:1146:// 外れないようにする (draft-ietf-moq-msf-01 §11.1.2)
devtools/src/signals/connectionSettings.test.ts:1696:// 送る (draft-ietf-moq-msf-01 §11.1.1 / §11.4.3)。画面で取り込みを解除しただけでは URL に
src/playout/mediaPlayout.ts:215:   * `draft-ietf-moq-msf-01 §5.2.8` の `targetLatency`。MUST は同じ render group と
devtools/src/utils/msfFragment.ts:4: * MOQT URI / URI Fragment の入力欄から msf fragment を取り出し、draft-ietf-moq-msf-01 §11.1 の
devtools/src/utils/msfFragment.ts:18: * draft-ietf-moq-msf-01 §11.1.2: track-identifier の `--` より左が Track Namespace の
devtools/src/utils/catalogValue.test.ts:4:// catalog の値は JSON の値である (draft-ietf-moq-msf-01 §5.1)。接続設定の Tracks カードと
src/msf.ts:6: * 参照: draft-ietf-moq-msf-01
src/msf.ts:16:// 定数 (draft-ietf-moq-msf-01 §5.1.1 / §5.2.4 / §5.2.6 / §5.2.39)
src/msf.ts:26:// Catalog / Timeline の型 (draft-ietf-moq-msf-01 §5 / §7.1 / §8.1)
src/msf.ts:45:// Catalog encode/decode (draft-ietf-moq-msf-01 §5.1 / §5.1.6 / §5.3)
src/msf.ts:48:// Catalog 検証 (draft-ietf-moq-msf-01 §5.1 / §5.2)
src/msf.ts:51:// audio codec の判定 (draft-ietf-moq-msf-01 §5.2.28 / §5.2.29。WebCodecs Codec Registry §3)
src/msf.ts:54:// Catalog 差分更新の適用 (draft-ietf-moq-msf-01 §5.1.6 / §5.3)
src/msf.ts:57:// Media Timeline / Event Timeline の encode/decode (draft-ietf-moq-msf-01 §7.1 / §8.1)
src/msf.ts:65:// Variable Substitution (draft-ietf-moq-msf-01 §5.4)
src/msf.ts:68:// catalog の track に載せる Authorization Info (draft-ietf-moq-msf-01 §5.2.42)
src/msf.ts:71:// MSF URI fragment 解析 (draft-ietf-moq-msf-01 §11.1)
src/msf.ts:79:// MSF URI Fragment reserved key helpers (draft-ietf-moq-msf-01 §11.1.1)
src/msf.ts:89:// (draft-ietf-moq-msf-01 §11.1.1 / §11.4.3, draft-ietf-moq-c4m-02 §8.2)
src/msf.ts:93:// (draft-ietf-moq-msf-01 §5.1.7 / §5.2.13 / §6.1)
devtools/src/utils/catalogValue.ts:6: * catalog の値は JSON の値である (draft-ietf-moq-msf-01 §5.1)。数値と文字列はそのまま
devtools/src/signals/publisher.ts:71:// 行う。draft-ietf-moq-msf-01 §6.1 は Group ID が track ごとに一意で単調増加することを
devtools/src/signals/publisher.ts:228:// メッセージを送る (draft-ietf-moq-msf-01 §8)。Group ID はメッセージごとに進める
src/moqlog.ts:3: * draft-jennings-moq-log-04 ([MOQLOG]) / draft-ietf-moq-msf-01 §9 (Log track)
src/moqmetrics.ts:3: * draft-jennings-moq-metrics-03 ([MOQMETRICS]) / draft-ietf-moq-msf-01 §10 (Metrics track)
src/moqmetrics.ts:384: * draft-ietf-moq-msf-01 §10.2 / [MOQMETRICS] §5.2。syslog severity と同じ 8 段階を使う。
src/moqmetrics.ts:592: * data track の Group ID を計算する（[MOQMETRICS] §5.4 / draft-ietf-moq-msf-01 §10.3）
src/createMediaSubscriber.media.test.ts:1623:  // (draft-ietf-moq-msf-01 §5)、最新 Group の先頭から要求すれば完全な catalog が
src/createMediaSubscriber.media.test.ts:1704: * draft-ietf-moq-msf-01 §11.4.3: track に紐づくトークンは、そのトラックに関係する
src/session.test.ts:2693: * draft-ietf-moq-msf-01 §11.4.3:
src/session.test.ts:11087: * draft-ietf-moq-msf-01 §11.4.3:
src/session.test.ts:13564: * draft-ietf-moq-msf-01 §11.4.3: track に紐づくトークンは、そのトラックに関係する
devtools/src/utils/publishTracks.ts:9: * トラック名は draft-ietf-moq-msf-01 §5.2.3 で Required であり、catalog の中で
devtools/src/utils/publishTracks.ts:49:    throw new Error("track name must not be empty per draft-ietf-moq-msf-01 §5.2.3");
devtools/src/utils/publishTracks.ts:52:    throw new Error("track names must be unique per namespace per draft-ietf-moq-msf-01 §5.2.3");
devtools/src/utils/msfFragment.test.ts:5: * draft-ietf-moq-msf-01 §11.1 の namespace / track name / parameter を取り出せることを
devtools/src/signals/statsSnapshot.ts:452:   * data の構造は catalog の eventType が定義する (draft-ietf-moq-msf-01 §5.2.5)。
devtools/src/utils/serverUrlStore.ts:58:    // msf fragment の解析と connection=q の拒否 (draft-ietf-moq-msf-01 §11.1.1)
devtools/src/utils/serverUrlStore.ts:60:    // c4m の Base64 復号 (draft-ietf-moq-msf-01 §11.1.1 / §11.4.3)
devtools/src/utils/eventTimeline.ts:4: * event timeline (draft-ietf-moq-msf-01 §8) を devtools で扱うための純関数
devtools/src/utils/eventTimeline.ts:21: * draft-ietf-moq-msf-01 §8.3 は、Group の先頭 Object に「それまでに蓄積されアクセス可能な
devtools/src/utils/trackAuthorization.ts:9: * draft-ietf-moq-msf-01 §11.4.3: track に紐づくトークンは、そのトラックに関係する
devtools/src/utils/c4m.ts:105: * draft-ietf-moq-msf-01 §11.1.1:
devtools/src/utils/c4m.ts:144: * 端数のビットが 0 でない入力 (draft-ietf-moq-msf-01 §11.1.1 の例) の緩さだけを残す。
devtools/src/utils/c4m.ts:163: * C4M のトークンは URL では Base64 encoded と定められる (draft-ietf-moq-msf-01 §11.1.1 /
devtools/src/utils/c4m.ts:200: * Authorization Token として送る (draft-ietf-moq-msf-01 §11.1.1 / §11.4.3)。
devtools/src/utils/c4m.ts:390: * c4m は Base64 encoded C4M token (CAT) を持つ (draft-ietf-moq-msf-01 §11.1.1)。
src/codec/config.test.ts:260: * draft-ietf-moq-msf-01 §5.2.29 は channelConfig の値語彙を定義せず、
devtools/src/utils/publishTracks.test.ts:10:// draft-ietf-moq-msf-01 §5.2.3: track name は Required で、catalog の中で namespace ごとに
devtools/src/utils/publishTracks.test.ts:39:    /track name must not be empty per draft-ietf-moq-msf-01 §5\.2\.3/,
devtools/src/utils/publishTracks.test.ts:43:    /track names must be unique per namespace per draft-ietf-moq-msf-01 §5\.2\.3/,
devtools/src/utils/c4m.test.ts:18:// draft-ietf-moq-msf-01 §11.1.1 の c4m 例 (パディング省略の Base64)
devtools/src/utils/c4m.prop.ts:352:// c4m は URL では標準 Base64 (draft-ietf-moq-msf-01 §11.1.1)、トークンでは base64url
devtools/src/utils/eventTimeline.test.ts:28:// draft-ietf-moq-msf-01 §8.1: entry は index 参照を 1 つ持ち、data の構造は
devtools/src/utils/eventTimeline.test.ts:56:// draft-ietf-moq-msf-01 §8.3: Group の先頭 Object には、それまでに蓄積されアクセス
devtools/src/utils/trackAuthorization.test.ts:12:// draft-ietf-moq-msf-01 §11.4.3: publisher は PUBLISH / PUBLISH_NAMESPACE にトークンを
src/codec/config.ts:101: * draft-ietf-moq-msf-01 §5.2.29 は channelConfig を「複雑なチャンネル構成を
devtools/src/components/ConnectionSettings.tsx:236:              href="https://datatracker.ietf.org/doc/html/draft-ietf-moq-msf-01"
devtools/src/components/ConnectionSettings.tsx:241:              draft-ietf-moq-msf-01
devtools/src/components/ConnectionSettings.tsx:465:// トラック名の問題の表示。draft-ietf-moq-msf-01 §5.2.3: name は Required で、
devtools/src/components/ConnectionSettings.tsx:468:  empty: "Track name must not be empty (draft-ietf-moq-msf-01 §5.2.3)",
devtools/src/components/ConnectionSettings.tsx:469:  duplicate: "Audio and video track names must differ (draft-ietf-moq-msf-01 §5.2.3)",
devtools/src/components/ConnectionSettings.tsx:1590:                  {/* draft-ietf-moq-msf-01 §5.2.8 (targetLatency) / §5.2.11 (renderGroup):
src/codec/types.ts:304:  // draft-ietf-moq-msf-01 §5.2.8 (targetLatency)
src/codec/types.ts:314:  // draft-ietf-moq-msf-01 §5.2.11 (renderGroup)
src/codec/types.ts:326:  // draft-ietf-moq-msf-01 §11.4.3: track に紐づくトークンは PUBLISH へも MUST 付与する。
src/codec/types.ts:365:  // draft-ietf-moq-msf-01 §5.2.2 のとおり、catalog の track が namespace を宣言しない
src/codec/types.ts:381:  // draft-ietf-moq-msf-01 §11.4.3: track に紐づくトークンは SUBSCRIBE / FETCH へも
src/codec/types.ts:386:  // draft-ietf-moq-msf-01 §11.4.2: トークン取得は仕様の対象外のためコールバックで注入する。
devtools/src/components/CatalogTracks.tsx:9: * draft-ietf-moq-msf-01 §5.2.2: track object の `namespace` は省略可能で、省略時は
devtools/src/components/CatalogTracks.tsx:59: * draft-ietf-moq-msf-01 §5.2.4 (Table 3 / Table 4): `loc` は音声 / 映像などの
devtools/src/components/TrackDeclaration.tsx:16: * 配信で送る catalog の値 (draft-ietf-moq-msf-01 §5.1) を、下の Audio / Video / Catalog
src/createMediaPublisher.test.ts:3003:  // draft-ietf-moq-msf-01 §6.1: 開始 Group ID は同一 track の過去の全 Group ID を上回る。
src/createMediaPublisher.test.ts:3040: * FIN で閉じる MUST。catalog は delta を送らない (draft-ietf-moq-msf-01 §5) ため、Group の
src/createMediaPublisher.test.ts:3445: * 完了条件 (draft-ietf-moq-msf-01 §11.2): catalog の Object を media の Object より先に
src/createMediaPublisher.test.ts:4118:  // draft-ietf-moq-msf-01 §6.1: 配信を再開したときの開始 Group ID は、同一 track で
src/createMediaPublisher.test.ts:5686:  // (draft-ietf-moq-msf-01 §6.1。allocateInitialGroupId は候補より前回値を優先する)
src/createMediaPublisher.test.ts:6743: * draft-ietf-moq-msf-01 §5.2.8 (targetLatency) / §5.2.11 (renderGroup):
src/createMediaPublisher.test.ts:6776: * draft-ietf-moq-msf-01 §5.2.8: 宣言が無く isLive が true のときは購読側が表示の遅れを
src/createMediaPublisher.test.ts:6798: * draft-ietf-moq-msf-01 §5.2.42 / §11.4.1: 視聴側は catalog の track の authInfo を見て、
src/createMediaPublisher.test.ts:7006: * draft-ietf-moq-transport-23 §5.1.1 / draft-ietf-moq-msf-01 §5:
src/createMediaPublisher.test.ts:7047: * draft-ietf-moq-msf-01 §11.4.3: publisher は track に紐づくトークンを PUBLISH へ MUST 付与する
src/session/types.ts:39:   * draft-ietf-moq-msf-01 §11.4.3:
src/session/types.ts:82:   * draft-ietf-moq-msf-01 §11.4.3 の MUST (SUBSCRIBE_NAMESPACE / REQUEST_UPDATE を
src/session/requests.ts:604:  // draft-ietf-moq-msf-01 §11.4.3: 後続の REQUEST_UPDATE に同じトークンを付与するため保持
src/session/publicTypes.ts:206:   * (draft-ietf-moq-msf-01 §11.1.1 / §11.4.3, draft-ietf-moq-c4m-02 §8.2 Table 4)。
src/session/publicTypes.ts:534:   * draft-ietf-moq-msf-01 §11.4.3: track に紐づくトークンは、そのトラックに関係する
src/session/publicTypes.ts:799:   * draft-ietf-moq-msf-01 §11.4.3: track に関連するトークンは SUBSCRIBE に MUST 付与。
src/session/publicTypes.ts:952:   * REQUEST_UPDATE にも同じ値を付与する (draft-ietf-moq-msf-01 §11.4.3 の MUST。
src/session/publicTypes.ts:1064:   * draft-ietf-moq-msf-01 §11.4.3: track に関連するトークンは FETCH に MUST 付与。
src/session/publicTypes.ts:1216:  // Authorization Token は公開オプションに持たせない。draft-ietf-moq-msf-01 §11.4.3 の
src/session/params.test.ts:37:// AUTHORIZATION_TOKEN 付与（draft-ietf-moq-msf-01 §11.4.3）
src/session/params.test.ts:52:// draft-ietf-moq-msf-01 §11.4.3: publisher は track に紐づくトークンを PUBLISH へ MUST 付与する。
src/session/namespaces.ts:211:  // AUTHORIZATION_TOKEN (0x03) - draft-ietf-moq-msf-01 §11.4.3: SUBSCRIBE_NAMESPACE に MUST 付与。
src/session/namespaces.ts:229:  // draft-ietf-moq-msf-01 §11.4.3: 購読に紐づくトークンは REQUEST_UPDATE にも
src/session/namespaces.ts:347:  // draft-ietf-moq-msf-01 §11.4.3: 購読に紐づくトークンは REQUEST_UPDATE にも
src/session/params.ts:413:  // draft-ietf-moq-msf-01 §11.4.3: publisher は track に紐づくトークンを PUBLISH に MUST 付与
src/session/params.ts:879:  // draft-ietf-moq-msf-01 §11.4.3: track に関連するトークンは SUBSCRIBE に MUST 付与。
src/session/params.ts:985:  // draft-ietf-moq-msf-01 §11.4.3: track に関連するトークンは FETCH に MUST 付与。
src/session/params.ts:1007:  // draft-ietf-moq-msf-01 §11.4.3: track に関連するトークンは SUBSCRIBE_NAMESPACE に MUST 付与。
src/session/incomingPublish.ts:965:  // 一方 draft-ietf-moq-msf-01 §11.4.3 は、track に関連するトークンを、その Track に
src/session/bidi.ts:4045:  // AUTHORIZATION_TOKEN (0x03) - draft-ietf-moq-msf-01 §11.4.3:
src/session/bidi.ts:4190: * draft-ietf-moq-msf-01 §11.4.3:
src/session/bidi.ts:4283:  // AUTHORIZATION_TOKEN (0x03) - draft-ietf-moq-msf-01 §11.4.3 / §9.19.2:
src/session/connection.ts:153:  // draft-ietf-moq-msf-01 §11.4.3: SETUP に載せたトークン。
src/session/connection.ts:356:  // draft-ietf-moq-msf-01 §11.4.3: SETUP に載せたトークンは、そのトラックに関係する
src/session/bidiSendNamespaceRequestUpdate.test.ts:564: * draft-ietf-moq-msf-01 §11.4.3:
src/session/bidiSendNamespaceRequestUpdate.test.ts:599: * (draft-ietf-moq-msf-01 §11.4.3 の MUST はトークンが紐づく場合だけ適用される)。
```
