# MSF Catalog の必須検証が仕様に対して不足している

- Created: 2026-09-21
- Completed: 2026-09-24
- Branch: feature/fix-catalog-required-validation
- Polished: 2026-09-21

## 目的

draft-ietf-moq-msf-01 の MUST のうち Catalog の検証が欠けているものが 2 点ある (§5.2.3 の namespace ごとの track name 一意、role が video / audio のときの codec / bitrate / samplerate / channelConfig)。あわせて、§5.2.13 の initRef が initDataList のエントリを指しているかどうかを確認していないため、参照切れの Catalog を受理してしまう。この 3 点を検証に追加する。initRef の参照切れ拒否は仕様の MUST ではなく、壊れた Catalog を早期に落とすための厳格化である。

## 現状

- `src/msf/catalogValidation.ts` の `assertTrackNameUnique` は `tracks` と `publishTracks` に対して別々に呼ばれ (同ファイルの `validateCatalog`)、配列をまたぐ `(name, namespace)` の重複を検出しない。呼び出し元は `src/msf/catalogDelta.ts` の `applyCatalogDelta` にもあり、delta 適用後の `publishTracks` は引き継がれるため、delta 経由では配列をまたぐ重複が未検証のまま残る
- `arrayName` は `"tracks" | "publishTracks"` をエラー文言に埋め込むだけの引数で、2 配列を連結して 1 回呼ぶ形にすると違反がどちらの配列に由来するかを関数側で示せない
- `src/msf.test.ts` の「Catalog: tracks と publishTracks の合算 uniqueness は行わない (subscribe/publish 同名共存許容)」が現状の挙動を固定しており、namespace 未指定どうしの同名 track を許容している
- `src/msf/catalogTrackValidation.ts` の `buildValidatedCatalogTrack` は `role` を型検証するだけで、`role` が `video` / `audio` のときの Conditional MUST を検証しない。packaging 別の MUST は clone では skip し、`applyCatalogDelta` が合成後に再検証する分担になっている
- `src/msf/tracks.ts` の `resolveInitData` は `initRef` の参照先が `initDataList` に無い場合に undefined を返す。これは公開 API (未知の参照を無視する既存の意図的な挙動) で、Catalog の検証では参照切れを検出していない
- `src/msf.prop.ts` の `catalogTrackArb` は `role` / `codec` / `bitrate` / `samplerate` / `channelConfig` を独立に生成し、`catalogArb` は `tracks` と `publishTracks` に別々の `uniqueCatalogTrackArrayArb` を使ううえ、`initRef` と `initDataList` の id も独立に生成するため、いずれも新しい検証を通らない組み合わせを生成する

## 設計方針

- §5.2.3 の「Within the catalog」は `tracks` と `publishTracks` の両方を含むため、2 配列をまとめて 1 回の uniqueness 検証にする。`assertTrackNameUnique` を 2 配列を受け取る形 (`tracks` と `publishTracks`) に変え、内部で連結して `(name, namespace)` の重複を検出し、違反した track がどちらの配列に由来するかをエラー文言に含める。closed/0316 が決めた「配列内の一意性」から広げる根拠は §5.2.3 の「Within the catalog」である
- この変更は従来受理していた「subscribe 用 track と publish 用 track の同名共存」を拒否する破壊的変更なので、設計方針と実装の両方でその旨を明示し、`CHANGES.md` の `## develop` に追記する
- `src/msf/catalogDelta.ts` の `applyCatalogDelta` も変更対象に含める。合成後の `tracks` と (引き継いだ) `publishTracks` をまとめて再検証し、delta の add 経由で §5.2.3 が破れないようにする
- `role` が `video` のときは `codec` (§5.2.18) と `bitrate` (§5.2.22) を、`role` が `audio` のときは加えて `samplerate` (§5.2.28) と `channelConfig` (§5.2.29) を必須にする。`role` は optional で custom role も許されるため、`video` / `audio` 以外には課さない
- role 条件付き MUST は packaging 別 MUST と同じ形の専用関数に切り出し、`buildValidatedCatalogTrack` (非 clone) と `applyCatalogDelta` (clone 合成後) の両方から呼ぶ。packaging 別 MUST の検証を先に行い、role=video の publishTracks に packaging 違反がある既存テストの期待文言を変えない
- initRef の参照切れは `validateCatalog` (parse 時) で、`tracks` と `publishTracks` の両方の track を対象に拒否する。参照先の有無だけを見て `type` は問わない。§5.4 の変数 (`%name%`) を含む値は置換前なので対象外にする (置換後の再検証は本 issue の対象外)。`resolveInitData` の寛容な挙動 (未知の `initRef` は undefined) は公開 API の互換のため変えず、devtools の購読経路 (`buildVideoDecoderConfig`) にも影響させない
- `src/msf.prop.ts` の Arbitrary を新しい検証に合わせる。`catalogTrackArb` は `role` と必須フィールドの組み合わせを揃え、`initRef` は生成しない (`initDataList` を持たないため、単体で使う delta の add でも参照切れの値を作らない)。`catalogArb` が `tracks` と `publishTracks` をまたぐ uniqueness と、`initRef` が `initDataList` のエントリを指す相関を生成後に保証する
- 期待挙動が変わる既存テスト (`src/msf.test.ts` の合算 uniqueness を固定するテスト) を新しい挙動に合わせて更新する。role=video の publishTracks に packaging 違反を置く 2 件は packaging 別 MUST が先に走るため期待文言を変えない

## 完了条件

- `tracks` と `publishTracks` をまたぐ `(name, namespace)` の重複が拒否される (`validateCatalog` と `applyCatalogDelta` の合成後の両方)
- `role` が `video` / `audio` で必須フィールドが欠けた Catalog が拒否される (clone の合成後にも再検証され、packaging 別 MUST の検証が先に走る)
- `initRef` の参照先が `initDataList` に無い Catalog が `validateCatalog` で拒否される (`tracks` と `publishTracks` の両方が対象。参照先の有無だけを見て `type` は問わない。`%name%` を含む値は対象外。`resolveInitData` の戻り値の挙動は変えない)
- `src/msf.prop.ts` の Arbitrary が新しい検証を通る Catalog を生成する (`catalogTrackArb` は role と必須フィールドを揃え `initRef` を生成しない。`catalogArb` は配列をまたぐ uniqueness と `initRef` / `initDataList` の相関を保証する)。round-trip の PBT が通る
- `CHANGES.md` の `## develop` に、従来受理していた Catalog を拒否するようになる変更として追記されている
- 追加したテストと既存テストが通る (`npx vp check` / `npx vp test --run`)

## 参照

- draft-ietf-moq-msf-01 §5.2.3 「Within the catalog, track names MUST be unique per namespace.」
- draft-ietf-moq-msf-01 §5.2.18 「This property MUST be specified for tracks which have an inherent codec associated with them (e.g., audio and video tracks).」
- draft-ietf-moq-msf-01 §5.2.22 「This property MUST be specified for audio and video tracks.」
- draft-ietf-moq-msf-01 §5.2.28 / §5.2.29 「This property MUST accompany tracks for which audio codecs are specified.」
- draft-ietf-moq-msf-01 §5.1.7 (initDataList) / §5.2.13 (initRef。参照先の存在を MUST とは定めていない) / §5.2.6 (role)

## 解決方法

- `src/msf/catalogValidation.ts` の `assertTrackNameUnique` を `(tracks, publishTracks, catalogNamespace?)` に変え、`tracks` → `publishTracks` の順に `(name, namespace)` の重複を検出するようにした。違反した track がどちらの配列に由来するかをエラー文言に含める。`validateCatalog` は publishTracks の検証後に 1 回だけ呼ぶ。`catalogNamespace` を渡した場合は §5.2.2 の継承を解決した値で比較するため、delta 経路では `options.catalogNamespace` を渡す
  - これは従来受理していた「subscribe 用 track と publish 用 track の同名共存」を拒否する破壊的変更であり、`CHANGES.md` に `[CHANGE]` として明記した
- `src/msf/catalogTrackValidation.ts` に `validateRoleSpecificRules` を追加し、role が `video` のときは codec (§5.2.18) と bitrate (§5.2.22)、`audio` のときは加えて samplerate (§5.2.28) と channelConfig (§5.2.29) を必須にした。`buildValidatedCatalogTrack` (packaging 別 MUST の後) と `applyCatalogDelta` (clone 合成後) の両方から呼ぶ。clone では packaging と同様に条件付き MUST を skip する
  - §5.2.28 / §5.2.29 の仕様上の条件は「audio codecs are specified」であり role ではないが、audio codec を持ち得る他の role (予約 role の audiodescription など) や custom role まで必須にしないため、role を手掛かりにする解釈を採り、JSDoc に差を明記した
- `src/msf/catalogValidation.ts` に `assertInitRefResolvable` を追加し、initRef の参照先が initDataList に無い Catalog を拒否する。`tracks` / `publishTracks` の両方が対象、参照先の有無だけを見て type は問わない。§5.4 の変数 (`%`) を含む値と、initDataList の id 自体が変数を含む場合は置換前で判定できないため対象外。`applyCatalogDelta` の合成後にも呼ぶ (delta の add / clone が参照切れを持ち込むと `validateCatalog` の拒否する Catalog になるため)。`resolveInitData` の寛容な挙動は変えていない
- `src/msf.prop.ts` の Arbitrary を新しい検証に合わせた。`catalogTrackArb` は role に応じて必須フィールドを補い `initRef` を生成しない (単体では参照先を保証できないため)。`catalogArb` は tracks と publishTracks をまたぐ uniqueness を保証し、initRef が initDataList のエントリを指す相関を作る
- 期待挙動が変わる既存テスト (合算 uniqueness を許容していた 1 件) を新しい挙動に更新し、role 条件付き MUST / initRef の参照切れ / delta 経由 / 境界のテストを追加した
- `CHANGES.md` の `## develop` 先頭に `[CHANGE]` を追記した (仕様 §5.6.14 の例のように codec / bitrate を省略した video track も拒否される旨を含む)

### 検証

- `npx vp check` / `npx vp test --run` (123 files / 2587 tests) が通る
- 変異テストで、配列またぎ走査の削除 / `catalogNamespace` の受け渡し削除 / delta の initRef 検証削除 (tracks 側・publishTracks 側の両方) / `%` 判定の前方一致化 / role 分岐の削除 / clone 合成後の再検証と検証順 / initDataList 未定義時の参照切れ許容、のいずれでも対応するテストが失敗することを確認した (レビュアーは独立に 28 種以上を実施)

## 残した課題

- parse 時は catalog namespace が未知のため、namespace 未指定の track と明示 namespace の track が継承後に同一になる重複は検出しない (delta 経路は `catalogNamespace` で解決する)
- `initDataList` の id に変数を含むエントリがある場合、参照切れを確定できないため initRef の検証を全体で行わない (置換後の再検証は対象外)
- role 条件付き MUST は role を手掛かりにするため、`role: "audiodescription"` など audio codec を持ち得る他の role には課さない (仕様の条件は codec)
- `encodeCatalog` / `createCatalog` は track 単位の MUST を検証しない (受信側の検証のみ。packaging 別 MUST と同じ非対称)
- catalog delta 側の `initDataList` (delta が root に持つ場合) は従来どおりマージしない
