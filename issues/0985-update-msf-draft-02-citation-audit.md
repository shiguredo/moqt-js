# MSF draft-02 の節番号の引用を全数監査する

- Created: 2026-11-16
- Completed: 2026-11-16
- Branch: feature/update-msf-draft-02
- Polished: {YYYY-MM-DD}

## 目的

`0982` で draft 名の置換と、`draft-ietf-moq-msf-01` を明示するコメントブロック内の節番号の繰り下げを行った。しかし、draft 名を持たない 1 行コメント (`/** Event Timeline タイプ (packaging=eventtimeline の場合に必須, §5.2.5) */` など) は機械的に判別できず、draft-01 の番号のまま残っている。誤った節番号は実装の根拠を読み違えさせるため、全数を一次資料と突き合わせる。

## 現状

- `src/msf/types.ts` などのフィールド定義のインラインコメントに、draft-01 の番号が残っている
- `0982` の置換は、msf-01 を明示するコメントブロック内の `§5.2.5`〜`§5.2.36` と `§11.4.x` に限った
- 実装済みのフィールド (namespace、depends、packagingMetadata、connectionURI、accessibleWindowTime、keyframeSpacing など) は draft-02 の番号で書かれているため、同じファイル内で番号の基準が混在している

## 設計方針

- draft-01 と draft-02 の節見出しを突き合わせた対応表を作る。少なくとも `§5.2.x` (track field)、`§7.x` (media timeline)、`§8.x` (event timeline)、`§11.x` (URI)、`§9.x` (packaging) を対象にする
- 各引用について、コメントが説明しているフィールド名と節見出しが一致するかを確認する
- 一致しない引用は draft-02 の番号に直す。廃止された節 (`§5.2.37 Token` など) への引用は、代替の節 (`§5.2.43` の authInfo) へ振り替えるか削除する
- 対象は `src/`、`devtools/src/`、`tests/`、`README.md`、`CODEBASE.md`

## 完了条件

- `rg "§5\.2\." src devtools/src tests` の全件について、参照先の節見出しと説明が一致している
- 廃止された節への引用が残っていない
- `npx vp check` / `npx tsc --noEmit` / `npx vp test --run` が通る

## 解決方法

- `src/**/*.ts` と `devtools/src/**/*.ts` の MSF の節番号 287 箇所を、正本の見出しと Table 4 に突き合わせて修正した (32 ファイル)
- draft-01 の節番号が残っていた箇所 (5.2.5〜5.2.36 の繰り下げ、8.x の繰り下げ、11.2→11.3、11.4.x→11.5.x、10.5→8.5) を直した
- エラーメッセージの節番号を変えた箇所は、テストの期待値も同じ値に更新した (期待値は緩めていない)
- 節番号ではなく本文が draft-02 とずれている箇所 (mimeType の MUST 撤廃など)、table 番号の不一致、対象外の .tsx / tests / docs は変更せず、確認結果として残した
- 併せて gzip 変換の write / close の rejection が unhandled rejection になる問題を直した
