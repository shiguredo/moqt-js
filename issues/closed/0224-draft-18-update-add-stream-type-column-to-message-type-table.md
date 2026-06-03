# メッセージタイプ表に stream type カラムを追加する

- Priority: Medium

Created: 2026-05-13
Model: Opus 4.7

- Branch: feature/draft-18
- Polished: 2026-06-02

## 概要

draft-18 の §10 で制御メッセージタイプ表に「どの stream type で送られるか」
(Request / Response / 双方向 stream の First メッセージ等) のカラムが追加された。
moqt-js の実装コードへの影響はなく、コメント内の節参照の更新のみ。

## RFC 参照

draft-ietf-moq-transport-18 §10 (Control Messages):

Table 3 (Message Types) に Stream Type 列が追加されている。
各メッセージが Request, Response, First のどのカラムに属するかが明示されている。

draft-ietf-moq-transport-18 A.1: "Add Stream Type column to message type table (#1555)"

## 変更内容

1. `src/message/types.ts` の `MessageType` 定数およびメッセージタイプ一覧の JSDoc を draft-18 に更新する

## 該当ファイル

| ファイル               | 行番号              | 変更内容                                 |
| ---------------------- | ------------------- | ---------------------------------------- |
| `src/message/types.ts` | (MessageType, 全般) | JSDoc を draft-18 §10 Table 3 に更新する |
| `src/controlStream.ts` | (全般)              | draft 番号を 18 に更新する               |

## 期待される動作

- 実装動作に変更はない
- メッセージタイプ定数の値は変更なし

## テスト方針

- 既存テストの変更は不要

## 影響範囲

- 実装変更なし、コメント更新のみ
- 後方互換あり

## 解決方法

moqt-js はクライアント専用実装であり、本 issue の仕様変更はクライアント側のコード変更を伴わない。仕様理解のための確認をもって完了とする。
