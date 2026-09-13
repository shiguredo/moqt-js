# msf モジュールを機能単位に分割する

- Created: 2026-09-06
- Completed: 2026-09-14
- Branch: feature/refactor-msf-split
- Polished: YYYY-MM-DD

## 目的

2959 行・公開 59 に 6 機能が同居し、型が flat で packaging 別の MUST を実行時に後付け担保する。分割と型整理が必要である。

## 現状

- `src/msf.ts` に Catalog 入出力・検証・Timeline・変数置換・Fragment・helper が同居する。
- `CatalogTrack` は 37 の optional を flat に並べ、`cast` 代入を多用する。
- `TrackRole` / `CipherSuite` / `AuthInfo` が緩く、判別情報が型に残らない。
- `namespaceMatches` が自明ラッパー、Timeline 系 4 関数と工場 2 件が不要な `async` である。

## 設計方針

1. 機能単位に分割する。
2. `packaging` 判別共用体化等で型レベルの不整合検出を検討する (無理のない範囲で)。
3. 自明ラッパー・不要 `async` を整理する。

## 完了条件

- 機能単位で見通せる分割になること。既存テストが全て通ること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 解決方法

`src/msf.ts` (3,016 行) を機能単位の 12 モジュールに分割し、自明ラッパーと不要な `async` を整理した。

### 分割

| ファイル                            | 行数 | 内容                                                      |
| ----------------------------------- | ---- | --------------------------------------------------------- |
| `src/msf.ts`                        | 99   | 公開名の再輸出のみ (既存の import パス維持)               |
| `src/msf/version.ts`                | 90   | バージョン / Packaging / Track Role / Cipher Suite の定数 |
| `src/msf/types.ts`                  | 392  | Catalog / Track / Timeline の型                           |
| `src/msf/catalogCodec.ts`           | 314  | Catalog / Catalog Delta の encode / decode                |
| `src/msf/catalogValidation.ts`      | 477  | Catalog / Remove Track / Init Data の検証                 |
| `src/msf/catalogTrackValidation.ts` | 559  | Track のフィールド検証と packaging 別 MUST                |
| `src/msf/json.ts`                   | 65   | JSON number ↔ bigint の共通ヘルパー                       |
| `src/msf/catalogDelta.ts`           | 181  | Catalog Delta の適用                                      |
| `src/msf/timeline.ts`               | 220  | Media / Event Timeline の encode / decode                 |
| `src/msf/variables.ts`              | 219  | Catalog 変数の置換                                        |
| `src/msf/fragment.ts`               | 195  | MSF Fragment と Connection パラメータ                     |
| `src/msf/c4m.ts`                    | 219  | C4M の時間 / Location 範囲                                |
| `src/msf/tracks.ts`                 | 217  | Track 取得・Catalog 生成・Track 選択                      |

全ファイル 800 行以下。モジュール間の依存は一方向で循環 import は無い。モジュール間で共有する非公開ヘルパー 9 件には `export` を付けたが、`src/msf.ts` からは再輸出していないため外部から見た公開面は変わらない。

### 自明ラッパーの整理

`namespaceMatches(a, b)` (`a === b` を返すだけ) を削除し、呼び出し 3 箇所を `trackNs !== targetNs` などの直接比較に置き換えた。

### 不要な `async` の整理

`encodeMediaTimeline` / `decodeMediaTimeline` / `encodeEventTimeline` / `decodeEventTimeline` は内部に await を持たないため `async` を外し、戻り値を `Promise<T>` から `T` に変更した。不正な入力は reject ではなく throw になる。公開 API の破壊的変更のため `CHANGES.md` では `[CHANGE]` として記載し、`docs/MSF.md` の「いずれも `async`」の記述も更新した。

issue の現状にあった「工場 2 件が不要な `async`」は現状と一致しなかった (`createCatalog` / `createCompleteCatalog` は既に同期関数で、`src/msf.ts` に `async` は Timeline 系 4 件のみ)。そのため Timeline 系 4 件だけを対象とした。

また、`async` 除去で `assertRejectsWithMessage` (`src/testSupport/helpers.ts`) の利用者が無くなったため、同ヘルパーを削除した。

### 検証

- `vp test run`: 98 ファイル / 2,177 テスト全通過 (Timeline のエラー系テスト 5 件は reject 検証から throw 検証に追随)
- 公開 API 不変の確認 (分割時点): `vp pack` の実行時輸出 63 件と `dist/index.d.ts` の宣言名 316 件が分割前と完全一致
- 移動の同一性: `src/msf.ts` のトップレベル関数 75 件すべてで本体が移動前後で一致することを機械照合した
- `vp check` / `tsc --noEmit` / `vp pack` 通過
- `CHANGES.md` の `## develop` に `[CHANGE]` (同期関数化) と `### misc` に `[UPDATE]` (分割) を追加した
