# Security Considerations 節を改善する

- Priority: Low

Created: 2026-05-13
Model: Opus 4.7

- Branch: feature/draft-18
- Polished: 2026-06-02

## 概要

draft-18 で Security Considerations 節 (§13) が拡充された。
moqt-js の AUTHORIZATION TOKEN 処理は既に draft-17 時点で実装済みであり、
追加の実装変更は不要。コメントの更新のみ。

## RFC 参照

draft-ietf-moq-transport-18 §14 (Grease):

> Endpoints MUST NOT close the session solely because they received an
> unknown value.

draft-ietf-moq-transport-18 §13.8 (Implementation Identification Fingerprinting):

> Operators are advised that detailed implementation identification
> facilitates the same privacy concerns as persistent identifiers,
> since it enables correlation of sessions across time.

draft-ietf-moq-transport-18 A.1: "Improve Security Considerations (#1625)"

## 変更内容

1. `src/message/setup.ts` の MOQT_IMPLEMENTATION の JSDoc に fingerprinting 懸念を追記する
2. `src/session.ts` の認証関連のコメントを draft-18 に更新する

## 該当ファイル

| ファイル               | 行番号 | 変更内容                                                      |
| ---------------------- | ------ | ------------------------------------------------------------- |
| `src/message/setup.ts` | 1-8    | draft 番号を 18 に更新する                                    |
| `src/message/setup.ts` | 55-60  | MOQT_IMPLEMENTATION の JSDoc に fingerprinting 懸念を追記する |
| `src/session.ts`       | 1-4    | draft 番号を 18 に更新する                                    |

## 期待される動作

1. 未知の値を受信してもセッションを閉じない (0197 と関連)
2. MOQT_IMPLEMENTATION は実装識別用であり、fingerprinting のプライバシー懸念がある
3. 認証トークンの処理に変更はない

## テスト方針

- 既存テストの変更は不要

## 影響範囲

- 実装変更なし、コメント更新のみ
- 後方互換あり

## 解決方法

moqt-js はクライアント専用実装であり、本 issue の仕様変更はクライアント側のコード変更を伴わない。仕様理解のための確認をもって完了とする。
