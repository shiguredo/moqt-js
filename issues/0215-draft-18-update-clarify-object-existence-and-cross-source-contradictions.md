# Object の存在性と複数ソース間の矛盾を明確化する

- Priority: Low

Created: 2026-05-13
Model: Opus 4.7

- Polished: 2026-06-02

## 概要

draft-18 で「Object が存在する」と判定される条件、および複数の relay / publisher 間で
Object の状態に矛盾がある場合の取り扱いが明確化された。
moqt-js はクライアントであり relay 機能を持たないため、Object の存在判定やキャッシュ機能は持たない。
Subscriber 側の受信処理のコメントを更新するのみ。

## RFC 参照

draft-ietf-moq-transport-18 §2.1 (Objects):

> Since Objects can be delivered out of order, an endpoint can receive
> an Object after it has already recorded that the Object does not
> exist (e.g., via a FETCH gap from one source and later delivery via a
> subscription). This is not a protocol error and the Track is not
> malformed.

draft-ietf-moq-transport-18 A.1: "Clarify Object existence and cross-source contradictions (#1566)"

## 変更内容

1. `src/subscriber.ts` の Object 受信処理の JSDoc に、Object の存在状態に関する draft-18 の明確化を追記する
2. `src/fetcher.ts` の FETCH Object 受信処理の JSDoc に、未知 Object の扱いを追記する

## 該当ファイル

| ファイル            | 行番号  | 変更内容                                                       |
| ------------------- | ------- | -------------------------------------------------------------- |
| `src/subscriber.ts` | 163-177 | `handleObject` の JSDoc に Object 存在状態の矛盾許容を追記する |
| `src/fetcher.ts`    | 115-122 | `handleObject` の JSDoc に unknown range の扱いを追記する      |
| `src/dataStream.ts` | 1-11    | draft 番号を 18 に更新する                                     |

## 期待される動作

1. Subscriber は FETCH で存在しないとされた Object を後から SUBSCRIBE 経由で受信してもエラーにしない
2. 複数ソース間の Object 状態の矛盾はプロトコルエラーではなく、通常の動作として扱う
3. moqt-js の既存コードは既にこの動作に準拠している

## テスト方針

- 既存テストの変更は不要
- コメント更新のみのためテスト対象外

## 影響範囲

- 実装変更なし、コメント更新のみ
- 後方互換あり
