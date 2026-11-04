# SUBSCRIBE_TRACKS_ID で受信 PUBLISH を要求に正確に関連付ける

- Created: 2026-11-03
- Completed: 2026-11-04
- Branch: feature/change-moqt-draft-23
- Polished: 2026-11-03

## 目的

draft 23 §3.6 は重なる SUBSCRIBE_TRACKS を許容し、結果の PUBLISH に SUBSCRIBE_TRACKS_ID (0x36) を持たせた。現在は namespace prefix が最初に一致した要求を選ぶため、重なる要求の callback とフィルタを取り違える。

## 現状

- `src/message/types.ts` と `src/message/parameter/messageParameter.ts` に 0x36 が無い
- `src/message/parameterScope.ts` の `PUBLISH_ALLOWED_PARAMS` は新パラメータを拒否する
- `src/session/incomingPublish.ts` の `incomingPublishMatchToSubscription` は `tracksSubscriptions` を先頭から走査し、最初の prefix 一致で返す
- 同じ Full Track Name の複数購読は `subscribersByAlias` の配列で扱えるため、対応する要求ごとに独立した購読を生成する必要がある

## 設計方針

- 0x36 を PUBLISH 専用の vi64 パラメータとして定義し、元の SUBSCRIBE_TRACKS Request ID を保持する
- ID がある PUBLISH は該当要求だけを参照し、その prefix・状態・Track Property Filter・callback に結び付ける。無効な ID を別要求の prefix 検索で救済しない
- ID の無い unsolicited PUBLISH は区別し、既存の興味判定に従って扱う。ID が無いことだけをすべての PUBLISH の形式違反にしない
- 重なる 2 要求からの同じ Track の PUBLISH を独立に処理する。元の SUBSCRIBE_TRACKS の取消しや prefix 更新で、確立済みの個別購読を取消さない
- ID が未知 / 取消し済み、または指定先の現在の prefix と一致しない PUBLISH は、興味の無い要求として REQUEST_ERROR(UNINTERESTED) + FIN で拒否し、受信方向も cancel する。Session は閉じず、別要求や unsolicited の経路へ fallback しない
- callback 呼出し前と、非同期 onPublish の完了後から Subscriber / Alias / request stream の登録までの間に、指定先要求が有効で現在の prefix / Track Property Filter に一致することを再確認する。取消し済みなら callback の返した設定を使わず同じ拒否経路へ進み、Subscriber や関連付けを残さない。認証トークンの受信処理など、要求拒否前にも必要な既存の検証順序は維持する
- 元要求との独立性の境界は、最終確認後の個別 Subscriber と関連 Map の登録時点とする。以後の元要求の取消し・更新では個別購読を取消さず、PUBLISH_OK の書込み失敗や個別要求の終了では既存の cleanup で Subscriber / Alias / request stream を解放する

## 完了条件

- 0x36 の固定ワイヤと PUBLISH 以外での scope 違反を検証する
- 同じ prefix、包含関係の prefix、異なるフィルタを持つ要求へ正しい callback が届く
- 未知 / 取消し済み ID と prefix 不一致を別要求に誤配しない
- onPublish の待機中に元要求が取消された場合、UNINTERESTED 応答と両方向の終了処理が行われ、Map に個別購読が残らない。登録後の元要求取消しでは個別購読を維持する
- 同じ Track Alias の合法な複数購読と、異なる Track による Alias 重複違反を維持する

## 参照

- `refs/moq/draft-ietf-moq-transport-23.txt` §3.6 / §9.5.2 / §9.8 / §9.19.21
- `src/session/incomingPublish.ts` の `incomingPublishHandleBidirectionalStream` / `incomingPublishMatchToSubscription`
- `src/session/types.ts` の `TracksSubscriptionState`、`src/session/namespaces.ts`

## 解決方法

- `src/message/types.ts` に `SUBSCRIBE_TRACKS_ID` (0x36) を追加し、§9.19.21 の varint 値を持つ Message Parameter として `src/message/parameter/messageParameter.ts` の Value エンコーディングに登録した。`src/message/parameterScope.ts` の `PUBLISH_ALLOWED_PARAMS` に追加し、PUBLISH 専用であることを明記した。
- `src/session/incomingPublish.ts` で、PUBLISH に `SUBSCRIBE_TRACKS_ID` がある場合はその Request ID だけを参照して厳格に照合するようにした。未知・取消し済み・現在の prefix に一致しない ID は `REQUEST_ERROR(UNINTERESTED)` を返して両方向を終了し、別要求の prefix 検索や unsolicited 経路への fallback は行わない。ID の無い PUBLISH は従来どおり最初に prefix が一致する active 要求へ結び付ける。
- 非同期の `onPublish` 解決後にマッチャーを再実行し、同一要求であること・active であること・現在の prefix と TRACK_PROPERTY_FILTER に一致することを確認するようにした。不一致なら callback の設定を捨てて同じ UNINTERESTED 拒否経路へ進み、Subscriber / Alias / request stream を残さない。
- 再検証後は同期処理で Subscriber と各 Map へ登録するため、以後の元 SUBSCRIBE_TRACKS の取消しや prefix 更新で個別購読を取消さない。PUBLISH_OK 失敗や個別終了時は既存の cleanup で解放する。
- 既存の認証トークン処理・予約 namespace・Request ID・alias 重複検証の順序は変更していない。
- テストは 0x36 の固定ワイヤ (`01 36 11`) とラウンドトリップ、PUBLISH で許可され PUBLISH 以外で scope 違反になること、重なる prefix と同一 prefix + 異なるフィルタでの callback 選択、未知 / 取消し済み / prefix 不一致 ID の UNINTERESTED 拒否、`onPublish` 待機中の元要求取消し、登録後の元要求取消しで購読が維持されることを検証する。
- docs は 0925 で一括更新するため触っていない。

### 既知の制限

- ID の無い PUBLISH は従来の prefix ベースの興味判定に従う (issue の設計方針どおり)。
- 実リレー E2E は統合ブランチの制約 (ALPN は移行完了まで moqt-22) のため未実施である。
