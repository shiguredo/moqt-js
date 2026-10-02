# Forward State を paused subscription として扱う

- Created: 2026-10-02
- Completed: {YYYY-MM-DD}
- Branch: feature/update-paused-subscription-terminology
- Polished: 2026-10-02

## 目的

draft-ietf-moq-transport-22 §3.1.1 は Forward State という用語を使わず、「Established subscription は paused かそうでないか」として記述する。paused の間は publisher が Object を送らず、PUBLISH_DONE などの制御メッセージは paused に関係なく送る。FORWARD パラメータの意味は同じで、§9.20.18 は「affected subscriptions are paused」と書く。

- 初期状態は subscription の initiator が PUBLISH または SUBSCRIBE の FORWARD で設定する
- subscriber は REQUEST_UPDATE の FORWARD 0 で pause、FORWARD 1 で resume する
- SUBSCRIBE_TRACKS の REQUEST_UPDATE の FORWARD は、prefix に一致する将来の subscription にのみ作用し、既存 subscription には影響しない

moqt-js は "Forward State" の語で実装・コメントしており、用語と参照を更新する。挙動自体が v22 と整合することを確認する。

## 現状

- `src/publisher.ts` の `PublisherImpl` は `forwardState` / `setForwardState` / `onForwardStateChange` を持つ。paused 相当 (forwardState false) の間は `publishSendObject` / `publishSendDatagram` が送信せず、PUBLISH_DONE は送る (テストで固定済み)
- `src/subscriber.ts` の `SubscriberImpl` は `forwardState` / `setForwardState` を持ち、`update({ forward })` で REQUEST_UPDATE を送る
- `src/session/bidi.ts` は PUBLISH / SUBSCRIBE / REQUEST_UPDATE / PUBLISH_STATE_NOTIFY / 受信 PUBLISH の各経路で FORWARD を反映する。SUBSCRIBE_TRACKS の REQUEST_UPDATE では将来の subscription にのみ作用する
- 公開オプションは `PublishOptions.forward` / `SubscribeOptions.forward` / `TracksUpdateOptions.forward` など。パラメータ名 FORWARD に由来するため維持する
- `src/createMediaPublisher.ts` の `onForwardStateChange` は resume 時に音声設定を再送する
- 同じ用語は `devtools/` (例: `devtools/src/components/PublisherPanel.tsx` の「Forward State:」表示、`devtools/src/hooks/usePublisher.ts`) と `docs/HIGH_LEVEL_API.md` / `README.md` にもある (`docs/LOW_LEVEL_API.md` はシンボル名 `forwardState` の説明のみ)
- コメントは v21 §9.20.19 (FORWARD Parameter) / §3.1 (Subscriptions) / §11.3.2 (Closing Subgroup Streams) を参照している (例: `src/publisher.ts` の `guardSend` の JSDoc が §3.1 の本文を引用し、`sendObject` の見送りコメントが §11.3.2 の本文を引用)

## 設計方針

- 内部名 (`forwardState` / `setForwardState`) と公開オプション (`forward`) は維持し、JSDoc / コメントを「subscription が paused かどうか」の表現に書き換える。参照を v22 §3.1.1 / §9.20.18 / §11.3.2 に更新する
- 対象は `src/` と `devtools/` のコメント・表示、および `docs/HIGH_LEVEL_API.md` / `README.md` の該当記述とする (refs/ と CHANGES.md の過去履歴は対象外)。公開 API のシンボル名 (`forwardState` / `forward`) とパラメータ名 (`FORWARD`) は v22 でも同じであるため維持し、シンボル名・パラメータ名としての出現は残してよい
- 「制御メッセージは paused に関係なく送る」「初期状態は initiator が設定する」「SUBSCRIBE_TRACKS の REQUEST_UPDATE は将来の subscription にのみ作用する」をコメントに明記する
- 挙動のテスト (PUBLISH_DONE が paused 中も送られる、FORWARD 省略時は不変、値域外は PROTOCOL_VIOLATION) は維持する

## 完了条件

- `src/` と `devtools/` のコメント・表示、および `docs/HIGH_LEVEL_API.md` / `README.md` の該当記述に、概念用語としての "Forward State" / "Forwarding State" が残っておらず、参照が v22 (§3.1.1 / §9.20.18 / §11.3.2) になっている (refs/ と CHANGES.md の過去履歴、および API シンボル名 `forwardState` / `forward` とパラメータ名 `FORWARD` としての出現は対象外)
- 挙動変更が無いことを既存テストで確認する
- `vp check` / `tsc --noEmit` / `vp test run` が通る

## 参照

- draft-ietf-moq-transport-22 §3.1.1 (Pausing Subscriptions) / §9.20.18 (FORWARD Parameter) / §11.3.2 (Closing Subgroup Streams)
- `devtools/src/components/PublisherPanel.tsx` の「Forward State:」表示 / `docs/HIGH_LEVEL_API.md` / `README.md`
- `src/publisher.ts` の `setForwardState` / `guardSend`
- `src/subscriber.ts` の `setForwardState` / `update`
- `src/session/bidi.ts` の `applyPublishRequestUpdate` / `bidiHandlePublishStateNotify` / `bidiHandleRequestUpdateOk`
- `src/session/publish.ts` の `publishSendObject` / `publishSendDatagram`
- `src/session/params.ts` の `extractForwardState`
- `src/session/publicTypes.ts` の `PublishOptions.forward` / `SubscribeOptions.forward` / `TracksUpdateOptions.forward` / `PublishStateNotifyOptions.forward`
- `src/createMediaPublisher.ts` の `onForwardStateChange`

## 解決方法

{未着手}
