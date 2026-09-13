# ストリームのタイムアウトとバッファ上限の締めを実装する

- Created: 2026-09-06
- Completed: 2026-09-14
- Branch: feature/add-stream-timeout-hardening
- Polished: YYYY-MM-DD

## 目的

半端 Length の無期限バッファでメモリが蓄積し、overflow 通知後の集計が他ストリームを巻き添えにする。DoS 耐性の締めが必要である。

## 現状

- `src/controlStream.ts` の Length 不足 `feed` が無期限にバッファする。`CONTROL_MESSAGE_TIMEOUT` / `DATA_STREAM_TIMEOUT` は定義のみで実装がない。
- `src/pendingSubgroupBuffer.ts` は overflow 通知後も加算が続き、巻き添え overflow を起こしうる。

## 設計方針

1. タイムアウト値を実装し、期限切れバッファを破棄する (値の既定は仕様の brief period と整合させる)。
2. overflow 後の `append` を no-op 化するか、所有者側の読取停止を強制する。

## 完了条件

- 半端入力が有界に処理され、巻き添え overflow が起きないこと。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 解決方法

2 つの対策を実装した。issue の参照は draft-20 の節番号だが、現在の一次資料 draft-ietf-moq-transport-21 の §11.3.1 / §12.2 に対応するため、実装とコメントは draft-21 の節番号に合わせている。

### 受信タイムアウト (CONTROL_MESSAGE_TIMEOUT / DATA_STREAM_TIMEOUT)

- `ControlStreamReader` に `hasBufferedBytes` / `bufferedBytes` を追加し、半端な制御メッセージを保持しているかを外から判定できるようにした
- `SessionImpl` の制御ストリーム読み取りループで、半端なメッセージが残っている間だけ期限を張る。期限切れは CONTROL_MESSAGE_TIMEOUT でセッションを閉じ、reader を cancel する
- `SessionImpl.createDataStreamTimeout(reader, bufferedBytes)` を追加し、Subgroup ストリーム (subscriber mode) と Fetch / fill ストリームの各読み取りループで、途中バイトが残っている間だけ期限を張る。期限切れは DATA_STREAM_TIMEOUT でセッションを閉じ、reader を cancel する
- 期限はループ先頭で張り直す。データ不足で `continue` する経路 (半端なヘッダー / Object) でも必ず張られるようにするためである。バッファを消費しきったら解除するため、Object の合間に時間がかかるだけの正常なピアは切らない
- `ConnectOptions.controlMessageTimeoutMs` (既定 10,000 ms) / `ConnectOptions.dataStreamTimeoutMs` (既定 30,000 ms) で指定でき、0 以下でタイムアウトしない。既定値の根拠は、制御メッセージが最大 65,535 バイトであること、および仕様が値を定めていないため「明らかに停止したストリーム」を切る保守的な値にしたことである

### pending Subgroup バッファの巻き添え overflow

per-stream / per-session の上限超過で破棄した entry に `abandoned` を追加し、破棄後の `appendChunk` を no-op にした。従来は破棄後もチャンクを加算し続けるため、破棄したはずのバイトが per-session の集計に残り、無関係な他ストリームが続けて overflow 通知を受けていた。破棄後はチャンクを保持しないので `remove` 時の減算もずれない。`timeout` / `session-close` / `subscriber` は所有者が保持中のチャンクを引き取る可能性があるため破棄扱いにしていない。

### テスト

- `src/session.test.ts`: 半端な制御メッセージが CONTROL_MESSAGE_TIMEOUT で閉じること、分割到着した制御メッセージはタイムアウトしないこと、途中バイトを保持したままタイムアウトすると DATA_STREAM_TIMEOUT で閉じること、完成した Object の処理後はタイムアウトしないこと
- `src/pendingSubgroupBuffer.test.ts`: 破棄した entry が以後のチャンクを加算しないこと、破棄した entry の後続チャンクが他ストリームを巻き添え overflow させないこと

### 実装中に判明した点

Subgroup ストリームは `handleIncomingStream` のループから `handleSubgroupStream` に委譲され、その関数が独自の読み取りループを持つ。タイマーを最初 `handleIncomingStream` のループだけに置いたところ Subgroup では発火しなかったため、共通ヘルパー `createDataStreamTimeout` を作り 2 つのループの両方から使う形に直した。

### 検証

- `vp check` / `tsc --noEmit` 通過
- `vp test run`: 75 ファイル / 2,161 テスト全通過 (6 件増)
- pending Subgroup の 2 件は `abandoned` 判定を外すと落ちることを実測した
- `CHANGES.md` の `## develop` に `[ADD]` (タイムアウト) と `[FIX]` (巻き添え overflow) を追加した
