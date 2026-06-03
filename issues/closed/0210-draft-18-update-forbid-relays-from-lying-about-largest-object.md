# Relay が LARGEST_OBJECT について嘘をつくことを禁止する

- Priority: Low

Created: 2026-05-13
Model: Opus 4.7

- Branch: feature/draft-18
- Polished: 2026-06-02

## 概要

draft-18 で relay が LARGEST_OBJECT パラメータについて、保有していないオブジェクトを
保有していると主張することが禁止された。moqt-js は relay 役ではないため、
Subscriber 側の LARGEST_OBJECT 利用ロジックのコメントを更新するのみ。

## RFC 参照

draft-ietf-moq-transport-18 §10.2.11 (LARGEST OBJECT Parameter):

> Relays MUST NOT set LARGEST_OBJECT to an Object that they are not
> capable of serving in a future FETCH request.

draft-ietf-moq-transport-18 A.1: "Forbid relays from lying about Largest Object (#1621)"

## 変更内容

1. `src/session.ts` の LARGEST_OBJECT パラメータ処理のコメントに、サーバー側の制約を追記する

## 該当ファイル

| ファイル            | 行番号    | 変更内容                                                                                                          |
| ------------------- | --------- | ----------------------------------------------------------------------------------------------------------------- |
| `src/session.ts`    | 1950-1954 | LARGEST_OBJECT 関連のコメントに「relay は実際に保有する Object のみを LARGEST_OBJECT として通知できる」を追記する |
| `src/subscriber.ts` | 48-53     | `largestLocation` プロパティの JSDoc に LARGEST_OBJECT の信頼性に関する注記を追記する                             |

## 期待される動作

1. Subscriber が受信した LARGEST_OBJECT はサーバーが実際に保有する range を示す
2. Joining Fetch の range 計算は LARGEST_OBJECT を信頼して行える
3. moqt-js の既存ロジックに変更は不要

## テスト方針

- 既存テストの変更は不要
- コメント更新のみのためテスト対象外

## 影響範囲

- 実装変更なし、コメント更新のみ
- 後方互換あり

## 解決方法

moqt-js はクライアント専用実装であり、本 issue の仕様変更はクライアント側のコード変更を伴わない。仕様理解のための確認をもって完了とする。
