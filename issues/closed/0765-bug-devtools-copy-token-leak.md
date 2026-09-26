# moqt-devtools の Copy for LLM に認可トークンの値が出る

- Created: 2026-09-26
- Completed: 2026-09-26
- Branch: feature/fix-devtools-copy-token-leak
- Polished: {YYYY-MM-DD}

## 目的

moqt-devtools のデバッグパネルの「Copy for LLM」は、不具合の報告のために外部 (LLM や issue) へ貼ることを前提にしたテキストである。そこに認可トークン (AUTHORIZATION_TOKEN) の値が出る経路が 2 つあり、そのまま貼ると credential が漏れる。共有される前提のテキストへ値を持ち込まないようにする。

## 現状

- Relay URI の c4m: `devtools/src/signals/connectionSettings.ts` の `applyC4mFromUrl` は `devtools/src/utils/c4m.ts` の `extractC4mBase64` で取り出した Base64 を `authorizationTokenBase64` へ入れるが、`url` と `fragment` の signal からは c4m を消さない。`devtools/src/signals/connectionSettingsSnapshot.ts` は `url` と `fragment` をそのまま載せ、`devtools/src/utils/debugExportText.ts` の `formatSnapshotSection` は全キーを出すため、c4m 付きの URL を貼ると `url:` 行と `fragment:` 行に Base64 のトークンが出る
  - `window.moqtDevTools` も `getConnection().serverUrl` と `getPublisher().serverUrl` で同じ値を返す (接続に使う値そのものなので、こちらは漏れではなく API の仕様である)
- SETUP の payload: `src/session/connection.ts` の SETUP 送信が `session.emitDebug("send", MessageType.SETUP, setupPayload, {})` で payload を通知する。SETUP は AUTHORIZATION_TOKEN Setup Option (draft-ietf-moq-transport-21 §9.1.4) を載せうるため、トークンを設定していると payload にトークンのバイト列が入る。`devtools/src/hooks/debugMessageLog.ts` の `logDebugMessage` が最大 `MAX_LOGGED_PAYLOAD_BYTES` (4096) バイトをコピーしてログに残し、hex dump が画面の Binary タブ、行コピー、Copy for LLM のログの節に出る
- `decoded` にはトークンは入らない。moqt-js が `emitDebug` に渡す `decoded` は `requestId` などの明示的な項目だけで、`parameters` を含まないため、`logDebugMessage` の `Object.assign(data, message.decoded)` 経由の漏れは無い。漏れるのは payload の hex dump と URL の c4m の 2 経路である
- 受信の payload も同じ: AUTHORIZATION_TOKEN Message Parameter (draft-ietf-moq-transport-21 §9.20.3) は SETUP のほか、SUBSCRIBE / FETCH / TRACK_STATUS / PUBLISH_NAMESPACE / SUBSCRIBE_NAMESPACE / SUBSCRIBE_TRACKS / PUBLISH / REQUEST_UPDATE の payload に載りうる。devtools が自分でトークンを載せるのは SETUP だけ (`buildConnectOptions` を `connect` に渡す経路) だが、受信の payload は peer が載せうる
- `devtools` に redact / mask の仕組みは無く、認可トークンの値がログ・コピー本文に出ないことを固定するテストも無い (`tests/e2e/devtools-authorization-token.spec.ts` は c4m の取り込みの UI だけを見る)

## 設計方針

- AUTHORIZATION_TOKEN を載せうるメッセージの payload は、ログへコピーしない。判定は `DebugMessage.type` の数値で行う (SETUP / PUBLISH / SUBSCRIBE / FETCH / TRACK_STATUS / PUBLISH_NAMESPACE / SUBSCRIBE_NAMESPACE / SUBSCRIBE_TRACKS / REQUEST_UPDATE)
  - payload からトークンのバイト範囲は特定できないため、hex dump を部分的に伏せることはできない。保持しないことを選ぶ
  - `payloadSize` と `decoded` は残すため、何バイトでどんな項目だったかは読める。画面の Binary タブも出なくなる
  - 未知の型で届いた payload は残る (仕様違反の peer が他の型に載せた場合は防げない)。これは対象外とし、コメントに理由を書く
- c4m を含む Relay URI と URI Fragment は、コピー用のテキストでは値を伏せる (`c4m=<redacted>`)。`devtools/src/utils/c4m.ts` に伏せ字の純関数を足し、URL 全体と fragment 単体の両方の入力形、`c4m=` の全出現を対象にする
  - `url` / `fragment` の signal は接続に使う値のため変えない。伏せるのは `devtools/src/signals/connectionSettingsSnapshot.ts` のスナップショットと、本文を組み立てる `devtools/src/signals/debugExport.ts` の最後で行う (統計の節の `serverUrl` のように、同じ Relay URI が別の節からも入るため)
- メッセージ型を足したら「認可トークンを載せうる」か「載せない (理由)」のどちらかへ分類することをテストで強制する (載せ忘れると payload がそのままログに残るため)
- テスト: トークンを設定した状態のコピー本文に値が出ないこと、トークンを載せうる型の payload が保持されないこと (decoded と payloadSize は残ること)、c4m 付きの URL と fragment から開いたコピー本文に c4m が出ないことを固定する。伏せ字の性質は Property-Based Testing で確かめる

## 完了条件

- 認可トークンの値 (Token Value と c4m の Base64) が、Copy for LLM のテキスト、行コピー、画面の hex dump のどこにも出ない (テストで固定する)
- トークンを載せうるメッセージでも `payloadSize` と `decoded` は読める
- Copy URL (URL で設定を共有する機能) と `window.moqtDevTools` の返す値は変えない
- `vp check` / `vp exec tsc --noEmit` / `vp exec tsc -p devtools --noEmit` / `vp test run` / `vp run e2e-test` が通る

## 参照

- `devtools/src/hooks/debugMessageLog.ts` の `logDebugMessage` / `MAX_LOGGED_PAYLOAD_BYTES`
- `devtools/src/utils/c4m.ts` の `extractC4mBase64`
- `devtools/src/signals/connectionSettings.ts` の `applyC4mFromUrl` / `buildAuthorizationToken` / `buildConnectOptions`
- `devtools/src/signals/connectionSettingsSnapshot.ts` の `buildConnectionSettingsSnapshot`
- `devtools/src/utils/debugExportText.ts` の `formatLogEntryText` / `formatSnapshotSection`
- `src/session/connection.ts` の SETUP 送信の `emitDebug`
- `src/session/params.ts` の `encodeAuthorizationTokenParameter` と各メッセージのパラメータ構築

## 解決方法

- `devtools/src/hooks/debugMessageLog.ts` で、認可トークンを載せうるメッセージ (SETUP / PUBLISH / SUBSCRIBE / FETCH / TRACK_STATUS / PUBLISH_NAMESPACE / SUBSCRIBE_NAMESPACE / SUBSCRIBE_TRACKS / REQUEST_UPDATE) の payload をログへコピーしないようにした。payload からトークンのバイト範囲は特定できないため hex dump を部分的に伏せることはできず、保持しないことが唯一確実である。`payloadSize` と `decoded` は残し、payload を残さなかった理由を `data` の `payloadOmitted` に記録する (payload が無いメッセージと区別できる)
  - 判定はメッセージ型の数値 (`src/message/types.ts` の `MessageType`) で行う (表示名は変わりうるため)
  - メッセージ型を足したら「載せうる」か「載せない (理由)」のどちらかへ分類することをテストで強制する。仕様の版が上がって応答にも credential を載せられるようになったら気づける
- `devtools/src/utils/c4m.ts` に `maskC4mValue` を足し、c4m の値を `c4m=<redacted>` にした。Relay URI と URI Fragment のどちらにも書けるため両方に適用し、`c4m=` の出現をすべて潰す。値の範囲は `&` と空白 (改行を含む) までにする (本文全体へかけるため、改行を値に含めると後続の節まで消える。Property-Based Testing がこの不具合を検出した)
- 伏せ字は `devtools/src/signals/connectionSettingsSnapshot.ts` (設定の節) と `devtools/src/signals/debugExport.ts` の本文全体の 2 箇所で行う。統計の節の `serverUrl` のように同じ Relay URI が別の節からも入るため、節ごとではなくテキスト全体にもかける。signal と `window.moqtDevTools` が返す値は変えない (Copy URL は設定を渡す共有リンクのため、今までどおり値を載せる。意図をコメントに書いた)
- テスト: payload の扱い (`devtools/src/hooks/debugMessageLog.test.ts`)、伏せ字の性質 (`devtools/src/utils/c4m.prop.ts` の PBT と `c4m.test.ts` の境界)、スナップショット (`connectionSettingsSnapshot.test.ts`)、本文 (`debugExport.test.ts`)、E2E (`tests/e2e/devtools-debug-panel.spec.ts` で c4m 付きの Relay URI と fragment から開き、Publisher の節も出した状態で本文に値が出ないことを確認)
- レビューで見つけた「Publisher の節の `serverUrl` から漏れる」経路と「伏せ字が行をまたいで後続の節を消す」不具合を直した
- `vp check` / `vp exec tsc --noEmit` / `vp exec tsc -p devtools --noEmit` / `vp test run` (169 ファイル / 3049 テスト) / `vp run e2e-test` (55 件) が通った
