# ピア起点のセッション終了時に subscriber / publisher / fetcher の state が closed にならない

- Created: 2026-08-30
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-peer-session-close-markclosed-missing
- Polished: {YYYY-MM-DD}

## 目的

ピア (relay / publisher) 起点で WebTransport セッションが閉じた場合、`SessionImpl` は `sessionState` を "closed" に遷移するだけで購読者・配信者・フェッチャーの `markClosed` を行わない。そのためアプリが保持している `Subscriber` / `Publisher` / `Fetcher` の `state` がセッション終了後も "active" のまま残り、state ベースの判断が機能しない問題を修正する。

## 現状

- `SessionImpl` コンストラクタの `transport.closed` ハンドラ (`src/session.ts`) は、`then` / `catch` の両方で `sessionState` を "closed" に遷移して `callbacks.close` を呼ぶだけである。個別の request 系オブジェクトの state は変更しない。
- 一方、自前起点でセッションを閉じる `SessionImpl.close()` は `publishers` / `subscribers` / `fetchers` を走査して `markClosed()` を呼ぶ。同じ「セッション終了」でも開始主体によって request 系オブジェクトの state が変わるのが非対称である。
- 実害と不整合 (state が "active" のまま残ること):
  - `SubscriberImpl.handleObject` / `handleDatagram` は `state === "closed"` で破棄するため、配信自体は止まる。ただしセッションが終了したのに購読者が active を名乗るのは state の意味論として不整合
  - `SubscriberImpl.update()` は `state === "closed"` のとき throw して送信を断る。"active" のままなので終了済みセッションに対して送信を試み、`onUpdate` 側の別ガード (streamInfo 欠落等) で失敗するまでアプリに伝わらない
  - `PublisherImpl.sendObject` は `publisherState === "closed"` のガードしか持たない (`sessionState` ガードは datagram 送信と PUBLISH_DONE 送信の冒頭にある)。state が "active" のままなので、ピア起点終了後の `sendObject` は `transport.createUnidirectionalStream()` の失敗がアプリへ伝わるまで検出できない
- 受信 PUBLISH 経路の RESET_STREAM で state が closed にならない問題は `issues/closed/0428-bug-incoming-publish-reset-markclosed-missing.md` で解消しており、本 issue はセッション終了経路 (`transport.closed`) に残る同族の問題を追跡する。過去にも同一の問題を残余リスクとして記録した例があるが、追跡先が closed 済みで消滅している (`issues/closed/0301-bug-fix-send-datagram-writer-race.md` のスコープ外記述、`issues/closed/0410-bug-subscribe-error-end-not-notified.md` のセッション終了除外の記述)。

## 設計方針

- `close()` が行う後始末のうち、request 系オブジェクトの `markClosed` 群 (publishers / subscribers / fetchers) を private ヘルパーに抽出し、`close()` と `transport.closed` ハンドラの両方から呼ぶ。ハンドラから `close()` を直接呼ぶことはできない。ハンドラは `sessionState` を "closed" に遷移した後に呼ばれるため、`close()` は冒頭の `sessionState === "closed"` ガードで早期 return し、後始末自体が走らない。
- 通知の二重化は行わない: `ConnectCallbacks.close` によるセッション終了通知は既存どおりハンドラから 1 回だけ送る。request 系オブジェクトの `handleEnd` / `handleError` は呼ばない (セッションレベルの終了は track レベルの PUBLISH_DONE でも失敗 FIN でもない。`close()` のコメントと同じ解釈を維持する)。
- pending Promise の reject (`pendingPublish` / `pendingSubscribe` / `pendingFetch` / `pendingRequestUpdate` / `pendingTrackStatus`) は本 issue のスコープに含めない。エラー終了したストリーム上の保留 Promise の掃除は経路単位で他 issue が追跡しており (`issues/0432-bug-reset-path-pending-request-update-leak.md` / `issues/0438-bug-send-request-failure-pending-cleanup.md`)、オブジェクトの state 遷移とは目的が異なる。
- 変更対象: `src/session.ts` (コンストラクタの `transport.closed` ハンドラと `close()`)、`src/session.test.ts` (テスト追加。既存テスト「Fetch データストリーム: セッション close 済み経路でも未完成 Object の FIN は end を通知しない」は `transport.closed` 由来の遷移で `FetcherImpl.state` が "active" のまま残ることをアサートしているため、closed へ追従させる)、`CHANGES.md`。

## 完了条件

- ピア起点で `transport.closed` が resolve / reject した場合、登録済みの `Publisher` / `Subscriber` / `Fetcher` の `state` が closed になること。
- セッション終了時に `ConnectCallbacks.close` が 1 回だけ呼ばれることは現行どおり維持されること (二重通知しないこと)。
- 終了済みの `Subscriber.update()` が "Subscriber is closed" で throw すること (state ガードが効くこと)。
- `close()` 経路 (自前起点) の挙動が変わらないこと (回帰ガード)。
- 上記を検証するテストがあること。`transport.closed` を resolve / reject できる Promise を返す最小限の fake transport を注入して検証する (`src/session.test.ts` の `createSessionImpl` と同じ組み立て方で、モックやスタブは使わない)。
- `CHANGES.md` の `## develop` に `[FIX]` があること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- draft-ietf-moq-transport-19 §3.5 (Termination): "The Transport Session can be terminated at any point."
- 関連: `issues/closed/0428-bug-incoming-publish-reset-markclosed-missing.md` (受信 PUBLISH 経路の RESET_STREAM で state が closed にならない問題。本 issue はセッション終了経路の同族問題を扱う)
- 関連: `issues/closed/0410-bug-subscribe-error-end-not-notified.md` (セッション終了時は subscriber に通知しない方針を明記した箇所。本 issue は state 遷移のみを追加し、通知方針を変えない)
