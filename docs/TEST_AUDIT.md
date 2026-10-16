# テスト監査 (2026-10-13)

「テストが多過ぎる。無駄なテスト、とくに PBT の無駄を確認する」という依頼に対する調査結果。

## 結論

無駄はある。とくに PBT は次の 2 点で無駄が多い。

1. **`*.prop.ts` の 500 テストのうち 79 件 (15.8%) が fast-check を一切使っていない。**
   PBT ファイルに置かれただけの単体テストであり、うち 7 件は対応する `*.test.ts` と本体が完全一致している。
2. **期待値をプロダクションコードの式から写した「写経」プロパティがある。**
   実装を書き換えない限り絶対に落ちないため、テストとして何も守っていない。

単体テスト側は「PBT でカバー済みの性質をなぞる」重複が広範囲にある。
一方で実行時間は 4.03 秒と短く、**コストの本体は保守 (113,011 行のテストコード、3,980 テスト) であって CI 時間ではない。**

## 1. 規模

| 項目                                             | 値                                          |
| ------------------------------------------------ | ------------------------------------------- |
| テストファイル                                   | 219                                         |
| テスト                                           | 3,980                                       |
| テストコード                                     | 113,011 行 (`src` + `devtools/src`)         |
| 実装コード                                       | 93,839 行                                   |
| `vp test run`                                    | 4.03 秒                                     |
| PBT ファイル                                     | 51 (`*.prop.ts`)                            |
| PBT テスト                                       | (プロパティ 421 + 非 PBT 79)                |
| PBT コード                                       | 22,216 行                                   |
| `fc.assert` / `fc.property` / `fc.asyncProperty` | 430 / 393 / 38                              |
| カバレッジ                                       | 83.60% stmts / 79.71% branch / 83.05% funcs |

### カバレッジの偏り

テストは純関数に厚く、ブラウザ API に依存する実装に薄い。

| 領域                 | Stmts  |
| -------------------- | ------ |
| `src/message`        | 99.10% |
| `src/dataStream`     | 95.32% |
| `src/session`        | 91.57% |
| `src/c4m` (大半)     | 100%   |
| `src/codec`          | 47.58% |
| `AudioEncoder.ts`    | 0.00%  |
| `VideoEncoder.ts`    | 34.48% |
| `AudioDecoder.ts`    | 38.46% |
| `devtools/src/hooks` | 24.29% |
| `useSubscriber.ts`   | 22.08% |
| `usePublisher.ts`    | 27.02% |

## 2. PBT の無駄 (最重要)

### 2.1 PBT ファイル内の非 PBT テスト 79 件

`test()` 本体に `fc.` が一度も現れないテスト。PBT の枠組み (反例探索) を使っていない。

| ファイル                        | 全テスト | 非 PBT |
| ------------------------------- | -------- | ------ |
| `src/loc.prop.ts`               | 57       | **40** |
| `src/msf.prop.ts`               | 36       | **18** |
| `src/message/session.prop.ts`   | 14       | 6      |
| `src/grease.prop.ts`            | 10       | 3      |
| `src/session/incoming.prop.ts`  | 19       | 3      |
| `src/session.prop.ts`           | 17       | 3      |
| `src/c4m/cose.prop.ts`          | 18       | 1      |
| `src/c4m/webcrypto.prop.ts`     | 9        | 1      |
| `src/message/namespace.prop.ts` | 18       | 1      |
| `src/message/publish.prop.ts`   | 5        | 1      |
| `src/playout/timeline.prop.ts`  | 4        | 1      |
| `src/session/params.prop.ts`    | 43       | 1      |
| 合計                            | 500      | **79** |

`src/loc.prop.ts` は実質もう 1 つの単体テストファイルになっており、`loc.test.ts` (66 テスト) と合わせて `src/loc.ts` (903 行) に 123 テストが付いている。

### 2.2 対応する `*.test.ts` と本体が完全一致する 7 件

機械的な本文比較で検出した。同じテストを 2 ファイルで保守している。

| PBT 側                                                                     | 単体テスト側           |
| -------------------------------------------------------------------------- | ---------------------- |
| `src/msf.prop.ts:435` Media Timeline: 空配列 round-trip                    | `src/msf.test.ts:1882` |
| `src/msf.prop.ts:442` Media Timeline: 不正な形式は throw                   | `src/msf.test.ts:1902` |
| `src/msf.prop.ts:475` Event Timeline: 空配列 round-trip                    | `src/msf.test.ts:1911` |
| `src/msf.prop.ts:482` Event Timeline: data 欠落は throw                    | `src/msf.test.ts:1918` |
| `src/msf.prop.ts:805` createInitialGroupId: Unix ms ベースの bigint        | `src/msf.test.ts:2117` |
| `src/msf.prop.ts:862` selectHighest/LowestBitrateTrack: altGroup           | `src/msf.test.ts:2145` |
| `src/msf.prop.ts:726` applyCatalogDelta: add でトラック追加 (同名・同本文) | `src/msf.test.ts:1335` |

`src/msf.prop.ts` の 726 以降は `applyCatalogDelta` / 仕様書例の固定値テストで占められており、PBT ファイルとして成立していない。

### 2.3 期待値が実装式そのもの (写経) のプロパティ

実装と同じ式で期待値を書いているため、実装を変えない限り落ちない。

| 箇所                                                  | 内容                                                                                                                                                                 |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/session/params.prop.ts:898`                      | `validateFetchOkEndLocation` の期待値を `compareLocations(endLocation, startLocation) < 0` で書いており、実装 (`params.ts:1074-1082`) の条件式と同一                 |
| `src/session/params.prop.ts:975`                      | `namespacePrefixesOverlap(a, b)` の期待値が `matchNamespacePrefix(b, a) !== null \|\| matchNamespacePrefix(a, b) !== null` で、実装 (`params.ts:1246-1251`) そのまま |
| `src/session/params.prop.ts:1000`                     | `validateNamespacePrefixUpdate` の期待値が実装のループ (`params.ts:1274-1285`) の写し                                                                                |
| `src/grease.prop.ts:31`                               | `0x7f * n + 0x9d` は `grease.ts:52` の式そのまま。同ファイル 14-19 行が代表値を pin 済み                                                                             |
| `src/moqlog.prop.ts:83`                               | `timestampMicros & ((1n << 62n) - 1n)` は `observability.ts:55` の写し                                                                                               |
| `src/moqmetrics.prop.ts:78`                           | 同上 (`observability.ts:51-56`)                                                                                                                                      |
| `devtools/src/utils/playoutTimingStats.prop.ts:29-37` | 「実装と独立したモデル」と書きながら `Math.max(0, Math.ceil(ratio * n) - 1)` は `src/playout/timingSummary.ts:35-37` と同一式                                        |

`src/grease.prop.ts` はさらに 40-49 行 (剰余不変条件) と 52-58 行 (単調増加) が 31 行から算術的に従うため、3 テストまとめて削除できる。

### 2.4 入力が結果に影響しないのに 100 回回しているプロパティ

| 箇所                                        | 内容                                                                                      |
| ------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `src/filter.prop.ts:313`                    | `nextObjectFilterArb` は `fc.constant`、`largestLocation` は `null` 固定。入力 1 通り     |
| `src/session/incoming.prop.ts:1339` `:1355` | `requestId` を振るが結果が ID 非依存                                                      |
| `src/publisher.prop.ts:90`                  | `done` は `markClosed()` を呼ぶだけで生成の 1/3 が重複                                    |
| `src/playout/audioPlayout.prop.ts:398`      | `reset()` が `offsetMs` を null に戻すため、先頭の `updates` がどの assert にも寄与しない |
| `src/namespaceLoops.prop.ts:939`            | 生成したメッセージがアサーションに一切使われない (3 ループ × 100 回)                      |
| `src/namespaceLoops.prop.ts:1041`           | `validSequenceArb` が `fc.constant` 1 件のみで 100 回同一入力                             |

`src/c4m/moqt.prop.ts:647` は逆の問題で、`fc.bigInt` が小さい値に偏るため prefix / suffix 分岐に入らない試行が 27% ある (実測)。

### 2.5 名前に反した弱い検証

| 箇所                                                       | 内容                                                                                                                                                |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/properties.prop.ts:252` `:264`                        | 「encodeProperty のラウンドトリップ」と名乗るが decode しておらず、検証は `encoded.length >= 2` のみ。実装は常に 2 バイト以上を返すため落ちない     |
| `src/c4m/cat.test.ts:493`                                  | 「タグの付与オプションを尊重する」と名乗るが `{coseTag:false, cwtTag:false}` のタグの有無を一切検証していない (`:303` は `d8 3d d1` を確認している) |
| `src/c4m/cat.test.ts:711`                                  | `captureThrownError` が undefined のときだけ assert する条件付き検証。throw 側に落ちれば素通りする                                                  |
| `devtools/src/hooks/useCopyFeedback.test.ts:7` `:17`       | `typeof === "function"` と `assert.ok(true)` のみ。フックの挙動を一切見ていない                                                                     |
| `devtools/src/utils/dummyAudio.test.ts:77`                 | 96000 サンプルは 440Hz の 880 周期ちょうどで、継ぎ目の差は約 3e-14。閾値 0.05 に対して恒真                                                          |
| `devtools/src/signals/keyframeIntervalDefaults.test.ts:39` | `[1, 2, 3, 4].includes(2)`。選択肢は ConfigPanel に直書きで import しておらず、変えても落ちない                                                     |

### 2.6 過剰な numRuns

| 箇所                                                | numRuns | 実測                                                                                |
| --------------------------------------------------- | ------- | ----------------------------------------------------------------------------------- |
| `src/c4m/moqt.prop.ts:701`                          | 2000    | 104 ms。成功側 assert が `decodeMoqtScope` の保証により恒真で、根拠が空振りしている |
| `devtools/src/utils/playoutTimingStats.prop.ts:339` | 1000    | 43 ms。325-331 行の 3 assert が構造的恒真                                           |

他は 25〜500。`devtools/src/utils/c4m.prop.ts` と `debugExportText.prop.ts` の 200 は既定 100 で足りる。

## 3. 単体テスト側の無駄

PBT が存在するモジュールで、PBT と同じ性質を固定値でなぞるテストが広範囲にある。
規約「PBT でカバーできるものを単体テストで書かないこと」の適用漏れ。

代表例 (いずれも PBT 側のカバー箇所を確認済み):

- **末尾データ違反系 13 件**: `src/message/namespace.test.ts:41/55/67/79/93/107`、`subscribe.test.ts:24/41`、`publish.test.ts:54`、`trackstatus.test.ts:19`、`fetch.test.ts:119`。prop 側が任意長の後続列で検証済みで、単体側はメッセージ文言の pin のみ
- **Request ID 検証 6 件**: `src/message/parameter.test.ts:55/67/83/98/122/134` (`decodeLocationFilter` の 6 分岐) → `parameter.prop.ts:87` が同じ 6 分岐を `fc.constant` で網羅
- **Subgroup Header roundtrip 5 件**: `src/dataStream.subgroup.test.ts:689/709/732/754/792` → `dataStream.prop.ts:521`。prop のコメント自身が「単体はエラーパスに絞る」と宣言しているのに残っている
- **Immutable Properties roundtrip 4 件**: `src/properties.test.ts:169/177/189/201` → `properties.prop.ts:281`
- **`src/session/params.test.ts:373/390/416/436`**: `includeProperties` の 3 状態を 4 関数分コピー → `params.prop.ts:674/754/791/836`
- **`src/c4m/moqt.test.ts:130/153/171/189/444`**: 有限宇宙の全列挙は `moqt.prop.ts:463` が担当
- **`src/session/params.prop.ts:898`**: 上記のとおり逆に prop 側が写経なので、単体側 (`params.test.ts:292/301`) を残して prop を削るのが正しい

同一ファイル内・ファイル間の重複も多い。
`src/session/bidi*` 系では 1 性質を 4〜7 本に分割した反復が目立つ (例: `bidiKeyValueFormattingError.test.ts:504/526/547/569/582/602/618` の 7 本はアサーションが同一)。

## 4. 構造・運用の問題

- **カバレッジ目的で命名されたテストファイル**: `src/session/bidiResponseUncoveredBranches.test.ts`。`bidiResponseCrossCancel.test.ts:172-175` もコメントでカバレッジ目的を自認している
- **ファイル名と内容の不一致**: `src/session/bidiKeyValueFormattingError.test.ts` (838 行 / 22 テスト) は malformed KV・fetch 待機者・Request ID の 3 題材の寄せ集め
- **過細なファイル分割**: `bidiSendRequestUpdate` 系が 6 ファイル、1〜3 テストのファイルが 40 ファイル中 5 つ
- **テスト名が英語のもの 83 件**: `devtools/src/utils/logFormatters.test.ts` 26、`devtools/src/signals/subscriber.test.ts` 22、`devtools/src/hooks/useSubscriber.test.ts` 10、`devtools/src/utils/codec.test.ts` 9 など (規約は日本語)
- **モック・スタブ規約の解釈が割れている**: `src/frameSource.test.ts:9-11` は「グローバルを差し替えて通すのはスタブを作ることにあたるため禁止」と明記する一方、`src/codec/configSupport.test.ts:24`、`src/codec/VideoDecoder.test.ts:86`、`src/connect.test.ts:86` は `globalThis.VideoDecoder` / `WebTransport` を手書きの代役へ差し替えている
- **手書きサンプリング**: `src/message/setup.test.ts:150/163`、`src/properties.test.ts:1079/1093/1250/1270` は `for` ループでランダム性を模しており、PBT で書くべきもの

## 5. 削減見込み

担当範囲ごとの指摘件数。範囲をまたぐ重複計上を含む。

| 範囲                                                    | テスト数 | 確信度 高 | 確信度 中 |
| ------------------------------------------------------- | -------- | --------- | --------- |
| `src` 直下の PBT 21 ファイル                            | 196      | 16        | 24        |
| `src/session` + `src/message` の PBT 15 ファイル        | 182      | 30        | 40        |
| `src/c4m` + devtools の PBT 14 ファイル                 | 92       | 9         | 4         |
| 主要単体テスト 16 ファイル対 PBT                        | 1,350    | 35        | 45        |
| `src/session` 42 ファイル                               | 738      | 77        | 30        |
| `src` の message / c4m / codec / 小〜中規模 55 ファイル | 785      | 74        | 60        |
| `devtools/src` 57 ファイル                              | 699      | 30        | 25        |
| 合計                                                    | —        | **271**   | **228**   |

重複計上を除いた確信度 高は 200 件前後。
まず着手すべきは次の 3 つで、ここだけで 90 件規模になる。

1. `src/loc.prop.ts` の非 PBT テスト 40 件 (`loc.test.ts` へ統合するか削除)
2. `src/msf.prop.ts` の非 PBT テスト 18 件 (うち 7 件は完全重複)
3. 写経プロパティ 7 件の削除と、`numRuns` 2000 / 1000 の引き下げ

## 6. 実施結果 (確信度「高」の削除)

ブランチ `feature/remove-redundant-tests` で実施した。コミットはしていない。

| 項目                | 前      | 後         | 差       |
| ------------------- | ------- | ---------- | -------- |
| テストファイル      | 219     | 216        | -3       |
| テスト              | 3,980   | 3,787      | **-193** |
| テストコード行数    | 113,011 | 110,252    | -2,759   |
| `vp test run`       | 4.03 秒 | 3.90 秒    | -0.13 秒 |
| カバレッジ (Stmts)  | 83.60%  | **84.70%** | +1.10    |
| カバレッジ (Branch) | 79.71%  | 80.62%     | +0.91    |

削除したファイルは 3 つ。

- `devtools/src/hooks/useCopyFeedback.test.ts` — `typeof` と `assert.ok(true)` のみで、フックの挙動を検証していなかった
- `devtools/src/utils/latencyBreakdown.prop.ts` — 唯一のテストが恒真で、PBT ファイルとして成立していなかった
- `src/session/bidiGoawayValidation.test.ts` — 1 テストのみで、`bidi.prop.ts` の PBT が同一性質を任意の Request ID 列で検証済みだった

領域別カバレッジは `src/session` / `src/message` / `src/dataStream` / `src/msf` が変化なし、`src/c4m` が +0.06。
削除で一時的に落ちた 2 ファイルはテストを戻して回復させた。

- `src/codec/config.ts` — `requiresAudioSpecificConfig` が唯一のテストを失い未実行になっていたため、`config.test.ts` に述語のテストを戻した (100% に復帰)
- `devtools/src/utils/logRowState.ts` — `pruneViewModes` が唯一のテストを失い未実行になっていたため、委譲の配線を確認するテストを戻した (100% に復帰)

`src/filter.ts` は 1 行 (相対指定の上限クランプ) が PBT の乱数ではほぼ踏まれない境界だったため、
`filter.test.ts` に境界の単体テストを追加して決定的にした (94.82% → 94.83%)。

### 残した候補

確信度「中」以下は削除していない。とくに次のものは次回以降の検討対象。

- 表駆動への統合 (テスト数は減るが書き換えを伴うもの): `src/session/bidi*` に残る同型テスト、`src/session/params.test.ts:373/390/416/436`、`src/dataStream.subgroup.test.ts:689-792`、`src/message/parameter.test.ts:55-134`、`src/createMediaPublisher.test.ts:4329-4506`、`src/properties.test.ts:169-201`
- `fc.constant` のみを入力にしている PBT: `src/session/namespaceLoops.prop.ts:1041` など
- 入力が結果に影響しない PBT: `src/session/incoming.prop.ts:1339/1355`、`src/publisher.prop.ts:90`、`src/playout/audioPlayout.prop.ts:398`、`src/namespaceLoops.prop.ts:939`
- 写経が残る PBT: `src/session/params.prop.ts` の他項目、`devtools/src/utils/playoutTimingStats.prop.ts:29`
- PBT の生成器が境界を踏まない問題: `src/c4m/moqt.prop.ts:647` (prefix / suffix 分岐に入らない試行が 27%)、`src/filter.prop.ts` の相対指定の生成器

### 副次的に見つかった問題 (テスト整理の範囲外)

- **規約解釈の割れ**: `src/frameSource.test.ts` は「グローバルを差し替えるのはスタブ禁止に抵触する」と明記する一方、`src/codec/configSupport.test.ts` / `src/codec/VideoDecoder.test.ts` / `src/connect.test.ts` は `globalThis.VideoDecoder` / `WebTransport` を差し替えている
- **テスト名が英語のもの 83 件**: `devtools/src/utils/logFormatters.test.ts` 26、`devtools/src/signals/subscriber.test.ts` 22、`devtools/src/hooks/useSubscriber.test.ts` 10 など (規約は日本語)
- **`CatToken.decode` の仕様差分の疑い**: `src/c4m/cat.test.ts` の書き直し中に、compact トークンの標準 Base64 包装を `CatToken.decode` が受理しないことを確認した。draft-ietf-moq-c4m-01 §2 は URL へ埋め込む場合に Base64 を定めているため、実装側の確認が必要
- **ファイル名と内容の不一致**: `src/session/bidiKeyValueFormattingError.test.ts` は malformed KV / fetch 待機者 / Request ID の 3 題材が同居したまま

## 7. 検証方法と限界

- 全体に対して機械的な検出を行った: `fc.` 非使用テストの抽出、`fc.property` の仮引数が本体で未使用のもの、本文を正規化した完全一致・近似一致 (Jaccard ≥ 0.75) の検出、テスト名の重複検出、カバレッジ測定
- 指摘のうち重要なもの (写経オラクル、完全重複、弱すぎる検証、`fc.constant` のみの入力) は原典に当たって裏取りした
- `src/session.test.ts` (11,300 行) と `src/createMediaSubscriber.test.ts` (8,935 行) は全行精読していない。内部重複は限定的と判断しているが、見落としの可能性は残る
- subagent の指摘のうち、次の 2 件は裏取りの結果 confidence を下げた
  - `src/session/params.test.ts:301` の削除推奨 → prop 側 (`params.prop.ts:898`) が写経なので、削除すべきは prop 側
  - `src/session/bidiNotifySubscriberFailure.test.ts` の 5 件削除推奨 → `fc.record` の 4 ブールは 100 runs で 16 通りを保証せず、単体側が固定している組み合わせは残す価値がある (確信度 中)
  - `src/message/namespace.test.ts` の末尾違反系削除推奨 → 検証が payload 非依存である点は正しいが、単体側はメッセージ文言を pin しているため、どちらを残すかは方針判断 (確信度 中)
