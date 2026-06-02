# SUBGROUP_HEADER type に FIRST_OBJECT ビットを追加する

- Priority: Medium

Created: 2026-05-13
Model: Opus 4.7

- Polished: 2026-06-02

## 概要

draft-18 で SUBGROUP_HEADER のタイプ値に FIRST_OBJECT ビット (0x40) が追加された。
最初のオブジェクトであることをタイプ値で示せるようになり、
Subgroup の先頭判定が type を見るだけで可能になる。
タイプ値の有効範囲が拡大するため、定数とバリデーションを更新する必要がある。

## RFC 参照

draft-ietf-moq-transport-18 §11.4.2 (Subgroup Header):

> The FIRST_OBJECT bit (0x40) indicates that the first object in
> this subgroup stream is the first object published in the subgroup
> by the original publisher.

draft-ietf-moq-transport-18 §11.4.2:

> SUBGROUP_HEADER {
> Type (i) = 0x10..0x15 / 0x18..0x1D / 0x30..0x35 / 0x38..0x3D /
> 0x50..0x55 / 0x58..0x5D / 0x70..0x75 / 0x78..0x7D,
> ...

draft-ietf-moq-transport-18 A.1: "Add FIRST_OBJECT bit to SUBGROUP_HEADER type (#1618)"

## 変更内容

1. `src/dataStream.ts` の `SubgroupHeaderType` 定数に FIRST_OBJECT ビットがセットされたタイプ値 (0x50-0x5D, 0x70-0x7D) を追加する
2. `src/dataStream.ts` の `decodeSubgroupHeader` のタイプ値バリデーションを拡張する (0x50-0x5F, 0x70-0x7F を有効範囲に含める)
3. `SUBGROUP_ID_MODE 0b11` の予約値リストを FIRST_OBJECT ビット込みの範囲に拡張する
4. `hasPriorityPresent` のチェックを 0x50-0x5D (Priority あり) と 0x70-0x7D (Priority なし) に対応させる

## 該当ファイル

| ファイル                 | 行番号  | 変更内容                                                                      |
| ------------------------ | ------- | ----------------------------------------------------------------------------- |
| `src/dataStream.ts`      | 37-126  | `SubgroupHeaderType` に 0x50-0x5D, 0x70-0x7D の定数を追加する                 |
| `src/dataStream.ts`      | 156-159 | `hasSubgroupIdField` の lowNibble 判定に 0x50-0x5D, 0x70-0x7D 範囲を追加する  |
| `src/dataStream.ts`      | 168-170 | `hasPriorityPresent` に 0x50-0x5D 範囲を追加する                              |
| `src/dataStream.ts`      | 218-285 | `decodeSubgroupHeader` のタイプ値バリデーションに FIRST_OBJECT 範囲を追加する |
| `src/dataStream.test.ts` | (全般)  | FIRST_OBJECT ビットを含むタイプ値のエンコード/デコードテストを追加する        |

## 期待される動作

1. FIRST_OBJECT ビット (0x40) がセットされた Subgroup ヘッダーを正しくデコードできる
2. FIRST_OBJECT ビットの有無で Subgroup の先頭判定が type 値だけで可能になる
3. FIRST_OBJECT ビット込みの範囲でも SUBGROUP_ID_MODE 0b11 のタイプ値 (0x56, 0x57, 0x5E, 0x5F, 0x76, 0x77, 0x7E, 0x7F) は PROTOCOL_VIOLATION で拒否する
4. Publisher として Subgroup 送信時、subgroup の先頭 object では FIRST_OBJECT ビットを設定する

## テスト方針

- `src/dataStream.test.ts` に FIRST_OBJECT ビットを含む Subgroup ヘッダーのエンコード/デコードのラウンドトリップテストを追加する
- 予約値 (0x56, 0x57, 0x5E, 0x5F, 0x76, 0x77, 0x7E, 0x7F) で `ProtocolViolationError` が throw されることを検証する
- `src/session.prop.ts` の PBT に FIRST_OBJECT ビットを含むタイプ値を生成する arbitrary を追加する

## 影響範囲

- 実装変更あり
- ワイヤーフォーマットの後方互換性なし (draft-18 のサーバーとの通信に必要)
- Publisher 側のエンコードパスは draft-18 対応時に FIRST_OBJECT ビットを適宜設定する実装を追加する
## 解決方法

本 issue は dataStream.ts の大規模なワイヤーフォーマット変更を伴うため、別途専用の実装セッションで対応する。draft-18 準拠に必要な変更として認識済み。
