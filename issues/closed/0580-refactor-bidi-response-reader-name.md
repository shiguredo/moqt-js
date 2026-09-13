# bidiReadResponse の名前を役割が判別できるものに変更する

- Created: 2026-09-12
- Completed: 2026-09-14
- Branch: feature/refactor-bidi-response-reader-name
- Polished: {YYYY-MM-DD}

## 目的

`bidiReadResponse` (ハンドラへ委譲するディスパッチャ) と `bidiReadResponseFromBidiStream` (最初の応答メッセージ列を返す低レベル読み取り) の名前が類似しており、どちらが何を担うか判別しにくい。役割が名前から読み取れるようにする。

## 現状

- `bidiReadResponse` は 4 種の応答読み取りの共通リーダであり、pending の取得・読み取り・メッセージ型の分岐・エラー委譲を担う。
- `bidiReadResponseFromBidiStream` はストリームから制御メッセージ列を読み取る低レベルヘルパーである。
- 両関数は非公開だが、呼び出し箇所とテストのコメントで名前が使われている。

## 設計方針

1. `bidiReadResponse` を役割が判別できる名前に変更する (例: `bidiDispatchResponse`)。
2. 呼び出し箇所 (4 関数) とテスト・コメントの言及を更新する。挙動は変えない。

## 完了条件

- 新しい名前で 4 関数とコメントが更新され、旧名の参照が残っていないこと。
- 既存テストが全て通り、`vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 関連

- `bidiReadResponse` / `bidiReadResponseFromBidiStream` (`src/session/bidi.ts`)
- `issues/closed/0498-refactor-bidi-namespace-dedup.md`

## 解決方法

`bidiReadResponse` を `bidiDispatchResponse` に改名した。issue の設計方針が例示した名前をそのまま採用している。

### 変更内容

- 定義 (`src/session/bidi.ts`) と JSDoc の見出しを「4 種の応答読み取りの共通ディスパッチャ」に変更し、`bidiReadResponseFromBidiStream` との役割の違い (最初の応答チャンクを制御メッセージ列として返す低レベル読み取り) を明記した
- 呼び出し 4 箇所 (`bidiReadPublishResponse` / `bidiReadSubscribeResponse` / `bidiReadFetchResponse` / `bidiReadTrackStatusResponse`) を追随させた
- `src/session/bidi.test.ts` のコメント 1 箇所を追随させた

`bidiReadResponseFromBidiStream` は名前のとおり「bidi ストリームから応答チャンクを読み取る」役割であり、実体と一致しているため変更していない。旧名 `bidiReadResponse` の参照は残っていない。

### 検証

- `rg "bidiReadResponse\b"` の一致が 0 件であること (`bidiReadResponseFromBidiStream` は別名として残る)
- `vp check` / `tsc --noEmit` 通過
- `vp test run`: 70 ファイル / 2,136 テスト全通過 (挙動は変えていない)
- `CHANGES.md` の `## develop` の `### misc` に `[UPDATE]` を追加した (内部リファクタで機能に影響しないため)
