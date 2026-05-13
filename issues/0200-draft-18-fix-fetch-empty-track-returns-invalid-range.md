# object を持たない track への FETCH は INVALID_RANGE を返す

Created: 2026-05-13
Model: Opus 4.7

## 概要

draft-18 で「object を 1 つも持たない track への FETCH は INVALID_RANGE を返す」と明示された。
moqt-js は Subscriber 側で REQUEST_ERROR(INVALID_RANGE) を受信し、
エラーをアプリケーション層に伝搬する。既存のエラーハンドリングコードはそのままで、
コメントの更新のみ行う。

## RFC 参照

draft-ietf-moq-transport-18 §10.12.3 (Fetch Handling):

> If no Objects have been published for the track or Start Location is
> greater than the Largest Object (Section 10.7) the publisher MUST
> return REQUEST_ERROR with error code INVALID_RANGE.

draft-ietf-moq-transport-18 §10.12.2 (Joining Fetches):

> If no Objects have been published for the track the publisher MUST
> respond with a REQUEST_ERROR with error code INVALID_RANGE.

draft-ietf-moq-transport-18 A.1: "FETCH to a track with no objects returns INVALID_RANGE (#1537)"

## 変更内容

1. `src/session.ts` の FETCH / Joining Fetch 処理のコメントを draft-18 に更新する
2. Joining Fetch の INVALID_RANGE ハンドリングのコメントに「track に object が 0 件の場合」の説明を追記する

## 該当ファイル

| ファイル | 行番号 | 変更内容 |
| --- | --- | --- |
| `src/session.ts` | 1-4 | draft 番号を 18 に更新する |
| `src/session.ts` | 2090-2140 | `sendJoiningFetch` の JSDoc に empty track → INVALID_RANGE を追記する |
| `src/fetcher.ts` | 1-10 | draft 番号を 18 に更新する |

## 期待される動作

1. Joining Fetch 送信時に、サーバー側で track に object が 0 件の場合は REQUEST_ERROR(INVALID_RANGE) が返る
2. moqt-js 側は REQUEST_ERROR を `RequestError` として `fetcher.onError` に伝搬する (既存通り)
3. Standalone Fetch でも同様

## テスト方針

- 既存テストの変更は不要
- E2E テスト環境で empty track への FETCH が INVALID_RANGE を返すことを確認できれば望ましいが、track 側の制御が困難なため単体テストレベルの確認でよい

## 影響範囲

- 実装変更なし、コメント更新のみ
- 後方互換あり
