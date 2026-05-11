# `DebugPanel` の formatter 群をモジュールスコープに整理し pure function 化する

Created: 2026-05-11
Model: Opus 4.7

## 概要

`devtools/src/components/DebugPanel.tsx` には formatter が 6 個存在するが、5 個はモジュールスコープのトップレベル関数として定義されている一方で、`formatElapsedTime` / `formatDeltaTime` の 2 個だけが `DebugPanel` コンポーネント内に定義され、`firstTimestamp` をクロージャ経由で参照している。同じ責務を持つヘルパーがスコープを跨いで分裂しており、可読性とテスタビリティを下げている。

この issue では、コンポーネントスコープに居る 2 個の formatter を「モジュールスコープへ移動 + 引数化」して pure function 化し、`formatBytes` を除く 5 個を `devtools/src/utils/logFormatters.ts` に集約する。`formatBytes` は `devtools/src/utils/codec.ts` に同名で出力仕様の異なる関数が存在する重複問題があり、本 issue では扱わない (後述「スコープ外」参照)。

## 根拠

- 同じカテゴリのヘルパー (タイムスタンプ整形) が、ファイル内でスコープが分裂しており、読み手がスコープを行き来する必要がある
  - `DebugPanel.tsx:187-194` `formatAbsoluteTime` (モジュールスコープ)
  - `DebugPanel.tsx:547-552` `formatElapsedTime` (コンポーネントスコープ、`firstTimestamp` をクロージャ参照)
  - `DebugPanel.tsx:555-561` `formatDeltaTime` (コンポーネントスコープ、外部状態に依存していない)
- `formatDeltaTime` は外部状態に依存しておらず、現状コンポーネント内に置く正当性がない
- `formatElapsedTime` も `firstTimestamp` を引数で受け取れば純粋関数化可能 (`firstTimestamp` 自体は `DebugPanel` 内で導出されるだけで、ヘルパー側で signal を読む必要はない)
- 現状 formatter のユニットテストが存在せず、境界値 (空配列、0 バイト、改行を含む文字、非 ASCII、`previousTimestamp === null` 等) を検証する手段がない

## 抽出対象 (全数列挙)

`devtools/src/components/DebugPanel.tsx` 内の formatter を全て洗い出した結果は以下の通り。本 issue で扱う対象 / 対象外を明示する。

| #   | 関数名                                                 | 行      | 現在のスコープ | 外部依存                      | 本 issue の扱い                                       |
| --- | ------------------------------------------------------ | ------- | -------------- | ----------------------------- | ----------------------------------------------------- |
| 1   | `formatMessageData(data, indent)`                      | 48-128  | モジュール     | なし (純粋)                   | 新モジュールへ移動                                    |
| 2   | `formatHexDump(data)`                                  | 131-167 | モジュール     | なし (純粋)                   | 新モジュールへ移動                                    |
| 3   | `formatAbsoluteTime(timestamp)`                        | 187-194 | モジュール     | なし (純粋)                   | 新モジュールへ移動                                    |
| 4   | `formatBytes(bytes)`                                   | 232-240 | モジュール     | なし (純粋)                   | **本 issue では移動しない** (※後述「スコープ外」参照) |
| 5   | `formatElapsedTime(timestamp)`                         | 547-552 | コンポーネント | `firstTimestamp` (クロージャ) | 引数化して新モジュールへ移動                          |
| 6   | `formatDeltaTime(currentTimestamp, previousTimestamp)` | 555-561 | コンポーネント | なし (純粋)                   | そのまま新モジュールへ移動                            |

`isParameter(key)` (`DebugPanel.tsx:43-45`) は `formatMessageData` の内部ヘルパーで formatter ではないが、`formatMessageData` から呼ばれるため一緒に移動する。同様に定数 `RFC_FIELD_NAMES` (`DebugPanel.tsx:22-40`) も移動する。

`generateSettingsText` / `generatePublisherStatsText` / `generateSubscriberStatsText` / `generateLogsText` / `generateFullLogText` は signal を直接参照しており純粋関数化できないため、本 issue のスコープ外とする (別 issue で検討)。

## 関連 issue との順序

- 0167 (DebugPanel ログバッファ刷新): 同じ `DebugPanel.tsx` を改修する。**0167 → 0174 の順** で実装する。0167 マージ後の `DebugPanel.tsx` では `firstTimestamp` の導出元が `logs.value[0].timestamp` から `logBuffer[0].timestamp` に変わるため、本 issue では 0167 マージ後の式を起点に `firstTimestamp` を `formatElapsedTime` 引数として渡す
- 0173 (`useCopyFeedback`): 同じ `DebugPanel.tsx` を改修するが触る箇所 (4 つの copy 関数) は本 issue と直交。0167 → 0173 → 0174 もしくは 0167 → 0174 → 0173 のいずれでも可

## 修正方針

1. 新規ファイル `devtools/src/utils/logFormatters.ts` を作成し、以下を移動する (`utils/` 配下を選ぶ理由は、これらが JSX を含まず純粋関数のため。`utils/codec.ts` と並ぶ位置付け)
   - 定数: `RFC_FIELD_NAMES`
   - 内部ヘルパー: `isParameter` (MOQT Parameters の判定。`draft-ietf-moq-transport-17` Parameter 概念への参照コメントをこの機会に追加する)
   - formatter: `formatMessageData` / `formatHexDump` / `formatAbsoluteTime` / `formatElapsedTime` / `formatDeltaTime` (`formatBytes` は除く)
2. `formatElapsedTime` のシグネチャを `(timestamp: number, firstTimestamp: number) => string` に変更する
   - 呼び出し側 (`DebugPanel.tsx:713-716` 相当) を `formatElapsedTime(log.timestamp, firstTimestamp)` に修正する
   - `firstTimestamp` の導出 (0167 マージ後は `logBuffer.length > 0 ? logBuffer[0].timestamp : 0`) は `DebugPanel` 内に残す
3. `formatDeltaTime` のシグネチャは現状維持 (`(currentTimestamp: number, previousTimestamp: number | null) => string`)
4. `DebugPanel.tsx` 側はインポートに置き換え、コンポーネント内の関数定義 (547-561) を削除する
5. 既存の `generateLogsText` / `copyToClipboard` 等の呼び出し箇所は新モジュールからのインポートで動作するよう調整する
6. `formatBytes` は `DebugPanel.tsx` 内モジュールスコープに残す (本 issue では移動しない)
7. テストファイル `devtools/src/utils/logFormatters.test.ts` を新規作成する
8. CLAUDE.md「何か変更をする場合はテストを先に修正すること」の規約に従い、テストを先に記述してから移動を行う

## 出力フォーマットの維持

本 issue は pure 化とモジュール抽出のみを行い、各 formatter の **出力フォーマットは一切変更しない**。`formatBytes` の `1024.0 KB` のような退化ケース (1MB 直前) も既存挙動を固定する。

## 影響範囲

- `devtools/src/components/DebugPanel.tsx` (5 個の formatter 定義の削除、インポート追加、`formatElapsedTime` 呼び出しの引数追加)
- `devtools/src/utils/logFormatters.ts` (新規)
- `devtools/src/utils/logFormatters.test.ts` (新規)

`DebugPanel.tsx` の外から formatter は参照されていない (grep 済) ため、外部 API への影響はない。`formatBytes` は `DebugPanel.tsx` 内に残し本 issue のスコープ外とする。

## テスト戦略

CLAUDE.md の規約 (Vitest の Chai API、`test` / `assert` のみ、モック・スタブ禁止、`it` / `describe` / `expect` 禁止) に従って `debugPanelFormatters.test.ts` を実装する。

各 formatter について以下の境界値を検証する。

- `formatAbsoluteTime`
  - 0 (epoch) と任意のミリ秒の整形結果が `HH:MM:SS.mmm` 形式
  - ミリ秒のゼロ埋め (例: `1ms` → `.001`)
  - 注意: タイムゾーン依存の値となるため、固定値ではなく `Date(timestamp).getHours()` 等から組み立てた期待値と比較する
- `formatElapsedTime` (呼び出し側は `firstTimestamp <= timestamp` を保証するため負の elapsed はテスト対象外。コード上にもこの前提をコメントで明示する)
  - `timestamp === firstTimestamp` のとき `+0.000`
  - 1001ms 差で `+1.001`
  - 59999ms 差で `+59.999`
- `formatDeltaTime` (呼び出し側は昇順 timestamp を保証するため負の delta はテスト対象外。コードコメントに明示する)
  - `previousTimestamp === null` のとき空文字
  - 0ms 差で `(+0ms)`
  - 12345ms 差で `(+12345ms)`
- `formatHexDump` (呼ばれる経路は描画側 (800 行目相当) のみ。`generateLogsText` / `copyToClipboard` 経路は `payload.length > 0` でガード済み)
  - 空 `Uint8Array` で空文字
  - 1 バイトのデータ (オフセット、padding、ASCII 部の確認)
  - 16 バイト境界 / 17 バイト (改行発生)
  - 32 バイト / 33 バイト (改行 2 回・3 行目発生、ループ定常状態の確認)
  - 非印字バイト (0x00, 0x1f, 0x7f, 0x80, 0xff) が ASCII 部で `.` に置換される
- `formatMessageData`
  - `null` / `undefined` → 空文字
  - プリミティブ (string / number / boolean / bigint) の文字列化
  - 空配列 `[]` の表示
  - スカラ配列 `[1, 2, 3]` → `[1, 2, 3]`
  - オブジェクト要素を含む配列は `JSON.stringify` 整形
  - 空オブジェクトで空文字
  - `RFC_FIELD_NAMES` によるリネーム (`requestId` → `Request ID`)
  - `isParameter` 判定 (`SOME_PARAM` を `Parameters:` セクションへ振り分け)
  - `catalog` フィールドの JSON インデント挙動
  - ネスト時のインデント幅
  - `undefined` 値のスキップ

検証コマンド:

- `vp run test` で全テストがパスすること
- `vp run build:devtools` でビルドが通ること
- `vp run lint` (Biome) でエラーが出ないこと

## CHANGES.md 記載方針

`## develop` の `### misc` サブセクションに以下を追加する。

```
- [UPDATE] `DebugPanel` の formatter 群を `debugPanelFormatters.ts` に分離し pure function 化する
  - @voluntas
```

## 完了条件

- `devtools/src/utils/logFormatters.ts` が新規追加されており、5 個の formatter (`formatMessageData` / `formatHexDump` / `formatAbsoluteTime` / `formatElapsedTime` / `formatDeltaTime`) と `RFC_FIELD_NAMES` / `isParameter` を含む
- `DebugPanel.tsx` 内にコンポーネントスコープの `formatElapsedTime` / `formatDeltaTime` 定義が残っていない
- `formatElapsedTime` が `(timestamp: number, firstTimestamp: number) => string` の純粋関数として動作する
- `logFormatters.test.ts` が追加されており、上記の境界値テストを全て含む
- `formatBytes` は `DebugPanel.tsx` 内に残されている (移動しない)
- `vp run test` / `vp run build:devtools` / `vp run lint` が全て成功する
- `CHANGES.md` の `## develop` の `### misc` に `[UPDATE]` エントリが追加されている

## スコープ外 (本 issue では扱わない)

- `utils/codec.ts:formatBytes` と `DebugPanel.tsx:formatBytes` の重複統合: 両者は出力仕様が異なる (`utils/codec.ts` は `1.5 MB` / `1.0 KB` / `1023 B`、`DebugPanel.tsx` は `1.50 MB` / `1.5 KB` / `1023 bytes`)。本 issue で `formatBytes` を `utils/logFormatters.ts` に移すと `utils/codec.ts` と同名関数が並び IDE auto-import の事故源になるため、本 issue では移動しない。重複統合は別 issue で検討する
- `generateSettingsText` / `generatePublisherStatsText` / `generateSubscriberStatsText` / `generateLogsText` / `generateFullLogText` の pure function 化 (signal を直接参照しており別アプローチが必要)
- `DebugPanel` 自体の構造リファクタ
