# devtools の Catalog publisher が Forward State 1 で送り直さない

- Created: 2026-09-20
- Completed: 2026-09-20
- Branch: feature/fix-devtools-catalog-forward-resend

## 目的

devtools の publisher は配信開始時に Catalog を 1 度だけ送る。Sora の Media over
QUIC 実装でありリレー機能を提供する sora-moq のリレーは、購読者が居ない間は
`REQUEST_UPDATE (FORWARD=0)` で Forward State 0 を要求する。Forward State が 0 の間、
publisher は Objects を送ってはならない。

このため、publisher が先に配信を開始し、後から subscriber が接続する順序では、
配信開始時に送った Catalog は購読者へ届かない。subscriber は Catalog を取得できず、
映像トラックの購読に進めない。

## 現状

- `devtools/src/hooks/usePublisher.ts` の `startPublishing` は Catalog を
  Group 0 の Object 0 として 1 度送る
- `devtools/src/hooks/usePublisher.ts` の停止処理は Complete Catalog を Group 1 と
  して送る。Group ID が固定値のため、間で Catalog を送り直す余地が無い
- Catalog publisher の `onForwardStateChange` は未設定であり、リレーが
  `REQUEST_UPDATE` で Forward State を 1 に変えても何も起きない
- Catalog の Group ID が 0 から始まる固定値であり、配信を停止して再開すると
  再び 0 から始まる。draft-ietf-moq-msf-01 §6.1 は「Group ID は Track ごとに
  一意で単調増加が MUST」「publisher の再起動時は以前に publish したどの
  Group ID よりも大きい値から始めることが MUST」と定めており、映像トラックが
  Unix epoch ミリ秒を開始値にしているのと揃っていない
- 結果として、publisher 先行で接続した subscriber は Catalog を一度も受信しない

## 設計方針

- Catalog を送った Group ID を signal で保持し、送り直しのたびに進める。同じ
  Location を 2 度送ると購読側で重複として扱われるため、送り直しは新しい Group で
  行う
- Group ID の開始値を映像トラックと同じ Unix epoch ミリ秒にする。Object ID は
  Group の先頭 Object のため 0 にする (§6.2)
- Catalog publisher の `onForwardStateChange` で Forward State が 1 になった時点で
  Catalog を新しい Group として送り直す。`Publisher.onForwardStateChange` は
  ライブラリが提供する購読状態の変化通知であり、リレーの `REQUEST_UPDATE` に
  よる 0 → 1 の遷移でも呼ばれる
- 停止処理の Complete Catalog は「最後に送った Group の次」を使い、Group ID の
  固定値をやめる
- 送り直しの判定で Catalog の保持値を参照するため、送信前に保持値を確定させる
  (送信は await しないため、確定が後だと Forward State の変化に間に合わない)

## 完了条件

- publisher を先に開始し、後から subscriber を接続しても Catalog が届く
- subscriber を先に開始し、後から publisher を開始しても Catalog が届く
  (従来どおり)
- Complete Catalog の Group ID が、Catalog の送り直しと衝突しない
- 配信を停止して再開しても Catalog の Group ID が前回より大きい
- 実リレー経由で上記を検証する E2E テストが通る
- `npx tsc --noEmit` / `npx vp check` / `npx vp test --run` が通る

## 参照

- draft-ietf-moq-transport-21 §3.1 (Subscriptions / Forward State)
- draft-ietf-moq-transport-21 §7.5 (Relay behavior)
- draft-ietf-moq-transport-21 §9.5 (REQUEST_UPDATE)
- draft-ietf-moq-transport-21 §9.20.19 (FORWARD Parameter)
- draft-ietf-moq-msf-01 §5 (Catalog)
- draft-ietf-moq-msf-01 §6.1 (Group numbering)
- draft-ietf-moq-msf-01 §6.2 (Object Numbering)

## 解決方法

### Catalog の送り直し

`devtools/src/hooks/usePublisher.ts` に `sendCatalogUpdate` を追加し、Catalog publisher の
`onForwardStateChange` で Forward State が 1 になった時点で Catalog を新しい Group と
して送り直すようにした。`Publisher.setForwardState` は状態が実際に変化したときだけ
コールバックを呼ぶため、既に 1 の状態で重複送信することはない。

### Group ID の払い出し

`devtools/src/signals/publisher.ts` に `catalogGroup` signal を追加し、Catalog を送った
Group ID を保持するようにした。`startPublishing` が `Date.now()` で開始値を設定し、
送り直しのたびに +1 する。`stopPublishing` の Complete Catalog も
`catalogGroup + 1` を使い、固定値をやめた。

Group ID の開始値を Unix epoch ミリ秒にしたのは、draft-ietf-moq-msf-01 §6.1 が
Group ID の一意性と単調増加を MUST とし、publisher の再起動時に以前に publish した
どの Group ID よりも大きい値から始めることを MUST としているためである。映像トラック
(`pubCurrentGroup`) と同じ扱いになった。`cleanupPublisher` は `catalogGroup` を 0 に
戻さない (戻すと再起動後の Group ID が前回より小さくなり MUST に反する)。

送り直しの判定は `pub.catalog.value` を参照するため、Catalog の送信前に保持値を確定
させるようにした。`sendObject` は await しないため、確定が後だと Forward State の
変化に間に合わない。

### テスト

devtools の publish 経路は WebCodecs と実 WebTransport に依存するため、単体テストでは
`onForwardStateChange` の経路を再現できない (モックやスタブは使わない方針)。
実リレーを起動して devtools を Playwright で駆動する相互運用 harness の
`test_devtools_subscriber_waits_for_devtools_publisher` で、publisher 先行で接続した
subscriber に Catalog が届くことを検証する。

### 検証

- `npx vp check` (287 files / 908 files)
- `npx vp test --run` (2400 passed)
- `CHANGES.md` の `## develop` に [FIX] エントリを追加
