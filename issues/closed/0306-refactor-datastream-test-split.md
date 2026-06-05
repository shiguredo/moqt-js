# dataStream.test.ts を機能別に分割する

- Priority: Medium
- Created: 2026-06-04
- Completed: 2026-06-05
- Model: qwen3.7-plus
- Branch: feature/refactor-datastream-test-split
- Polished: 2026-06-04

## 目的

`src/dataStream.test.ts` (1784 行) を機能別のファイルに分割し、テストの可読性・保守性を向上させる。

## 優先度根拠

1 ファイルに 78 個のテストが `describe` なしのフラット構造で並んでおり、対象機能を探しにくく差分レビューも追いにくい。テスト自体は正しく動作しているため Medium。

## 現状

`src/dataStream.test.ts` には `test()` が 78 個、`describe()` なしのフラット構造で、コメントと命名で次の機能群に緩く分かれている (行番号は目安)。

- SubgroupHeader のエンコード / デコード / roundtrip / 予約値 / 不正タイプ (約 32-253 行)
- `hasPropertiesPresent` と ObjectFields のエンコード / デコード / roundtrip (約 254-366 行)
- `createObject` (約 367-405 行)
- `ObjectStatus` / `SubgroupHeaderType` の enum 値・フラグ判定・roundtrip (約 405-520 行)
- ObjectDatagram のエンコード / デコード / roundtrip (約 522-720 行)
- FetchHeader のエンコード / デコード / roundtrip (約 721-778 行)
- FetchObjectFields のエンコード / デコード (約 779 行以降)

なお PBT は別ファイル `src/dataStream.prop.ts` に分離済みであり、本 issue の対象は単体テスト `src/dataStream.test.ts` のみ。

## 設計方針

データストリームの種別 (Subgroup / Datagram / Fetch) を軸に 3 ファイルへ分割する。`dataStream.ts` 自体は単一ファイルのままなので、テストはフラットなドット命名で co-located にする。

| 分割先ファイル                    | 含めるテスト群                                                                                                  |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `src/dataStream.subgroup.test.ts` | SubgroupHeader / `hasPropertiesPresent` / ObjectFields / `createObject` / `ObjectStatus` / `SubgroupHeaderType` |
| `src/dataStream.datagram.test.ts` | ObjectDatagram                                                                                                  |
| `src/dataStream.fetch.test.ts`    | FetchHeader / FetchObjectFields                                                                                 |

- テストの内容・アサーションは一切変更せず、移動のみ行う
- 各ファイルは必要な import を個別に持たせる (共有ヘルパがある場合は各ファイルへ複製、または共通ヘルパを別ファイルに切り出すかは実装時に判断)
- 分割後、元の `src/dataStream.test.ts` は削除する

## 変更対象ファイル

- `src/dataStream.subgroup.test.ts`: 新規作成 (移動)
- `src/dataStream.datagram.test.ts`: 新規作成 (移動)
- `src/dataStream.fetch.test.ts`: 新規作成 (移動)
- `src/dataStream.test.ts`: 削除
- 機能変更がないため `CHANGES.md` への追記は不要 (テスト構成の変更のみ)

## テスト方針

- 分割は純粋な移動であり、テスト総数 (78 個) と各テストの内容は変わらない
- 分割前後で全テストが同じ結果で PASS することを確認する
- Vitest の test / assert を使用する既存スタイルを維持する。モックやスタブは利用しない

## 完了条件

- 上記 3 ファイルに機能別で分割され、元の `dataStream.test.ts` が削除されている
- 移動前後でテスト総数が変わらず、すべてのテストが PASS する

## 解決方法

設計方針通り、`src/dataStream.test.ts` (1784 行・78 テスト) をデータストリームの種別を軸に 3 ファイルへ分割した。テスト本体・アサーション・ヘルパ配列・for ループ・セクション区切りコメントはバイト単位で一切変更せず移動のみ行った。

### 分割先

- `src/dataStream.subgroup.test.ts`: SubgroupHeader / `hasPropertiesPresent` / ObjectFields / `createObject` / `ObjectStatus` / `SubgroupHeaderType` (ヘルパ `subgroupHeaderTestCases` / `objectFieldsTestCases` を含む)
- `src/dataStream.datagram.test.ts`: ObjectDatagram (ヘルパ `objectDatagramTestCases` を含む)
- `src/dataStream.fetch.test.ts`: FetchHeader / FetchObjectFields (ヘルパ `requestIds` とセクション区切りを含む)

### import の最小化

各ファイルで実際に使用するシンボルのみを import するよう絞った。`fetch` は `ProtocolViolationError` を import していないが、当該テストは `assert.throws(..., /computed group id out of range/)` の正規表現マッチで検証しておりクラス識別子を参照しないため、import 不要。

### 検証

- 元ファイル単独実行 (107 passed) と分割後 3 ファイル合計 (107 passed) が一致し、ループ展開後のテスト数も含めて欠落・重複がないことを確認した。
- 全体テストは分割前後とも 663 passed で変化なし。
- 各ファイルに日本語の doc コメント (RFC セクション参照付き) を追加した。これは「移動のみ」を僅かに超えるが、3 ファイルの責務を明示するため追加した。

機能変更がないため `CHANGES.md` への追記はしていない。
