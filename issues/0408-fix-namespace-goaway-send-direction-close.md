# namespace ループが GOAWAY 受信後に送信方向を閉じない

- Created: 2026-08-10
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-namespace-goaway-send-direction-close
- Polished: 2026-08-16

## 目的

namespace 系ストリーム (SUBSCRIBE_NAMESPACE / SUBSCRIBE_TRACKS / PUBLISH_NAMESPACE) で GOAWAY を受信した際 (resolved=true)、draft-ietf-moq-transport-19 §10.4 の SHOULD「Upon receiving a GOAWAY on a request stream, the endpoint SHOULD re-issue that specific request ... and close the old request stream using the appropriate mechanism (e.g. FIN, stream reset, or PUBLISH_DONE)」に従い、送信方向を FIN (writer.close()) で閉じる。

## 現状

- 0372 の実装で namespace 3 ループは GOAWAY 受信後も読み取りを継続する (重複 GOAWAY 検出のため)。しかし送信方向 (writer) は開いたままになっている。
- ピアが FIN も GOING_AWAY リセットも送らない場合、namespaceSubscriptions / tracksSubscriptions / namespacePublications の Map エントリと streamReader ロックがセッション close まで残る。
- 一方、bidi の subscribe ロール (bidiReadRequestStreamMessages) は GOAWAY 受信時に `streamInfo.writer.close()` で送信方向を FIN する。namespace ループには同様の FIN 送信がない。
- 0372 の設計方針は「送信方向はアプリの再発行に委ね、受信方向の読み取りを継続する」としていたが、§10.4 SHOULD の観点で FIN 送信が望ましい。
- なお、本修正 (送信方向 FIN) は Map エントリと streamReader ロックの残留を直接解消しない (受信方向は読み取り継続のままであり、ピアが FIN / GOING_AWAY を送らない限りエントリは残る。0372 がこの残留を許容済み)。

## 設計方針

- namespace ループの GOAWAY 受信 (resolved=true) 時も、送信方向を `writer.close()` で FIN し、ピアのストリームクローズ (FIN / GOING_AWAY) を促す。受信方向の読み取り継続は維持する。
- writer は namespaceSubscriptions / tracksSubscriptions / namespacePublications のエントリから取得する。writer は optional (`NamespaceSubscriptionState` / `TracksSubscriptionState`) または必須 (`NamespacePublicationState`) であり、undefined ガードを付ける。
- PUBLISH_NAMESPACE ループ (publisher ロール) への FIN 適用は、bidi の publisher ロール (GOAWAY 受信時に FIN を送らずアプリの done() に委ねる) と非対称に見えるが、§3.3.2 の「the publisher of an Established subscription MUST send PUBLISH_DONE, before sending a FIN」は Established subscription 限定であり、namespace publication は subscription ではないため対象外。§10.4 の「e.g. FIN, stream reset, or PUBLISH_DONE」の選択肢に FIN が含まれ、PUBLISH_NAMESPACE への FIN は妥当である。
- `writer.close()` は局所 try/catch で囲む (0372 のエッジケース (e) の知見)。try/catch なしで置くと close() の reject がループ全体の catch に落ち、catch → finally でループが終了して重複 GOAWAY 検出のための読み取り継続が失われる (goawayReceived 設定の前後に関わらず、catch は読み取り継続を維持しない)。
- 変更対象ファイル: `src/session/namespaceLoops.ts` (3 ループの GOAWAY ケース)、`src/session/namespaceLoops.test.ts` (テスト追加。テスト基盤 `createNamespaceLoopTestContext` の subscription オブジェクトに writer が含まれていないため、writer の注入が必要)、`CHANGES.md` (既存の 0372 エントリ「namespace 系ループは GOAWAY 後も読み取りを継続し、callbacks.goaway 通知のみを行う」の「のみ」は不正確になるため更新)。

## 完了条件

- namespace ループで GOAWAY 受信時 (resolved=true) に送信方向が FIN (writer.close()) で閉じられること。
- 重複 GOAWAY 検出 (読み取り継続) が維持されること。
- resolved=false の GOAWAY (先頭 GOAWAY) の扱いは変更しないこと (open issue 0407 のスコープ)。
- 上記を検証するテストがあること (namespaceLoops.test.ts の既存 GOAWAY テスト基盤を使用し、writer 注入により送信方向 FIN を検証。既存の GOAWAY 受信後 REQUEST_ERROR テストによる読み取り継続の維持も検証手段に含む。なおテスト基盤 `createNamespaceLoopTestContext` は namespace / tracks の 2 種のみであり、PUBLISH_NAMESPACE ループの検証には kind: "publication" の基盤拡張または新規テストが必要)。
- `CHANGES.md` の `## develop` に `[FIX]` があること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- draft-ietf-moq-transport-19 §10.4 (GOAWAY)（「Upon receiving a GOAWAY on a request stream, the endpoint SHOULD re-issue that specific request ... and close the old request stream using the appropriate mechanism (e.g. FIN, stream reset, or PUBLISH_DONE)」）
- 関連: `issues/closed/0372-moqt-draft-19-duplicate-goaway-on-request-stream-undetected.md`（GOAWAY 受信後の読み取り継続。エッジケース (e) で writer.close() の局所 try/catch を規定）
- 関連: `issues/0407-fix-initial-goaway-on-namespace-stream.md`（先頭 GOAWAY の許可。resolved=false が対象。本 issue は resolved=true が対象であり、同一 switch ケースに触れるため実装順序に注意）

## 解決方法

未着手。
