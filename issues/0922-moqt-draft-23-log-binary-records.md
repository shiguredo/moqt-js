# ログを秒単位 Group とバイナリ Log Record へ移行する

- Created: 2026-11-03
- Completed: {YYYY-MM-DD}
- Branch: feature/change-log-binary-records
- Polished: 2026-11-08

## 目的

moq-log-04 §5.2 / §5.3 は、JSON のログ Object をバイナリ Log Record にし、1 秒を 1 Group とする構成へ変更した。現在の JSON helper とマイクロ秒 Group では新版のログを読み書きできない。

## 現状

- `src/moqlog.ts` の `LogEntry` / `encodeLogEntry` / `decodeLogEntry` は旧 JSON を扱う
- `logGroupId` は時刻のマイクロ秒を `observabilityGroupId` で 62 bit に切り詰める
- `logObjectId` の引数と説明は同一マイクロ秒内の連番である

## 設計方針

- `src/moqlog.ts` の公開型を `LogRecord` に置き換える。`timestampOffset: bigint`（Group の秒に足すナノ秒）、`facility: number`、`hostname` / `appName` / `procId` / `msgId` / `message: string`、`attributes: readonly LogAttribute[]`（`LogAttribute` は `{ key: string; value: string }`）をすべて必須にし、空文字は NILVALUE とする。`severity` / `timestamp` / `pri` と索引シグネチャ、`LOG_ENTRY_FIELD_TYPES` は削除する。`encodeLogEntry` / `decodeLogEntry` は `encodeLogRecord` / `decodeLogRecord` に置き換え、旧名は残さない。`LOG_SEVERITY_LEVELS` は Track Name の決定用に残す
- §5.3 の順序で Timestamp Offset (vi64)、Facility (vi64)、Hostname / App Name / Proc ID / Msg ID の vi64 length + ASCII bytes、Message の vi64 length + UTF-8 bytes、Number of Attributes (vi64) と各 Attribute の Key / Value の vi64 length + UTF-8 bytes を読み書きする。severity は Track Name にあり payload へ重複して格納しない。定義済みフィールドの後のバイトは将来拡張として無視し、旧 JSON の未知フィールド保持を新形式へ持ち込まない
- encode は `timestampOffset` を 0 以上 10^9 未満、`facility` を 0〜23、ASCII フィールドを 0x00〜0x7f に制限し、範囲外を `Error` で拒否する。decode は切り詰めを `IncompleteDataError`、値域違反・ASCII 範囲外・不正 UTF-8 を `ProtocolViolationError` で拒否する。UTF-8 は `TextEncoder` と `fatal: true` の `TextDecoder` で扱う
- `logGroupId(timestampMicros: bigint)` は Unix epoch からのマイクロ秒を秒へ切り捨て、`timestampMicros / 1_000_000n` を返す。負数と 2^64-1 (`MAX_VARINT`) を超える結果を拒否する。`observabilityGroupId` は `metricsGroupId` が使うため実装は変更せず、`logGroupId` からの利用だけを外す。`src/observability.ts` の module JSDoc、`GROUP_ID_MASK_62`、`observabilityGroupId` の 62-bit truncate と `label` の例に関する記述だけを metrics 用に限定し、`SYSLOG_LEVELS` / `observabilityTrackName` / `observabilityTrackNamespace` の共有は維持する。helper の削除は 0924 に委ねる
- `logObjectId(sequenceInSecond: number)` はその秒の 0 始まりの生成順を bigint で返し、非負の安全な整数だけを受理する。`Publisher.sendObject` の `groupId` / `objectId` は number のため、`logGroupId` / `logObjectId` の戻り値は `Number()` で渡す（Object ID は安全な整数の範囲に限る）。`LogRecord.timestampOffset` は Group の秒に足すナノ秒とし、絶対ナノ秒時刻 t では group = t / 1_000_000_000n、timestampOffset = t % 1_000_000_000n、マイクロ秒時刻 m では group = logGroupId(m)、timestampOffset = (m % 1_000_000n) * 1000n とする。後者は得られないナノ秒精度を補わない。旧 epoch の不整合説明は新形式の説明へ置き換える
- 1 Group は Subgroup 0 の 1 本、Datagram 不使用とする。最終ログの次の Object ID を `status: ObjectStatus.END_OF_GROUP`、空 payload、properties なしで `Publisher.sendObject` に渡して End of Group にし、空 payload を `decodeLogRecord` が Log Record として受理しない
- 各 Group の最初の Normal Object に `PRIOR_GROUP_ID_GAP` を付け、値は前の Group からの差 - 1（0 を含む）とする。ただし前の Group が不明な場合（開始後最初の Group など）は付けない。`logPriorGroupIdGap(previousGroupId: bigint | undefined, currentGroupId: bigint): bigint | undefined` を追加し、前の Group が不明なら undefined、それ以外は `currentGroupId - previousGroupId - 1n` を返す。負の Group ID や増加しない Group ID を拒否し、§5.8 の 946684799 → 946684805 で 5 を返す
- 推奨の Publisher Priority 128〜240、`DEFAULT_PUBLISHER_GROUP_ORDER` の Ascending、`MAX_CACHE_DURATION`、`OBJECT_DELIVERY_TIMEOUT`、FETCH / fill の時間範囲を module の JSDoc に書き、自動送信基盤は新設しない
- MSF-01 §9.1 の JSON MUST と §9.3 のマイクロ秒 62-bit は旧 log-03 を参照している。`src/moqlog.ts` の module JSDoc、`src/moqlog.test.ts` / `src/moqlog.prop.ts` の先頭、`docs/IMPLEMENTATION_STATUS.md` の MOQ Log を log-04 のバイナリ Log Record / 秒 Group に更新し、MSF-01 との不一致を明記する。0921 が入れた「payload は log-03」の記述は log-04 に置き換える。CHANGES.md は CODEBASE.md の特別ルールにより更新しない
- 名前 / namespace は 0921、metrics の catalog / payload は 0923 / 0924 が担当する。0922 は log の payload / Group / Object / Prior Group ID Gap の契約だけを扱う

## 完了条件

- `LogRecord` の各フィールドを §5.3 の順序でエンコードし、固定バイトで検証する。Timestamp Offset / Facility の vi64、長さ 0 の ASCII / UTF-8、Attributes の順序と重複キー、定義済みフィールド後の将来拡張バイトを無視することを検証する
- `timestampOffset` の 10^9 境界、`facility` の 0 / 23 / 24、ASCII の 0x7f / 0x80、UTF-8 の不正バイト、切り詰めを拒否する
- `logGroupId` がマイクロ秒を秒へ切り捨て、負数と `MAX_VARINT` 超を拒否する。§5.8 の 946684799 / 946684805 と offset 250000000 / 900000000 / 120000 を再現する。Group の差は 6 であり、例の本文の「five seconds later」ではなく数値・UTC 時刻・表に合わせる。マイクロ秒と絶対ナノ秒の換算式が同じ Group / offset を与え、精度差が入力に由来することを固定する
- `logObjectId(0)` / `logObjectId(1)` が 0n / 1n を返し、§5.8 の End of Group が Object ID 2 / 1 になることを、`sendObject` の `END_OF_GROUP` 契約（空 payload・properties なし）と `Number()` 変換を合わせて検証する。空 payload を `decodeLogRecord` が拒否する
- `logPriorGroupIdGap(946684799n, 946684805n)` が 5n、`logPriorGroupIdGap(946684799n, 946684800n)` が 0n、`logPriorGroupIdGap(undefined, 946684799n)` が undefined になり、負数・減少・同値を拒否する
- `src/moqlog.ts` / `src/moqlog.test.ts` / `src/moqlog.prop.ts` の先頭を log-04 にし、`docs/IMPLEMENTATION_STATUS.md` の MOQ Log を log-04 のバイナリ Log Record / 秒 Group に更新する。MSF-01 §9.1 / §9.3 が旧 JSON / マイクロ秒を参照していることを明記する。`src/observability.ts` の module JSDoc / `GROUP_ID_MASK_62` / `observabilityGroupId` の 62-bit truncate と `label` の例を metrics 用に限定する
- 公開型・export・JSDoc・テストが新しい API に一致し、`src/moqlog*` / `src/index.ts` / `docs/IMPLEMENTATION_STATUS.md` に旧 `LogEntry` / `encodeLogEntry` / `decodeLogEntry` の参照が残らない（devtools の同名の別型は対象外）

## 参照

- `refs/moq/draft-jennings-moq-log-04.txt` §5.1〜§5.8 / §6
- `refs/moq/draft-ietf-moq-transport-23.txt` §8.1 / §10.8 / §11.1.1 / §11.1.2
- `refs/moq/draft-ietf-moq-msf-01.txt` §9
- `src/moqlog.ts`、`src/observability.ts`、`src/varint.ts`、`src/properties.ts`、`src/publisher.ts`、`src/index.ts`
- `src/moqlog.test.ts` / `src/moqlog.prop.ts`、`src/varint.test.ts`、`src/properties.test.ts`
- `docs/IMPLEMENTATION_STATUS.md` の MOQ Log
- `issues/0921-moqt-draft-23-observability-track-names.md`、`issues/0923-moqt-draft-23-metrics-versioned-catalog.md`、`issues/0924-moqt-draft-23-metrics-binary-values.md`（担当範囲の境界）
- `issues/0864-add-publisher-prior-group-id-gap.md`（Prior Group ID Gap の既存実装）、`issues/0865-change-catalog-fill-fetch.md`（fill fetch の既存方針）

## 解決方法

{未着手}
