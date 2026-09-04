# INCLUDE_PROPERTIES パラメータを追加する

- Created: 2026-09-01
- Completed: 2026-09-04
- Branch: feature/add-include-properties-parameter
- Polished: 2026-09-02

## 目的

draft-ietf-moq-transport-20 §10.2.21 の `INCLUDE_PROPERTIES` (0x35) を追加し、応答 / PUBLISH に Track Properties を載せるかを要求できるようにする。

## 現状

- `MessageParameterType` に 0x35 が無い。未知パラメータとして受信時 PROTOCOL_VIOLATION、送信 API も無い。
- 値は uint8: 0 (Properties を送らない / 空) または 1 (送る)。デフォルト 1。範囲外は PROTOCOL_VIOLATION。
- 出現箇所: SUBSCRIBE / TRACK_STATUS / FETCH / SUBSCRIBE_TRACKS。

## 設計方針

- `MessageParameterType.INCLUDE_PROPERTIES = 0x35` を追加し、`MESSAGE_PARAMETER_VALUE_ENCODING` に uint8 として載せる。受信側の `*_ALLOWED_PARAMS` スコープ集合は、moqt-js が受信 SUBSCRIBE / FETCH / TRACK_STATUS / SUBSCRIBE_TRACKS を NOT_SUPPORTED で拒否するため存在せず、更新対象は送信側の `build*Parameters` のみ (既存スコープ集合へ誤って追加しないこと)。
- 公開オプション (Subscribe / Fetch / Tracks / TrackStatus) に `includeProperties?: boolean` を足し、0/1 をワイヤ化する。省略時はパラメータ自体を送らない (デフォルト 1 と同等)。TRACK_STATUS は `trackStatus()` のオプションとして受け取る。
- 受信側で 0/1 以外は PROTOCOL_VIOLATION。OK / PUBLISH 生成は、moqt-js が当該応答を生成する経路がある場合のみ空 Properties に従う。無い経路は送信オプションと受信検証まででよい。

## 完了条件

- 0x35 の encode / decode があること。
- 値 0/1 以外で PROTOCOL_VIOLATION になること。
- SUBSCRIBE / FETCH / SUBSCRIBE_TRACKS / TRACK_STATUS から送れること。
- `CHANGES.md` の `## develop` に `[ADD]` があること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- draft-ietf-moq-transport-20 §10.2.21 (INCLUDE_PROPERTIES Parameter)
- draft-ietf-moq-transport-20 Appendix A.1 (#1813, #1847)

## 解決方法

`INCLUDE_PROPERTIES` (0x35) を uint8 パラメータとして追加し、4 経路の送信に対応した。

- 値 0/1 の符号化と範囲外の受信検証をデコード経路に接続する
- SUBSCRIBE / TRACK_STATUS / FETCH / SUBSCRIBE_TRACKS の公開オプションとビルダーに透過する (省略時は不送)
- 受信側スコープ集合には追加せず、応答混入は既存機構で拒否する
- `CHANGES.md` の `## develop` に `[ADD]` を追記する
