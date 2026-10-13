# encodeCatalog が track 単位の MUST を検証せず不正な Catalog を送信できる

- Created: 2026-09-24
- Completed: 2026-10-14
- Branch: feature/fix-encode-catalog-validation
- Polished: 2026-09-24

## 目的

closed の `0647-bug-catalog-required-validation.md` で受信側 (`decodeCatalogMessage` / `applyCatalogDelta`) の track 単位 MUST 検証を強化したが、送信側の `encodeCatalog` は同じ検証を通らない。ライブラリ自身が仕様違反の Catalog を生成・送信でき、自分の `decodeCatalogMessage` で decode できない Catalog を作れる。packaging 別 MUST と同じ非対称が残っており、相互運用の相手に拒否される Catalog を自ら送る経路になる。

## 現状

- `src/msf/catalogCodec.ts` の `encodeCatalog` (43 行目) が検証するのは `isComplete` が false でないこと (§5.1.3、45-49 行目) と、`serializeTrackForJson` (89 行目) の template Location の precision loss だけである。`validateCatalog` / `validateCatalogTrack` を呼ばない
- `src/msf/tracks.ts` の `createCatalog` (79 行目) は `version` と options を object へ詰めるだけで、track 配列を検証しない
- `src/msf/catalogValidation.ts` の `validateCatalog` (36 行目) は `validateCatalogTrack` (349 行目) を経由して `src/msf/catalogTrackValidation.ts` の `buildValidatedCatalogTrack` (83 行目) を呼び、そこで `validatePackagingSpecificRules` (387 行目) と `validateRoleSpecificRules` (361 行目) を適用する。この経路は `decodeCatalogMessage` (受信) と `applyCatalogDelta` (delta 合成後) からしか呼ばれない
- `encodeCatalog` と `createCatalog` は `src/index.ts` (91 行目 / 95 行目) から再 export された公開 API である
- encode 側で現在拒否される違反は `isComplete` だけで、`src/msf.test.ts` の「Catalog: encode 時に isComplete=false が指定されたら reject (§5.1.3)」がその先例である
- encode 時検証を入れると落ちる既存テストがある。`src/msf.test.ts` の「Catalog: encodeCatalog の JSON フィールド順序は version→…→tracks→publishTracks→initDataList (§5.1.7)」は `publishTracks: [{ name: "log", packaging: "moqlog", isLive: true }]` (151 行目) を encode しており、§9.4 の `role: "log"` MUST を満たさない
- `src/msf.test.ts` の「getVideoTracks/getAudioTracks: role でフィルタする」は role が `video` / `audio` で codec / bitrate を持たない track を Catalog として組み立てている (1765-1767 行目。encode はしていない)
- `src/msf.prop.ts` の `catalogTrackArb` (165 行目) は 0647 で検証を通るよう role と必須フィールドを相関させてあり (226-244 行目)、`catalogArb` の round-trip PBT (387 行目) は encode 時検証を入れても通る見込みである
- `createCatalog` の呼び出し元は `src/createMediaPublisher.ts` (670 行目) と `devtools/src/hooks/usePublisher.ts` の `buildPublisherCatalog` (101 行目) で、どちらも §5.2.18 / §5.2.22 / §5.2.28 / §5.2.29 を満たす track を組み立てている

## 設計方針

- `encodeCatalog` の先頭で track 単位の検証を行う。`validateCatalog` をそのまま呼ぶと version の受理範囲や root の未知フィールド保持という decode 固有の契約まで巻き込むため、`tracks` と `publishTracks` の各要素に `validateCatalogTrack` (source は `"root"` / `"publishTracks"`) を適用し、そのうえで `assertTrackNameUnique` (§5.2.3 の配列をまたぐ重複) と `assertInitRefResolvable` (§5.2.13 の参照切れ) を呼ぶ。decode と同一の関数を使い、違反時のエラー文言も受信側と揃える
- `createCatalog` も同じ検証を行う。生成時点で違反が分かるため、Catalog を組み立ててから送信するまでの間に不正な状態が持ち回られない
- これは従来 encode できていた Catalog を拒否する破壊的変更である。`CHANGES.md` の `## develop` に `[CHANGE]` として明記する (0647 が受信側の拒否を `[CHANGE]` として記録したのと同じ扱い)
- role を持たない track (`{ name, packaging: "loc", isLive }` の最小形) は引き続き encode できる。role 条件付き MUST は role が `video` / `audio` のときだけ課される
- 検証順は decode と揃える。packaging 別 MUST を先に、role 条件付き MUST を後に評価する (0647 が固定したエラー文言の順序を encode でも維持する)
- `encodeCatalogDelta` は本 issue の対象外とする。delta は add / clone の合成結果に対して `applyCatalogDelta` が既に検証しており、encode 時に何を検証すべきか (delta 単体か合成後か) は別の判断が必要である。対象外であることを JSDoc に書く
- 既存テストのうち encode 時検証を通らない Catalog を使っているものは、検証を通る形に直す (`packaging: "moqlog"` に `role: "log"` を補う等)。decode 側の拒否を確認するテストは `encodeRaw` で生 JSON を組み立てる既存の形を維持し、encode を経由させない
- `src/msf.test.ts` に、encode 時に §5.2.3 / §5.2.5 / §5.2.13 / §5.2.18 / §5.2.22 / §5.2.28 / §5.2.29 / §9.4 / §10.4 の違反を reject するテストを追加する

## 完了条件

- `encodeCatalog` が次を reject する。エラー文言は decode 側と同一の関数が出す
  - §5.2.3: `tracks` と `publishTracks` をまたぐ `(name, namespace)` の重複
  - §5.2.13: `initRef` の参照先が `initDataList` に無い
  - §5.2.5 / §9.4 / §10.4: packaging 別 MUST (eventType / depends / mimeType / role)
  - §5.2.18 / §5.2.22 / §5.2.28 / §5.2.29: role が `video` / `audio` のときの必須フィールド欠落
- `createCatalog` も同じ違反を reject する
- 上記を満たす Catalog は従来どおり encode でき、`decodeCatalogMessage` と round-trip する
- `src/index.ts` の公開 API のシグネチャは変わらない (引数と戻り値の型は同じで、throw が増える)
- `CHANGES.md` の `## develop` に破壊的変更として追記されている
- `src/msf.prop.ts` の round-trip PBT が通る
- `src/msf.test.ts` の既存テストが新しい期待値に更新され、追加テストが通る
- `npx vp check` / `npx vp test --run` が通る

## 参照

- draft-ietf-moq-msf-01 §5.2.3 (track name の一意性) / §5.2.13 (initRef) / §5.2.18 (codec) / §5.2.22 (bitrate) / §5.2.28 (samplerate) / §5.2.29 (channelConfig) / §5.2.5 (eventType) / §9.4 (moqlog) / §10.4 (moqmetrics)。本文は `refs/moq/draft-ietf-moq-msf-01.txt`
- closed `0647-bug-catalog-required-validation.md` (受信側の検証強化。残した課題に「`encodeCatalog` / `createCatalog` は track 単位の MUST を検証しない」がある)
- 0692 (§5.4 の置換後の initRef 再検証。同じ検証関数を共有する)

## 解決方法

- `src/msf/catalogCodec.ts` の `encodeCatalog` は、fixed-order で組んだ object を `JSON.stringify` したバイト列を `decodeCatalogMessage` 自身に通してから返すようにした。検証対象を「実際に送る wire」に一致させ、track 単位の MUST と root の型 (§5.1.1 / §5.1.2 / §5.1.3 / §5.1.4 / §5.1.5 / §5.1.7 / §5.2 / §7.2 / §8.2 / §9.4 / §10.4) を decode 側と同じ関数・同じ文言で検証する。`JSON.stringify` の変換 (toJSON と getter の呼び出し、非有限数を null にする、undefined のプロパティを落とす、疎配列の穴を null にする) を含めて判定できるため、内部表現を写して検証する方式のような「検証した値と送る値のずれ」が無い。root の未知フィールドが `deltaUpdate` のときは decode が delta update として読むため、戻り値が full catalog であることも確かめる
- `src/msf/tracks.ts` の `createCatalog` は、生成した Catalog を `assertCatalogEncodable` (同じ経路の検証入口。公開 API には含めない) に通す。組み立てた時点で違反が分かる。`tracks` / `publishTracks` / `initDataList` は変換せずそのまま保持し、送信の直前に `encodeCatalog` が再検証する
- `serializeTrackForJson` は template を number へ変換する前に `validateMediaTimelineTemplate` (decode と同じ関数。内部表現の bigint Location も受理し、負値と `Number.MAX_SAFE_INTEGER` 超を拒否する) で検証する。形が壊れた template (配列でない / 6 要素でない / Location が 2 要素配列でない) を読んで TypeError になる経路を塞いだ
- `src/msf/json.ts` に `assertFiniteNumber` を足した。JSON は非有限数 (NaN / ±Infinity) を null にするため wire では number でなくなり、`JSON.parse` は桁あふれした数値リテラル (`1e999`) を Infinity にする。track の数値フィールド (codec / bitrate / samplerate などの必須値、buffers、targetLatency、trackDuration、template の number) と root の `generatedAt` (catalog と delta の decode、delta の encode) で拒否する。decode の受理集合は「有限でない number を拒否する」分だけ厳しくなる (この値は再 encode で null になり自分で decode できなくなるため)
- `isComplete` は own で enumerable なプロパティのときだけ wire に載せる (`JSON.stringify` が読む値と同じ基準)。false / 非 boolean の拒否は自己 decode (decode と同じ文言) に委ねる
- `src/msf/catalogCodec.ts` の `encodeCatalogDelta` は `operations` と各 operation の型を plain `Error` で拒否する (TypeError を塞ぐ)。`generatedAt` は型と有限数を検証する。track 単位の MUST の検証は対象外のまま (delta 単体か合成後かは別の判断)
- 配列でない `tracks` / `publishTracks`、object でない要素、`initDataList` の構造違反は decode と同じ文言の plain `Error` で拒否する (従来は TypeError になる経路があった)
- テストは encode / `createCatalog` 経由の拒否 (§5.2.3 / §5.2.5 / §5.2.13 / §5.2.18 / §5.2.22 / §5.2.28 / §5.2.29 / §7.2 / §8.2 / §9.4 / §10.4 / §5.1.3 / §5.1.4 / §5.1.5 / §5.1.7)、非有限数、template の形状、JSON に出ない値 (undefined / 関数 / シンボル)、疎配列を追加した。PBT には「encode に成功した Catalog は必ず decode できる」「値が undefined のフィールドは encode が拒否しない」「非有限数を混ぜた Catalog は encode が必ず拒否する」を追加した
- `devtools/src/hooks/useSubscriber.test.ts` の Catalog の fixture は、role に応じた必須フィールド (§5.2.18 / §5.2.22 / §5.2.28 / §5.2.29) を補う形にした

### 検証

- `npx vp check` / `npx tsc --noEmit` / `npx vp test --run` (218 ファイル / 3831 テスト) / `npx vp run e2e-test` (chromium 110 件) が通る
- `/review-diff-code` を 5 周回し、致命的 0 件・重要 0 件で終了した (1〜4 周目の指摘はすべて反映済み)
- `CHANGES.md` は CODEBASE.md の「MOQT RFC ドラフト中の特別ルール」に従い更新していない。この変更は従来 encode / 作成できていた違反 Catalog を拒否する破壊的変更である

## 残した課題

- `src/msf/timeline.ts` の Media / Event Timeline は、非有限数 (桁あふれした数値リテラル) を受理し、その戻り値を encode すると null になって自分の decode が拒否する経路が残る (本 issue は Catalog の encode と生成だけを扱う)
- `encodeCatalogDelta` は delta の中身 (add / clone の track 単位 MUST、remove の track の形) を encode 時に検証しない。decode した delta は `decodeCatalogMessage` が op ごとに検証し、合成後の MUST は `applyCatalogDelta` が検証する (encode 時に delta 単体を検証するか合成後を検証するかは別の判断)
- §9.4 / §10.4 の「MUST be declared in the publishTracks array」は検証していない (配列の位置の制約であり decode の受理集合も変わるため別 issue とする)
- `renderGroup` (§5.2.11) / `altGroup` (§5.2.12) の整数性は decode も encode も検証しない (`createMediaPublisher` がオプションの時点で個別に守っている)。整数でない値は encode と decode を通り、相互接続の相手が拒否し得る
- 相対的な影響として、encode は送るバイト列を decode してから返すため、Catalog 1 件あたりの encode コストが数 µs 増える (定期再送は最大 30 秒間隔であり実害は無い)
- 非有限数のフィールドは wire では null になるため、encode 時のエラー文言は「must be a number per §X, got object」になる (`1e999` の decode は「must be a finite number ... got Infinity」)。原因をより直接示す文言にするには、wire 化の前に内部表現の数値を走査する必要がある
