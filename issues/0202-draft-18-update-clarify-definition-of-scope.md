# scope の定義を明確化する

- Priority: Low

Created: 2026-05-13
Model: Opus 4.7

- Polished: 2026-06-02

## 概要

draft-18 で Track の scope (どの namespace・どの relay 範囲で track が一意となるか) の定義が
明確化された。moqt-js は単一セッション内で動作するクライアントであり、
scope に依存するロジック (track 一意性判定など) を持たない。
コメントの更新のみ行う。

## RFC 参照

draft-ietf-moq-transport-18 §2.4.3 (Scope):

> An MOQT scope is a set of servers (as identified by their connection
> URIs) for which a Full Track Name is guaranteed to be unique and
> identify a specific track.

draft-ietf-moq-transport-18 §2.4.3:

> A single MOQT transport session is tied to the scope that is
> negotiated in the beginning of the session.

draft-ietf-moq-transport-18 A.1: "Clarify definition of scope (#1629)"

## 変更内容

- 該当するコメント箇所がないため、変更不要
- moqt-js は WebTransport 単一セッションのクライアントであり、scope の定義に依存するロジックを持たない

## 該当ファイル

| ファイル | 行番号 | 変更内容 |
| -------- | ------ | -------- |
| (なし)   | -      | 変更不要 |

## 期待される動作

- 変更なし

## テスト方針

- なし

## 影響範囲

- 実装変更なし
- 後方互換あり
