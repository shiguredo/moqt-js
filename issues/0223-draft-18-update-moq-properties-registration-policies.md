# MOQ Properties の登録ポリシーを更新する

Created: 2026-05-13
Model: Opus 4.7

## 概要

draft-18 で MOQ Properties (Track Properties / Object Properties) の IANA 登録ポリシー
(§15.8) が更新された。range 配分や expert review 要件が整理されている。

moqt-js の `MOQTPropertyId` / `TrackPropertyId` 定数は既に存在し、
現在使用しているプロパティは draft-18 の割り当てと一致している。
定数値の変更は不要。コメントを更新するのみ。

## RFC 参照

draft-ietf-moq-transport-18 §15.8 (Properties):

> This document establishes the "MOQT Properties" IANA registry.

draft-ietf-moq-transport-18 §2.5 (Properties):

> Unknown Properties MUST be ignored.

draft-ietf-moq-transport-18 A.1: (Properties の registry 整備に含まれる)

## 変更内容

1. `src/properties.ts` の `MOQTPropertyId` および `TrackPropertyId` の JSDoc を draft-18 §15.8 に更新する
2. 未知 Property の ignore 処理が実装されていることを確認する

## 該当ファイル

| ファイル | 行番号 | 変更内容 |
| --- | --- | --- |
| `src/properties.ts` | 1-10 | draft 番号を 18 に更新する |
| `src/properties.ts` | 21-37 | `MOQTPropertyId` の JSDoc に IANA registry 参照を追加する |
| `src/properties.ts` | 51-100 | `TrackPropertyId` の JSDoc に IANA registry 参照を追加する |

## 期待される動作

1. 既存の MOQ Property 定数値は変更なし
2. 未知 Property は ignore される (既存の `decodeProperties` で実装済み)
3. GREASE 値の Property も ignore される

## テスト方針

- 既存テストの変更は不要

## 影響範囲

- 実装変更なし、コメント更新のみ
- 後方互換あり
