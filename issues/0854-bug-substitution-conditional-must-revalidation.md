# 変数置換後に role / codec が条件の MUST を再検証しない

- Created: 2026-10-14
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-substitution-conditional-must-revalidation
- Polished: 2026-11-15

## 目的

§5.4 の変数置換は `role` / `codec` を含む string フィールドにも適用される。本実装では `role` を手掛かりに §5.2.18 (codec) と §5.2.22 (bitrate) の条件付き MUST を課しており、`codec` が audio codec かどうかを手掛かりに §5.2.28 (samplerate) と §5.2.29 (channelConfig) の条件付き MUST を課している。置換前は変数のままでは条件を判定できないため `validateCatalog` はどちらも素通りさせるが、置換で `role: "%r%"` が `video`、`codec: "%c%"` が `opus` になると必須フィールドが不足する。`resolveCatalogVariables` は置換後の Catalog を検証しないため、そのまま後段へ渡り、欠けた値が既定値で補われたり、codec 不在で復号器の configure が失敗したりする経路が残る。

## 現状

- `src/msf/variables.ts` の `substituteTrack` は `role` / `codec` を含む string フィールドを置換する (stringFields に両方がある)。`resolveCatalogVariables` は `tracks` と `publishTracks` の両方に適用する
- `src/msf/catalogTrackValidation.ts` の `validateRoleSpecificRules` (§5.2.18 / §5.2.22) と `validateAudioCodecRules` (§5.2.28 / §5.2.29) が条件付き MUST を担うが、呼ばれるのは decode 経路 (`buildValidatedCatalogTrack`) と clone 合成後 (`applyCatalogDelta`) だけである
- `resolveCatalogVariables` は 0692 で `assertInitRefResolvable` のみを呼ぶ (JSDoc に「置換で値が変わる string フィールドが他の MUST の条件になっている場合は検証結果が変わり得るが、検証は initRef の参照切れに限定する」と明記している)
- 実測: `{version: "draft-01", tracks: [{name: "v", packaging: "loc", isLive: true, role: "%r%"}]}` を `decodeCatalogMessage` で decode した後 `resolveCatalogVariables(catalog, {r: "video"})` を適用すると `role: "video"` で codec / bitrate が無い Catalog が返る。`encodeCatalog` は拒否するが、購読側のように置換結果を in-memory で使う経路では検証されない

## 設計方針

- 置換後の Catalog の `tracks` と `publishTracks` の各 track に対して `validateRoleSpecificRules` / `validateAudioCodecRules` を decode 側と同じ順 (role → audio codec) で再実行する (エラー文言は decode 側と同一の関数が出す)。`validateCatalog` 全体は再実行しない。置換によって初めて生じる §5.2.3 の track 名重複と §5.1.7 の `initDataList` の id 重複の検証を混ぜないためであり、重複は 0855 が扱う。型・必須フィールドの検証結果は置換で変わらないため再実行しない。packaging 別 MUST も再実行しない。packaging は置換対象ではなく、条件になる `role` / `mimeType` が変数を含む Catalog は decode 時点で拒否されるためである
- `role` / `codec` が置換対象であるため、置換前後で条件が変わり得ることを前提にする (0691 の「残した課題」と同根)
- 置換で §5.2.3 の重複や §5.1.7 の id 重複が生じる場合の扱いは別 issue (issues/0855-bug-substitution-duplicate-revalidation.md) とし、本 issue は role / codec が条件の MUST に限定する
- 従来受理していた Catalog を拒否する破壊的変更になる。`CHANGES.md` は CODEBASE.md の「MOQT RFC ドラフト中の特別ルール」に従い更新しない
- 対象は `src/msf/variables.ts` / `src/msf.test.ts`。`resolveCatalogVariables` は公開パッケージの API ではないため外部互換の破壊はない。`src/msf/variables.ts` の JSDoc にある「検証は initRef の参照切れに限定する」記述と、モジュールヘッダの「置換後の参照検証」の記述を、条件付き MUST も再検証する内容に更新する

## 完了条件

- 置換で `role` が `video` / `audio` になった結果 codec / bitrate が不足する Catalog を `resolveCatalogVariables` が reject する (`tracks` と `publishTracks` の両方)
- 置換で `codec` が audio codec になった結果 samplerate / channelConfig が不足する Catalog を reject する (`tracks` と `publishTracks` の両方)
- 置換後に条件を満たす Catalog は従来どおり返る
- エラー文言が decode 側と同一である
- `src/msf/variables.ts` の JSDoc とモジュールヘッダが新しい挙動に合っている
- `npx vp check` / `npx tsc --noEmit` / `npx vp test --run` が通る

## 参照

- draft-ietf-moq-msf-01 §5.4 (Variable Substitution) / §5.2.18 (codec) / §5.2.22 (bitrate) / §5.2.28 (samplerate) / §5.2.29 (channelConfig)。本文は `refs/moq/draft-ietf-moq-msf-01.txt`
- `src/msf/variables.ts` の `resolveCatalogVariables` / `substituteTrack`
- `src/msf/catalogTrackValidation.ts` の `validateRoleSpecificRules` / `validateAudioCodecRules`
- closed `0692-bug-catalog-init-ref-substitution-revalidation.md` (置換後の検証を initRef に限定した。本件は「残した課題」にある)
- closed `0691-bug-audio-codec-role-must-gap.md` (role 条件と codec 条件の分離。同じく「残した課題」にある)
- open `0853-bug-subscriber-variable-substitution.md` (購読経路に変数置換を組み込む。置換結果を in-memory で使う経路の例)

## 解決方法

{未着手}
