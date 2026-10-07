# msf fragment の解析が仕様に無い制限で空の Track Name を拒否する

- Created: 2026-10-07
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-msf-empty-track-name
- Polished: {YYYY-MM-DD}

## 目的

draft-ietf-moq-transport-22 §2.4.1 は Track Name を "a sequence of bytes, possibly empty" と定め、draft-ietf-moq-msf-01 §11.1.2 は `--` の区切りとエスケープ規則のみを定めて Track Name の非空を要求しない。`parseMsfFragmentValue` は空の Track Name を拒否しており、仕様に根拠が無い。この関数を公開 API にしたため、制限が利用者に見える契約になった。

## 現状

- `src/msf/fragment.ts` の `parseMsfFragmentValue` は `ns--` を `invalid msf fragment value: track name is empty per §11.1.2` で throw する。一方で `--t` は namespace `[]` として受理し、空の namespace と空の Track Name で扱いが非対称である
- `src/fullTrackName.ts` の `formatFullTrackName` は「Track Name は §8.7 が空を許すため、空でも描画する」として `formatFullTrackName(["room"], "")` が `"room--"` を返し、`parseMsfFragmentValue` を parse 側とする往復関係を宣言している。実際は `parseMsfFragmentValue("room--")` が throw するため往復しない
- `src/fullTrackName.prop.ts` の `displayFieldArb` は「Track Name も MSF fragment (§11.1.2) が空を許さないため 1 文字以上にする」と、裏付けの無い前提で入力を絞っている
- `devtools/src/utils/msfFragment.test.ts` は `msf:room-123--` を undefined とする前提のテストを持つ
- `parseMsfFragmentValue` の `@throws` にも「空の track name」を挙げている

## 設計方針

- 拒否を外し、`ns--` を `{ trackNamespace: ["ns"], trackName: "", parameters: [] }` として受理する。`--` が 1 つだけの `--` は namespace `[]` + Track Name `""` になり、区切りは一意に読める
- `src/fullTrackName.prop.ts` の arbitrary から「空を許さない」前提を外し、空の Track Name を含む round-trip を検証する
- `devtools/src/utils/msfFragment.test.ts` の拒否前提のテストを、受理する期待値に更新する (`parseMsfFragmentFromInput` は undefined を返さなくなる)
- `parseMsfFragmentValue` の `@throws` から「空の track name」を外す
- 空の Track Name を拒否する既存の利用者がいるかは `parseMsfFragmentValue` / `parseMsfFragmentFromInput` の呼び出し元で確認する
- 後方互換のない挙動変更 (拒否していた入力が受理される) のため `CHANGES.md` の `## develop` に `[CHANGE]` として記載する

## 完了条件

- `parseMsfFragmentValue("ns--")` が `{ trackNamespace: ["ns"], trackName: "", parameters: [] }` を返す
- `parseMsfFragmentValue(formatFullTrackName(["room"], ""))` が `["room"]` と `""` に往復する
- `src/fullTrackName.prop.ts` の round-trip が空の Track Name を含む入力で通る
- `devtools/src/utils/msfFragment.test.ts` の期待値が更新されている
- `vp check` / `vp test run` / `vp run build:devtools` が通る
- `CHANGES.md` の `## develop` に `[CHANGE]` として記載されている

## 参照

- `refs/moq/draft-ietf-moq-transport-22.txt` の §2.4.1 (Track Name is a sequence of bytes, possibly empty) / §8.7 (Track Namespace Field は 1 バイト以上)
- `refs/moq/draft-ietf-moq-msf-01.txt` の §11.1 / §11.1.2
- `src/msf/fragment.ts` の `parseMsfFragmentValue` / `src/fullTrackName.ts` の `formatFullTrackName` / `src/fullTrackName.prop.ts` の `displayFieldArb` / `devtools/src/utils/msfFragment.ts` の `parseMsfFragmentFromInput`

## 解決方法

{未着手}
