# メッセージタイプ表に stream type カラムを追加する

Created: 2026-05-13
Model: Opus 4.7

## 概要

draft-18 で制御メッセージタイプ表に「どの stream type で送られるか」のカラムが追加された。
仕様参照時にメッセージとストリームの対応関係が一望できるようになる。
moqt-js は実装影響はほぼないが、コメント / ドキュメントで仕様参照する箇所を更新できる。

## draft-18 参照

- draft-ietf-moq-transport-18 §10 Control Messages
- moq-wg/moq-transport#1555

## 影響範囲

- ソース内の RFC 参照コメントの更新
- ドキュメント
