# 購読経路が §5.4 の変数置換を行わず、initRef が解決できない

- Created: 2026-10-14
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-subscriber-variable-substitution

## 目的

§5.4 の変数 (`%name%`) は「delivery time に、catalog を取得した URI の fragment identifier から解決する」と定められる (§5.4.2)。配信側が変数入りの Catalog を送ることは仕様上想定されており、購読側は受け取った Catalog を fragment の値で置換してから使う必要がある。しかし本ライブラリの購読経路は置換を行わないため、変数入りの Catalog を購読すると `initRef` が未解決のまま復号器の初期化データが得られず、description 無しで configure へ進む。

## 現状

- `devtools/src/hooks/useSubscriber.ts` は `resolveInitData` (src/msf/tracks.ts) を直接呼び、Catalog の置換を行わない。`initRef` が `%name%` のままだと参照先が見つからず `undefined` が返り、`buildVideoDecoderConfig` は description 無しで構成する
- `src/createMediaSubscriber.ts` は `initRef` / `initDataList` を一切参照しない (initData を使う経路が devtools だけに存在する)
- `src/msf/variables.ts` の `resolveCatalogVariables` は §5.4 の置換を行うが、呼び出し元はテストと PBT だけで、`src/index.ts` にも再輸出されていない (現状はライブラリ内で使われていない)
- §5.4.2 の変数の出所は URI の fragment identifier (query parameter は MUST NOT)。`src/msf/fragment.ts` の `parseMsfFragmentValue` は fragment の 1 つの値を解析するが、fragment 全体から変数名と値の対応を作る helper は無い
- 未置換の Catalog は decode / `encodeCatalog` を通り、`resolveInitData` が `undefined` を返す (issues/closed/0692-bug-catalog-init-ref-substitution-revalidation.md の「残した課題」で確認済み)

## 設計方針

- fragment から変数の対応を作る helper (`parseMsfFragmentVariables` など) を `src/msf/fragment.ts` に足し、購読経路 (§5.4.2 の fragment を持つ経路) で受け取った Catalog に `resolveCatalogVariables` を適用する
- 置換の適用位置は「Catalog を受理した直後」とし、置換後の検証 (initRef の参照切れなど) は `resolveCatalogVariables` が行う (0692)
- method / scheme など fragment に変数以外の要素がある場合の扱い (予約キー) と、変数が 1 つも無い場合に置換を skip する条件を決める
- devtools の `useSubscriber` と `createMediaSubscriber` のどちらに組み込むか (両方か) は実装時に決める。高レベル API は initData を使わないため、少なくとも devtools の購読経路を対象にする
- 対象は `src/msf/fragment.ts` / `devtools/src/hooks/useSubscriber.ts` / テスト。公開 API への追加は `src/msf.ts` までとし、`src/index.ts` へ出すかは別途判断する

## 完了条件

- fragment に `%name%` の値がある Catalog を購読したとき、`initRef` が解決され復号器が正しい description で構成される
- fragment に変数がない場合は従来どおりの挙動になる
- §5.4.2 の「query parameter を変数に使わない」を満たす (fragment のみを見る)
- 置換後に参照切れがあれば `resolveCatalogVariables` が throw する (0692 の検証が効く)
- `npx vp check` / `npx tsc --noEmit` / `npx vp test --run` が通る

## 参照

- draft-ietf-moq-msf-01 §5.4 (Variable Substitution) / §5.4.1 (Variable Syntax) / §5.4.2 (Variable Resolution。fragment 由来のみ、query parameter は MUST NOT) / §5.2.13 (initRef) / §5.1.7 (initDataList) / §11.1 (URI fragment)
- `src/msf/variables.ts` の `resolveCatalogVariables`
- `src/msf/fragment.ts` の `parseMsfFragmentValue`
- `src/msf/tracks.ts` の `resolveInitData`
- `devtools/src/hooks/useSubscriber.ts` の `buildVideoDecoderConfig`
- closed `0692-bug-catalog-init-ref-substitution-revalidation.md` (「残した課題」に本件がある)

## 解決方法

{未着手}
