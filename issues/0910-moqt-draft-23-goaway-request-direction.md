# 受信 PUBLISH の要求受信者に届いた GOAWAY を拒否する

- Created: 2026-11-03
- Completed: 2026-11-04
- Branch: feature/change-moqt-draft-23
- Polished: 2026-11-03

## 目的

draft 23 §9.2 は request stream の GOAWAY を元の要求の受信者だけが送れると明示した。クライアントが受信 PUBLISH に応答する側では、peer が GOAWAY を送ることは許されない。

## 現状

- `src/session/incomingPublish.ts` の `incomingPublishRunStreamSubLoop` は受信 PUBLISH の GOAWAY を受理し、callback 通知と pending 更新の reject、送信方向の FIN を行う
- ここでの moqt-js は subscriber だが、重要なのは元の PUBLISH の要求受信者である点である
- `src/session/bidi.ts` の `bidiHandleRequestStreamGoaway` は role を受け取らず共通処理するため、どの経路が要求送信者か確認が必要である

## 設計方針

- 元の要求送信者 / 受信者の区別で判定する。publisher / subscriber、クライアント / サーバーの区別で代用しない
- 受信 PUBLISH の後続 GOAWAY は §9.2 が指定する PROTOCOL_VIOLATION で Session を閉じ、移行 callback を呼ばない
- 自側が送信した PUBLISH / SUBSCRIBE / FETCH / TRACK_STATUS / namespace 要求への GOAWAY は引き続き受理する
- 重複 GOAWAY の新しい UNEXPECTED_MESSAGE は 0902 の分類と揃える。Session 制御ストリームの GOAWAY はこの方向制約の対象にしない
- 既存 0891 の高レベル通知配線は、合法な GOAWAY のみを通知する前提で依存関係を整理する

## 完了条件

- 受信 PUBLISH の要求受信者への GOAWAY が移行処理に入らず Session 終了になる
- 自側が開始した各要求への GOAWAY と Session GOAWAY は従来どおり処理される
- 「subscriber だから受理できる」という誤判定を防ぐテストがある

## 参照

- `refs/moq/draft-ietf-moq-transport-23.txt` §9.2
- `src/session/incomingPublish.ts` の `incomingPublishRunStreamSubLoop`
- `src/session/bidi.ts` の `bidiHandleRequestStreamGoaway`、`src/session/namespaceLoops.ts`
- `issues/closed/0891-add-high-level-goaway-migration.md`

## 解決方法

- 判定を「元の要求の送信者 / 受信者」の区別で行うようにした。publisher / subscriber やクライアント / サーバーでの代用はしていない。
- `src/session/incomingPublish.ts` の受信 PUBLISH サブループで GOAWAY を受けた場合、移行受理ではなく draft-23 §9.2 の方向制約違反として PROTOCOL_VIOLATION でセッションを閉じるようにした。移行 callback の通知、送信方向の FIN、未応答 REQUEST_UPDATE の GOING_AWAY reject は行わない。旧 `goawayReceived` 状態とその抑止分岐、不要になった import・interface フィールドを削除した。
- 自側が送信した PUBLISH / SUBSCRIBE / FETCH / TRACK_STATUS / namespace 要求への request stream GOAWAY は従来どおり受理する。重複 GOAWAY は UNEXPECTED_MESSAGE のまま。Session 制御ストリームの GOAWAY はこの方向制約の対象外である。
- `src/session/bidi.ts` の `bidiHandleRequestStreamGoaway` の JSDoc に、自側が要求送信者のストリームからのみ呼ぶこと、受信 PUBLISH など要求受信者側では PROTOCOL_VIOLATION になることを明記した。
- 高レベル通知は、合法な GOAWAY のみを通知する前提に整理された (既存の配線は変更不要)。
- テストは受信 PUBLISH 上の GOAWAY が PROTOCOL_VIOLATION でセッションを閉じ goaway callback を呼ばないこと、自側送信要求への GOAWAY が受理されること、重複 GOAWAY が UNEXPECTED_MESSAGE になることを検証する。旧・移行受理前提の 4 テストは削除した。
- docs は 0925 で一括更新するため触っていない。

### 既知の制限

- 実リレー E2E は統合ブランチの制約 (ALPN は移行完了まで moqt-22) のため未実施である。
