# namespace ループが GOAWAY 受信後に送信方向を閉じない

- Created: 2026-08-10
- Completed: 2026-08-28
- Branch: feature/fix-namespace-goaway-send-direction-close
- Polished: 2026-08-20

## 目的

namespace 系ストリーム (SUBSCRIBE_NAMESPACE / SUBSCRIBE_TRACKS / PUBLISH_NAMESPACE) で GOAWAY を受信した際 (resolved=true)、draft-ietf-moq-transport-19 §10.4 の SHOULD「Upon receiving a GOAWAY on a request stream, the endpoint SHOULD re-issue that specific request ... and close the old request stream using the appropriate mechanism (e.g. FIN, stream reset, or PUBLISH_DONE)」に従い、送信方向を FIN (writer.close()) で閉じる。

## 現状

- 0372 の実装で namespace 3 ループは GOAWAY 受信後も読み取りを継続する (重複 GOAWAY 検出のため)。しかし送信方向 (writer) は開いたままになっている。
- ピアが FIN も GOING_AWAY リセットも送らない場合、namespaceSubscriptions / tracksSubscriptions / namespacePublications の Map エントリと streamReader ロックがセッション close まで残る。
- 一方、bidi の subscribe ロール (bidiReadRequestStreamMessages) は GOAWAY 受信時に `streamInfo.writer.close()` で送信方向を FIN する。namespace ループには同様の FIN 送信がない。
- 0372 の設計方針は「送信方向はアプリの再発行に委ね、受信方向の読み取りを継続する」としていたが、§10.4 SHOULD の観点で FIN 送信が望ましい。

## 設計方針

- namespace ループの GOAWAY 受信 (resolved=true) 時も、送信方向を `writer.close()` で FIN し、ピアのストリームクローズ (FIN / GOING_AWAY) を促す。受信方向の読み取り継続は維持する。
- `writer.close()` は局所 try/catch で囲み、`await` で実行する（bidi の `closeOldRequestStreamOnGoaway`（`src/session/bidi.ts`）の既存パターン `await streamInfo.writer.close()` に揃える。await しないと close() の reject が局所 try/catch をすり抜けて unhandled rejection になる）。try/catch なしで置くと close() の reject がループ全体の catch に落ち、catch → finally でループが終了して重複 GOAWAY 検出のための読み取り継続が失われる (goawayReceived 設定の前後に関わらず、catch は読み取り継続を維持しない)。
- writer は namespaceSubscriptions / tracksSubscriptions / namespacePublications のエントリから取得する。writer は optional (`NamespaceSubscriptionState` / `TracksSubscriptionState`) または必須 (`NamespacePublicationState`) であり、undefined ガードを付ける。なお実行時は `src/session.ts` のエントリ生成時に必ず writer が設定されるため、ガードは型起因の防御である。
- GOAWAY 受信時点で pending の REQUEST_UPDATE がある場合の扱いは変更しない。namespace ループは「GOAWAY 後の REQUEST_ERROR 受信時」または「ストリームクローズ時」に reject する既存設計のままとし、`writer.close()` 追加後も読み取り継続により reject 経路は健在である（bidi の GOAWAY 受信時即時 reject とは非同期だが、挙動を揃える変更は行わない）。
- アプリの done() / unsubscribe() との二重 close は、既存の局所 try/catch により黙殺される（bidi の二重 close 黙殺パターンと同様）。GOAWAY 時は state を閉じないため、GOAWAY 後にアプリが done() を呼ぶと二重 close になり得るが、実害はない。
- PUBLISH_NAMESPACE ループ (namespace 系リクエストの requester 側) への FIN 適用は、bidi の Established subscription の publisher ロール (GOAWAY 受信時に FIN を送らずアプリの done() に委ねる) と非対称に見えるが、§3.3.2 の「the publisher of an Established subscription MUST send PUBLISH_DONE, before sending a FIN」は Established subscription 限定であり、namespace publication は subscription ではないため対象外。§10.4 の「e.g. FIN, stream reset, or PUBLISH_DONE」の選択肢に FIN が含まれ、PUBLISH_NAMESPACE への FIN は妥当である。
- 変更対象ファイル: `src/session/namespaceLoops.ts` (3 ループの GOAWAY ケース)、`src/session/namespaceLoops.test.ts` (テスト追加。テスト基盤 `createNamespaceLoopTestContext` の subscription オブジェクトに writer が含まれていないため、writer の注入が必要)、`CHANGES.md` (既存の 0372 エントリ「namespace 系ループは GOAWAY 後も読み取りを継続し、callbacks.goaway 通知のみを行う」の「のみ」は不正確になるため更新、および本 issue の新規 `[FIX]` エントリ追加。`## develop` は未リリースのため、0372 エントリの文言修正は本 issue の差分に含めてよい)。
- 実装順序: 0407 (先頭 GOAWAY の許可、resolved=false 対象) を先に実装する。0408 は「0407 の resolved=false 分岐に触れず resolved=true 側へ `writer.close()` を追加」という変更範囲が明確になり、完了条件「resolved=false の GOAWAY (先頭 GOAWAY) の扱いは変更しないこと」の検証も実装後に可能になる。

## 完了条件

- namespace ループで GOAWAY 受信時 (resolved=true) に送信方向が FIN (writer.close()) で閉じられること。
- 重複 GOAWAY 検出 (読み取り継続) が維持されること (`writer.close()` 後も読み取りが継続することを新テストで検証する)。
- resolved=false の GOAWAY (先頭 GOAWAY) の扱いは変更しないこと (open issue 0407 のスコープ)。
- 上記を検証するテストがあること (namespaceLoops.test.ts の既存 GOAWAY テスト基盤を使用し、実 `WritableStream` を writer として注入して送信方向 FIN を検証。検証方法: close() 後の write が reject する、または close() の Promise が resolve することを確認する。モック / スタブは使わない)。あわせて `writer.close()` 後も読み取り継続が維持されること (既存の GOAWAY 受信後 REQUEST_ERROR テストによる読み取り継続の維持も検証手段に含む) を検証する。なおテスト基盤 `createNamespaceLoopTestContext` は namespace / tracks の 2 種のみであり、PUBLISH_NAMESPACE ループの検証には kind: "publication" の基盤拡張または新規テストが必要)。
- `CHANGES.md` の `## develop` に `[FIX]` があること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- draft-ietf-moq-transport-19 §10.4 (GOAWAY)（「Upon receiving a GOAWAY on a request stream, the endpoint SHOULD re-issue that specific request ... and close the old request stream using the appropriate mechanism (e.g. FIN, stream reset, or PUBLISH_DONE)」）
- 関連: `issues/closed/0372-moqt-draft-19-duplicate-goaway-on-request-stream-undetected.md`（GOAWAY 受信後の読み取り継続。エッジケース (e) で writer.close() の局所 try/catch を規定）
- 関連: `issues/0407-fix-initial-goaway-on-namespace-stream.md`（先頭 GOAWAY の許可。resolved=false が対象。本 issue は resolved=true が対象であり、同一 switch ケースに触れるため実装順序に注意）

## 解決方法

0407 で導入した `namespaceHandleGoawayMessage` helper を async 化し、resolved=true (確立後) の GOAWAY で `writer.close()` を await + try/catch する経路を追加した (draft-ietf-moq-transport-19 §10.4 SHOULD「close the old request stream using the appropriate mechanism (e.g. FIN, stream reset, or PUBLISH_DONE)」に従い送信方向を FIN で閉じる)。

- helper に `writer` 引数を追加し、3 ループ (namespace / tracks / publication) の呼び出し側を `await namespaceHandleGoawayMessage(..., subscription.writer, ...)` / `await namespaceHandleGoawayMessage(..., publication.writer, ...)` に更新した。
- `writer.close()` は局所 try/catch で reject を握り潰し、ループ全体の catch に落ちて読み取り継続 (2 通目 GOAWAY 検出) が失われるのを防ぐ。二重 close (アプリ側の unsubscribe() / done() との競合) も try/catch で黙殺する。
- `namespaceHandleGoaway` の `callbacks.goaway` 呼び出しを try/catch で保護し、コールバック例外で FIN 送信がスキップされないようにした (bidi の `closeOldRequestStreamOnGoaway` と同方針)。
- `src/session/namespaceLoops.test.ts` にテストヘルパーの writer フィールドと `writerClosed()` を追加した。3 ループそれぞれで「REQUEST_OK → GOAWAY → writer.closed 到達 → 2 通目 GOAWAY を PROTOCOL_VIOLATION で検出」の経路を検証する新規テストを追加した。
- `CHANGES.md` の既存 0372 由来 [FIX] エントリの子項目「namespace 系ループは GOAWAY 後も読み取りを継続し、callbacks.goaway 通知のみを行う」を「読み取りを継続する (送信方向 FIN は本 [FIX] エントリで対応する)」に修正し、本 issue の新規 [FIX] エントリへの cross-reference を明確化した。
