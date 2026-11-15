# devtools の publisher が PUBLISH_NAMESPACE を送れるようにする

- Created: 2026-11-15
- Completed: 2026-11-15
- Branch: feature/add-devtools-publisher-namespace-announcement
- Polished: 2026-11-15

## 目的

devtools の publisher から PUBLISH_NAMESPACE を送れるようにする。

draft-ietf-moq-transport-23 §7.7 は「If a Publisher would like Subscriptions in a Namespace routed to it, it MUST send an explicit PUBLISH_NAMESPACE.」と定める。PUBLISH だけを送る publisher には、relay は namespace 内の購読 (SUBSCRIBE_TRACKS など) をルーティングしない。devtools で SUBSCRIBE_TRACKS の受信側の挙動を確認するには、publisher が namespace を告知できる必要がある。

高レベル API の `createMediaPublisher` は `announceNamespace` で告知できる (closed 0887)。devtools は `createMediaPublisher` を使わず `devtools/src/hooks/usePublisher.ts` で独自に `session.publish()` を呼ぶため、告知の経路が無い。

## 現状

- `devtools/src/hooks/usePublisher.ts` の `startPublishing` は catalog / audio / video / event を `session.publish()` で送るが、`session.publishNamespace()` を呼ばない
- `devtools/src/signals/connectionSettings.ts` の publisher 設定に告知の項目が無く、`devtools/src/signals/publisher.ts` にも告知の状態が無い。`PublisherPanel` にもトグルが無い
- `devtools/src/utils/trackAuthorization.ts` は PUBLISH と PUBLISH_NAMESPACE の両方のトークン組み立てを扱うが、PUBLISH_NAMESPACE を送る経路が無い
- `devtools/src/testSupport/fakes.ts` の `FakeSession.publishNamespace` は未対応として throw する
- devtools の publisher の単体テスト (`devtools/src/hooks/usePublisher.test.ts`) と、devtools の publisher を使う E2E は、告知の経路を検証していない。ライブラリの publisher の告知は `tests/e2e/relay/namespace-announcement.spec.ts` で検証している
- devtools の publisher を使う実リレー E2E (`tests/e2e/relay/`) は、publisher が namespace を告知しないため relay から namespace 内の購読を受けない

## 設計方針

- `devtools/src/signals/connectionSettings.ts` に `announceNamespace` (既定 false) を追加し、`PublisherPanel` にチェックボックスを追加する。ラベルと説明は英語にする (devtools の画面は英語)。`devtools/src/signals/publisher.ts` に、確立した `NamespacePublication` を保持する signal を追加する
- `startPublishing` は、catalog・映像・音声・event timeline の `session.publish()` の往復が終わった後に `session.publishNamespace(namespaceArray, callbacks, options)` を 1 回呼び、REQUEST_OK を待つ。PUBLISH を確立してから告知する点を closed 0887 の `createMediaPublisher` と揃える (§4.1)。devtools は catalog の PUBLISH が先なので、告知はすべての PUBLISH の後になる
- Authorization Token は PUBLISH と同じ SETUP のトークンを付与する (draft-ietf-moq-msf-01 §11.4.3)。`trackAuthorization.ts` の既存の組み立てを使う
- 告知の確立後に停止したら `done()` を呼び、PUBLISH_NAMESPACE を撤回する。relay は購読者へ `NAMESPACE_DONE` を送る (§9.16)。停止の止め方 (publish-done / close-session / stop-sending) にかかわらず、告知の `done()` は catalog・映像・音声・event timeline の publisher の `done()` より前に 1 回呼ぶ。開始の失敗・セッション終了では、未確立の `publishNamespace()` の Promise は reject し (低レベル API が保証する)、確立済みの publication はセッション終了で `state` が `"closed"` になる。devtools は待ちの reject を `startPublishing` の失敗として扱い、保持した publication を停止・後始末で `done()` し、保持した signal を null にする。開始の失敗では、エラー表示 (status / ログ) を 1 回だけ行う (callbacks.error と catch で二重に通知しない)
- 告知を無効にした場合と、接続に使う `namespaceArray` が空配列の場合は送らない。空配列は 0 フィールドの prefix が全 namespace に一致するため (§2.4.2)、黙って告知しない
- `startPublishing` は module-level の `connect()` を使うため、告知の送信と失敗時の通知を Session を受け取る関数に切り出し、`devtools/src/testSupport/fakes.ts` の `FakeSession.publishNamespace` を実装して単体テストで検証する (closed 0956 の `sendSubscribeTracks` と同じ形)。単体テストで、無効時に送らないこと、有効時に 1 回送ること、トークンが付くこと、停止で告知の `done()` が catalog・映像・音声・event timeline の publisher の `done()` より前に呼ばれること、失敗時にエラー表示が 1 回であることを検証する。PUBLISH の後に送る順序は `startPublishing` の呼び出し位置で保証する
- 実リレーで、devtools の publisher が告知した namespace を別 Session の `SUBSCRIBE_NAMESPACE` から `NAMESPACE` として観測できるか、停止で `NAMESPACE_DONE` を観測できるかを確かめる。`NAMESPACE` と `NAMESPACE_DONE` の両方を観測できた場合だけ `tests/e2e/relay/` に E2E を 1 本追加する。どちらかを観測できない場合は、観測できた範囲と `PUBLISH_NAMESPACE` が受理された事実を記録し、失敗を隠すテストは追加しない (closed 0887 / pending 0817 の方針)

## 完了条件

- devtools の publisher が `announceNamespace` を有効にし、`namespaceArray` が空でないときは PUBLISH_NAMESPACE を送り、REQUEST_OK を待てる
- PUBLISH_NAMESPACE は catalog・映像・音声・event timeline の PUBLISH の後に 1 回送る
- 停止・失敗・セッション終了で告知を後始末でき、エラー表示の二重通知が無い
- 停止では、告知の `done()` が publisher の `done()` より前に 1 回呼ばれる
- `PublisherPanel` のトグルで有効・無効を切り替えられる
- 単体テストが通り、実リレーでの確認結果を解決方法に記録する。`NAMESPACE` と `NAMESPACE_DONE` の両方を観測できた場合は `tests/e2e/relay/` の E2E も追加する
- `vp check`、`vp exec tsc --noEmit`、`vp test run` が通る
- `README.md` の moqt-devtools の機能一覧に、告知の既定 (無効) と、relay が `NAMESPACE` / `NAMESPACE_DONE` を返さない場合の制限を記録する
- `CHANGES.md` は MOQT RFC ドラフト中のため更新しない (`CODEBASE.md` の特別ルール)

## 参照

- `devtools/src/hooks/usePublisher.ts`
- `devtools/src/components/PublisherPanel.tsx`
- `devtools/src/signals/publisher.ts`
- `devtools/src/signals/connectionSettings.ts`
- `devtools/src/utils/trackAuthorization.ts`
- `devtools/src/testSupport/fakes.ts`
- `devtools/src/hooks/usePublisher.test.ts`
- `src/session.ts` の `Session.publishNamespace`
- `src/session/publicTypes.ts` の `NamespacePublication` / `PublishNamespaceOptions`
- `src/codec/types.ts` の `MediaPublisherOptions.announceNamespace`
- `tests/e2e/main.ts` の `window.__moqtE2E` (`startSubscribeNamespace` / `getSubscribeNamespace`)
- `tests/e2e/relay/` (devtools の publisher を使う E2E)
- `README.md` の moqt-devtools の機能一覧
- draft-ietf-moq-transport-23 §2.4.2 / §4.1 / §7.7 / §9.13 / §9.15 / §9.16 / §9.19.2
- draft-ietf-moq-msf-01 §11.4.3
- closed 0887 (createMediaPublisher の announceNamespace)、closed 0956 / 0957 (devtools の SUBSCRIBE_TRACKS)、closed 0960 (publisher としての SUBSCRIBE_TRACKS)
- pending 0817 (実リレーでの namespace discovery の試行結果と E2E の分担)

## 解決方法

- `devtools/src/signals/publisher.ts` に `announceNamespace` (既定 false) を追加し、`PublisherPanel` にチェックボックスを追加した。開始中・配信中・停止中は変更できない
- `usePublisher` は既存の PUBLISH の往復の後に `session.publishNamespace()` を 1 回呼び、REQUEST_OK を待つ。Authorization Token は PUBLISH と同じ SETUP のトークンを `trackAuthorization.ts` の組み立てで付与する。namespace が空配列のときは送らない (0 フィールドの prefix が全 namespace に一致するため)
- 停止時は `done()` で撤回し、開始の失敗・セッション終了・パネル破棄では未確立の待ちを reject し、確立済みなら closed にする。onError は 1 回だけ通知する。REQUEST_OK 待ちの停止は停止起点の打ち切りとして識別し、後始末を `stopPublishing` に任せる (開始側がセッションを閉じて stop-sending の表示と食い違うのを防ぐ)
- 統計に `namespaceAnnouncement` (確立状態) を追加し、成功・撤回・確立前の取消をログに記録した
- 単体テストに、無効時に送らない、有効時に PUBLISH の後に 1 回、トークン付与、停止で `done()` 1 回、REQUEST_OK 待ちの停止 (publish-done / stop-sending)、開始失敗と確立後エラーの onError 1 回、空 namespace、dispose を追加した
- `tests/e2e/relay/devtools-namespace-announcement.spec.ts` を追加した。実リレーで devtools の publisher が告知を受理され (`namespaceAnnouncement === "active"`、映像 Object が流れる)、別 Session の `SUBSCRIBE_NAMESPACE` から告知した namespace が `NAMESPACE` として観測でき、停止で `NAMESPACE_DONE` が届くことを確認した。既存の SUBSCRIBE_NAMESPACE の購読・観測処理は `tests/e2e/relay/support.ts` の共通関数へ切り出した
- `docs/DEVELOPMENT.md` に告知トグルの意味と確認方法を追記し、`README.md` に告知の既定 (無効) と、relay が NAMESPACE / NAMESPACE_DONE を返さない場合の制限を記録した
- 確認: `tsc --noEmit`、`vp check`、`vp test run` (279 ファイル / 5254 テスト)、実リレーの E2E (1 passed) が通った
