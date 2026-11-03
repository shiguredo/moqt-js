# ログを秒単位 Group とバイナリ Log Record へ移行する

- Created: 2026-11-03
- Completed: {YYYY-MM-DD}
- Branch: feature/change-log-binary-records
- Polished: 2026-11-03

## 目的

moq-log-04 §5.2 / §5.3 は、JSON のログ Object をバイナリ Log Record にし、1 秒を 1 Group とする構成へ変更した。現在の JSON helper とマイクロ秒 Group では新版のログを読み書きできない。

## 現状

- `src/moqlog.ts` の `LogEntry` / `encodeLogEntry` / `decodeLogEntry` は旧 JSON を扱う
- `logGroupId` は時刻のマイクロ秒を `observabilityGroupId` で 62 bit に切り詰める
- `logObjectId` の引数と説明は同一マイクロ秒内の連番である

## 設計方針

- Timestamp Offset、Facility、Hostname / App Name / Proc ID / Msg ID、Message、Attributes を §5.3 の順序・vi64 length・文字コードで読み書きする
- Timestamp Offset は Group の秒に足すナノ秒で 10^9 未満、Facility は 0〜23 とする。severity は Track Name にあり payload へ重複して格納しない
- 定義済みフィールドの後のバイトは将来拡張として無視する。既存の JSON 未知フィールド保持を、新形式の曖昧な追加フィールドへ変換しない
- logGroupId(timestampMicros: bigint) の入力は Unix epoch からのマイクロ秒を維持し、出力を timestampMicros / 1_000_000n の秒 Group ID にする。旧 62 bit truncate は除き、負数や vi64 範囲を超える結果を拒否する。logObjectId の引数は sequenceInSecond とし、その秒の 0 始まりの生成順を表す
- 新しい Log Entry の timestampOffset は bigint のナノ秒 offset とし、絶対時刻やマイクロ秒とは分ける。絶対ナノ秒時刻 t を使う利用例では group = t / 1_000_000_000n、timestampOffset = t % 1_000_000_000n とする。マイクロ秒時刻 m しか無い場合の offset は (m % 1_000_000n) * 1000n であり、得られないナノ秒精度を補わない。旧 epoch の不整合説明は新形式の説明へ置き換える
- 1 Group は Subgroup 0 の 1 本、Datagram 不使用、最終ログの次の Object ID で End of Group、空いた秒は Prior Group ID Gap で示す。現在の module は payload helper なので、自動送信基盤を新設せず利用者向けの組み立て契約と必要な helper を整備する
- 推奨の Publisher Priority 128〜240、group order、cache / timeout、FETCH / fill での時間範囲を新版の説明に揃える
- MSF-01 の JSON / マイクロ秒という旧契約との相違を明記する。名前の移行は 0921 が担当する

## 完了条件

- §5.8 の例に対応する Group 946684799 / 946684805、offset 250000000 / 900000000 / 120000 ns、連番、gap 5 を検証する。Group の差は 6 であり、例の本文の「five seconds later」ではなく数値・UTC 時刻・表に合わせる
- 対応するマイクロ秒入力と絶対ナノ秒入力で Group が一致し、offset の精度差が入力に由来することを検証する。秒境界で丸めや単位の取り違えを起こさない
- 各フィールドの固定バイト、ASCII / UTF-8、空文字、Attributes、切り詰め、将来拡張末尾を検証する
- ログを含む Object と End of Group を混同しない
- 公開型・export・テスト・利用例が最新のバイナリ形式に一致する

## 参照

- `refs/moq/draft-jennings-moq-log-04.txt` §5.1〜§5.8 / §6
- `src/moqlog.ts`、`src/observability.ts` の `observabilityGroupId`、`src/moqlog.test.ts` / `moqlog.prop.ts`、`src/index.ts`

## 解決方法

{未着手}
