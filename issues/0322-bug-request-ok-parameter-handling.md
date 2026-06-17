# FETCH_OK / REQUEST_UPDATE_OK / TRACK_STATUS_OK のパラメータ処理を修正する

- Priority: Medium
- Created: 2026-06-17
- Model: Opus 4.8
- Branch: feature/fix-request-ok-parameter-handling

## 目的

`FETCH_OK`、`REQUEST_UPDATE_OK`、`TRACK_STATUS_OK` の各 OK 応答メッセージにおけるパラメータの許可/禁止/処理を draft-ietf-moq-transport-18 に合わせて修正する。現在の実装では許可パラメータの定義が誤っていたり、許可されていないパラメータを読み取ろうとしていたり、パラメータが捨てられていたりする。

## 優先度根拠

パラメータ処理の誤りは、将来的な拡張や相互運用時に問題を引き起こす。特に `FETCH_OK` に許可されていない `GROUP_ORDER` を読もうとしている点は、draft 違反にあたる。ただし現状の主要フローが即座に破綻するわけではないため Medium。

## 現状

`src/message/parameterScope.ts`:

- L51-L53: `FETCH_OK_ALLOWED_PARAMS` に `EXPIRES` と `LARGEST_OBJECT` が含まれている。draft では `FETCH_OK` にこれらは含められない (§10.2.10, §10.2.11)。
- L83-L87: `REQUEST_UPDATE_OK_ALLOWED_PARAMS` に `EXPIRES` が含まれていない。draft では `EXPIRES` は `REQUEST_UPDATE_OK` に出現可能 (§10.2.10)。

`src/session/bidi.ts`:

- L519-L527: `bidiReadFetchResponse` で `FETCH_OK` から `GROUP_ORDER` を読もうとしている。`GROUP_ORDER` は `FETCH_OK` には許可されていない (§10.2.8)。
- L583-L635: `bidiReadTrackStatusResponse` で `TRACK_STATUS_OK` の `trackProperties` (パラメータ) が捨てられており、パラメータスコープの検証も行われていない。

## 仕様根拠

draft-ietf-moq-transport-18:

- **§10.2.8 (GROUP_ORDER)**: `GROUP_ORDER` は `SUBSCRIBE_OK` 等に許可されるが、`FETCH_OK` には許可されない。
- **§10.2.10 (EXPIRES)**: `EXPIRES` は `SUBSCRIBE_OK`、`FETCH_OK`、`REQUEST_UPDATE_OK` 等に出現可能。
- **§10.2.11 (LARGEST_OBJECT)**: `LARGEST_OBJECT` は `SUBSCRIBE_OK` 等に許可されるが、`FETCH_OK` には許可されない。
- **§10.5 (FETCH_OK)**: `FETCH_OK` に許可されるパラメータの範囲。
- **§10.14 (TRACK_STATUS_OK)**: `TRACK_STATUS_OK` に許可されるパラメータの範囲。

## 設計方針

1. `src/message/parameterScope.ts` の修正:
   - `FETCH_OK_ALLOWED_PARAMS` から `EXPIRES` と `LARGEST_OBJECT` を削除する。
   - `REQUEST_UPDATE_OK_ALLOWED_PARAMS` に `EXPIRES` を追加する。
   - 各 `*_ALLOWED_PARAMS` が draft §10.x に照らし合わせて正しいことを再確認する。

2. `src/session/bidi.ts` の修正:
   - `bidiReadFetchResponse` から `FETCH_OK` の `GROUP_ORDER` 読み取りを削除する。
   - 必要であれば、代わりに許可されているパラメータ (`EXPIRES` 等) を適切に処理する。
   - `bidiReadTrackStatusResponse` で `TRACK_STATUS_OK` のパラメータを捨てず、`parameterScope` を用いて検証し、許可されたパラメータは呼び出し側で利用可能にする。

3. 型定義の更新:
   - `FetchOk`、`RequestUpdateOk`、`TrackStatusOk` 等の型に、許可されたパラメータフィールドを追加または修正する。

4. テスト追加:
   - 各 OK メッセージのパラメータ許可/禁止を検証するテストを追加する。
   - 無効なパラメータが含まれる場合のエラー処理を検証する。

## 完了条件

- `FETCH_OK_ALLOWED_PARAMS` から `EXPIRES` と `LARGEST_OBJECT` が削除される
- `REQUEST_UPDATE_OK_ALLOWED_PARAMS` に `EXPIRES` が追加される
- `bidiReadFetchResponse` が `FETCH_OK` から `GROUP_ORDER` を読み取らない
- `bidiReadTrackStatusResponse` が `TRACK_STATUS_OK` のパラメータを検証し、利用可能にする
- パラメータ処理に関するテストが追加される
- 既存の全テストが PASS する
- `CHANGES.md` に `[FIX]` エントリを追記する
