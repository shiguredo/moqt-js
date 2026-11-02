# createMediaPublisher が PUBLISH_NAMESPACE を送らない

- Created: 2026-11-02
- Completed: 2026-11-02
- Branch: feature/add-media-publisher-namespace-announcement
- Polished: 2026-11-02

## 目的

高レベル API の `createMediaPublisher` で作った配信を、relay の namespace discovery (`SUBSCRIBE_NAMESPACE`) から発見できるようにする。現状の高レベル API は catalog と媒体トラックの `PUBLISH` だけを送るため、relay は namespace を列挙せず、視聴者は高レベル API の配信に discovery から到達できない。会議 (N:N) のアプリは発見のためだけに低レベル API の `Session` を別に張り、そこで `PUBLISH_NAMESPACE` と `SUBSCRIBE_NAMESPACE` を行っており、参加者ごとに余分な Session を抱えている。

本 issue で高レベル API に移すのは告知側 (`PUBLISH_NAMESPACE`) だけである。発見の購読 (`SUBSCRIBE_NAMESPACE`) は高レベル API に足さず、余分な Session は発見の購読のために残る。この範囲を明記しておかないと、目的を読んだ実装者が購読側まで実装してしまう。

## 現状

- `MediaPublisherImpl` は `connectToServer` で受け取った `Session` を private フィールドに保持し、`MediaPublisher` に Session を読む入口が無い。
- `MediaPublisherImpl.start` は、接続、音声の配送方式の検査 (`assertAudioDeliverySupported`)、PUBLISH の往復 (`createPublishers`)、音声の取り出し経路 (`prepareAudioFrameSource`)、catalog の送信 (`publishCatalog`)、エンコーダーの設定 (`setupEncoders`)、処理ループの起動の順に進み、`PUBLISH_NAMESPACE` を送る段が無い。
- 低レベル API には `Session.publishNamespace` と `NamespacePublication` (`state` / `namespace` / `done()`) があり、draft-ietf-moq-transport-22 §4.1 の告知と §6.4.2.3 の撤回 (request のキャンセル) に対応している。高レベル API が同じ Session で呼べば追加の Session は要らない。
- ただし Session の終了時に、未確立の `publishNamespace` の Promise が settle することを低レベル API は保証していない。`sessionMarkRequestObjectsClosed` は `namespacePublications` の state を `"closed"` にするが Promise は reject せず、`sessionRejectPendingRequests` の対象にも `namespacePublications` が入っていない。ピア起点の close では `sessionMarkRequestObjectsClosed` が state を `"closed"` にするため、読み取りエラーの時点で state が `"closed"` になっていれば `onReadError` も reject しない。どちらが先になるかは保証されないため、`start()` が告知の await で止まったままになる経路が残る。
- `docs/proposals/NAMESPACE_ANNOUNCEMENT.md` に、draft-22 と msf-01 を根拠にした設計案 (ライフサイクル、エラーと認可、未決事項、テスト計画) がある。実装はまだ無い。この提案書は低レベル API の変更を不要としているが、上の穴があるため変更が要る。
- `tests/e2e/main.ts` の `window.__moqtE2E` は namespace 系を公開しておらず、実リレーでの `PUBLISH_NAMESPACE` / `SUBSCRIBE_NAMESPACE` の往復は未検証である。`issues/0817-add-relay-tests.md` の記録 (2026-10-03) では `PUBLISH_NAMESPACE` は受理され、`SUBSCRIBE_NAMESPACE` に応答が無かった。
- `docs/LOW_LEVEL_API.md` の「Namespace 系の扱い」は、`PUBLISH_NAMESPACE` の終了を「ローカル状態の cleanup のみで表現している」と書いている。実装 (`namespacesCloseNamespacePublication`) は RESET_STREAM と STOP_SENDING で撤回しており、記述が実装と食い違っている。

## 設計方針

`docs/proposals/NAMESPACE_ANNOUNCEMENT.md` の推奨案に従い、未決事項は次のとおり決める。

- 低レベル API に「Session 終了時に未確立の namespace publication を reject する」後始末を足す。`namespacePublications` のエントリに reject を保持し、Session 終了時の後始末で、Promise が未解決かどうかで判定して reject する (`sessionMarkRequestObjectsClosed` が先に state を `"closed"` にするため、state では判定できない)。これにより、自前の `close()` とピア起点の close のどちらでも告知の await が settle し、`start()` が続行または失敗できる。あわせて `docs/proposals/NAMESPACE_ANNOUNCEMENT.md` の「`src/session.ts`、`src/session/namespaces.ts`、`src/session/publicTypes.ts`: 変更不要」を訂正する。
- オプション名は `MediaPublisherOptions.announceNamespace?: boolean` とし、低レベル API の `publishNamespace` に揃える。既定値は `false` (opt-in) とする。relay の対応と失敗時の扱いを実リレーで確かめるまで、既存の呼び出しの挙動を変えない。
- `MediaPublisher` に `readonly namespacePublication: NamespacePublication | null` を追加する。告知だけを先に終えたい利用者が `done()` を呼べるようにする (draft-22 §4.1 は告知だけを終えることを許す)。null を返すのは `announceNamespace` が無効な場合、`start()` の確立前 (実行中を含む)、`start()` が失敗した後、`stop()` / `close()` の後、ピア起点の close の後である。利用者が `done()` を呼んだ後は `"closed"` の publication を返す (告知の有無を観測できるようにするため)。
- `start()` は `createPublishers` の後、`prepareAudioFrameSource` の前に告知し、`REQUEST_OK` を待って保持する。PUBLISH を確立してから告知するのは、§4.1 の「prefix に一致する namespace にトラックがある」という表明と一致させるためである。告知の失敗は `start()` の失敗にする (指定した機能を黙って落とさない。音声の配送方式の検査と同じ方針)。
- 告知の確立前の失敗は `onError` を 1 回だけ通知する契約にする。`REQUEST_ERROR` と読み取りエラーでは `NamespacePublicationCallbacks.error` の通知を抑止し、`start()` の失敗として 1 回通知する (低レベルの `publishNamespace` は `REQUEST_ERROR` でコールバックを呼んでから Promise を reject するため、そのまま流すと二重になる)。`PUBLISH_NAMESPACE_OK` のスコープ違反と Track Properties 違反は `namespaceRejectAndCloseWithError` が `session.closeWithError` を呼び、高レベルの Session error コールバック (`onSessionError`) が `onError` を呼んでから `start()` の catch が同じエラーを通知するため、Session エラーで通知済みの error を記録し、`notifyStartFailure` の通知を skip する。`REQUEST_OK` の decode 自体が `ProtocolViolationError` を投げる経路は、読み取りエラーの catch が別の `SessionError` を作って Session を閉じる既存の経路であり、同一の error を記録するこの仕組みでは 1 回にできない。この経路は本 issue の対象外とし、Session エラーと `start()` の失敗で 2 回通知し得る。
- 告知の確立後は stream のエラー (RESET_STREAM) を `onError` に流し、配信は続ける。ピアの FIN は graceful な終了であり、低レベルは FIN で `NamespacePublicationCallbacks.error` を呼ばない (`createPublicationStreamHandlers` の `onStreamDone` は確立後は writer を閉じるだけ)。このため FIN では `onError` を通知せず、`namespacePublication` の `state` が `"closed"` になることで告知の終了を観測させる。
- `pause()` / `resume()` では告知を維持する。`stop()` / `close()` の解放では publisher の `done()` より前に告知の `done()` を 1 回呼ぶ。停止中の配信を新規の購読者に発見させないためである。`start()` の失敗時の巻き戻しでも同じ解放を通す。`stop()` からの再 `start()` は新しい Session なので告知し直す。
- 告知の await 中に `close()` またはピア起点の close が先行し得るため、告知の後にも `assertStartNotDisposed` を置く。解決済みの publication は `done()` してから失敗し、ローカルの参照を残さない。待ちが残らないことは上の低レベルの後始末で保証する。
- 認可は SETUP に載せたトークン (`Session.setupAuthorizationToken`) を `PublishNamespaceOptions.authorizationToken` に渡し、PUBLISH と共用する (draft-ietf-moq-msf-01 §11.4.3)。
- `namespace` が空配列で `announceNamespace: true` の場合は `start()` の入口で拒否する。接続前のオプション解決 (`resolveVideoPublishSettings` など) と同じ扱いにし、`onError` は通知しない。0 フィールドの prefix は全 namespace に一致する (§2.4.2) ため、黙って全 namespace を告知しない。

実装に先行して実リレーで確認する。`tests/e2e/main.ts` に `publishNamespace` / `subscribeNamespace` を露出し、`PUBLISH_NAMESPACE` → `REQUEST_OK` を確かめる。高レベルの経路は `StartPublisherOptions` に `announceNamespace` を足し、`announceNamespace: true` で `start()` した publisher を別 Session の `SUBSCRIBE_NAMESPACE` で `NAMESPACE` として観測する E2E で確認する。E2E の停止は既存ハーネスの `stopPublisher` が `close()` を呼ぶため、`close()` の解放で `NAMESPACE_DONE` を観測する。relay が `SUBSCRIBE_NAMESPACE` に `REQUEST_OK` を返しても `NAMESPACE` が届かない場合は E2E を追加せず、`PUBLISH_NAMESPACE` が受理されたことを解決方法に記録する (`issues/0817-add-relay-tests.md` の方針。失敗を隠すテストは追加しない)。PUBLISH の後に PUBLISH_NAMESPACE を送る順序が受理されることを確かめ、受理されない relay であれば順序の設計を見直す。

`window.__moqtE2E` の namespace 系の露出は本 issue の検証に必要な範囲に限る。`issues/0817-add-relay-tests.md` が扱う他の namespace 経路 (`SUBSCRIBE_NAMESPACE` の継続受信、`REQUEST_UPDATE`、`TRACK_STATUS` など) は 0817 に残す。

## 完了条件

- Session の終了 (自前の `close()` とピア起点の close) で、未確立の `publishNamespace` の await が reject する (低レベルのテストで固定する)。これにより、告知の await 中に close が重なっても `start()` がハングせず失敗する
- `announceNamespace` を指定しない場合と `false` の場合に `publishNamespace` を呼ばない
- `announceNamespace: true` で、`namespace` と同じ配列と SETUP のトークン付きで `publishNamespace` を 1 回呼び、PUBLISH の往復の後に告知する (呼び出し順も固定する)
- 告知の `REQUEST_OK` を待って `namespacePublication` が `"active"` になり、`stop()` / `close()` の後に `null` になる
- 告知の確立前の失敗 (`REQUEST_ERROR`、読み取りエラー (ただし `REQUEST_OK` の decode が `ProtocolViolationError` を投げる経路は除く)、`PUBLISH_NAMESPACE_OK` のスコープ違反と Track Properties 違反) で `start()` が失敗し、`onError` は 1 回だけ通知され、確保済みのリソースが残らない。実装では start 中に Session エラーを通知したかを記録するため、`REQUEST_OK` の decode の経路も 1 回になる (解決方法を参照)
- 告知の確立前に `close()` またはピア起点の close が重なった場合に、`start()` が失敗して publication の参照が残らない
- `stop()` / `close()` で `done()` を 1 回呼び、それが catalog / 音声 / 映像の publisher の `done()` より前である (呼び出し順も固定する)。`stop()` からの再 `start()` で再度告知する
- `pause()` / `resume()` で `done()` も再告知もしない
- ピア起点の close で、解放に伴う `done()` の失敗が `onError` に通知されない
- 告知の確立後の stream エラー (RESET_STREAM) で `onError` が 1 回だけ通知され、配信は継続する
- 告知の確立後にピアが FIN した場合、`onError` は通知されず、`namespacePublication` の `state` が `"closed"` になる
- 利用者が `namespacePublication.done()` を呼ぶと告知だけが終了して配信は継続し、`namespacePublication` は `"closed"` の publication を返し、`stop()` は失敗せず、告知の `done()` を二重に呼ばない。再 `start()` で再告知する
- `namespace: []` と `announceNamespace: true` の組み合わせで `start()` が入口で拒否され、`onError` を通知しない
- 実リレーで `PUBLISH_NAMESPACE` → `REQUEST_OK` を確認する。relay が `SUBSCRIBE_NAMESPACE` に `REQUEST_OK` を返し、`NAMESPACE` が届くことを確認できた場合にだけ、`announceNamespace: true` の `start()` を別 Session の `SUBSCRIBE_NAMESPACE` で `NAMESPACE` として観測し、`close()` で `NAMESPACE_DONE` を観測する E2E を 1 本追加する。確認できなければ E2E は追加せず、受理の確認結果を解決方法に記録する
- PUBLISH の後に PUBLISH_NAMESPACE を送る順序が実リレーで受理されることを確認する (受理されない場合は順序の設計を見直す)
- `docs/HIGH_LEVEL_API.md` のオプション、プロパティ表 (`namespacePublication`)、認可の付与先一覧 (`PUBLISH_NAMESPACE` を追加)、状態遷移を更新する
- `docs/ARCHITECTURE.md` の MediaPublisher の内部構成を更新する
- `docs/LOW_LEVEL_API.md` の「Namespace 系の扱い」にある「ローカル状態の cleanup のみ」を、RESET_STREAM / STOP_SENDING による撤回の実装に合わせて直す
- `docs/proposals/NAMESPACE_ANNOUNCEMENT.md` に採否と移行先を残し、実装箇所の「`src/session.ts`、`src/session/namespaces.ts`、`src/session/publicTypes.ts`: 変更不要」を、`src/session/lifecycle.ts` / `src/session/namespaceLoops.ts` / `src/session/types.ts` の変更が必要であることに訂正する。`docs/proposals/README.md` の表の実装済み範囲とオプション名を更新する
- `npx vp check` と `npx vp test --run` が通る

`CHANGES.md` は MOQT RFC ドラフト中のため更新しない (`CODEBASE.md` の特別ルール)。

## 解決方法

`MediaPublisherOptions.announceNamespace` (`boolean`、既定 false) と `MediaPublisher.namespacePublication` を追加した。`start()` は PUBLISH の確立後に `Session.publishNamespace` で `PUBLISH_NAMESPACE` を送り、`REQUEST_OK` を待ってから続行する。認可トークンは `SETUP` に載せたものを `PUBLISH` と共用する (`setupAuthorizationTokenOptions()` に集約)。

- 低レベル: Session 終了時に未確立の `publishNamespace()` の Promise が settle しない穴を修正した。`NamespacePublicationState` に確立前の reject を保持し、`sessionRejectPendingRequests` が reject する (エントリの削除は専用ループが行う)。確立時に `namespaceStartPublicationStreamLoop` が reject を外す。`done()` 後も `NamespacePublication.namespace` を読めるよう、生成時に namespace を固定した
- 高レベルのライフサイクル: 告知は `stop()` / `close()` の解放で publisher の `done()` より前に `done()` する。`pause()` / `resume()` は維持する。利用者の `done()` は配信を継続する。`start()` の実行中は `namespacePublication` が null を返す。告知の失敗は `start()` の失敗にし、`onError` は 1 回だけ通知する (Session エラーが `start()` の失敗としても届く経路は、start 中に Session エラーを通知したかで抑止する)
- E2E: `tests/e2e/main.ts` に namespace 系の操作を露出し、`tests/e2e/relay/namespace-announcement.spec.ts` を追加した。実リレーで `PUBLISH_NAMESPACE` の受理 (`REQUEST_OK`)、`SUBSCRIBE_NAMESPACE` での `NAMESPACE` 受信、`close()` 後の `NAMESPACE_DONE` を確認した (2026-11-02、1 passed)
- 確認: `npx vp check`、`npx vp test run` (4417 tests)、`npx vp run build`、実リレー E2E が通る
- 設計からの変更: issue の設計方針は `REQUEST_OK` の decode の `ProtocolViolationError` 経路を「対象外・2 回通知し得る」としていたが、実装では start 中に Session エラーを通知したかで抑止するため 1 回になった。テストでも固定した。確立後の protocol violation (2 通目の `REQUEST_OK` の構造破損、確立後の `REQUEST_ERROR` の不正 redirect など) は、低レベルが per-request コールバックと Session エラーの両方に通知するため 2 回通知し得る。この経路は今回の対象外として残し、follow-up issue 候補として報告する
- 確認できなかったこと: 音声・映像の `PUBLISH` と告知の順序は catalog の `PUBLISH` との順序だけを単体テストで固定し、音声・映像は await の位置で保証している。Session 終了が `publishNamespace` のストリーム作成 / write の await 中に重なった場合は、登録前のため reject の対象外であり、settle はストリームの読み取りエラーに依存する (既知の窓。follow-up 候補)
- 未検証: 発見した namespace の track を `SUBSCRIBE` して受信する経路は実リレー未検証。今回の往復確認とは分けた
- `CHANGES.md` は MOQT RFC ドラフト期間中のため更新していない

## 参照

- `docs/proposals/NAMESPACE_ANNOUNCEMENT.md` (設計案)
- `src/codec/types.ts` の `MediaPublisherOptions` / `MediaPublisher`
- `src/createMediaPublisher.ts` の `MediaPublisherImpl.start` / `createPublishers` / `prepareAudioFrameSource` / `disposeAllResources` / `notifyStartFailure`
- `src/session.ts` の `Session.publishNamespace` / `Session.setupAuthorizationToken`
- `src/session/namespaces.ts` の `namespacesPublishNamespace` / `namespacesCloseNamespacePublication`
- `src/session/publicTypes.ts` の `NamespacePublication` / `PublishNamespaceOptions`
- `src/session/lifecycle.ts` の `sessionMarkRequestObjectsClosed` / `sessionRejectPendingRequests` / `sessionClose`
- `src/session/types.ts` の `NamespacePublicationState`
- `src/session/namespaceLoops.ts` の `namespaceStartPublicationStreamLoop` / `runNamespaceStreamLoop` / `createPublicationStreamHandlers`
- `src/publisher.ts` の `isErrorNotifiedByPublisher` (通知済みの記録の先例)
- `tests/e2e/main.ts` の `window.__moqtE2E` と `StartPublisherOptions`
- `docs/HIGH_LEVEL_API.md` / `docs/ARCHITECTURE.md` / `docs/LOW_LEVEL_API.md`
- `docs/proposals/README.md`
- draft-ietf-moq-transport-22 §2.4.2 / §4.1 / §4.2 / §6.4.2.3 / §9.14
- draft-ietf-moq-msf-01 §11.4.3
- `issues/0817-add-relay-tests.md` (実リレーでの namespace discovery の試行結果と E2E の分担)
