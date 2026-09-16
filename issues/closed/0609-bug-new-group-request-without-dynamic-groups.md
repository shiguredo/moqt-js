# REQUEST_UPDATE の NEW_GROUP_REQUEST が DYNAMIC_GROUPS を検査しない

- Created: 2026-09-15
- Completed: 2026-09-17
- Branch: feature/fix-new-group-request-dynamic-groups
- Polished: 2026-09-15

## 目的

draft-ietf-moq-transport-21 §9.20.20 は、Track が DYNAMIC_GROUPS Property を値 1 で含まない限り REQUEST_UPDATE に NEW_GROUP_REQUEST を送ってはならない (MUST NOT) と定める。現状は公開 API から無条件に送信でき、SUBSCRIBE での送信 (適法) と更新経路での送信 (違法になりうる) が区別されていない。

## 現状

- `bidiSendRequestUpdate` (`src/session/bidi.ts`) は `options.newGroupRequest` について非負値検査と重複検査だけを行い、DYNAMIC_GROUPS の有無を検査せずに NEW_GROUP_REQUEST (0x32) を送る
- raw パラメータ経由の 0x32 も同様に検査されない (0x32 は `REQUEST_UPDATE_ALLOWED_PARAMS` (`src/message/parameterScope.ts`) に含まれるため `assertParametersAllowedForSend` を通過する)
- `SubscriberImpl` は `trackProperties` を保持しており、`supportsDynamicGroups` (`src/properties.ts`) で DYNAMIC_GROUPS=1 を判定できる
- 高レベル経路の `createMediaSubscriber` は `supportsDynamicGroups` を使って判定しているが、下位の公開 API (`Subscriber.update` の `RequestUpdateOptions`) では MUST が担保されない

draft-ietf-moq-transport-21 §9.20.20:

> A subscriber MUST NOT send this parameter in REQUEST_UPDATE if the Track did not include the DYNAMIC_GROUPS Property with value 1. A subscriber MAY include this parameter in SUBSCRIBE without foreknowledge of support.

## 設計方針

- `bidiSendRequestUpdate` で 0x32 を送る前に、型付きと raw の双方について `supportsDynamicGroups(subscriber.trackProperties)` を検査し、偽ならローカル API 誤用として拒否する
- SUBSCRIBE 経路は §9.20.20 が foreknowledge なしの送信を認めるため対象外とする
- DYNAMIC_GROUPS は Immutable Properties 配下にも置けるため、`supportsDynamicGroups` の二重検索をそのまま使う (§10.7 の MUST を再実装しない)

### 確定事項

- 例外型は汎用 `Error` とする。`InvalidFilterError` は使わない。同関数内の送信前ローカル拒否のうち、パラメータの種類と値の検査は汎用 `Error` を使っており (`assertParametersAllowedForSend` / `validateNonNegative` / 既存の NEW_GROUP_REQUEST 重複ガード / ピアの MAX_REQUEST_UPDATES 超過 / ピアの MAX_FILTER_RANGES が 0)、`InvalidFilterError` はフィルタのデコード失敗専用である。`ProtocolViolationError` は受信側のプロトコル違反通知であり送信側では使わない
- エラーメッセージは型付き経路と raw 経路で同一の 1 文言に固定する。`cannot send NEW_GROUP_REQUEST in REQUEST_UPDATE: track did not include DYNAMIC_GROUPS property with value 1` とする
- 検査は 1 箇所に置く。既存の NEW_GROUP_REQUEST 重複検査と `validateNonNegative` を含む 0x32 の組み立てブロックの直後で、`AUTHORIZATION_TOKEN` を積む前とする。型付き (`options.newGroupRequest !== undefined`) と raw (`options.parameters` 内の 0x32) の合算で 1 件以上あれば検査する。`pendingRequestUpdate.set` と `fillFetchTargets.set` より前に失敗させる既存方針 (登録後の throw はエントリ残留を生む) にそのまま乗る
- 判定は「値 1 の DYNAMIC_GROUPS を受けているか」で行い、`options.newGroupRequest` の値は見ない。§9.20.20 は値に依らずパラメータの送信自体を禁じており、値 0 も拒否対象である
- 既存の重複検査と `validateNonNegative` は変更しない。新しい検査は両者より後に走るため、重複または負値の入力では両者が先に throw し、既存のエラー契約が保たれる。このため `duplicate NEW_GROUP_REQUEST` と `must not be negative` を検証する既存テストは変更しない
- raw パラメータの値自体はエンコーダが varint として直列化するため、送信前の値検査は型付き経路と同じ `options.newGroupRequest` の非負値検査で足りる
- `MediaSubscriberImpl.requestKeyframe` (`src/createMediaSubscriber.ts`) の `supportsDynamicGroups` 検査は残す。下位の検査と同じ MUST を二重に担保する防御であり、公開 API のエラーを従来どおりの文言で先に返せる。検査の本体は下位 1 箇所であり、この分岐が MUST の根拠ではないことをコメントで示す
- 同じ関数の §9.20.20 引用コメントは "PUBLISH_OK or REQUEST_UPDATE" と書いているが、draft-21 の §9.20.20 は REQUEST_UPDATE のみを対象とし PUBLISH_OK には言及しない (0x32 は `PUBLISH_OK_ALLOWED_PARAMS` にも含まれない)。旧ドラフトの文言が残っているため、draft-21 の文言に合わせて直す

## 完了条件

- DYNAMIC_GROUPS=1 を受けていない購読で `update({ newGroupRequest })` が送信前に拒否される。汎用 `Error` を throw し、メッセージは上記の 1 文言とする。REQUEST_UPDATE は 1 バイトも書かれず、`pendingRequestUpdate` と `fillFetchTargets` にエントリが残らない
- DYNAMIC_GROUPS=1 を受けている購読では送信できる。mutable 側と Immutable Properties (0x0B) 配下のどちらに置かれていても送信できる
- DYNAMIC_GROUPS が値 0 の購読と、DYNAMIC_GROUPS を全く含まない購読の双方で拒否される
- SUBSCRIBE での送信は従来どおり可能
- raw パラメータ経由の 0x32 も同じ検査を受け、同じ文言で拒否される。型付きとの併用が重複として拒否される既存の挙動は変わらない
- 既存の `duplicate NEW_GROUP_REQUEST` と `must not be negative` のガードは変更されない
- DYNAMIC_GROUPS=1 を設定していない既存テストのうち、0x32 の送信成功を assert している `bidiResponseScopeViolation.test.ts` の `bidiSendRequestUpdate: newGroupRequest が NEW_GROUP_REQUEST としてエンコードされる` と `bidiSendRequestUpdate: newGroupRequest の 0 がエンコードされる` は、`SubscriberImpl.setTrackProperties` で DYNAMIC_GROUPS=1 を設定して通す。同ファイルの重複 2 件と負値 1 件のテストは変更せずに通る
- `MediaSubscriberImpl.requestKeyframe` の `supportsDynamicGroups` 検査は残し、同関数の §9.20.20 引用コメントは draft-21 の文言に合わせて直す
- テストがある
- `vp check` / `tsc --noEmit` / `vp test run` が通る

## 参照

- draft-ietf-moq-transport-21 §9.20.20 (NEW GROUP REQUEST Parameter)
- draft-ietf-moq-transport-21 §10.6 (DYNAMIC GROUPS)
- draft-ietf-moq-transport-21 §10.7 (Immutable Properties)

## 解決方法

`src/session/bidi.ts` の `bidiSendRequestUpdate` で、NEW_GROUP_REQUEST の組み立てブロックの直後 (AUTHORIZATION_TOKEN を積む前) に
draft-ietf-moq-transport-21 §9.20.20 の MUST NOT の検査を追加した。

- 型付き (`options.newGroupRequest !== undefined`) と raw (`options.parameters` 内の 0x32) の合算で 1 件以上ある場合に
  `supportsDynamicGroups(subscriber.trackProperties)` を検査し、偽なら汎用 `Error`
  (`cannot send NEW_GROUP_REQUEST in REQUEST_UPDATE: track did not include DYNAMIC_GROUPS property with value 1`) を throw する
- 値には依らず送信自体が禁止されるため、値 0 の NEW_GROUP_REQUEST も拒否する
- DYNAMIC_GROUPS は Immutable Properties (0x0B) 配下にも置けるため、§10.7 の二重検索を行う `supportsDynamicGroups` をそのまま使う
- SUBSCRIBE 経路 (`buildSubscribeParameters`) は §9.20.20 が foreknowledge なしの送信を認めるため変更していない
- 既存の重複検査と `validateNonNegative` はそのまま残し、新しい検査はその後に走るため既存のエラー契約は変わらない
- `src/createMediaSubscriber.ts` の `requestKeyframe` の検査は残し、MUST の本体は下位 1 箇所であることをコメントで明示した。
  あわせて §9.20.20 の引用が旧ドラフトの "PUBLISH_OK or REQUEST_UPDATE" になっていたため draft-21 の文言に直した

テストは `src/session/bidiSendRequestUpdateNewGroupRequest.test.ts` に 6 本追加した (DYNAMIC_GROUPS なし / 値 0 / raw の拒否、
mutable と Immutable Properties 配下の DYNAMIC_GROUPS=1 での送信、0x32 を含まない更新の送信)。
DYNAMIC_GROUPS を設定していなかった既存の 2 本 (`bidiResponseScopeViolation.test.ts` の newGroupRequest エンコード検証) は、
検査の対象外だったエンコード検証が目的のため DYNAMIC_GROUPS=1 を設定する形に更新した。

検証は `pnpm exec tsc --noEmit` / `pnpm exec vp check` / `pnpm test --run` (2256 passed) の通過で確認した。
