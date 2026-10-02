# Forward State を paused subscription として扱う

- Created: 2026-10-02
- Completed: 2026-10-03
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

### 1. 用語の統一

概念用語 "Forward State" / "Forwarding State" (小文字の "forward state" を含む) を `src/` `devtools/` `docs/HIGH_LEVEL_API.md` `README.md` から無くし、「subscription が paused かどうか」の表現に統一した。値の対応は true (1) = paused でない / false (0) = paused である。

- 内部名 (`forwardState` / `setForwardState` / `onForwardStateChange`) と公開オプション (`forward`)、パラメータ名 (FORWARD) は v22 でも同じため維持した (シンボル名としての出現は残る)
- `devtools` の表示ラベルは "Forward State:" から "FORWARD:" に変えた (値は `1 (forwarding)` / `0 (not forwarding)` のまま。paused の真偽と値の向きが逆になるため、"Paused:" というラベルにはしなかった)
- `PublishOptions.forward` / `SubscribeOptions.forward` / `TracksUpdateOptions.forward` / `UpdateOptions.forward` の JSDoc を paused の表現に書き換え、「paused でも PUBLISH_DONE などの制御メッセージは送る」「初期状態は subscription の initiator が設定する」「SUBSCRIBE_TRACKS の REQUEST_UPDATE の FORWARD は prefix に一致する将来の subscription にのみ作用し、既存の subscription は変わらない」を明記した

### 2. 参照の更新

- 観点の節を v22 §3.1.1 (Pausing Subscriptions) / §9.20.18 (FORWARD Parameter) / §11.3.2 (Closing Subgroup Streams) に更新した
- 一時停止と関係しない記述 (STOP_SENDING による終了、PUBLISH_DONE、SUBSCRIBE_OK の応答規則、state の破棄) は §3.1 (Subscriptions) のままにするか、v22 の §3.1.2 (Subscription State Management) に直した (§3.1 を §3.1.1 に一括で寄せると誤帰属になるため)
- FORWARD が v21 §9.20.19 から v22 §9.20.18 に繰り上がったことに伴い、同じ行が引いている LARGEST OBJECT (§9.20.18 → §9.20.17) / GROUP ORDER (§9.20.9 → §9.20.8) / LOCATION FILTER (§9.20.10 → §9.20.9) / FILL_PARAMETERS (§9.20.16 → §9.20.15) / INCLUDE_PROPERTIES (§9.20.22 → §9.20.21) / TRACK_NAMESPACE_PREFIX (§9.20.21 → §9.20.20) / EXPIRES (§9.20.17 → §9.20.16) も v22 の番号に直した (同じ行で v21 と v22 の番号が混ざらないようにするため。§9.20 全体の棚卸しは 0803 の担当)
- 逐語引用は v22 の原文に合わせて直した (「The publisher does not send Objects on a paused subscription」「FILL_PARAMETERS carried while the subscription is paused opens no fill fetch stream.」「Omitting a Subgroup Object because the subscription is paused」「reports whether the subscription is paused at the publisher」など)。v21 の文面をそのまま残した箇所は版表記も v21 のままにした (呼称の更新は 0802 の担当)
- `c4m` の RFC 8392 / draft-ietf-moq-c4m-01 §3.1.1 参照は本 issue と無関係のため触れていない (誤って変更しないよう確認した)

### 3. 挙動

差分はコメント・devtools の表示・ドキュメントのみで、実行されるコードは変更していない。paused 中に Object / Datagram を送らず PUBLISH_DONE を送ること、FORWARD 省略時は不変であること、値域外は PROTOCOL_VIOLATION になることは既存テストで固定されている (`vp test run` で不変を確認)。

### 4. 検証

`vp check` (1284 files 整形 / 475 files lint・型エラーなし) / `tsc --noEmit` / `vp test run` (198 files / 3569 tests) が通る。`/review-diff-code` を 3 周回し、指摘はすべて反映した。CHANGES.md の `## develop` の `### misc` に [UPDATE] エントリを追加した。
