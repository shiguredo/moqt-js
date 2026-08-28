# PublishOptions / SubscribeOptions の deliveryTimeout doc コメントを実態に合わせて修正する

- Created: 2026-08-07
- Completed: 2026-08-28
- Branch: feature/fix-delivery-timeout-options-doc-comment
- Polished: 2026-08-20

## 目的

`PublishOptions.deliveryTimeout` と `SubscribeOptions.deliveryTimeout`（`src/session.ts`）の doc コメント「Publisher と Subscriber の両方が指定した場合、小さい方の値が使用される。」を、moqt-js の実態に合わせて修正する。moqt-js は SUBSCRIBE を受理（処理）しないクライアントライブラリであり、どちらの値も比較しない。比較と適用は、publisher 値と subscriber 値の両方を知るエンドポイント（典型的にはリレー）の責務である（§8「If both the publisher's value and the subscriber's value are non-zero, the smaller of the two is used.」）。現行コメントはネットワーク全体の挙動としては正しいが、moqt-js 自身が比較するかのような読まれ方をして誤解を招くため修正する。

## 現状

- `src/session.ts` の `PublishOptions.deliveryTimeout`（PublishOptions は publisher ロール）と `SubscribeOptions.deliveryTimeout`（SubscribeOptions は subscriber ロール）の doc コメントに、同一の文言「Publisher と Subscriber の両方が指定した場合、小さい方の値が使用される。」が記載されている。
- moqt-js の `handleIncomingBidirectionalStream()`（`src/session.ts`）は受信双方向ストリームの先頭メッセージを PUBLISH のみ受理し、SUBSCRIBE は `incomingClassifyFirstBidiMessage()`（`src/session/incoming.ts`）で unsupported-request に分類して REQUEST_ERROR (NOT_SUPPORTED) で拒否する。つまり moqt-js は subscriber 値を受信・保持する経路を持たず、publisher 側・subscriber 側のどちらでも値の比較は発生しない。
- なお moqt-js は現状 delivery timeout の強制（タイマー・ストリームリセット・データグラム破棄）を実装しておらず（0366 は未着手）、「タイムアウトを超過したオブジェクトは配信されない。」も現時点では moqt-js の挙動を表していない（0366 実装後に成立する記述）。

## 設計方針

- 両方の doc コメントを、大小比較の主体が moqt-js ではないことを明記する形に修正する。比較の仕組み（§8「両方が非ゼロなら小さい方の値が使用される」）自体は保持し、主体を「両方の値を知るエンドポイント（典型的にはリレー）」とする。
- 各オプションのロールに合わせて文面を書き分ける:
  - `PublishOptions.deliveryTimeout`（publisher ロール）: この値は PUBLISH の Track Property として送信される。moqt-js は subscriber 値を知らないため比較せず、比較・適用は両値を持つエンドポイント（リレー）の責務である旨を記述する。
  - `SubscribeOptions.deliveryTimeout`（subscriber ロール）: この値は SUBSCRIBE の Message Parameter として送信される。moqt-js はこの値の適用（強制）を行わず、比較・適用は両値を持つエンドポイント（リレー）の責務である旨を記述する。
- 「タイムアウトを超過したオブジェクトは配信されない。」は、現状 moqt-js が強制を実装していないため、その旨を注記して残す（強制実装後に成立する文であることを明記する）か、削除するかを完了条件で確定する。注記の内容には issue 番号を含めず、理由そのもの（強制未実装である旨）のみを書くこと（shiguredo-issues 規約「issue 番号・issue への言及をソースコードに持ち込まないこと」に従う）。
- 修正後の文言例（PublishOptions）: 「moqt-js は SUBSCRIBE を受理しないため subscriber 値との比較は行わない。比較と適用は publisher 値と subscriber 値の両方を持つエンドポイント（典型的にはリレー）の責務であり、両方が非ゼロの場合は小さい方の値が使用される。」
- 修正後の文言例（SubscribeOptions）: 「moqt-js はこの値を SUBSCRIBE の Message Parameter として送信する。比較と適用は publisher 値と subscriber 値の両方を持つエンドポイント（典型的にはリレー）の責務であり、両方が非ゼロの場合は小さい方の値が使用される。moqt-js 自身はこの値の適用（強制）を行わない。」

## 完了条件

- `PublishOptions.deliveryTimeout` の doc コメントが、比較の主体が moqt-js ではなく両値を持つエンドポイント（典型的にはリレー）である旨を明記した内容に修正されていること（§8 の「両方が非ゼロなら小さい方の値が使用される」を保持する）。
- `SubscribeOptions.deliveryTimeout` の doc コメントが、この値は SUBSCRIBE の Message Parameter として送信され、moqt-js は比較・適用を行わない旨を明記した内容に修正されていること。
- 「タイムアウトを超過したオブジェクトは配信されない。」の扱いが整理されていること（現状 moqt-js は強制を未実装である旨を注記して残す、または削除する。注記には issue 番号を含めない）。
- `CHANGES.md` の `## develop` に本修正の記載があること（doc コメント修正のため `### misc` サブセクションに記載する。`shiguredo-changelog` 参照）。
- `vp check` / `tsc --noEmit` / `vp test run` が通る。

## 参照

- draft-ietf-moq-transport-19 §8 (Delivery Timeouts and Data Reliability)（「If both the publisher's value and the subscriber's value are non-zero, the smaller of the two is used.」）
- draft-ietf-moq-transport-19 §10.2.4 (OBJECT_DELIVERY_TIMEOUT Parameter)
- 関連: `0366-add-delivery-timeout-enforcement.md`（Delivery Timeout の強制。本 issue はそこから分離された doc 修正）

## 解決方法

`src/session.ts` の `PublishOptions.deliveryTimeout` と `SubscribeOptions.deliveryTimeout` の doc コメントを、moqt-js が値の比較・強制を行わない実態に合わせて修正した。

- 両方の doc コメントを「moqt-js はこの値を … として送信するが、この値の強制は行わない。比較と強制は Publisher 値と Subscriber 値の両方を持つエンドポイント（典型的にはリレー）の責務であり、詳細は Section 8 (Delivery Timeouts and Data Reliability) を参照。」の対称構造に統一した。
- 旧文言「タイムアウトを超過したオブジェクトは配信されない。」は moqt-js が強制を実装していない現状と齟齬するため削除した (完了条件の「削除する」を採用)。
- `CHANGES.md` の `## develop` セクション内の既存 `### misc` サブセクションに `[UPDATE]` エントリを追加した (misc 内の順序 CHANGE → UPDATE を維持)。
