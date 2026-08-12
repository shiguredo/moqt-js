# 受信側の FORWARD パラメータが SubscriberImpl の Forward State に反映されない

- Priority: Low
- Created: 2026-08-06
- Completed: 2026-08-12
- Model: DeepSeek V4 Flash
- Branch: feature/fix-moqt-draft-19-publish-forward-param-not-applied
- Polished: 2026-08-12

## 目的

draft-ietf-moq-transport-19 §10.2.17 (FORWARD Parameter) に従い、Forward State を SubscriberImpl に反映する。現在は値域検証のみで、Forward State がサブスクライバ側の状態管理に反映されていない。反映経路は次の 4 つ (初期値 2 経路 + 更新 2 経路):

1. SUBSCRIBE 送信時: `subscribe()` の `options.forward` で初期化
2. 受信 PUBLISH: PUBLISH の FORWARD パラメータで初期化
3. ケース 1 の REQUEST_UPDATE: 受信 PUBLISH ストリーム上でピア (publisher) が送る REQUEST_UPDATE の FORWARD で更新
4. 自 update() の REQUEST_OK: `subscriber.update({ forward })` が REQUEST_OK になった時点で更新

## 優先度根拠

draft-ietf-moq-transport-19 §5.1 は「The publisher does not send Objects if the Forward State is 0」と定める。受信 PUBLISH の FORWARD=0 は「オブジェクトを送信しない」ことの宣言であり、これをサブスクライバ側で保持しないと forward 状態遷移 (0→1) を正しく反映できない。また FORWARD を含む REQUEST_UPDATE を NOT_SUPPORTED で拒否する現状は、仕様準拠ピアの forward 状態更新を扱えない。ただし moqt-js はクライアント実装であり、受信側の状態管理に留まるため実害は限定的。Low。

## 現状

- `handleIncomingBidirectionalStream` (`src/session.ts`) で受信 PUBLISH のパラメータは `PUBLISH_ALLOWED_PARAMS` によるスコープ検証 (validateParameterScope 呼び出し) のみ行われ、FORWARD の値は `extractForwardState` 等で取り出されていない。
- `SubscriberImpl` (`src/subscriber.ts`) に Forward State を保持するフィールドがない (PublisherImpl には `forwardState` / `setForwardState` / `onForwardStateChange` が存在し、非対称)。`subscribe()` の `options.forward` は送信専用であり、SubscriberImpl には反映されない。
- `bidiHandlePublishRequestUpdate` (`src/session/bidi.ts`) は無限定 3 種のみ REQUEST_OK で受理し、文脈限定パラメータ (FORWARD 含む) を含む REQUEST_UPDATE は REQUEST_ERROR (NOT_SUPPORTED) で応答する (判定順序 (3))。
- `bidiHandleRequestUpdateOk` は REQUEST_OK 受信時に LARGEST_OBJECT のみを SubscriberImpl に反映する。
- 送信側では `bidiSendRequestUpdate` が `options.forward` を FORWARD パラメータとして送信済み (送信済み機能の受信側反映が未接続)。
- 変更対象ファイル: `src/subscriber.ts` (forwardState フィールド + 公開 API 追加)、`src/session.ts` (受信 PUBLISH での抽出・設定、subscribe() での初期値設定)、`src/session/bidi.ts` (ケース 1 の FORWARD 受理・反映、自 update() の OK 反映)、`src/message/parameterScope.ts` (`PUBLISH_REQUEST_UPDATE_OK_PARAMS` への FORWARD 追加と JSDoc 更新)、`src/session/bidi.test.ts` (テスト追加・既存テストのパラメータ置き換え)、`docs/LOW_LEVEL_API.md` (Subscriber の forwardState 行追加)、`CHANGES.md`。

## 設計方針

- **初期値の設定 (2 経路)**: `subscribe()` の `options.forward` (経路 1) と受信 PUBLISH の FORWARD パラメータ (経路 2) で SubscriberImpl の Forward State を初期化する。受信 PUBLISH は `extractForwardState` で抽出して設定する。値域検証 (0 / 1) は `decodeMessageParameter` 側で既に実施済みのため、受信側では抽出と設定のみ。FORWARD 省略時のデフォルト値は §10.2.17 に従い 1。
- **ケース 1 の REQUEST_UPDATE 受理と反映 (経路 3)**: FORWARD を NOT_SUPPORTED 対象から外し、`PUBLISH_REQUEST_UPDATE_OK_PARAMS` に FORWARD を追加して REQUEST_OK で受理する。`bidiHandlePublishRequestUpdate` の判定順序 (3) を改修し、FORWARD は REQUEST_OK 受理 + SubscriberImpl への反映を行う。判定順序 (3) のメッセージ単位の判定は維持し、FORWARD と他の文脈限定パラメータ (例: SUBSCRIBER_PRIORITY) が混合した REQUEST_UPDATE は引き続き NOT_SUPPORTED で全体拒否する (FORWARD の部分受理はしない)。反映は §10.9 / §10.2.17 のマージセマンティクス (REQUEST_UPDATE に無いパラメータは不変) に従い、FORWARD パラメータが存在する場合のみ行う (省略時は不変。既存の extractForwardState + setForwardState 無条件適用パターン (bidi.ts の受信 REQUEST_UPDATE 処理) は踏襲しない)。
  - 仕様上の位置付け: ケース 1 (受信 PUBLISH の publisher による REQUEST_UPDATE) での FORWARD は、§10.2.17 の「It MAY appear in ... REQUEST_UPDATE (for a subscription) ...」の列挙に含まれる。「for a subscription」は subscription 向け REQUEST_UPDATE の区別であり送信者を限定しない。§5.1 の「The subscriber can send PUBLISH_OK or REQUEST_UPDATE to update the Forward State.」は subscriber への許可であり、publisher 発を禁止しない。§10.9 ケース 1 がリクエスト送信者 (PUBLISH の publisher) による REQUEST_UPDATE を明示的に許可しているため、受理側で FORWARD 受理を確定する (0373 が「曖昧」とした点への回答)。
  - 同一の「for a subscription」修飾子を持つ他 3 種 (SUBSCRIBER_PRIORITY (§10.2.7) / LOCATION_FILTER (§10.2.9) / NEW_GROUP_REQUEST (§10.2.18)) は NOT_SUPPORTED を維持する。理由は本 issue の目的が Forward State の状態保持にあり、他 3 種は反映先の状態管理がスコープ外であるため。これは 0373 の残余リスク (1)(a) が 4 種を同一グループとして扱った判断のうち FORWARD のみを受理側に確定するもので、他 3 種の NOT_SUPPORTED 維持とは矛盾しない。
- **自 update() の OK 反映 (経路 4)**: サブスクライバ自身が `subscriber.update({ forward })` で送信した REQUEST_UPDATE が REQUEST_OK になった時点で SubscriberImpl の Forward State に反映する (pendingRequestUpdate のエントリに送信時の forward 値を保持し、`bidiHandleRequestUpdateOk` で反映)。送信時 forward 値が undefined (REQUEST_UPDATE に FORWARD を含めない) の場合は反映しない (不変)。REQUEST_ERROR 受信時 (coalescing による一括 reject を含む) も反映しない (不変)。
- **公開 API**: `Subscriber` インターフェースに `readonly forwardState: boolean` を追加する (Publisher と対称)。この値は SUBSCRIBE 送信時の宣言値 (経路 1) と自 REQUEST_UPDATE の REQUEST_OK 確認値 (経路 4) を反映したものであり、Publisher.forwardState (ピアの PUBLISH_OK 確認値) と意味論が異なる点を JSDoc に明記する。アプリケーションへの変化通知コールバック (onForwardStateChange 相当) は追加しない (必要になったら別 issue の対応とする)。受信 PUBLISH から生成される SubscriberImpl はアプリに公開されない (onPublish は SubscribeCallbacks のみを返す) ため、経路 2・3 の状態は internal-only であり、テストでのみ検証する (アプリからの観測は subscribe() 経由のみ)。
- **既存テストの調整**: `src/session/bidi.test.ts` の「文脈限定パラメータ → NOT_SUPPORTED」テスト 2 件 (FORWARD 単独と AUTHORIZATION_TOKEN + FORWARD の混合) と該当テストの直前の JSDoc は FORWARD を例に使用しているため、FORWARD を NOT_SUPPORTED の例から外す実装に伴い、例を他の文脈限定パラメータ (例: SUBSCRIBER_PRIORITY) に置き換えて NOT_SUPPORTED のカバレッジを維持する。ケース 1 の FORWARD 受理・反映と自 update() の OK 反映のテストは 0373 と同じ実 W3C ストリーム注入方式で追加する。経路 1・2 の配線 (subscribe() と handleIncomingBidirectionalStream 内の設定) は private メソッド内のため自動テスト対象外とし、SubscriberImpl の setter 単体テストとコードレビューで担保する (0373 の残余リスク (4) と同じ扱い)。
- **実装時に陳腐化する既存コメント**: `bidiHandlePublishRequestUpdate` の JSDoc (「moqt-js は受信 PUBLISH のパラメータを状態として保持しない ... accept-then-ignore の意味論乖離が残る」) と判定順序 (3) のコメント (FORWARD を NOT_SUPPORTED 列挙に含む)、`PUBLISH_REQUEST_UPDATE_OK_PARAMS` の JSDoc (FORWARD を NOT_SUPPORTED 対象とする記述) は本 issue の実装で陳腐化するため、反映対象外パラメータのみの記述に改める。
- **スコープ外の明記**: (a) 受信 PUBLISH への応答 PUBLISH_OK は現状どおり空 parameters で送信する (FORWARD=0 のエコーはしない。エコーは別 issue の対応とする)。§10.2.17 により FORWARD 省略の PUBLISH_OK はデフォルト 1 として扱われ、保持した FORWARD=0 は「publisher が宣言した初期 Forward State の記録」であり、応答時点の subscription の Forward State (1) とは乖離し得る (残余リスクとして記録)。(b) 既存の role=publish ハンドラ (bidi.ts の PublisherImpl への FORWARD 反映) の同種の無条件適用パターンは本 issue では修正しない (別 issue の対応とする)。

## 完了条件

- `subscribe()` の `options.forward` と受信 PUBLISH の FORWARD パラメータが SubscriberImpl の Forward State に反映されること (いずれも省略時はデフォルト 1)。
- 受信 PUBLISH ストリーム上の REQUEST_UPDATE に FORWARD が含まれる場合、REQUEST_OK で受理され、SubscriberImpl の Forward State に反映されること (FORWARD 省略時は不変)。
- サブスクライバ自身の `subscriber.update({ forward })` の REQUEST_OK 受信時に SubscriberImpl の Forward State が反映されること。
- 上記を検証するテストがあること (既存の NOT_SUPPORTED テスト 2 件のパラメータ置き換えと JSDoc 更新を含む。経路 1・2 の配線は private メソッド内のためコードレビューで担保する)。
- 公開 API は `Subscriber.forwardState` (readonly) の追加のみ。
- `CHANGES.md` の `## develop` に `[FIX]` があること (0373 のエントリで FORWARD が NOT_SUPPORTED 対象として記載された部分の修正を含む)。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- draft-ietf-moq-transport-19 §5.1 (Subscriptions / Forward State の初期値設定と更新主体)
- draft-ietf-moq-transport-19 §10.2.17 (FORWARD Parameter / MAY appear / 値域外は PROTOCOL_VIOLATION / REQUEST_UPDATE で省略時は不変 / それ以外で省略時はデフォルト 1)
- draft-ietf-moq-transport-19 §10.9 (REQUEST_UPDATE / ケース 1 / MUST respond / マージセマンティクス)
- draft-ietf-moq-transport-19 §10.19.1 (Parameters on SUBSCRIBE_TRACKS / FORWARD=0 の SUBSCRIBE_TRACKS から生じる PUBLISH は FORWARD=0)
- 関連: `issues/closed/0373-moqt-draft-19-request-update-on-publish-stream-misdetected.md`（ケース 1 の FORWARD 受理と反映を本 issue に委譲した元）
- 関連: `issues/closed/0336-draft-19-subscribe-tracks-parameters.md`（空 PUBLISH_OK が Forward State を 1 に戻す問題を先送りした元）
- 関連: `issues/0388-moqt-draft-19-parameter-scope-unused-constants.md`（`PUBLISH_REQUEST_UPDATE_OK_PARAMS` の削除対象外注記。本 issue が FORWARD を追加するため、実装時に 0388 側の注記を更新すること）

## 解決方法

- `src/subscriber.ts`: `Subscriber` インターフェースに `readonly forwardState: boolean` を追加し、`SubscriberImpl` にフィールド・getter・`setForwardState` (internal) を実装した (初期値はデフォルト 1)
- `src/session.ts`: `subscribe()` で `options.forward` (省略時 1) を設定 (経路 1)、`handleIncomingBidirectionalStream` で受信 PUBLISH の FORWARD を `extractForwardState` で抽出して設定 (経路 2)
- `src/session/bidi.ts`: `bidiHandlePublishRequestUpdate` の判定順序 (3) を改修し、FORWARD は REQUEST_OK で受理して受信 PUBLISH 由来の SubscriberImpl に反映 (経路 3、FORWARD 省略時は不変)。`bidiSendRequestUpdate` で送信時の FORWARD 値を pendingRequestUpdate エントリに保持し、`bidiHandleRequestUpdateOk` の REQUEST_OK 受信時に反映 (経路 4)。`resolvePendingRequestUpdate` が解決エントリの FORWARD 値を返すよう変更
- `src/message/parameterScope.ts`: `PUBLISH_REQUEST_UPDATE_OK_PARAMS` に FORWARD を追加 (計 4 種) し、JSDoc を更新 (FORWARD が「for a subscription」限定ながら受理対象である旨を理由そのもので記述)
- `docs/LOW_LEVEL_API.md`: Subscriber テーブルに forwardState 行を追加
- テスト: `src/session/bidi.test.ts` にケース 1 の FORWARD 受理・反映 (0/1・省略時不変・他文脈限定との混合拒否) と自 update の REQUEST_OK 反映 (false/true/省略時不変) を追加、既存 NOT_SUPPORTED テスト 2 件のパラメータを SUBSCRIBER_PRIORITY に置き換え。`src/subscriber.test.ts` に setForwardState 単体テストを追加
- `issues/0388` に「注記 (0377 実装時)」を追加し、`PUBLISH_REQUEST_UPDATE_OK_PARAMS` が 4 種になった旨を反映
- `CHANGES.md` の `## develop` に [FIX] を追記し、0373 エントリの FORWARD 列挙を修正
