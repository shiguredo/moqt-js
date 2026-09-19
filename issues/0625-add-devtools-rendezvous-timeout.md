# devtools の購読に RENDEZVOUS_TIMEOUT を設定する

- Created: 2026-09-20
- Completed: 2026-09-20
- Branch: feature/add-devtools-rendezvous-timeout

## 目的

devtools の subscriber は Catalog を購読し、Catalog が広告する映像トラックを購読する。
publisher がまだ接続していない状態で購読を開始すると、Sora の Media over QUIC 実装で
ありリレー機能を提供する sora-moq のリレーは `REQUEST_ERROR (DOES_NOT_EXIST)` を返す。
subscriber は「publisher を待つ」ことができず、視聴を開始できない。

「先に視聴を開始し、後から配信が始まる」順序は実運用で一般的であり、待てないのは
体験として問題である。

## 現状

- `moqt-js` の `SubscribeOptions` は `rendezvousTimeout` を持つ
  (`src/session/bidi.ts` の `bidiSendRequestUpdate` 系と
  `src/session/requests.ts` の SUBSCRIBE 送信経路が `RENDEZVOUS_TIMEOUT` を載せる)
- `devtools/src/hooks/useSubscriber.ts` の Catalog 購読と映像トラック購読は
  `rendezvousTimeout` を指定していない
- `devtools/src/hooks/useSubscriber.ts` は `settings.catalogSubscriptionTimeout` を
  Catalog の受信タイムアウトとして既に使っているが、SUBSCRIBE には渡していない
- publisher が居ない状態で購読すると、リレーは
  `REQUEST_ERROR (DOES_NOT_EXIST)` を返し、devtools は購読失敗として扱う

## 設計方針

- Catalog 購読と映像トラック購読の両方に `rendezvousTimeout` を渡す。
  `settings.catalogSubscriptionTimeout` と同じ値をミリ秒から bigint に変換して使う。
  ユーザーが指定した待ち時間の意味を「Catalog の受信待ち」と「publisher の出現待ち」で
  揃えるため、別の設定値は増やさない
- `0` は「リレーは購読を保持せず、publisher が居なければ即座に失敗させる」を意味する。
  ユーザーが `0` を指定した場合は待たない挙動になるため、そのまま渡す
- 値の変換は既存の `BigInt(settings.catalogSubscriptionTimeout.value)` と同じ形にする

## 完了条件

- subscriber を先に開始し、後から publisher を開始しても Catalog が届き、映像が
  視聴できる
- publisher が最後まで現れない場合は `REQUEST_ERROR (TIMEOUT)` で失敗が通知される
- 実リレー経由で上記を検証する E2E テストが通る
- `npx tsc --noEmit` / `npx vp check` / `npx vp test --run` が通る

## 参照

- draft-ietf-moq-transport-21 §9.20.7 (RENDEZVOUS TIMEOUT Parameter)
- draft-ietf-moq-transport-21 §9.4.2 (REQUEST_ERROR)
- draft-ietf-moq-transport-21 §7.5 (Relay behavior)

## 解決方法

### RENDEZVOUS_TIMEOUT の設定

`devtools/src/hooks/useSubscriber.ts` の Catalog 購読と映像トラック購読の
`SubscribeOptions` に `rendezvousTimeout` を追加し、
`BigInt(settings.catalogSubscriptionTimeout.value)` を渡すようにした。ライブラリ側は
`SubscribeOptions.rendezvousTimeout` → `buildSubscribeParameters` → SUBSCRIBE の
Message Parameter (0x04) の経路が既に実装済みであり、devtools が値を渡していなかった
だけである。

待ち時間は `catalogSubscriptionTimeout` と同じ値を使う。ユーザーにとっての「Catalog の
受信待ち」と「publisher の出現待ち」は同じ待ち時間であり、設定値を増やさない。`0` は
§9.20.7 のとおり「待たない」の意味になるため、そのまま渡す。

### テスト

devtools の購読経路は実 WebTransport に依存するため、単体テストでは SUBSCRIBE の
Message Parameter を観測できない (モックやスタブは使わない方針)。実リレーを起動して
devtools を Playwright で駆動する相互運用 harness の
`test_devtools_subscriber_waits_for_devtools_publisher` で、subscriber 先行で接続しても
後から現れた publisher の Catalog が届くことを検証する。
`test_devtools_subscriber_without_publisher_reports_failure` で、publisher が現れないまま
devtools の待ち時間が尽きたときに失敗として報告されることも検証する。

リレー側が保持した購読を期限切れで `REQUEST_ERROR (TIMEOUT)` にする挙動は、
`sora-moq` のリレー実装のテストで検証している。

### 検証

- `npx vp check` (287 files / 908 files)
- `npx vp test --run` (2400 passed)
- `CHANGES.md` の `## develop` に [ADD] エントリを追加
