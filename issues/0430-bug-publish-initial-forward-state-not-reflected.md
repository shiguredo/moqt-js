# publish({ forward: false }) の初期 Forward State が PUBLISH_OK の FORWARD 省略で true に上書きされる

- Created: 2026-08-25
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-publish-initial-forward-state-not-reflected
- Polished: {YYYY-MM-DD}

## 目的

`publish({ forward: false })` でアプリが初期 Forward State を false に設定しても、対向の PUBLISH_OK が FORWARD パラメータを省略した場合に `bidiReadPublishResponse` (`src/session/bidi.ts`) が `extractForwardState` (省略時デフォルト true) を無条件反映し、Forward State が true に上書きされる。draft-ietf-moq-transport-19 §10.5 は「The initiator of a subscription... MAY include the Forwarding Preference... The initiator can set the initial Forward State」を定めており、initiator (publish するアプリ) が設定した値が、応答側の省略によって消されるのは解釈の衝突が残る。PUBLISH_OK 側を 0416 と同様に「FORWARD パラメータが存在する場合のみ反映」とする (または省略時は initiator 側の値を維持する)。

## 現状

- `publish()` (`src/session.ts`) は `options.forward` を `buildPublishParameters` 経由で PUBLISH メッセージに載せるが、ローカル `PublisherImpl` (`src/publisher.ts`) の初期 `forwardState` は常に true であり、`options.forward` を反映しない。
- `bidiReadPublishResponse` の PUBLISH_OK 処理 (`src/session/bidi.ts` の REQUEST_OK ケース) は、`extractForwardState(decoded.parameters)` を FORWARD の有無に関わらず無条件に `pending.impl.setForwardState(...)` へ反映している。
- その結果: アプリが `publish({ forward: false })` を指定しても、対向が FORWARD 省略の PUBLISH_OK を返すと、アプリの Publisher の `forwardState` は true になる (アプリが送信停止状態から送信再開状態へ誤って遷移する。0416 で修正した受信 REQUEST_UPDATE 経路と同構図ただし 0416 は「アプリが事前に false を設定した場合」を想定しており、本 issue は「初期値設定がそもそも動かない」点が異なる)。
- 対照: subscribe 側 (`src/session.ts` の SUBSCRIBE 送信) は `options.forward` をローカルの SubscriberImpl に反映している (既存実装)。

## 設計方針

- PUBLISH_OK の FORWARD 反映を 0416 と同様に「FORWARD パラメータが存在する場合のみ反映」に変更するか、`publish()` の `options.forward` をローカル PublisherImpl の初期 forwardState に反映するか、両方を実装するかは実装時に確定する (確実なのは「初期値の反映」であり、PUBLISH_OK 側のガードは応答セマンティクスの解釈による)。§10.5 の原文を確認して解釈を確定すること。
- `publish({ forward: false })` の時に `options.forward` が undefined の場合 (省略) の挙動も決定する (現行の初期値 true を維持か、既定値を変えるか)。
- 変更対象: `src/session.ts` (`publish()` / `createPublisher` 相当)、`src/session/bidi.ts` (bidiReadPublishResponse の FORWARD 反映)、`src/publisher.ts` (初期値)、該当テスト、`CHANGES.md`。

## 完了条件

- `publish({ forward: false })` を行った後、対向が FORWARD 省略の PUBLISH_OK を返しても、Publisher の `forwardState` が false のままであること (上書きされない)。
- `publish({ forward: true })` (または省略) の既存挙動が変わらないこと (回帰ガード)。
- 対向が FORWARD を含む PUBLISH_OK を返した場合は従来どおり反映されること。
- 上記を検証するテストがあること。
- `CHANGES.md` の `## develop` に `[FIX]` があること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- draft-ietf-moq-transport-19 §10.2.17 (FORWARD Parameter / 省略時の挙動)
- draft-ietf-moq-transport-19 §10.5 (REQUEST_OK / initiator の初期 Forward State)
- 関連: `issues/closed/0416-bug-publish-forward-omitted-overwrite.md` (受信 REQUEST_UPDATE の FORWARD 反映。本 issue は PUBLISH_OK 経路と初期値)
