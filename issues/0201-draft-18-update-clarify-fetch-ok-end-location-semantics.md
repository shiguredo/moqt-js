# FETCH_OK の End Location semantics を明確化する

- Priority: Low

Created: 2026-05-13
Model: Opus 4.7
- Polished: 2026-06-02

## 概要

draft-18 で FETCH_OK の End Location フィールドの意味 (exclusive、未確定時の扱い) が明確化された。
moqt-js は FETCH_OK の End Location を `Fetcher.endLocation` として公開しており、
既存の解釈と draft-18 の明確化に齟齬がないか確認し、コメントを更新する。

## RFC 参照

draft-ietf-moq-transport-18 §10.13 (FETCH_OK):

> End Location: The end of the range covered by the FETCH response,
> using the same encoding as the FETCH request End Location (the
> last Object, plus 1; or 0 to indicate the entire Group).

draft-ietf-moq-transport-18 §10.13:

> If the requested FETCH End Location was beyond the Largest known
> (possibly final) Object, End Location is {Largest.Group,
> Largest.Object + 1}

draft-ietf-moq-transport-18 A.1: "Clarify FETCH_OK End Location semantics (#1536)"

## 変更内容

1. `src/session.ts` の `readFetchResponse` メソッド内の FETCH_OK End Location 処理コメントを更新する
2. `src/fetcher.ts` の `endLocation` プロパティの JSDoc に End Location が exclusive (last + 1) であることを明記する

## 該当ファイル

| ファイル         | 行番号    | 変更内容                                                               |
| ---------------- | --------- | ---------------------------------------------------------------------- |
| `src/session.ts` | 2070-2090 | `readFetchResponse` の End Location 検証コメントを draft-18 に更新する |
| `src/fetcher.ts` | 27-29     | `endLocation` の JSDoc に exclusive semantics を追記する               |
| `src/fetcher.ts` | 92-94     | `endLocation` getter にコメントを追記する                              |

## 期待される動作

1. FETCH_OK の End Location は「最後の object + 1」の exclusive な値である
2. End Location = 0 は「グループ全体」を意味する
3. 要求範囲が Largest Object を超える場合、End Location は {Largest.Group, Largest.Object + 1} に調整される
4. moqt-js の既存コードはこの semantics に合致している (End Location 比較検証済み)

## テスト方針

- 既存テストの変更は不要 (既に End Location 検証が実装済み)
- CHANGES.md の "FETCH_OK endLocation 検証が無効になっている問題を修正する" の修正と合わせて動作確認する

## 影響範囲

- 実装変更なし、コメント更新のみ
- 後方互換あり
