# リクエストストリーム上の重複 GOAWAY を検出できない

- Priority: Medium
- Created: 2026-08-06
- Completed: {YYYY-MM-DD}
- Model: DeepSeek V4 Flash
- Branch: feature/fix-moqt-draft-19-duplicate-goaway-on-request-stream-undetected
- Polished: 2026-08-06

## 目的

draft-ietf-moq-transport-19 §10.4 の MUST 要件「The endpoint MUST close the session with a PROTOCOL_VIOLATION (Section 3.5) if it receives more than one GOAWAY on the control stream or on a single request stream.」を満たす。現在は GOAWAY 処理後に読み取りループを return (または `readable.cancel()`) で終了するため、2 通目以降の GOAWAY が検出されない。

## 優先度根拠

`validateNoDuplicateGoawayOnRequestStream` は実装されているが、GOAWAY 処理後のループ終了により重複検出分岐が到達不能になっている (詳細は現状参照)。§10.4 の MUST 要件を満たしておらず、重複 GOAWAY を送る不正ピアを検出できない。Medium の根拠: closed issue 0259 (add-duplicate-goaway-detection-on-request-stream) は同じ MUST 違反を「プロトコル完全性に関わる致命的な欠落」= High と評価して Completed にしたが、0259 の完了条件は 0259 自身の現状で「return するため事実上 2 つ目が処理されない」と認識したまま実質未達でクローズされている。本 issue はその未達を解消するものだが、発現条件が「不正ピアが重複 GOAWAY を送信する」ことに限定され、仕様準拠ピアの合法動作では発現しない点で 0370 (High) より低く、Medium と評価する。

## 現状

- `src/session/bidi.ts:782-811` (`bidiReadRequestStreamMessages`) の GOAWAY ケースは、重複検出ヘルパーを呼んだ後に `return` (811 行) してループを終了する。同一ストリーム上の 2 通目以降の GOAWAY は読み取りが停止しているため検出されない。
- 同じパターンが `src/session.ts:3193-3205` (`runPublishStreamSubLoop` の GOAWAY ケース) と `src/session/namespaceLoops.ts` の 3 ループ (191-206 / 380-395 / 541-558 の GOAWAY ケース) に存在する。
- 確立前の単発応答読み取り経路 (`src/session/bidi.ts:346-352` / `467-473` / `555-561` / `624-632` の各 GOAWAY 分岐) は `bidiReadResponseFromBidiStream` (bidi.ts:253-271) が `messages[0]` のみ返す単発読み取り構造のため、GOAWAY 受信後に関数全体が return し、2 通目 GOAWAY は構造的に検出できない。
- GOAWAY 受信時の旧リクエストストリームのクローズ: `namespaceLoops.ts` (`namespaceHandleGoaway` 37-63 行) は `streamReader.cancel()` (61 行) で受信方向を既に閉じている一方、bidi.ts と session.ts は送信方向・受信方向とも閉じていない (§10.4 の「close the old request stream using the appropriate mechanism (e.g. FIN, stream reset, or PUBLISH_DONE)」は SHOULD だが未達)。
- 制御ストリーム上の GOAWAY 重複検出 (`src/session.ts:2828-2876` の `handleGoaway` / `receivedGoaway`) は既に実装済みのため対象外。
- 変更対象ファイル: `src/session/bidi.ts`、`src/session.ts`、`src/session/namespaceLoops.ts`、`src/session/bidi.test.ts` (テスト追加)、`CHANGES.md`。

## 設計方針

- **修正方針の決定**: 「GOAWAY 受信後に読み取りループを return / cancel せず、受信方向の読み取りを継続する」方式を採用する。これにより 2 通目以降の GOAWAY が `validateNoDuplicateGoawayOnRequestStream` で検出され、§10.4 の MUST (PROTOCOL_VIOLATION) が満たされる。旧ストリームのクローズは「送信方向のみ」に限定して GOAWAY 処理内で行い、受信方向はピアの FIN まで読み取りを継続する (bidi ストリームの各方向は独立に閉じられる。§3.3.2 冒頭「A request stream is bidirectional and each direction is closed independently...」が根拠)。受信方向の終了は §10.4 の「the sender SHOULD reset the stream with GOING_AWAY after the indicated timeout」に依存する。ピアが FIN / GOING_AWAY リセットを送らない場合に読み取りループと `requestStreams` エントリが無期限に残るリスクを許容する (セッション close 時のクリーンアップで回収される)。GOING_AWAY リセット受信時のループ終了は経路ごとに挙動が異なる点に注意する (後述の「エッジケース (g)」参照)。
- **適用箇所 (読み取りループを持つ 5 箇所)**: 以下 5 箇所の GOAWAY ケースを「検出ヘルパー呼び出し → 送信方向のクローズ → 読み取り継続 (1 通目 GOAWAY ではループを抜けない)」に統一する。2 通目 GOAWAY はヘルパーが false を返し `closeWithError(PROTOCOL_VIOLATION)` でセッションが閉じるため、その場合は return でループを終了する (セッション close 後に後続メッセージを処理し続けないため)。これら 5 箇所はすべて `while` ループを持つ経路であり、読み取り継続が構造的に可能である。
  1. `src/session/bidi.ts:782-811` (`bidiReadRequestStreamMessages`)
  2. `src/session.ts:3193-3205` (`runPublishStreamSubLoop`)
  3. `src/session/namespaceLoops.ts:191-206` (SUBSCRIBE_NAMESPACE ループ)
  4. `src/session/namespaceLoops.ts:380-395` (SUBSCRIBE_TRACKS ループ)
  5. `src/session/namespaceLoops.ts:541-558` (PUBLISH_NAMESPACE ループ)
- **確立前経路 4 箇所はスコープ外**: 確立前の単発応答読み取り経路は `bidiReadResponseFromBidiStream` が `messages[0]` のみ返す単発構造 (現状セクション参照) のため、ヘルパー呼び出しを追加しても 2 通目 GOAWAY の検出は構造上不可能である (同一チャンク内の 2 通目も破棄される)。本 issue ではこれら 4 箇所をスコープ外とし、§10.4 の MUST が確立前経路では未達のまま残ることを残余リスクとして明記する (単発読み取りのループ化は別 issue の対応とする)。
- **namespace 系ループ (3-5) の設計**: `namespaceHandleGoaway` の現行実装は `streamReader.cancel()` (受信方向の即時クローズ) + `closeState()` (state = "closed") + reject + `callbacks.error` であり、これを読み取り継続方式に変更する。3 ループの継続条件が state 依存 (`while (subscription.state === "active")` / `while (publication.state !== "closed")`) のため、`closeState()` が state を "closed" にした時点でループが即終了する。**採用案**: 受信継続用フラグ (例: `goawayReceived`) を導入し、GOAWAY 受信時は `callbacks.goaway` 通知と reject を即時に行い、`closeState()` と state 遷移はピアの FIN 検出時 (ループ自然終了時) に遅延する。`callbacks.error` は GOAWAY 時には呼ばない (GOAWAY は error ではなく migration 通知であり、`callbacks.goaway` がその役割を担う)。フラグの置き場所はループローカル変数とし (型変更不要)、`namespaceHandleGoaway` のシグネチャは `streamReader.cancel()` と `closeState()` と `callbacks.error` 呼び出しを廃止してフラグ設定と `callbacks.goaway` 通知のみを行う形に変更する。3 ループの `while` 条件は state 依存のままで変更しない (closeState 遅延により GOAWAY 後も継続し、フラグはメッセージ処理判断専用)。重複 GOAWAY 時はヘルパーが PROTOCOL_VIOLATION でセッションを閉じるため、ループは終了する。**resolved=false (REQUEST_OK 受信前) の GOAWAY**: ループ 3 (PUBLISH_NAMESPACE) は先頭ガードがなく、REQUEST_OK 前に GOAWAY が届き得る。この場合、reject 後に読み取りを継続すると後続 REQUEST_OK の resolve (no-op) や NAMESPACE 系コールバックが reject 済みリクエストに対して発火し、アプリが矛盾した通知を受ける。**resolved=false の GOAWAY は reject 後にループを終了する (現行の return 維持)** とし、読み取り継続は resolved=true の場合のみとする。ループ 1 / 2 は先頭ガード (namespaceLoops.ts:114-122 / 312-320) が GOAWAY を REQUEST_OK / REQUEST_ERROR 以外として PROTOCOL_VIOLATION にするため、GOAWAY は常に resolved=true 後に到達する (先頭 GOAWAY は本 issue のスコープ外として残余リスクに明記する)。
- **GOAWAY 後の非 GOAWAY メッセージの扱い (共通方針)**: 読み取り継続中に GOAWAY 以外のメッセージが届いた場合の共通方針は「既存の各メッセージ処理を継続する」。ただしマイグレーション対象の旧リクエストに対して REQUEST_UPDATE を適用・応答するのは仕様意図に反し得るため、`bidiReadRequestStreamMessages` では GOAWAY 受信後 (`goawayReceivedOnRequestStreams` に requestId が追加済み) の REQUEST_UPDATE は REQUEST_ERROR (GOING_AWAY) で応答する (この関数は publish / subscribe 両ロールで共有されるため、ロールに関わらず共通処理として適用する)。`runPublishStreamSubLoop` 側も GOAWAY 後に REQUEST_UPDATE が届いた場合、現行の「unknown message type on publish stream」分岐 (session.ts:3232-3237) で PROTOCOL_VIOLATION になるのを避けるため、同様に REQUEST_ERROR (GOING_AWAY) で応答するか無視する (0373 の REQUEST_UPDATE 対応実装前の 0372 単独適用期間に新規のセッション切断が発生しないための措置。0373 を先に実装する場合は不要)。namespace 系では `goawayReceived` フラグが立っている間、NAMESPACE / NAMESPACE_DONE / REQUEST_OK 等の既存処理を継続しつつ (重複 GOAWAY のみヘルパーで PROTOCOL_VIOLATION)、REQUEST_ERROR は REQUEST_ERROR ケース内の `if (resolved)` 分岐 (namespaceLoops.ts:162-189 / 351-378) の処理を `resolved && !goawayReceived` 相当に変更して GOAWAY 後は無視し、読み取りを継続する (GOAWAY 後の REQUEST_ERROR で spurious PROTOCOL_VIOLATION「received REQUEST_ERROR after REQUEST_OK」が発火するのはこの分岐であり、先頭メッセージガード (110-123 / 303-317) の条件拡張では防げないため、ケース内の処理として実装する)。
- **送信方向のクローズ方法 (ロール別)**: §10.4 の「close the old request stream using the appropriate mechanism (e.g. FIN, stream reset, or PUBLISH_DONE)」に従うが、Established subscription の publisher に対しては §3.3.2 の MUST「the publisher of an Established subscription MUST send PUBLISH_DONE, before sending a FIN」を優先する。
  - publisher (`session.publishers` に存在): GOAWAY 受信時は即時クローズせず、アプリの `done()` に委ねる (詳細は後述の「0370 との相互参照」を参照)。
  - subscriber (`session.subscribers` に存在): 送信方向を FIN (`writer.close()`) で閉じ、受信方向は読み取りを継続する。`runPublishStreamSubLoop` は現行シグネチャ (session.ts:3168-3174) が writer を持たないため、`session.requestStreams.get(publishRequestId).writer` 経由でアクセスする (session.ts:3438-3441 で登録済み)。
  - fetcher: established FETCH ストリームは FETCH_OK 後に読み取りループが存在しない (bidi.ts:509-546) ため、fetcher の GOAWAY 分岐 (bidi.ts:807-810) は現状到達不能であり、本 issue では変更しない (スコープ外)。
  - namespace 系: 送信方向はアプリの再発行に委ね、受信方向の読み取りを継続する (上記のフラグ方式)。
- **0370 との相互参照**: 0370 (PUBLISH_OK 後にピアが FIN すると PUBLISH_DONE が送信されない) は本 issue に「GOAWAY ハンドラの return 経路での同種問題 (GOAWAY 後の `requestStreams` 削除) は issue 0372 で扱う」と委譲し、「GOAWAY 後の done() による PUBLISH_DONE スキップは 0372 修正後も残余として残り得る」と明記している。本 issue の読み取り継続方式では、GOAWAY 後にピアが FIN した場合、0370 の finally の「publish ロール && receivedFin フラグ」経路に合流して `requestStreams` が保持され、`done()` で PUBLISH_DONE が送信可能になる。0370 を先に実装し、本 issue は 0370 の finally 変更が入った状態で実装する (実装順序: 0370 → 0372 → 0374、その後 0390)。完了条件の「publisher の Established subscription では GOAWAY 受信後に FIN を送らず、アプリの done() による PUBLISH_DONE → FIN の経路が維持されること」は、0372 が「FIN を送らない」こと (＝§3.3.2 に違反しないこと) を保証するものであり、GOAWAY 後の done() の PUBLISH_DONE 送信自体は 0370 の finally 変更に依存する点を明記する (0370 の「含まれない」断言と整合させる)。0374 (subscribe ロールの finally 通知) とも同じ finally ブロックを共有するため、0374 実装後の「GOAWAY 経由のピア FIN」で誤った error 通知が発火しないよう、0374 側にも注記が必要である (0372 側から 0374 へ逆方向の注記を追加する)。また 0390 (未使用 export の非公開化) は `bidiReadRequestStreamMessages` と `namespaceHandleGoaway` を対象としており、本 issue の統合テストは前者の export 維持に依存するため、0370 と同様に 0390 側に「テストで使用する関数の export を維持する」旨の注記が必要である (0372 側から 0390 へ逆方向の注記を追加する)。0373 (受信 PUBLISH の REQUEST_UPDATE 誤検知) は同じ `runPublishStreamSubLoop` を変更対象とするため、相互に行番号ズレと実装順序の調整注記を入れる (0372 側から 0373 へ逆方向の注記を追加する。GOAWAY 後の REQUEST_UPDATE の扱いについては上記の共通方針を参照)。
- **エッジケース**: (a) 同一チャンク内の複数 GOAWAY は、修正後は `for (const msg of messages)` の連続処理で検出可能になる。(b) GOAWAY 後のピア FIN は読み取り継続の自然終了 (namespace 系は state 遷移を遅延した上で finally でマップ削除)。(c) 2 通目 GOAWAY のデコード失敗は既存の catch で処理。(d) GOAWAY 受信時点で pending の REQUEST_UPDATE がある場合は既存の pendingRequestUpdate 処理を維持。(e) GOAWAY ケース内の送信方向 FIN (`writer.close()`) は局所 try/catch で囲む (ループ全体の catch に落ちると読み取り継続が失われる)。(f) established FETCH の GOAWAY は到達不能のためスコープ外 (残余リスクとして完了条件に明記)。(g) GOING_AWAY リセット受信時のループ終了は経路ごとに挙動が異なる: bidi ループは非 ProtocolViolationError を黙殺する一方、`runPublishStreamSubLoop` と namespace 3 ループの catch は `state === "active"` の間 `callbacks.error` を発火する。フラグ方式では state が active のままのため spurious error 通知が発生し得るため、namespace ループの catch では `goawayReceived` フラグが立っている間の `callbacks.error` 発火を抑止する。(h) 確立前経路の GOAWAY 2 通目はスコープ外 (残余リスク)。(i) 先頭 GOAWAY (REQUEST_OK 前): ループ 1 / 2 の先頭ガード (namespaceLoops.ts:114-122 / 312-320) が GOAWAY を PROTOCOL_VIOLATION にする既存挙動は本 issue の変更では解消されず、スコープ外の残余リスクとして明記する。

## 完了条件

- 読み取りループを持つ経路 (bidiReadRequestStreamMessages / runPublishStreamSubLoop / namespace 3 ループ) で、同一リクエストストリーム上に 2 通目の GOAWAY を受信した場合、PROTOCOL_VIOLATION でセッションが閉じること (§10.4 MUST)。同一チャンク内とチャンク境界をまたぐ GOAWAY 2 通の両方を検証する。
- GOAWAY 受信時に旧リクエストストリームが適切に処理されること: bidi / session 経路では送信方向が FIN で閉じられ、namespace 系では `callbacks.goaway` が呼ばれつつ読み取りが継続されること (§10.4 SHOULD)。publisher の扱いは次項参照。
- publisher の Established subscription では、GOAWAY 受信後に FIN を送らず、アプリの `done()` による PUBLISH_DONE → FIN の経路が維持されること (§3.3.2 MUST)。
- 上記を検証するテストがあること。テストは `validateNoDuplicateGoawayOnRequestStream` の統合経路 (ループ内で GOAWAY 2 通を feed し、2 通目で closeWithError(PROTOCOL_VIOLATION) が呼ばれること) を `src/session/bidi.test.ts` に追加する (0370 で新設する実 W3C ストリーム注入方式に揃える。e2e は `TEST_MOQT_URI` 依存で常時実行されないため対象外)。検証項目: 1 通目 GOAWAY ではセッションが閉じず読み取りが継続されること / 2 通目 GOAWAY で `closeWithError(PROTOCOL_VIOLATION)` が呼ばれること / 送信方向の FIN が呼ばれること (subscriber) / publisher では FIN が呼ばれないこと / 制御ストリームの重複検出が変更されていないこと (既存の `handleGoaway` テストがないため、コードレビューで担保しつつ bidi 統合テストで GOAWAY 2 通の検出が制御ストリーム経路に影響しないことを確認する)。namespace 3 ループ (`namespaceStartNamespaceStreamLoop` / `namespaceStartTracksStreamLoop` / `namespaceStartPublicationStreamLoop`) は export 済みの free function であるため、bidi.test.ts と同様の fake session (`as unknown as SessionInternal`) + 実ストリーム注入で自動テスト可能である。ただし `SessionInternal` の fake 構築が大掛かりになるため、本 issue では namespace ループの自動テスト追加はスコープ外とし、`goawayReceived` フラグ方式・state 遷移遅延・REQUEST_ERROR 特例はコードレビュー + bidi 統合テストで担保する (自動テスト追加は別 issue の対応とする。テスト駆動方法の詳細は実装時に確定)。
- 後方互換: 公開 API は変更しない。挙動変化は「GOAWAY 受信後の読み取り継続」「namespace 系の GOAWAY が terminal でなくなる」「bidi / session の GOAWAY 経路で送信方向が FIN で閉じられる」の 3 点。残余リスクとして明記するもの: 確立前経路 4 箇所 (単発読み取り構造のため §10.4 MUST が全ケースで未達)、established FETCH ストリーム (読み取りループが存在しないため GOAWAY 自体が未処理)、ループ 1 / 2 の先頭 GOAWAY (先頭ガードが PROTOCOL_VIOLATION にする既存挙動)。
- `CHANGES.md` の `## develop` に `[FIX]` があること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- draft-ietf-moq-transport-19 §3.3.2 (Graceful Request Stream Closure / 各方向の独立クローズ / PUBLISH_DONE before FIN)
- draft-ietf-moq-transport-19 §3.3.3 (Request Cancellation and Rejection)
- draft-ietf-moq-transport-19 §3.6 (Session Migration / リクエストストリーム GOAWAY は当該リクエストのみ移行)
- draft-ietf-moq-transport-19 §10.4 (GOAWAY / 重複 GOAWAY の MUST / 旧ストリームクローズの SHOULD / Timeout フィールドと GOING_AWAY リセット)

## 注記 (0371 実装時)

- 0371 (未対応リクエストの NOT_SUPPORTED 応答) の実装で session.ts の `handleIncomingBidirectionalStream` の構造が変更され行がドリフトしたため、`runPublishStreamSubLoop` の GOAWAY ケース等の session.ts 行番号参照をシンボル名に書き換えること。

## 解決方法

未着手。
