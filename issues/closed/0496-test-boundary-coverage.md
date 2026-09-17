# 境界値テストの未検証領域を埋める

- Created: 2026-09-06
- Completed: 2026-09-17
- Branch: feature/test-boundary-coverage
- Polished: 2026-09-17

## 目的

値域外・不正形の入力挙動が pin されておらず、文書化された折り畳みやフォールバックの退行を検出できない。

## 現状

- LOC の値域外折り畳み (`temporalLayerId` / `spatialLayerId` のマスク) が PBT の arbitrary 制約で未テストである。
- moqlog の `pri` 値域・severity 短縮形、moqmetrics の `NaN` / `Infinity` 挙動が未テストである。
- `moqtUri` の IPv6 / userinfo / 不正ポート、`grease` の非整数入力、devtools params の `0x` / `Infinity` / 指数表記、log 表示の underscore なし大文字が未定義である。
- `frameSource` フォールバック経路は可用性判定の 1 件のみである (実ブラウザ基盤が必要な範囲は方針決定を含む)。

## 設計方針

1. 上記を単体テストまたは PBT で pin する (実行基盤の制約があるものは方針を明記)。
2. 仕様・ヘルパーの想定動作とテストを対応させる。

## 完了条件

- 上記領域の挙動がテストで pin されること (基盤制約分は方針が決まること)。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 解決方法

起票時に挙げた領域を既存テストファイルへの追加で pin した。実装コードの変更は無く、すべて現行の挙動を固定するテストである (折り畳み・フォールバック・入力表記の扱いは変えていない)。

### 追加したテスト (新規 test 32 件、純増 31 件)

- `src/loc.prop.ts` (4 件): `temporalLayerId` / `spatialLayerId` の値域外入力が `& 0x07` / `& 0x03` で下位ビットに折り畳まれること、非整数は `ToInt32` で 0 方向に切り捨てられること、`temporalLayerId=8` が TID=0 として B 抑圧されること、単体エンコーダと `encodeVideoProperties` 経由の 2 経路で結果が一致することを検証する。PBT の arbitrary (`videoFrameMarkingArb`) は RFC 9626 §3.1 の定義域 (TID 0-7 / LID 0-3) のみを生成するため、値域外はここで固定する。
- `src/moqlog.test.ts` (4 件): `pri` は 0-23 の値域を検査せず、値域外 (負数・24・非整数) も round-trip で保持すること、欠落時に既定値 1 を補わないこと、severity の短縮形 "Info" が `LOG_SEVERITY_LEVELS` に無くデコード後も正規形へ正規化されないことを検証する。
- `src/moqmetrics.test.ts` (2 件 + 既存 1 件の拡張): 既知数値フィールドの非有限数 (NaN / 正負の Infinity) のエンコード拒否を全組み合わせに拡張し、デコードでは `1e999` が `JSON.parse` で Infinity になる経路と NaN リテラル (JSON のリテラルではないため不正 JSON) の拒否を検証する。
- `src/moqtUri.test.ts` (14 件): IPv6 リテラル (ポート有無・クエリと fragment の併用・閉じ括弧なし)、userinfo (保持・パスワード中の `@`・user 名が空・host なし)、ポート (範囲外・非数値・空・host なし) を検証する。
- `src/grease.prop.ts` (2 件): `generateGreaseValue` の非整数・非有限インデックスが `BigInt` 変換の RangeError になること、負の非整数は非負検査で拒否されることを検証する。
- `devtools/src/webtransport-devtools/params.test.ts` (6 件): `Number()` の解釈に従い 16 進数 / 2 進数 / 指数表記を受理すること、`1e-1` と `Infinity` は整数を要求するパーサだけが拒否すること、桁区切り (`1_000`) は拒否することを検証する。
- `devtools/src/utils/logFormatters.test.ts` (1 件): `isParameter` の「大文字かつ underscore を含む」AND 判定により、underscore を含まない大文字キーが Parameters セクションではなくフィールドとして表示されることを検証する。

### frameSource フォールバック経路の方針 (基盤制約)

`createVideoFrameSource` の processor 経路と `requestVideoFrameCallback` フォールバック経路は、どちらも実ブラウザ基盤 (MediaStreamTrackProcessor / HTMLVideoElement / requestVideoFrameCallback / VideoFrame) を必要とする。Node.js の単体テスト環境には存在せず、グローバルを差し替えて通すのはスタブを作ることにあたるため (AGENTS.md で禁止)、単体テストは可用性判定 (`isMediaStreamTrackProcessorAvailable`) のみを対象とする。Playwright e2e は chromium のみを対象としており、chromium は MediaStreamTrackProcessor をメインスレッドに公開するためフォールバック経路を通らない。したがってフォールバック経路の確認は Safari 実機の手動確認に委ねる。この方針は `src/frameSource.test.ts` の冒頭コメントに明記した。

### 判断した点

- devtools の `parseDatagramMaxAge` は `Infinity` をそのまま通す (setter へ Infinity が渡りうる)。本 issue は挙動の pin を求めており、値域の厳格化は実装の設計変更にあたるため、テストで現行契約として固定するにとどめた。
- `generateGreaseValue` の非整数インデックスは専用エラーではなく `BigInt` 変換の RangeError が漏れる。これも同様に現行挙動を固定するにとどめた。

### 検証

- `vp check` / `tsc --noEmit` / `vp test run` (104 ファイル / 2350 テスト) / `vp run build` すべて成功
- テスト数は 2319 → 2350 (+31)。既存 1 件を全組み合わせへ拡張したため、新規 test 32 件に対して純増は 31 件
