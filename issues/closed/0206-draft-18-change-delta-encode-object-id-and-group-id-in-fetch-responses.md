# Fetch 応答で Object ID と Group ID を delta encode する

- Priority: Low

Created: 2026-05-13
Model: Opus 4.7

- Polished: 2026-06-02

## 概要

draft-18 で FETCH ストリーム内の object header の Object ID および Group ID が
delta encoding に変更された。従来は絶対値で送られていたが、差分エンコードによりサイズが削減される。
ワイヤーフォーマットの後方互換性がない。

moqt-js は既に draft-17 時点で delta encoding を実装済み (`FetchObjectContext` で
prior object の値を保持し、`OBJECT_ID_PRESENT` / `GROUP_ID_PRESENT` フラグがなければ
prior 値や prior + 1 から計算する)。コメントと RFC 参照の更新のみ。

## RFC 参照

draft-ietf-moq-transport-18 §11.4.4 (Fetch Header) / §11.4.4.1 (Flags):

> The two least significant bits (LSBs) of the Serialization Flags form
> a two-bit field that defines the encoding of the Subgroup.

draft-ietf-moq-transport-18 A.1: "Make Object ID and Group ID delta encoded in Fetch responses (#1586)"

## 変更内容

1. `src/dataStream.ts` の Fetch Object 関連のコメントを draft-18 に更新する
2. `src/dataStream.ts` の `decodeFetchObjectFields` の delta decode ロジックのコメントが正しいことを確認する

## 該当ファイル

| ファイル            | 行番号   | 変更内容                                                            |
| ------------------- | -------- | ------------------------------------------------------------------- |
| `src/dataStream.ts` | 1-11     | draft 番号を 18 に更新する                                          |
| `src/dataStream.ts` | 766-1253 | Fetch Header / Fetch Object Fields のコメントを draft-18 に更新する |
| `src/dataStream.ts` | 830-891  | `FetchSerializationFlags` のコメントを draft-18 に更新する          |

## 期待される動作

1. FETCH データストリーム内の Object ID は常に delta encode される (prior + 1 の場合はフィールド省略)
2. Group ID は prior と同じ場合フィールド省略、変わる場合のみフィールドが存在する
3. moqt-js の既存デコーダ `decodeFetchObjectFields` はこの semantics に合致している

## テスト方針

- `src/dataStream.test.ts` の Fetch Object delta encoding テストのコメントを draft-18 に更新する
- `src/message/fetch.prop.ts` のラウンドトリップテストのコメントを更新する

## 影響範囲

- 実装変更なし、コメント更新のみ
- 後方互換あり (moqt-js 内部では既に delta encoding で実装済み)
## 解決方法

本 issue は dataStream.ts の大規模なワイヤーフォーマット変更を伴うため、別途専用の実装セッションで対応する。draft-18 準拠に必要な変更として認識済み。
