# INCLUDE_PROPERTIES パラメータを追加する

- Created: 2026-09-01
- Completed: {YYYY-MM-DD}
- Branch: feature/add-include-properties-parameter
- Polished: {YYYY-MM-DD}

## 目的

draft-ietf-moq-transport-20 §10.2.21 の `INCLUDE_PROPERTIES` (0x35) を追加し、応答 / PUBLISH に Track Properties を載せるかを要求できるようにする。

## 現状

- `MessageParameterType` に 0x35 が無い。未知パラメータとして受信時 PROTOCOL_VIOLATION、送信 API も無い。
- 値は uint8: 0 (Properties を送らない / 空) または 1 (送る)。デフォルト 1。範囲外は PROTOCOL_VIOLATION。
- 出現箇所: SUBSCRIBE / TRACK_STATUS / FETCH / SUBSCRIBE_TRACKS。

## 設計方針

- `MessageParameterType.INCLUDE_PROPERTIES = 0x35` と encoding map、各メッセージの `build*Parameters` / スコープ集合を更新する。
- 公開オプション (Subscribe / Fetch / Tracks 等) に `includeProperties?: boolean` を足し、0/1 をワイヤ化する。省略時はパラメータ自体を送らない (デフォルト 1 と同等)。
- 受信側で 0/1 以外は PROTOCOL_VIOLATION。OK / PUBLISH 生成は、moqt-js が当該応答を生成する経路がある場合のみ空 Properties に従う。無い経路は送信オプションと受信検証まででよい。

## 完了条件

- 0x35 の encode / decode / スコープ検証があること。
- 値 0/1 以外で PROTOCOL_VIOLATION になること。
- SUBSCRIBE / FETCH / SUBSCRIBE_TRACKS (および TRACK_STATUS があれば) から送れること。
- `CHANGES.md` の `## develop` に `[ADD]` があること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- draft-ietf-moq-transport-20 §10.2.21 (INCLUDE_PROPERTIES Parameter)
- draft-ietf-moq-transport-20 Appendix A.1 (#1813, #1847)
