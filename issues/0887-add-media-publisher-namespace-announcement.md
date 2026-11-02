# createMediaPublisher が PUBLISH_NAMESPACE を送らない

- Created: 2026-11-02
- Completed: {YYYY-MM-DD}
- Branch: feature/add-media-publisher-namespace-announcement
- Polished: {YYYY-MM-DD}

## 目的

高レベル API の `createMediaPublisher` で作った配信を、relay の namespace discovery (`SUBSCRIBE_NAMESPACE`) から発見できるようにする。現状の高レベル API は catalog と媒体トラックの `PUBLISH` だけを送るため、relay は namespace を列挙せず、視聴者は高レベル API の配信に discovery から到達できない。会議 (N:N) のアプリは発見のためだけに低レベル API の `Session` を別に張り、そこで `PUBLISH_NAMESPACE` と `SUBSCRIBE_NAMESPACE` を行っており、参加者ごとに余分な Session を抱えている。

## 現状

- `MediaPublisherImpl` は `connectToServer` で受け取った `Session` を private フィールドに保持し、`MediaPublisher` に Session を読む入口が無い。
- `MediaPublisherImpl.start` は、接続、音声の配送方式の検査 (`assertAudioDeliverySupported`)、PUBLISH の往復 (`createPublishers`)、音声の取り出し経路 (`prepareAudioFrameSource`)、catalog の送信 (`publishCatalog`)、エンコーダーの設定 (`setupEncoders`)、処理ループの起動の順に進み、`PUBLISH_NAMESPACE` を送る段が無い。
- 低レベル API には `Session.publishNamespace` と `NamespacePublication` (`state` / `namespace` / `done()`) があり、draft-ietf-moq-transport-22 §4.1 の告知と §6.4.2.3 の撤回 (request のキャンセル) に対応している。高レベル API が同じ Session で呼べば追加の Session は要らない。
- `docs/proposals/NAMESPACE_ANNOUNCEMENT.md` に、draft-22 と msf-01 を根拠にした設計案 (ライフサイクル、エラーと認可、未決事項、テスト計画) がある。実装はまだ無い。
- `tests/e2e/main.ts` の `window.__moqtE2E` は namespace 系を公開しておらず、実リレーでの `PUBLISH_NAMESPACE` / `SUBSCRIBE_NAMESPACE` の往復は未検証である。`issues/0817-add-relay-tests.md` の記録 (2026-10-03) では `SUBSCRIBE_NAMESPACE` に応答が無かった。

## 設計方針

`docs/proposals/NAMESPACE_ANNOUNCEMENT.md` の推奨案に従い、未決事項は次のとおり決める。

- オプション名は `MediaPublisherOptions.announceNamespace?: boolean` とし、低レベル API の `publishNamespace` に揃える。既定値は `false` (opt-in) とする。relay の対応と失敗時の扱いを実リレーで確かめるまで、既存の呼び出しの挙動を変えない。
- `MediaPublisher` に `readonly namespacePublication: NamespacePublication | null` を追加する。告知だけを先に終えたい利用者が `done()` を呼べるようにする (draft-22 §4.1 は告知だけを終えることを許す)。
- `start()` は `createPublishers` の後、`prepareAudioFrameSource` の前に告知し、`REQUEST_OK` を待って保持する。PUBLISH を確立してから告知するのは、§4.1 の「prefix に一致する namespace にトラックがある」という表明と一致させるためである。告知の失敗は `start()` の失敗にする (指定した機能を黙って落とさない。音声の配送方式の検査と同じ方針)。
- 告知の確立前は `NamespacePublicationCallbacks.error` の通知を抑止し、`start()` の失敗として 1 回だけ通知する。低レベルの `publishNamespace` は `REQUEST_ERROR` でコールバックを呼んでから Promise を reject するため、そのまま流すと `onError` が二重になる。
- 告知の確立後は stream のエラーを `onError` に流し、配信は続ける。
- `pause()` / `resume()` では告知を維持する。`stop()` / `close()` の解放では publisher の `done()` より前に告知の `done()` を 1 回呼ぶ。停止中の配信を新規の購読者に発見させないためである。`start()` の失敗時の巻き戻しでも同じ解放を通す。`stop()` からの再 `start()` は新しい Session なので告知し直す。
- 告知の await 中に `close()` またはピア起点の close が先行し得るため、告知の後にも `assertStartNotDisposed` を置く。解決済みの publication は `done()` してから失敗し、ローカルの参照を残さない。
- 認可は SETUP に載せたトークン (`Session.setupAuthorizationToken`) を `PublishNamespaceOptions.authorizationToken` に渡し、PUBLISH と共用する (draft-ietf-moq-msf-01 §11.4.3)。
- `namespace` が空配列で `announceNamespace: true` の場合は `start()` を拒否する。0 フィールドの prefix は全 namespace に一致するため、黙って全 namespace を告知しない。

実装に先行して実リレーで往復を確認する。`tests/e2e/main.ts` に `publishNamespace` / `subscribeNamespace` を露出し、`PUBLISH_NAMESPACE` → `REQUEST_OK` と `SUBSCRIBE_NAMESPACE` → `NAMESPACE` を確かめる。relay が `SUBSCRIBE_NAMESPACE` に未対応なら告知の受理までを確認し、E2E は追加しない (`issues/0817-add-relay-tests.md` の方針。失敗を隠すテストは追加しない)。

## 完了条件

- `announceNamespace` を指定しない場合と `false` の場合に `publishNamespace` を呼ばない
- `announceNamespace: true` で、`namespace` と同じ配列と SETUP のトークン付きで `publishNamespace` を 1 回呼び、PUBLISH の往復の後に告知する (呼び出し順も固定する)
- 告知の `REQUEST_OK` を待って `namespacePublication` が `"active"` になり、`stop()` / `close()` の後に `null` になる
- 告知の失敗で `start()` が失敗し、`onError` は 1 回だけ通知され、確保済みのリソースが残らない
- 告知の確立前に `close()` またはピア起点の close が重なった場合に、`start()` が失敗して publication の参照が残らない
- `stop()` / `close()` で `done()` を 1 回呼び、`stop()` からの再 `start()` で再度告知する
- `pause()` / `resume()` で `done()` も再告知もしない
- ピア起点の close で `done()` の失敗が通知されない
- 告知の確立後の stream エラーで `onError` が 1 回だけ通知され、配信は継続する
- `namespace: []` と `announceNamespace: true` で `start()` が失敗する
- 実リレーで `PUBLISH_NAMESPACE` の受理と `SUBSCRIBE_NAMESPACE` の応答を確認し、通った経路だけ E2E に追加する
- `docs/HIGH_LEVEL_API.md` のオプションと状態遷移、`docs/ARCHITECTURE.md` の MediaPublisher の内部構成を更新する
- `docs/proposals/NAMESPACE_ANNOUNCEMENT.md` に採否と移行先を残す (`docs/proposals/README.md` の方針)
- `npx vp check` と `npx vp test --run` が通る

`CHANGES.md` は MOQT RFC ドラフト中のため更新しない (`CODEBASE.md` の特別ルール)。

## 解決方法

{未着手}

## 参照

- `docs/proposals/NAMESPACE_ANNOUNCEMENT.md` (設計案)
- `src/codec/types.ts` の `MediaPublisherOptions` / `MediaPublisher`
- `src/createMediaPublisher.ts` の `MediaPublisherImpl.start` / `createPublishers` / `disposeAllResources`
- `src/session.ts` の `Session.publishNamespace` / `Session.setupAuthorizationToken`
- `src/session/namespaces.ts` の `namespacesPublishNamespace` / `namespacesCloseNamespacePublication`
- `src/session/publicTypes.ts` の `NamespacePublication` / `PublishNamespaceOptions`
- `src/session/lifecycle.ts` の Session 終了時の namespace publication の後始末
- `tests/e2e/main.ts` の `window.__moqtE2E`
- draft-ietf-moq-transport-22 §4.1 / §4.2 / §6.4.2.3 / §9.14
- draft-ietf-moq-msf-01 §11.4.3
- `issues/0817-add-relay-tests.md` (実リレーの namespace discovery の試行結果)
