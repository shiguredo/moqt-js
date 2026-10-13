# §5.4 の変数置換後に initRef の参照切れが再検証されない

- Created: 2026-09-24
- Completed: 2026-10-14
- Branch: feature/fix-catalog-init-ref-substitution-revalidation
- Polished: 2026-09-24

## 目的

closed の `0647-bug-catalog-required-validation.md` で `validateCatalog` に initRef の参照切れ検証 (`assertInitRefResolvable`) を入れたが、draft-ietf-moq-msf-01 §5.4 の変数 (`%name%`) を含む値は置換前では参照先を判定できないため対象外にした。置換を行う `resolveCatalogVariables` は置換後の Catalog を検証しないため、置換後に参照切れになる Catalog を受理してしまう。参照切れのまま `resolveInitData` に渡ると復号器の初期化データが無い状態で configure へ進む経路が残り、0647 が塞いだ穴が変数経由で復活する。

## 現状

- `src/msf/catalogValidation.ts` の `assertInitRefResolvable` (226 行目) は、`initDataList` の id のいずれかに `%` を含む場合に検証全体を打ち切り (232-234 行目)、track の `initRef` に `%` を含む場合も個別に skip する (239-241 行目)。0647 の設計方針どおり置換前の判定を諦めている
- `src/msf/variables.ts` の `resolveCatalogVariables` (35 行目) は §5.4 の置換を行うが、置換後の Catalog に対して `validateCatalog` も `assertInitRefResolvable` も呼ばない。戻り値は検証されないまま呼び出し元へ渡る
- `src/msf/variables.ts` の `substituteString` (76 行目) は未定義の変数参照を空文字に置換する (82-84 行目)。`initRef: "%missing%"` は `""` になり、id が空文字のエントリが無ければ参照切れの Catalog が生成される
- `src/msf/variables.ts` の `substituteInitDataEntry` (219 行目) は `initDataList` の id 側も置換するため、置換後は id と initRef の一致を判定できる状態になる
- `src/msf/tracks.ts` の `resolveInitData` (28 行目) は参照先が見つからない場合に `undefined` を返すだけで throw しない (32 行目)。呼び出し元は devtools の `devtools/src/hooks/useSubscriber.ts` の `buildVideoDecoderConfig` のみである
- `src/msf/catalogDelta.ts` の `applyCatalogDelta` (40 行目) は置換を行わないため、変数を含む値の参照切れは delta 経路でも未検出のままである (143 行目の `assertInitRefResolvable` は同じ対象外条件を通る)
- `resolveCatalogVariables` は `src/msf.ts` (63 行目) から export されるが、`src/index.ts` には再 export されておらず、`package.json` の `exports` も `"."` のみのため、公開パッケージの API としては未露出である

## 設計方針

- 置換後の Catalog に対して initRef の参照切れ検証を行う。`resolveCatalogVariables` の末尾で置換結果を `assertInitRefResolvable` に渡し、参照切れなら throw する。置換を行ったその場で成否が分かるため、呼び出し元が壊れた Catalog を後段へ流さない
- `validateCatalog` 全体の再実行はしない。§5.4 の置換対象は string 値のみで、型・必須フィールドの検証結果は置換で変わらない。再実行すると「置換によって初めて §5.2.3 の重複が生じる場合を拒否するか」という別の判断が混ざるため、本 issue は initRef の参照切れに限定する
- 置換後の Catalog は `%` を含まない。`substituteString` が置換後に残った `%` を reject するため (94-98 行目)、0647 が入れた「`%` を含むなら対象外」の条件は置換後の検証では外せる。`initDataList` の id 側に変数がある Catalog も、置換後は具体的な id になるため検証できる
- 未定義変数を空文字にする現挙動は変えない。§5.4 は未定義変数の扱いを定めておらず、`src/msf.test.ts` の「`resolveCatalogVariables`: `%` リテラル単独は reject (§5.4.1)」が空文字化を前提にしている。参照切れになった時点で throw する
- `resolveInitData` の寛容な挙動 (未知の `initRef` は `undefined`) は公開 API の互換のため変えない (0647 と同じ判断)。検証は Catalog の受理時点で行う
- `resolveCatalogVariables` は `src/msf.ts` から export されるが公開パッケージの API ではないため破壊的変更にはならない。それでも JSDoc に「置換後に参照切れなら throw する」を明記し、置換の成否が戻り値の検証で決まることを読み手に示す
- 対象は `src/msf/variables.ts` / `src/msf/catalogValidation.ts` と `src/msf.test.ts` のテストとする。公開 API の挙動変更ではないため `CHANGES.md` には追記しない
- 0653 (msf の prototype pollution) が同じ `resolveCatalogVariables` / `substituteTrack` を触るため、実装順は 0653 を先にするか、後から conflict を解消する

## 完了条件

- `%name%` を含む `initRef` が置換後に `initDataList` のどの id とも一致しない場合、`resolveCatalogVariables` が `Error` を throw し、メッセージに track 名と置換後の `initRef` が含まれる
- 未定義変数 (`%missing%`) を含む `initRef` が置換で空文字になり、id が空文字のエントリが無ければ throw する
- `initDataList` の id に `%name%` を含み、置換後に `initRef` と一致する Catalog は受理され、置換後の Catalog を返す
- 置換後に一致する Catalog と `initRef` を持たない Catalog は従来どおり Catalog を返す
- `resolveInitData` の戻り値の挙動は変わらない
- `src/msf.test.ts` に、置換後の参照切れ / 置換後の一致 / id 側に変数がある場合 / 未定義変数で空文字になる場合のテストが追加される
- `npx vp check` / `npx vp test --run` が通る

## 参照

- draft-ietf-moq-msf-01 §5.4 (Variable Substitution) / §5.4.1 (Variable Syntax。「The percent character (%) MUST NOT appear in catalog field values except as part of a variable reference.」) / §5.4.2 (Variable Resolution) / §5.2.13 (initRef) / §5.1.7 (initDataList)。本文は `refs/moq/draft-ietf-moq-msf-01.txt`
- closed `0647-bug-catalog-required-validation.md` (initRef の参照切れ検証。`%` を含む値を対象外にし、置換後の再検証を残した課題とした)
- 0653 (msf の prototype pollution。同じ `resolveCatalogVariables` を触る)

## 解決方法

- `src/msf/variables.ts` の `resolveCatalogVariables` は、置換結果に対して `assertInitRefResolvable` (§5.2.13 / §5.1.7) を呼び、`initDataList` のどの id とも一致しない `initRef` を throw するようにした。置換前は `%` を含む値を参照先として判定できないため `validateCatalog` が検証を skip しており、置換を行う本関数が置換後の参照切れを検出する
- 置換後の `initRef` と `initDataList` の id に `%` は残らない (`substituteString` が残った literal な `%` を §5.4.1 として拒否する) ため、`assertInitRefResolvable` の「`%` を含むなら対象外」条件は置換後の呼び出しでは働かない。id 側に変数がある Catalog も置換後の id 集合で判定する。この旨を `assertInitRefResolvable` の JSDoc に追記した
- 未定義変数を空文字にする現挙動は変えていない (§5.4 は未定義変数の扱いを定めていない)。`initRef: "%missing%"` は空文字になり、id が空文字のエントリが無ければ参照切れとして throw する
- `validateCatalog` 全体は再実行せず、検証は initRef の参照切れに限定した。**設計方針にある「§5.4 の置換対象は string 値のみで、型・必須フィールドの検証結果は置換で変わらない」は誤りである** (本 issue の着手前に 0691 で `role` を条件にする §5.2.18 / §5.2.22 と `codec` を条件にする §5.2.28 / §5.2.29 が入り、置換で値が変わる string フィールドが他の MUST の条件になった)。`role: "%r%"` が `video` になれば codec / bitrate が必須になるため、置換で検証結果は変わり得る。それらは本 issue の範囲外とし、置換結果を再 encode する呼び出し元では `encodeCatalog` が拒否する (購読側のように in-memory で使う経路では検証されない) ことを JSDoc に明記した
- 同じ理由で、置換によって初めて生じる §5.2.3 の track 名重複と §5.1.7 の `initDataList` の id 重複は検証しない。送信経路では `encodeCatalog` が拒否するが、`resolveInitData` で解決する場合は先頭の一致で解決されるため、参照切れと違って沈黙する点を JSDoc に明記した
- 置換後の Catalog を検証する経路を持たない呼び出し元 (購読側は `resolveInitData` を直接呼び、変数置換を行わない) は保護されないことを JSDoc に明記した
- 非 string の `initRef` は型の検証を decode 側 (§5.2.13 の string) の責務とし、`assertInitRefResolvable` は TypeError を出さずに無視するようにした (置換経路から JavaScript で組み立てた Catalog が渡り得るため)
- `resolveCatalogVariables` の JSDoc と `src/msf/variables.ts` のモジュールヘッダを更新した
- テストは置換後の参照切れ / 未定義変数で空文字 / id 側の変数が置換後に一致 / 置換後の id と一致しない / `publishTracks` の initRef / 非 string の initRef (置換経路と `applyCatalogDelta`) / `resolveInitData` の挙動不変を追加した
- 公開 API の挙動変更ではないため `CHANGES.md` は更新しない (CODEBASE.md の「MOQT RFC ドラフト中の特別ルール」とも整合)

### 検証

- `npx vp check` / `npx tsc --noEmit` / `npx vp test --run` (218 ファイル / 3853 テスト) / `npx vp run e2e-test` (chromium 110 件) が通る
- `/review-diff-code` を 3 周回し、3 周目で致命的 0 件・重要 0 件になった (1〜2 周目の指摘はすべて反映済み)
- 呼び出し元は `src/msf.ts` の再輸出 / `src/msf.test.ts` / `src/msf.prop.ts` のみで、devtools や `tests/` からの呼び出しは無い。`src/index.ts` に再輸出していないためパッケージ公開 API ではなく、新しい throw で壊れる既存の呼び出し元は無い
- 変異テスト (検証呼び出しの削除 / 置換前の値の引き渡し / `publishTracks` の未検証 / 型ガードの撤去) で追加テストが落ちることを確認した

## 残した課題

- 置換によって初めて生じる §5.2.3 の track 名重複と §5.1.7 の `initDataList` の id 重複は検証しない (送信経路は `encodeCatalog` が拒否する。in-memory で `resolveInitData` に渡す経路は沈黙する)
- 置換で値が変わる `role` / `codec` が条件の MUST (§5.2.18 / §5.2.22 / §5.2.28 / §5.2.29) は置換後に再検証しない (0691 の「残した課題」と同根)
- `applyCatalogDelta` は置換を行わないため、`%name%` を含む `initRef` の参照切れは delta 経路では検出されない (本 issue の対象外)
- 購読側 (`devtools/src/hooks/useSubscriber.ts` など) は変数置換を行わないため、wire 上の `%name%` は解決されず `resolveInitData` が `undefined` を返す。置換を購読経路に組み込むかは別の判断とする
- `substituteString` は string 以外の値 (`initDataList[].id` など) を渡されると TypeError になる (型を迂回した手組み入力のみ。本 issue の対象外)
