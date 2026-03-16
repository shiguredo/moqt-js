# アプリケーション用 Property Type 範囲の予約

## 概要

Property Type のレジストリにアプリケーション固有の使用のための範囲を予約する。

## 参照

- draft-ietf-moq-transport-17 Section 14.4
- https://github.com/moq-wg/moq-transport/pull/1473

## 変更内容

- draft-17 で Property Type の値範囲にアプリケーション用の予約範囲が追加された
- プロトコルで定義された Property Type と衝突しないように、アプリケーション固有の Property Type を使用可能にする

## 影響範囲

- `src/extensions.ts`

## 実装方針

1. draft-17 Section 14.4 の Property Type 範囲を確認する
2. アプリケーション用の Property Type 範囲を定数として定義する
3. バリデーション処理を更新する
4. テストを追加する

## 解決方法

`PropertyTypeRange` 定数を `properties.ts` に追加し、アプリケーション固有の Property Type 範囲 (0x3800 - 0x3FFF) を定義した。`index.ts` からエクスポート。
