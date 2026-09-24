# encodeCatalog が track 単位の MUST を検証せず不正な Catalog を送信できる

- Created: 2026-09-24
- Completed: {YYYY-MM-DD}
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

{未着手}
