# README / docs の実装状況と API 記述を draft-19 実装に合わせて修正する

- Priority: Medium
- Created: 2026-08-06
- Completed: 2026-08-13
- Model: DeepSeek V4 Flash
- Branch: feature/update-moqt-draft-19-implementation-status
- Polished: 2026-08-12

## 目的

README.md の実装状況と docs/LOW_LEVEL_API.md の API 記述を、draft-19 対応済みの実装実態に合わせて修正する。GOAWAY の Request ID は draft-19 で削除済みだが README には「Request ID 対応」と残っており、LOW_LEVEL_API.md には実装に存在しない旧関数名・誤記が残っている。

## 優先度根拠

README は実装状況の一次情報源であり、draft-19 で削除された機能を「対応済み」と記載すると利用者を誤誘導する。LOW_LEVEL_API.md の旧関数名は実装を追う開発者を誤導する。Medium。

## 現状

- README.md の「コントロールメッセージ > GOAWAY」項目に「Request ID 対応」と記載。draft-19 §10.4 の GOAWAY Message に Request ID は存在せず (draft 変更履歴「Remove Request ID from GOAWAY」)、コードの `Goaway` 型 (`src/message/session.ts`) にも requestId は存在しない。
- docs/LOW_LEVEL_API.md の `Session` テーブルの `subscribeNamespace(namespacePrefix, callbacks, mode?)` と記載。実装の第 3 引数は `options?: { authorizationToken?: AuthorizationToken }` (`subscribeNamespace` の `options` パラメータ) であり、`mode` は実在しない (draft-18 で `subscribeOptions` が廃止されたことに由来する doc 側の誤記)。
- docs/LOW_LEVEL_API.md の「通常の request stream」節に `readRequestStreamMessages()` と記載。実装は `bidiReadRequestStreamMessages` (`src/session/bidi.ts`) に改名済み。同関数はパッケージの公開 API ではない (index.ts から未 re-export。ただしテストから import されるため export は維持される。0390 / 0397 の確定事項)。
- 同種の陳腐化が docs/LOW_LEVEL_API.md にさらに 4 箇所ある (本 issue で修正する):
  - 「通常の request stream」節の `readResponseFromBidiStream()` — 実装は `bidiReadResponseFromBidiStream`。
  - 「REQUEST_UPDATE」節の `sendJoiningFetch()` — 実装は `bidiSendJoiningFetch`。
  - 同節の `handleRequestUpdateOk()` — 実装は `bidiHandleRequestUpdateOk`。
  - 「先行到着への対応」節の `waitForSubscriber(trackAlias)` — ソースに存在しない。`PendingSubgroupBuffer` に置換済みの旧設計の記述。
- 変更対象ファイル: `README.md` / `docs/LOW_LEVEL_API.md` (コード変更なし)。

## 設計方針

- README.md の GOAWAY 項目から「Request ID 対応」を削除し、draft-19 の実装状況 (Timeout / リクエストストリーム上での受信) に合わせる。
- docs/LOW_LEVEL_API.md の `subscribeNamespace` の引数記述を `options?` に修正する。
- docs/LOW_LEVEL_API.md の旧関数名 (readRequestStreamMessages / readResponseFromBidiStream / sendJoiningFetch / handleRequestUpdateOk) を現行の関数名 (bidiReadRequestStreamMessages / bidiReadResponseFromBidiStream / bidiSendJoiningFetch / bidiHandleRequestUpdateOk) に修正する (内部実装フローの説明であり、削除すると情報が失われるため修正に確定)。
- docs/LOW_LEVEL_API.md の「先行到着への対応」節の `waitForSubscriber(trackAlias)` の記述を、現行の `PendingSubgroupBuffer` による pending mode の説明に修正する。

## 完了条件

- README.md の GOAWAY 項目から「Request ID 対応」が削除されていること。
- docs/LOW_LEVEL_API.md の `subscribeNamespace` の第 3 引数が `options?` と記載されていること。
- docs/LOW_LEVEL_API.md の旧関数名 4 箇所が現行の関数名に修正され、`waitForSubscriber` の記述が現行実装の説明に修正されていること。
- README.md と docs/LOW_LEVEL_API.md をコード実装と照合し、上記以外に実装と食い違う記述がないこと (照合対象: README.md の実装状況セクションと docs/LOW_LEVEL_API.md 全体)。

## 参照

- draft-ietf-moq-transport-19 §10.4 (GOAWAY / Request ID なし)
- draft-ietf-moq-transport-19 §10.18 (SUBSCRIBE_NAMESPACE)
- 関連: `issues/closed/0184-draft-18-change-split-subscribe-namespace.md`（`subscribeOptions` 廃止の元。`mode` 誤記の由来）
- 関連: `0377-moqt-draft-19-publish-forward-param-not-applied.md`（同じ docs/LOW_LEVEL_API.md を変更対象とする (Subscriber の forwardState 行追加)。編集箇所は異なり実質的な衝突は起きにくいが、並行編集に注意）

## 解決方法

- `README.md` の GOAWAY 項目から「Request ID 対応」を削除した (draft-19 §10.4 に Request ID は存在しない)
- `docs/LOW_LEVEL_API.md` の `subscribeNamespace` の第 3 引数を `mode?` から `options?` に修正した
- `docs/LOW_LEVEL_API.md` の旧関数名 4 箇所を現行の関数名に修正した (`readRequestStreamMessages` → `bidiReadRequestStreamMessages` / `readResponseFromBidiStream` → `bidiReadResponseFromBidiStream` / `sendJoiningFetch` → `bidiSendJoiningFetch` / `handleRequestUpdateOk` → `bidiHandleRequestUpdateOk`)。レスポンス読み取り関数名 4 種も `bidi*` プレフィックスに統一した
- `docs/LOW_LEVEL_API.md` の「先行到着への対応」節の `waitForSubscriber(trackAlias)` の記述を、現行の `PendingSubgroupBuffer` による pending mode の説明に修正した
- コード実装との照合で見つかった食い違いも修正した:
  - `publishNamespace()` の送信経路を「制御ストリーム」から「専用双方向ストリーム」に修正
  - 制御ストリームで処理するメッセージを GOAWAY のみである旨に修正 (draft-19 §3.3)
  - `handleIncomingStream()` のストリーム種別判定に FIRST_OBJECT bit 付き Subgroup stream (`0x50-0x5F` / `0x70-0x7F`) と PADDING stream を追記
  - `Closed Subgroup Tracking` の TODO 記述を `closedSubgroups` Set による実装済みの説明に修正
  - 背景ループを 3 つから 4 つ (受信双方向ストリームループ追加) に修正
  - `SessionStatistics` に `pendingSubgroupStreamsCount` / `pendingSubgroupStreamsBytes` を追記
  - `ConnectOptions` 表に `pendingSubgroup` / `moqtImplementation` / `grease` を追記
  - `README.md` の Range Filters 送信経路に `fetch()` を追記
- `CHANGES.md` には記載しない (.md ファイルの変更は変更履歴に反映しない規約)
