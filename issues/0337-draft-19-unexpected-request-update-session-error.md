# 予期しない REQUEST_UPDATE 受信でセッションを PROTOCOL_VIOLATION で閉じる (draft-19 追従)

- Priority: Medium
- Created: 2026-07-07
- Model: Fable 5
- Branch: feature/change-draft-19-request-update-session-error
- Polished: 2026-07-23

## 目的

draft-ietf-moq-transport-19 Section 10.9 (REQUEST_UPDATE) に、予期しない REQUEST_UPDATE の扱いが追加された。変更履歴は Appendix A.1 `#1784` ("Unexpected REQUEST_UPDATE is a session error")。

draft-19 Section 10.9 が許可する 2 ケース:

1. リクエスト送信側（SUBSCRIBE / PUBLISH / FETCH / PUBLISH_NAMESPACE / SUBSCRIBE_NAMESPACE / SUBSCRIBE_TRACKS）が、同一 bidi ストリーム上で後から REQUEST_UPDATE を送る
2. subscriber が、PUBLISH で確立したサブスクリプションのパラメータを REQUEST_UPDATE で変更する

> An endpoint that receives a REQUEST_UPDATE other than in the two
> cases above MUST close the session with a PROTOCOL_VIOLATION.

必須応答の規則（同一節。例外の由来は draft-19 新設ではない）:

> The receiver of a REQUEST_UPDATE MUST respond with exactly one
> REQUEST_OK or REQUEST_ERROR message indicating if the update was
> successful, unless it is coalescing failed updates to produce just
> one REQUEST_ERROR for multiple REQUEST_UPDATE messages.

coalescing 自体は Appendix A.2 `#1540` ("Allow coalescing REQUEST_UPDATE processing") で draft-17 → 18 に入った規定。draft-19 で新規なのは上記 MUST close（`#1784`）である。送信側の `pendingRequestUpdate` は「1 応答 = 1 pending」前提のままなので、失敗 coalescing 時のリーク修正を本 issue に含める（closed `#0195` が見送った送信側）。

Section 10.9.1 (Updating Subscriptions) の失敗時 MUST（現行仕様。本 issue の実装範囲は設計方針で限定）:

> When a REQUEST_UPDATE fails for a SUBSCRIBE_NAMESPACE, SUBSCRIBE_TRACKS or
> PUBLISH_NAMESPACE, the responder MUST close the bidi stream (see
> Section 3.3.2).

（同節には subscription 失敗時の PUBLISH_DONE UPDATE_FAILED、FETCH 失敗時の data stream reset もある。）

## 優先度根拠

moqt-js は SUBSCRIBE ストリーム上で peer から REQUEST_UPDATE を受けたとき REQUEST_ERROR を返してセッションを継続しており、Section 10.9 の MUST に違反する。プロトコル準拠違反だが、攻撃・誤動作ピアからの防御でありデータパスの相互運用は壊さないため Medium。

## 現状

### 受信ループは SUBSCRIBE と PUBLISH で共有

`bidiReadRequestStreamMessages`（`src/session/bidi.ts`）は次の 2 経路から起動される共有後続ループである。

- `bidiReadPublishResponse`: PUBLISH_OK 後（client-as-publisher）
- `bidiReadSubscribeResponse`: SUBSCRIBE_OK 後（client-as-subscriber）

FETCH / TRACK_STATUS / namespace 系はこの関数を使わない。役割引数は無く、REQUEST_UPDATE 時は `publishers.get` の有無だけで分岐している。

### REQUEST_UPDATE 受信

同関数の `case MessageType.REQUEST_UPDATE`:

- `session.publishers.get(requestId)` があれば FORWARD を反映し REQUEST_OK を返す（PUBLISH ストリーム上の case 2）
- publisher が無い場合は REQUEST_ERROR（INTERNAL_ERROR）を返してセッションを継続する

closed `#0318` が「publisher 不在 → REQUEST_ERROR」を入れたのは **PUBLISH ストリーム上の更新失敗** を想定した挙動である。

共有ループのため、SUBSCRIBE ストリーム上で REQUEST_UPDATE を受けると publishers に無く常に REQUEST_ERROR 経路になる。SUBSCRIBE ストリームで peer から REQUEST_UPDATE が来ることは Section 10.9 の 2 ケースに該当せず、MUST で PROTOCOL_VIOLATION である。現状はそれを REQUEST_ERROR で握りつぶしている。

doc コメントは draft-18 の「MUST respond with exactly one」のみを引用しており、coalescing 例外と MUST close が未反映。

### 送信側 pendingRequestUpdate（REQUEST_ERROR 処理は 2 箇所）

- 公開 API で REQUEST_UPDATE を送れるのは `Subscriber.update()` → `bidiSendRequestUpdate` のみ
- `onUpdate` の結線は 2 経路
  - client-as-subscriber（自発 SUBSCRIBE）: 応答は `bidiReadRequestStreamMessages`
  - incoming PUBLISH（Section 10.9 case 2 の送信側）: 応答は `runPublishStreamSubLoop`（`session.ts`）。OK は `bidiHandleRequestUpdateOk` へ委譲
- `NamespaceSubscription` / `TracksSubscription` に `update` API は無い
- REQUEST_ERROR 受信時の `break` 付き先頭 1 件 reject が次の 2 箇所に重複。失敗 coalescing では残りがリークする
  - `bidiReadRequestStreamMessages` の `case MessageType.REQUEST_ERROR`
  - `runPublishStreamSubLoop` の REQUEST_ERROR 分岐
- REQUEST_OK 側（`bidiHandleRequestUpdateOk`）の先頭 1 件 resolve は仕様どおり（成功時は 1 件ずつ MUST）

### Section 10.9.1 関連

- SUBSCRIBE 失敗時の PUBLISH_DONE UPDATE_FAILED 受信は `SubscriberImpl` で充足（closed `#0198`）
- PUBLISH 上 publisher 不在時の PUBLISH_DONE UPDATE_FAILED 送信は未実装（`#1784` 本体とは別。別 issue）
- NS / TRACKS / PUBLISH_NAMESPACE の REQUEST_UPDATE 送信 API は無い
- `runPublishStreamSubLoop` に REQUEST_UPDATE 受信分岐は無く、未知メッセージとして PROTOCOL_VIOLATION。publisher 発 case 1 の受信は範囲外

## 設計方針

### 本 issue の範囲（`#1784` + 送信側 coalescing リーク）

1. **受信側（役割は起動時に固定）**: `bidiReadRequestStreamMessages` に role 引数（例: `"publish" | "subscribe"`）を追加する。`bidiReadPublishResponse` からは `"publish"`、`bidiReadSubscribeResponse` からは `"subscribe"`。`publishers` / `subscribers` Map の瞬間値だけで判定しない（両方不在のレースで `#1784` MUST を逃す・誤判定する）
   - **role=`"subscribe"`**: peer からの REQUEST_UPDATE は予期しない → `session.closeWithError(new SessionError(..., SessionErrorCode.PROTOCOL_VIOLATION))`。REQUEST_ERROR は返さない
   - **role=`"publish"`** かつ publisher あり: case 2 として FORWARD 反映 + REQUEST_OK
   - **role=`"publish"`** かつ publisher 不在: 更新失敗。REQUEST_ERROR 継続（closed `#0318` の PUBLISH 失敗経路は維持）。PUBLISH_DONE UPDATE_FAILED は範囲外
2. **送信側**: 同一 `targetRequestId` の pending を単一 REQUEST_ERROR ですべて reject（`break` 削除）。対象は `bidi.ts` と `session.ts` `runPublishStreamSubLoop` の 2 箇所。REQUEST_OK は 1 件ずつのまま
3. 触る箇所の仕様参照を draft-19 Section 10.9 に更新。全体一掃は `#0343`

### 意図的に含めないもの

- `MAX_REQUEST_UPDATES` / `TOO_MANY_REQUEST_UPDATES`: `#0338`
- Section 3.3.2 Graceful Closure 一般: `#0339`
- NS / TRACKS / PUBLISH_NAMESPACE の `update` API と失敗時 bidi close（Section 10.9.1）
- PUBLISH 更新失敗時の PUBLISH_DONE UPDATE_FAILED、FETCH data stream reset
- incoming PUBLISH 上の publisher 発 REQUEST_UPDATE（case 1）受信
- SUBSCRIBE_TRACKS パラメータ: `#0336`

### テスト戦略（モック禁止）

- 既存 `bidiHandleRequestUpdateOk` の部分 session パターンだけではストリームループを駆動できない。次のいずれか（WebTransport 全体モックは禁止）
  - **推奨**: role 付きの REQUEST_UPDATE 処理を同期ヘルパー／純粋関数に抽出し単体テストする
  - または `ReadableStream` / `WritableStream` 実インスタンスでループを駆動する
- ケース: (1) role=`"subscribe"` → PROTOCOL_VIOLATION・REQUEST_ERROR 非送信 (2) role=`"publish"` + publisher あり → REQUEST_OK (3) 複数 pending + 単一 REQUEST_ERROR → 全 reject（`bidi.ts` で代表。共通化すればその関数をテスト） (4) role=`"publish"` + publisher 不在 → REQUEST_ERROR 継続
- `runPublishStreamSubLoop` の `break` 削除は実装必須。private 駆動が重い場合はレビュー担保＋`bidi.ts` 側テスト代表でよい

## 完了条件

- role=`"subscribe"` で REQUEST_UPDATE 受信時、セッションが `SessionErrorCode.PROTOCOL_VIOLATION` で閉じ、REQUEST_ERROR を返さないこと（テストあり）
- role=`"publish"` で publisher ありの REQUEST_UPDATE → REQUEST_OK が維持されること（テストあり）
- 複数 outstanding に対する単一 REQUEST_ERROR で該当 pending がすべて reject されること（テストあり）。`bidi.ts` と `runPublishStreamSubLoop` の両方で `break` が無いこと
- `CHANGES.md` の `## develop` にエントリがあること
- lint / build / typecheck / 既存テストが通ること

## 解決方法

1. `src/session/bidi.ts`: `bidiReadRequestStreamMessages` に role 引数を追加。呼び出し元 2 箇所を更新。`REQUEST_UPDATE` は role で分岐。コメントに `#1784` / `#1540` を区別して書く
2. REQUEST_ERROR の全 pending reject: `bidiReadRequestStreamMessages` と `session.ts` `runPublishStreamSubLoop`。`bidiHandleRequestUpdateOk` は変更しない
3. `src/session/bidi.test.ts`: 上記ケースを追加（ヘルパー抽出または実ストリーム。モック禁止）
4. `CHANGES.md` の `## develop` に `[CHANGE]` で PROTOCOL_VIOLATION 化と pending 全 reject を追記する
