# bidi.ts の 4 種の応答読み取りを共通リーダとハンドラ表に畳む

- Created: 2026-09-06
- Completed: {YYYY-MM-DD}
- Branch: feature/refactor-bidi-response-reader
- Polished: 2026-09-12

## 目的

`src/session/bidi.ts` の 4 種の応答読み取り (PUBLISH / SUBSCRIBE / FETCH / TRACK_STATUS) は、pending の取得・読み取り・メッセージ分岐・catch の定型処理を複製しており、1 件の修正が複数箇所の保守になる。共通リーダとハンドラ表に畳んで 1 箇所保守にする。

## 現状

- `bidiReadPublishResponse` / `bidiReadSubscribeResponse` / `bidiReadFetchResponse` / `bidiReadTrackStatusResponse` の 4 関数が、pending の取得 (`pendingPublish` / `pendingSubscribe` / `pendingFetch` / `pendingTrackStatus`)、読み取り (`bidiReadResponseFromBidiStream`)、メッセージ分岐、catch (`toSessionCloseError` の分岐と一般分岐) をそれぞれ複製している。共通ヘルパー `bidiReadResponseFromBidiStream` は共有済みであり、残る複製は関数本体の構造である。
- 4 関数には OK decode と scope 検証以外にも次の差があり、共通化ではこれらを保持する必要がある。
  - OK 受理後の処理: PUBLISH は `session.publishers.set` と `bidiReadRequestStreamMessages` の起動、SUBSCRIBE は track alias 重複検証・購読設定・`subscribersByAlias` 登録・読み取りループの起動、FETCH は End Location 検証・`setFetchOkInfo`・`fetchers.set`・`fireFetcherReadyCallbacks`、TRACK_STATUS は `closeRequestStreamWriter` による writer の FIN を行う。
  - REQUEST_ERROR の `RequestError` 構築: PUBLISH のみ `retryInterval` と `redirect` を含む。
  - GOAWAY の `goawayCallback` 呼び出し: PUBLISH / SUBSCRIBE / FETCH は呼ぶが TRACK_STATUS は呼ばない。
  - catch の `MalformedTrackError` 特別処理: SUBSCRIBE / FETCH は cancel するが PUBLISH / TRACK_STATUS は一般分岐のみ。
  - 失敗経路の削除集合: SUBSCRIBE は `fillFetchTargets`、FETCH は `fireFetcherReadyCallbacks` を追加で処理する。
- 各経路の削除集合・reject してから `closeWithError` する順序・同一 `SessionError` オブジェクト性は、過去の改修で確立した不変条件であり、共通化でも変えない。

## 設計方針

1. 4 関数を共通リーダ + ハンドラ表に畳む。各関数の入口 (export) は `src/session.ts` と `src/session/bidi.test.ts` から参照されているため、薄いラッパーとして残す。
2. 共通リーダは pending の取得・読み取り・catch の共通部分を持ち、経路固有の処理をハンドラとして注入する。ハンドラの軸は「OK 応答の decode と受理後処理」「REQUEST_ERROR の構築」「GOAWAY の扱い」「想定外メッセージ型の扱い」「失敗経路の削除集合」「MalformedTrackError の扱い」とする。
3. 経路固有の差分 (現状の 5 項目) はハンドラ側に残し、共通リーダに取り込まない。
4. 挙動を変えない。特に削除集合・reject / close の順序・エラーオブジェクトの同一性を維持する。
5. 変更対象は `src/session/bidi.ts` (4 関数と共通リーダ) と `src/session/bidi.test.ts` (4 関数の直接呼び出しの追従) とする。`src/session.ts` の呼び出し 4 箇所は原則無変更。

## 完了条件

- 4 種の応答読み取りが 1 本の共通リーダ + ハンドラ表に置き換わり、各関数は薄いラッパーになること。
- 経路固有の挙動 (OK 受理後の処理・REQUEST_ERROR の `retryInterval` / `redirect`・GOAWAY コールバック・`MalformedTrackError` の特別処理・TRACK_STATUS の writer FIN・経路別の削除集合・reject / close の順序) が変わらないこと。
- 既存テストが全て通り、テストの検証内容が変わらないこと。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。
- `CHANGES.md` の `### misc` に `[UPDATE]` を追加すること。

## 関連

- `bidiReadPublishResponse` / `bidiReadSubscribeResponse` / `bidiReadFetchResponse` / `bidiReadTrackStatusResponse` / `bidiReadResponseFromBidiStream` (`src/session/bidi.ts`)
- `issues/0523-refactor-namespace-validation-error.md` (scope 検証フォールバックの整理。`validateParameterScope` の API を先に確定させるため、本 issue より先に実施する)
- `issues/0576-refactor-bidi-test-split.md` (bidi.test.ts の分割。本 issue の入口を残す前提)
- `issues/0577-refactor-namespace-loop-dedup.md` (分割前の 0498 が扱っていた namespace ループの共通化)
