# docs と既存 issue の前提を draft-02 に追随させる

- Created: 2026-11-16
- Completed: {YYYY-MM-DD}
- Branch: feature/update-msf-draft-02
- Polished: {YYYY-MM-DD}

## 目的

監査で、利用者向け docs に旧仕様 (`c4m`) が残り、実装済みのフィールドと新しいオプションが記載されていないことが分かった。あわせて、open / pending の issue が削除済みの API や解消済みの保留理由を前提にしている。

## 現状

- `docs/LOW_LEVEL_API.md` と `docs/HIGH_LEVEL_API.md` は `c4m` を前提にしている。実装は `cat` のみを受理するため、docs どおりの URL では認可トークンが載らない
- `docs/IMPLEMENTATION_STATUS.md` の Track 一覧に `accessibleWindowTime` が無い
- `docs/HIGH_LEVEL_API.md` に `altGroup` / `keyframeSpacing` / `initialGroupId` の記載が無い
- コメントに旧仕様が残る (`src/msf/variables.ts` の変数名の文字制約、`src/msf/types.ts` の cipherSuite 条件、`src/moqlog.ts` / `src/moqmetrics.ts` の `-` 区切り namespace の例)
- `issues/pending/0703-test-c4m-cat-interop.md` は削除済みの `getC4mParameter` と `c4m` を前提にしている
- `issues/pending/0355-add-msf-compression-property.md` は Property ID が TBD という保留理由のままだが、0x78 の割当てで解消済みである
- `issues/pending/0354-add-msf-secure-objects-encryption.md` に `cipherSuite` 条件の draft-02 差分が未反映である

## 設計方針

- docs の `c4m` を `cat` に直し、変数参照 `%cat%` と予約パラメータの説明を揃える
- 実装済みフィールドと新しい publisher オプションを docs に追記する
- コメントの旧仕様を draft-02 の記述に直す
- pending issue の前提を現状に更新する。0703 は `getCatParameter` と `cat` に、0355 は保留理由の解消と再開条件に、0354 は `cipherSuite` の条件と残作業に書き換える

## 完了条件

- `rg "c4m" docs/` に、draft-01 との差分を説明する文脈以外の旧仕様が残っていない
- `accessibleWindowTime` と publisher の新オプションが docs に載っている
- `issues/pending/0355` / `0354` / `0703` の前提が現状と一致している
- `npx vp check` / `npx tsc --noEmit` / `npx vp test --run` が通る
