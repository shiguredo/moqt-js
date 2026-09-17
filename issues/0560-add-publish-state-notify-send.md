# PUBLISH_STATE_NOTIFY の送信を実装する

- Created: 2026-09-09
- Completed: 2026-09-17
- Branch: feature/add-publish-state-notify-send
- Polished: 2026-09-17

## 目的

draft-ietf-moq-transport-21 §9.10 は、publisher が購読状態の変化を PUBLISH_STATE_NOTIFY で通知し、既知なら LARGEST_OBJECT を必ず含める MUST を定める。現状は受信ハンドラとエンコーダのみで送信経路がなく、EXPIRES 失効等の状態変化を購読者へ通知できない。

## 現状

- `src/message/session.ts` の `encodePublishStateNotifyPayload()` はエクスポートされているが、送信経路から呼ばれていない。
- `src/session/bidi.ts` の `bidiHandlePublishStateNotify` は受信のみ。
- publisher 側の状態変化 (EXPIRES 失効等) を通知する経路がない。

## 設計方針

1. publisher の購読状態変化時に PUBLISH_STATE_NOTIFY を購読の双方向ストリームへ送信する。
2. 既知なら LARGEST_OBJECT を含める (§9.20.18)。
3. 許可パラメータ (LARGEST_OBJECT / FORWARD / LOCATION_FILTER) のみを載せる。
4. 送信タイミング (EXPIRES 失効等) と重複送信の抑止は実装時に確定する。

## 完了条件

- 購読状態変化時に PUBLISH_STATE_NOTIFY が送信される。
- LARGEST_OBJECT が必要時に含まれる。
- `vp check` / `tsc --noEmit` / `vp test run` が通る。

## 参照

- `refs/moq/draft-ietf-moq-transport-21.txt` §9.10 / §9.20.18
- 監査: issue 0558 の適合監査 (A-2)
- 関連: `issues/0552-update-publish-state-notify-filter-compare.md`

## 解決方法

送信経路を実装した。パラメータの扱いは draft-ietf-moq-transport-21 §9.10 (PUBLISH_STATE_NOTIFY) / §9.20.18 (LARGEST OBJECT Parameter) / §9.20.19 (FORWARD Parameter) / §9.20.10 (LOCATION FILTER Parameter) に従い、実装とコメントも同じ節番号を参照している。

### 送信タイミング (設計方針 4)

アプリが変化後の値を指定して呼ぶ明示 API とした。

- moqt-js は購読状態を自力で変化させない。Forward State は PUBLISH 送信時の指定と REQUEST_UPDATE 受信、Location Filter は REQUEST_UPDATE 受信で変わる。後者は「subscriber が送った REQUEST_UPDATE が理由の変化」であり、§9.10 の定義 (「for a reason other than a subscriber sent REQUEST_UPDATE」) から通知の対象外である。
- 購読の EXPIRES (§9.20.17) は期限切れ時に PUBLISH_DONE もしくはリクエストの cancel で購読を終了するものであり、状態変化の通知ではない。失効を理由にした通知を自動で送るには期限タイマーと「何が変わったか」の判断が要るが、moqt-js は期限タイマーを持たず、通知に載せられる EXPIRES も許可パラメータに無い。したがって自動送信は行わず、状態変化を知っているアプリからの呼び出しを契機とする。

公開 API は `Publisher.notifyStateChange(options?)` とした。`options.forward` / `options.filter` が「変化後の値」であり、省略したフィールドは通知に載せない。返値は送信の完了を表す Promise で、購読終了後は送信せず resolve、送信できない場合 (ストリーム終了等) は reject する。セッションは閉じない。fire-and-forget で呼んでも unhandled rejection にならないよう、返却値と同一インスタンスに catch を登録する (`Subscriber.update()` と同じ扱い)。

### 載せるパラメータ (設計方針 2 / 3)

パラメータの組み立ては `src/session/bidi.ts` の `bidiSendPublishStateNotify()` が行う (`bidiSendRequestUpdate()` と同じ役割分担)。

- LARGEST_OBJECT: 送信済み Object があり既知なら必ず載せる (§9.20.18 の MUST)。未知なら載せない。
- FORWARD / LOCATION_FILTER: 現在値から変化した場合のみ載せる。FORWARD は値域 0/1 を `encodeUint8ParameterValue`、LOCATION_FILTER は End Group の値域を `encodeLocationFilterParameter` が送信前に検証する。
- 送信前に `assertParametersAllowedForSend(parameters, PUBLISH_STATE_NOTIFY_ALLOWED_PARAMS, ...)` でスコープを検証する (§9.20.1 の MUST。許可 3 種のみ)。
- 応答を待たない片方向通知のため pending 登録を行わず、§9.10 により MAX_REQUEST_UPDATES (§9.1.7) の対象外である。

### 重複送信の抑止 (設計方針 4)

「値の変化したパラメータのみを運ぶ」(§9.10) を判定基準にした。変化したパラメータが 1 つも無ければ送信しない。現在値と同じ値の再通知、変化を指定しない通知は送信されない。LARGEST_OBJECT は変化の有無に依らず既知なら載せる MUST のため、判定には数えない。

### 状態の反映

Forward State / Location Filter の反映は write 成功後に行う。送信できなかった変更を反映すると、購読者が受け取った値と publisher が実際に適用する値が食い違うためである。`forward: false` を通知した場合は Forward State 0 が反映され、購読者が REQUEST_UPDATE で FORWARD=1 を送るまで Object を送信しない (§9.8 の PUBLISH 時の FORWARD=0 と同じ扱い)。

`PublisherImpl` に生の Location Filter の保持と `getLocationFilter()` を追加した。解決済みの `subscriptionLocationFilter` は解決時点の LARGEST_OBJECT に依存するため、同じ内容の再設定を避ける等価判定 (`isSameLocationFilter`) に使えない (`SubscriberImpl.getLocationFilter` と同じ理由)。

`SessionImpl.publish()` で `PublisherImpl.onNotifyStateChange` を配線した。サブスクライバー側の `Subscriber.update()` → `bidiSendRequestUpdate()` と対称の構成である。

### テスト

- `src/session/bidiSendPublishStateNotify.test.ts` を追加 (8 件)。実ストリームと実 Map の testSupport (`createPublishReadTestContext`) を使い、モックやスタブは使わない
  - FORWARD の変化を LARGEST_OBJECT 付きで通知すること、LARGEST_OBJECT が未知なら FORWARD のみを載せること
  - 値の変化が無い通知 (同じ値の再通知・変化を指定しない通知) を送信せず、変化した値は送信すること
  - LOCATION_FILTER の変化を通知し、等価な値では送信しないこと
  - write 失敗時に購読状態を反映せず reject すること、購読終了後は送信しないこと、request stream が無い場合は reject すること
  - 送信したバイト列を購読側の読み取りループへ流し、`bidiHandlePublishStateNotify` が LARGEST_OBJECT と FORWARD を購読状態へ反映すること (エンコードとデコードの突き合わせ)
- `src/session.test.ts` に 1 件追加。`Session.publish()` が返す Publisher の `notifyStateChange()` が購読の双方向ストリームへ PUBLISH_STATE_NOTIFY を送信し、送信済み Object がある場合は LARGEST_OBJECT が載ることを公開 API から検証する (配線を外すと失敗することを実測した)。この検証のため `createPublishSession()` が双方向ストリームへの write を記録し、Subgroup ストリームを作れるようにした
- `src/testSupport/bidi.ts` の `createPublishReadTestContext()` に `SessionImpl.publish()` と同じ `onNotifyStateChange` の配線を追加した

### 検証

- `vp check` 通過 (oxfmt / oxlint type-aware)
- `tsc --noEmit` 通過
- `vp test run`: 105 ファイル / 2,328 テスト全通過
- `vp run build` 通過
- `CHANGES.md` の `## develop` に `[ADD]` を追加した
