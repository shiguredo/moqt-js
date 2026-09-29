# 出荷経路から参照されないコードとサーバー / リレー専用のコーデックを削除する

- Created: 2026-09-21
- Completed: {YYYY-MM-DD}
- Branch: feature/remove-client-unnecessary-code
- Polished: 2026-09-29

## 目的

`CODEBASE.md` は「現時点ではブラウザでの利用のみを想定しているため、クライアントでのみ利用すること」「クライアント以外での用途の実装は不要であること」を定める (Node.js が WebTransport に正式対応したらテスト用としてサーバー対応も行う予定である)。closed/0601 で同種の整理を行ったが、その後追加された未参照コードと、クライアントが送受信しないメッセージのコーデックがテスト専用のまま残っている。読み手に「使われている機能」と誤解させ、影響範囲調査を無駄に広げるため削除する。

## 現状

いずれも `rg` で `src/` / `devtools/` / `examples/` / `tests/` を検索し、次のいずれかに該当することを確認済み: (a) 出荷経路 (`src/index.ts` から到達するコード) とテストのどちらからも参照されない、(b) テスト専用、(c) 定義ファイル内からしか参照されない 1 行委譲ラッパ、(d) 到達しない分岐。項目ごとの区分は以下に示す。

- `src/session/requests.ts` の `requestsReadPublishResponse` / `requestsReadSubscribeResponse` / `requestsReadFetchResponse` / `requestsReadTrackStatusResponse` は定義以外に参照が無い。呼び出し側は `bidi.bidiReadPublishResponse` などを直接呼んでおり、実体は bidi 側の関数への純粋委譲である
- `src/controlStream.ts` の `ControlStreamReader.clear` は本番参照が無く、`src/controlStream.test.ts` の 1 箇所だけが呼ぶ。バッファを空にするだけの 1 行である
- `src/filter.ts` の `findTrackPropertyValue` は `findPropertyValueInList` を呼ぶだけ、`findPropertyValueInList` は `findPropertyValueRecursive` を呼ぶだけの 1 行ラッパである。どちらも `src/filter.ts` 内でしか呼ばれない (呼び出し元はそれぞれ `trackPropertyFilterParamMatches` / `extractObjectPropertyValue`)。削除時は呼び出し元を委譲先 `findPropertyValueRecursive` の直接呼び出しに変更する
- `src/codec/workerConfigure.ts` の `if (!worker)` は、直前の `new WorkerModule.default()` の戻り値に対する判定であり到達しない (`configureWrapperWorker` の `loadWorkerModule` の型は `new () => Worker` のため戻り値は null にならない)
- クライアントが送受信しないメッセージのコーデックがテスト専用で残っている
  - `src/message/subscribe.ts` の `encodeSubscribeOkPayload`。受信側が必要とする `decodeSubscribeOkPayload` は `src/session/bidi.ts` が使うため残す
  - `src/message/publish.ts` の `encodePublishDonePayload`。本番の送信は `src/session/publish.ts` の `publishSendPublishDoneCore` が `encodeVarint` で payload を組み立てており、この関数を通らない
  - `src/message/namespace.ts` の `decodePublishNamespacePayload` / `encodeNamespacePayload` / `encodeNamespaceDonePayload` / `decodeSubscribeNamespacePayload` / `decodeSubscribeTracksPayload` / `encodePublishSkippedPayload`
  - `encodePublishNamespacePayload` / `encodeSubscribeNamespacePayload` / `encodeSubscribeTracksPayload` (`src/session/namespaces.ts`) と `decodeNamespacePayload` / `decodeNamespaceDonePayload` / `decodePublishSkippedPayload` (`src/session/namespaceLoops.ts`) は出荷経路が使うため残す
- クライアントは受信した SUBSCRIBE / FETCH 等の要求を処理せず、`src/session/incoming.ts` が REQUEST_ERROR (NOT_SUPPORTED) を返す。要求への応答メッセージを組み立てる経路が無いため、対応する encode 関数は出荷経路から到達しない

## 設計方針

1. 出荷経路 (`src/index.ts` から到達するモジュール) とテストのどちらからも参照が無いものを削除する。クライアントが送る側・受信する側のどちらで必要かを 1 つずつ判定し、判定結果を残す
2. 完全未参照に加えて、次も対象とする (どちらも挙動は変えない)
   - モジュール内からしか参照されない 1 行委譲ラッパ (`src/filter.ts` の `findTrackPropertyValue` / `findPropertyValueInList`): 呼び出し元を委譲先 `findPropertyValueRecursive` の直接呼び出しに変更してから削除する
   - 到達しない分岐 (`src/codec/workerConfigure.ts` の `if (!worker)`): 分岐ごと削除する
3. テストが受信メッセージの構築に使っているものは、テストの作りを変えてから削除する (エンコーダーを使った encode→decode のラウンドトリップ PBT は、エンコード側の検証が失われることを踏まえて作り直す)
4. 将来のサーバー対応 (Node.js が WebTransport に正式対応した後のテスト用途) で必要になるコーデックは、その時点で用途に合わせて設計し直す。削除の根拠は「現時点で参照が無いこと」であり、「将来使うかもしれない」ことを残す理由にしない
5. `src/message/index.ts` の再輸出も合わせて整理する
6. 削除の前に、対象ごとに「本番コード (テストを除く) から参照されない」または前掲の「モジュール内専用の 1 行委譲ラッパ・到達しない分岐」に該当することを `rg` で再確認する

## 完了条件

- 出荷経路から参照されないコード (モジュール内専用ラッパ・到達しない分岐を含む) が消え、参照が残っていない
- `vp check` / `vp exec tsc --noEmit` / `vp test run` / `vp pack` が通る
- `CHANGES.md` の `## develop` の `### misc` に `[CHANGE]` を追記すること (closed/0601 と同じ扱い。機能に直接影響しないため misc)

## 参照

- `CODEBASE.md` (クライアント専用であること、および Node.js の WebTransport 正式対応後にテスト用のサーバー対応を行う方針)
- closed/0601 (リポジトリ全体から参照されていない実装コードの削除)
- `src/index.ts` / `src/message/index.ts`

## 解決方法

{未着手}
