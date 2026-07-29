# MSF URI fragment の reserved key helper を追加する

- Priority: Medium
- Created: 2026-07-24
- Completed: YYYY-MM-DD
- Model: Composer
- Branch: feature/add-msf-fragment-reserved-key-helpers
- Polished: 2026-07-30

## 目的

draft-ietf-moq-msf-01 §11.1.1 の reserved fragment parameters のうち、`connection` 以外（`wallclock-range` / `mediatime-range` / `location-range` / `c4m`）の取得 helper が未実装である。`getConnectionParameter` と対称な helper を追加する。

## 優先度根拠

`parseMsfFragmentValue` は parameters を順序保持で返すが、range / c4m の型付き解釈が無いと呼び出し側が仕様例ごとに手書きパースする。`connection` 適用は `#0352` に分離済みで、本 issue は helper のみ。メディア再生パス自体は止まらないため Medium。

## 現状

- `parseMsfFragmentValue` / `getConnectionParameter` は `src/msf.ts` に実装済み（`#0316`）
- `wallclock-range` / `mediatime-range` / `location-range` / `c4m` の専用 helper は無い
- `connection` の transport 適用は `#0352`（本 helper 群には依存しない）

## 設計方針

`parameters` から取得。`msf.ts` に追加（`export * from "./msf"` で公開）。不正値はそのエントリをスキップして走査を続行する（throw しない。有効なエントリだけを配列に含める）。start 省略形（例: `-200`）は不正値としてスキップする。

| 関数                 | 戻り値                                                                                              |
| -------------------- | --------------------------------------------------------------------------------------------------- |
| `getWallclockRanges` | `{ start: number; end?: number }[]`（出現順 = union。wallclock ms は `MediaTimelineTemplate` と同じ `number`） |
| `getMediatimeRanges` | 同上（mediatime ms も `number`）                                                                     |
| `getLocationRanges`  | `{ start: { groupId: bigint; objectId?: bigint }; end?: { groupId: bigint; objectId?: bigint } }[]` |
| `getC4mParameter`    | `string \| undefined`（最初の `c4m`。base64 文字列のまま。検証しない。検証は C4M 利用時 / `#0350`） |

`getLocationRanges` の期待戻り値（仕様例を固定）:

| 入力           | 戻り値                                                                                                 |
| -------------- | ------------------------------------------------------------------------------------------------------ |
| `34.0-2145.16` | `{ start: { groupId: 34n, objectId: 0n }, end: { groupId: 2145n, objectId: 16n } }`                    |
| `16.24`        | `{ start: { groupId: 16n, objectId: 24n } }`（`end` 無し）                                             |
| `16-24`        | `{ start: { groupId: 16n }, end: { groupId: 24n } }`（`objectId` キーを付けない。`0n` と同一視しない） |

規範: §11.1.1 — range は inclusive。終端省略で open range MAY。同一 key 複数は union MUST。`location-range` は Group.Object を `.`、範囲を `-`。第 2 値省略時は `.` / `-` を MUST omit。

## 完了条件

- 上記 4 関数が export され、仕様例を含む単体テストがある（`src/msf.test.ts`、必要なら `msf.prop.ts`）
- 不正値スキップのテストがある（非数値、空値、`location-range=1.2.3` ドット過多、`location-range=1.` 末尾ドット、有効/不正混在で有効分だけ返ること）
- `CHANGES.md` に `[ADD]` を追記する
- `vp test run` / `vp build` が pass する

## 解決方法

1. `src/msf.ts` に 4 関数を追加する
2. `src/msf.test.ts` に仕様例・不正値スキップのテストを追加する
3. `CHANGES.md` の `## develop` に `[ADD]` を追記する

## 関連

- `#0316` (closed) `parseMsfFragmentValue` / `getConnectionParameter`
- `#0345` Catalog delta / Joining FETCH（本 helper とは独立）
- `#0352` `connection` transport 適用
- `refs/moq/draft-ietf-moq-msf-01.txt` §11.1.1
