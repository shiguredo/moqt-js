# devtools の publisher が PUBLISH_NAMESPACE を送れるようにする

- Created: 2026-11-15
- Completed: 2026-11-15
- Branch: feature/add-devtools-publisher-namespace-announcement
- Polished: {YYYY-MM-DD}

## 目的

devtools の publisher から PUBLISH_NAMESPACE を送れるようにする。

draft-ietf-moq-transport-23 §7.7 は「If a Publisher would like Subscriptions in a Namespace routed to it, it MUST send an explicit PUBLISH_NAMESPACE.」と定める。PUBLISH だけを送る publisher には、relay は namespace 購読 (SUBSCRIBE_TRACKS / SUBSCRIBE_NAMESPACE) をルーティングしない。devtools で SUBSCRIBE_TRACKS の受信側の挙動を確認するには、publisher が namespace を告知できる必要がある。

高レベル API の `createMediaPublisher` は `announceNamespace` で告知できる (closed 0887)。devtools は `createMediaPublisher` を使わず `devtools/src/hooks/usePublisher.ts` で独自に `session.publish()` を呼ぶため、告知の経路が無い。

## 現状

- `devtools/src/hooks/usePublisher.ts` の `startPublishing` は catalog / audio / video / event を `session.publish()` で送るが、`session.publishNamespace()` を呼ばない
- publisher の設定を表す signal に告知の項目が無く、`PublisherPanel` にもトグルが無い
- `devtools/src/utils/trackAuthorization.ts` は PUBLISH と PUBLISH_NAMESPACE の両方のトークン組み立てを扱うが、PUBLISH_NAMESPACE を送る経路が無い
- 単体テスト (`devtools/src/hooks/usePublisher.test.ts`) と E2E は告知の経路を検証していない
- devtools の publisher を使う実リレー E2E (`tests/e2e/relay/`) は、publisher が namespace を告知しないため relay から namespace 購読を受けない

## 設計方針

- publisher の設定 signal に `announceNamespace` (既定 false) を追加し、`PublisherPanel` にチェックボックスを追加する。ラベルと説明は英語にする (devtools の画面は英語)
- `startPublishing` は、既存の PUBLISH の往復を終えた後に `session.publishNamespace(namespace, callbacks, options)` を 1 回呼び、REQUEST_OK を待つ。順序は closed 0887 の `createMediaPublisher` と同じにする (§4.1)
- Authorization Token は PUBLISH と同じ SETUP のトークンを付与する (draft-ietf-moq-msf-01 §11.4.3)。`trackAuthorization.ts` の既存の組み立てを使う
- 告知の確立後に停止したら `done()` を呼び、`NAMESPACE_DONE` を送る。開始の失敗・セッション終了・コンポーネントの破棄では pending を reject し、確立済みなら state を closed にする。onError は 1 回だけ通知する
- 告知を無効にした場合と、`namespace` が空配列の場合は送らない。空配列は 0 フィールドの prefix が全 namespace に一致するため (§2.4.2)、黙って告知しない
- 単体テストで、無効時に送らないこと、有効時に PUBLISH の後に 1 回送ること、トークンが付くこと、停止で `done()` が呼ばれること、失敗時に onError が 1 回であることを検証する
- 実リレーで、devtools の publisher が告知した namespace を別 Session の `SUBSCRIBE_NAMESPACE` から `NAMESPACE` として観測できるかを確かめる。relay が `NAMESPACE` を返さない場合は、`PUBLISH_NAMESPACE` が受理されたことだけを記録し、失敗を隠すテストは追加しない (closed 0887 / pending 0817 の方針)

## 完了条件

- devtools の publisher が `announceNamespace` を有効にすると PUBLISH_NAMESPACE を送り、REQUEST_OK を待てる
- 停止・失敗・セッション終了で告知を後始末でき、onError の二重通知が無い
- `PublisherPanel` のトグルで有効・無効を切り替えられる
- 単体テストが通り、実リレーでの確認結果を解決方法に記録する
- `vp check` と `vp test run` が通る
- 告知の制限 (relay が NAMESPACE を返さない場合など) を docs に記録する

## 参照

- `devtools/src/hooks/usePublisher.ts`
- `devtools/src/components/PublisherPanel.tsx`
- `devtools/src/signals/publisher.ts`
- `devtools/src/utils/trackAuthorization.ts`
- `src/session/publicTypes.ts` の `publishNamespace`
- draft-ietf-moq-transport-23 §4.1 / §7.7 / §9.10 / §9.19
- closed 0887 (createMediaPublisher の announceNamespace)、0956 / 0957 (devtools の SUBSCRIBE_TRACKS)

## 解決方法

- `devtools/src/signals/publisher.ts` に `announceNamespace` (既定 false) を追加し、`PublisherPanel` にチェックボックスを追加した。開始中・配信中・停止中は変更できない
- `usePublisher` は既存の PUBLISH の往復の後に `session.publishNamespace()` を 1 回呼び、REQUEST_OK を待つ。Authorization Token は PUBLISH と同じ SETUP のトークンを `trackAuthorization.ts` の組み立てで付与する。namespace が空配列のときは送らない (0 フィールドの prefix が全 namespace に一致するため)
- 停止時は `done()` で撤回し、開始の失敗・セッション終了・パネル破棄では未確立の待ちを reject し、確立済みなら closed にする。onError は 1 回だけ通知する。REQUEST_OK 待ちの停止は停止起点の打ち切りとして識別し、後始末を `stopPublishing` に任せる (開始側がセッションを閉じて stop-sending の表示と食い違うのを防ぐ)
- 統計に `namespaceAnnouncement` (確立状態) を追加し、成功・撤回・確立前の取消をログに記録した
- 単体テストに、無効時に送らない、有効時に PUBLISH の後に 1 回、トークン付与、停止で `done()` 1 回、REQUEST_OK 待ちの停止 (publish-done / stop-sending)、開始失敗と確立後エラーの onError 1 回、空 namespace、dispose を追加した
- `tests/e2e/relay/devtools-namespace-announcement.spec.ts` を追加した。実リレーで devtools の publisher が告知を受理され (`namespaceAnnouncement === "active"`、映像 Object が流れる)、別 Session の `SUBSCRIBE_NAMESPACE` から告知した namespace が `NAMESPACE` として観測できることを確認した。既存の SUBSCRIBE_NAMESPACE の購読・観測処理は `tests/e2e/relay/support.ts` の共通関数へ切り出した
- `docs/DEVELOPMENT.md` に告知トグルの意味と確認方法を追記した
- 確認: `tsc --noEmit`、`vp check`、`vp test run` (279 ファイル / 5254 テスト)、実リレーの E2E (1 passed) が通った
