# 変数置換後に role / codec が条件の MUST を再検証しない

- Created: 2026-10-14
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-substitution-conditional-must-revalidation

## 目的

§5.4 の変数置換は `role` / `codec` を含む string フィールドにも適用される。`role` は §5.2.18 (codec) と §5.2.22 (bitrate) の条件であり、`codec` は §5.2.28 (samplerate) と §5.2.29 (channelConfig) の条件である。置換前は変数のままでは条件を判定できないため `validateCatalog` はどちらも素通りさせるが、置換で `role: "%r%"` が `video`、`codec: "%c%"` が `opus` になると必須フィールドが不足する。`resolveCatalogVariables` は置換後の Catalog を検証しないため、そのまま後段へ渡り、復号器の構成が既定値で埋められて誤った設定になる経路が残る。

## 現状

- `src/msf/variables.ts` の `substituteTrack` は `role` / `codec` を含む string フィールドを置換する (stringFields に両方がある)
- `src/msf/catalogTrackValidation.ts` の `validateRoleSpecificRules` (§5.2.18 / §5.2.22) と `validateAudioCodecRules` (§5.2.28 / §5.2.29) が条件付き MUST を担うが、呼ばれるのは decode 経路 (`buildValidatedCatalogTrack`) と clone 合成後 (`applyCatalogDelta`) だけである
- `resolveCatalogVariables` は 0692 で `assertInitRefResolvable` のみを呼ぶ (JSDoc に「置換で値が変わる string フィールドが他の MUST の条件になっている場合は検証結果が変わり得るが、検証は initRef の参照切れに限定する」と明記している)
- 実測: `{tracks: [{name: "v", packaging: "loc", isLive: true, role: "%r%"}]}` を decode した後 `resolveCatalogVariables(catalog, {r: "video"})` を適用すると `role: "video"` で codec / bitrate が無い Catalog が返る。`encodeCatalog` は拒否するが、購読側のように置換結果を in-memory で使う経路では検証されない

## 設計方針

- 置換後の Catalog に対して `validateRoleSpecificRules` / `validateAudioCodecRules` を再実行する (エラー文言は decode 側と同一の関数が出す)。0692 と同じ理由で `validateCatalog` 全体は再実行しない
- `role` / `codec` が置換対象であるため、置換前後で条件が変わり得ることを前提にする (0691 の「残した課題」と同根)
- 置換で §5.2.3 の重複や §5.1.7 の id 重複が生じる場合の扱いは別 issue (issues/0855-bug-substitution-duplicate-revalidation.md) とし、本 issue は条件付き MUST に限定する
- 従来受理していた Catalog を拒否する破壊的変更になる。`CHANGES.md` は CODEBASE.md の「MOQT RFC ドラフト中の特別ルール」に従い更新しない
- 対象は `src/msf/variables.ts` / `src/msf.test.ts`。`resolveCatalogVariables` は公開パッケージの API ではないため外部互換の破壊はない

## 完了条件

- 置換で `role` が `video` / `audio` になった結果 codec / bitrate が不足する Catalog を `resolveCatalogVariables` が reject する
- 置換で `codec` が audio codec になった結果 samplerate / channelConfig が不足する Catalog を reject する
- 置換後に条件を満たす Catalog は従来どおり返る
- エラー文言が decode 側と同一である
- `npx vp check` / `npx tsc --noEmit` / `npx vp test --run` が通る

## 参照

- draft-ietf-moq-msf-01 §5.4 (Variable Substitution) / §5.2.18 (codec) / §5.2.22 (bitrate) / §5.2.28 (samplerate) / §5.2.29 (channelConfig)
- `src/msf/variables.ts` の `resolveCatalogVariables` / `substituteTrack`
- `src/msf/catalogTrackValidation.ts` の `validateRoleSpecificRules` / `validateAudioCodecRules`
- closed `0692-bug-catalog-init-ref-substitution-revalidation.md` (置換後の検証を initRef に限定した。本件は「残した課題」にある)
- closed `0691-bug-audio-codec-role-must-gap.md` (role 条件と codec 条件の分離。同じく「残した課題」にある)

## 解決方法

{未着手}
