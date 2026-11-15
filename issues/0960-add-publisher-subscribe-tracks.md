# publisher として SUBSCRIBE_TRACKS をフル実装する

- Created: 2026-11-15
- Completed: {YYYY-MM-DD}
- Branch: feature/add-publisher-subscribe-tracks
- Polished: {YYYY-MM-DD}

## 目的

moqt-js を publisher として使ったとき、リレーから送られる SUBSCRIBE_TRACKS を受理し、仕様どおりに PUBLISH と PUBLISH_SKIPPED を返せるようにする。

現状は、受信した双方向ストリームの先頭が SUBSCRIBE_TRACKS だと、未対応リクエストとして REQUEST_ERROR (NOT_SUPPORTED) を返して FIN している。このため、クラスター構成のリレーで publisher と subscriber を別ノードに置くと、SUBSCRIBE_TRACKS が publisher まで届いても PUBLISH が下流へ届かず、購読が確立しない。

制御面だけの最小対応 (REQUEST_OK を返して応答ストリームを維持する) では相互接続はできるが、publisher 側の仕様である「一致する Track の PUBLISH を返す」「PUBLISH_SKIPPED を返す」「購読ごとの状態を持つ」が欠けたままになる。本 issue ではこのデータ面まで実装する。

## 現状

- `src/session/incoming.ts` の `incomingClassifyFirstBidiMessage` は SUBSCRIBE_TRACKS を `"unsupported-request"` に分類し、`incomingHandleFirstBidiMessage` は REQUEST_ERROR (NOT_SUPPORTED) を返して応答方向を FIN している。
- `src/session/incomingPublish.ts` の `incomingPublishStartBidiStreamLoop` / `incomingPublishHandleBidirectionalStream` は、受信 PUBLISH を subscriber として処理する経路だけを持つ。publisher として SUBSCRIBE_TRACKS を受ける経路は無い。
- `src/message/namespace.ts` の `decodeSubscribeTracksPayload` / `encodeSubscribeTracksPayload` と、`src/message/parameter/messageParameter.ts` の SUBSCRIBE_TRACKS_ID の codec は存在する。ただし publisher の PUBLISH 送信経路は SUBSCRIBE_TRACKS_ID を載せていない。
- `src/createMediaPublisher.ts` の `announceNamespace` は PUBLISH_NAMESPACE を送れるが、受信 SUBSCRIBE_TRACKS の受理や PUBLISH の返却は行わない。
- `src/session/bidi.ts` の `session.publishers` は `PublisherImpl` を Request ID で保持する。namespace prefix から公開済み Track を引く registry は無い。
- 受信 SUBSCRIBE_TRACKS を認可・受理する公開 API やコールバックは無い。
- `src/publisher.ts` の `PublisherImpl` は、1 つの PUBLISH と Track Alias を前提にしている。同じ Track を複数の PUBLISH subscription で配信する状態を持っていない。
- 同じ Track に複数の PUBLISH subscription ができた場合の Object の fan-out と、購読ごとの PAUSED / filters の評価が未実装である。
- リレーが publisher の既存 PUBLISH を下流 SUBSCRIBE_TRACKS へブリッジする構成では、publisher が同じ Track の PUBLISH をもう 1 本送ると重複として扱われる可能性がある。既存 PUBLISH を再利用するか、常に新しい PUBLISH を送るかの方針が必要である。

## 仕様根拠

- draft-ietf-moq-transport-23 §3.6 (Subscribing to Tracks by Prefix)
  - publisher は REQUEST_OK または REQUEST_ERROR を応答側で返す。
  - 成功した場合、publisher は一致する Track の PUBLISH を新しい双方向ストリームで送る。
  - 各 PUBLISH には SUBSCRIBE_TRACKS_ID を載せ、元の SUBSCRIBE_TRACKS の Request ID を示す。
  - 同じ Track が複数の SUBSCRIBE_TRACKS に一致した場合、publisher は要求ごとに PUBLISH を送る。
  - publisher は購読者がその namespace の購読を認可されていることを確認する (MUST)。
- draft-ietf-moq-transport-23 §9.17 (SUBSCRIBE_TRACKS)
  - メッセージ形式と、SUBSCRIBE_TRACKS で許可される parameter を定める。
- draft-ietf-moq-transport-23 §9.19.21 (SUBSCRIBE_TRACKS_ID Parameter)
  - SUBSCRIBE_TRACKS_ID は、SUBSCRIBE_TRACKS の結果として送る PUBLISH にだけ載せ、値はその SUBSCRIBE_TRACKS の Request ID とする。
- draft-ietf-moq-transport-23 §9.18 (PUBLISH_SKIPPED)
  - 双方向ストリームなどの都合で PUBLISH を送れない場合、publisher は SUBSCRIBE_TRACKS の応答ストリームへ PUBLISH_SKIPPED を送る。
  - PUBLISH_SKIPPED を送った Track には、その PUBLISH の間は PUBLISH を送ってはならない (MUST NOT)。
- draft-ietf-moq-transport-23 §9.5 (REQUEST_UPDATE)
  - SUBSCRIBE_TRACKS の REQUEST_UPDATE で更新できるのは AUTHORIZATION_TOKEN、PAUSED、TRACK_PROPERTY_FILTER、TRACK_NAMESPACE_PREFIX。
  - receiver は REQUEST_UPDATE ごとに REQUEST_UPDATE_OK または REQUEST_UPDATE_ERROR を 1 つ返し、受信順を守る。
- draft-ietf-moq-transport-23 §9.5.2 (Updating Namespace Subscriptions)
  - prefix の更新は既存の購読に影響しない。
  - 同じ SUBSCRIBE_TRACKS で既に PUBLISH した Track を再 PUBLISH してはならない (MUST NOT)。
- draft-ietf-moq-transport-23 §6.4.2.3 (Request Cancellation and Rejection)
  - SUBSCRIBE_TRACKS の取消は RESET_STREAM / STOP_SENDING で行う。
  - 取消は既存の購読に影響しない。
- draft-ietf-moq-transport-23 §7.7 (Publisher Interactions)
  - namespace subscription を自分へルーティングしてほしい publisher は PUBLISH_NAMESPACE を明示的に送る (MUST)。
  - リレーが PUBLISH を受けたときに下流 SUBSCRIBE_TRACKS へ PUBLISH を送る MUST はリレー側の責務であり、本 issue の publisher 側実装とは別である。

## 設計方針

### 1. 受信分類とハンドラ

- `incomingClassifyFirstBidiMessage` に `"subscribe-tracks"` を追加し、SUBSCRIBE_TRACKS を対応メッセージとして扱う。
- `incomingHandleFirstBidiMessage` は SUBSCRIBE_TRACKS を新しいハンドラへディスパッチする。
- Request ID のパリティ (server 発の奇数) と重複を `incomingValidateRequestId` で検証する。
- 予約 namespace は DOES_NOT_EXIST で拒否する。既存の受信 PUBLISH と同じ判定を使う。
- メッセージのデコードは `decodeSubscribeTracksPayload` を使う。切詰め・trailing data は MALFORMED_MESSAGE としてセッションを閉じる。

### 2. 受信購読の状態

`SessionImpl` に受信 SUBSCRIBE_TRACKS 用の registry を追加する。キーは Request ID。

保持するもの:

- Request ID
- Track Namespace Prefix
- 応答ストリームの writer と control reader
- 受理した parameter (PAUSED、TRACK_PROPERTY_FILTER、Range Filters、AUTHORIZATION_TOKEN)
- 状態 (active / closed)
- この要求から PUBLISH 済みの Full Track Name の集合
- PUBLISH_SKIPPED を送った Full Track Name の集合
- 未応答 REQUEST_UPDATE 数

既存の `TracksSubscriptionState` は送信側 (subscriber としての SUBSCRIBE_TRACKS) の状態である。受信側は別の型と Map を用意し、送信側と混ぜない。

セッション終了時は `src/session/lifecycle.ts` の後始末で、受信 SUBSCRIBE_TRACKS の writer / reader を閉じ、Map を clear する。

### 3. 応答

- 受理したら REQUEST_OK を応答側へ書く。Track Properties は空、Parameters も空でよい。
- 応答方向は FIN しない。REQUEST_UPDATE を同じストリームで受けるため、writer を保持する。
- 拒否する場合は REQUEST_ERROR を書いて FIN する。認可拒否は UNAUTHORIZED、未対応 parameter は INVALID_PARAMETER、予約 namespace は DOES_NOT_EXIST を使う。
- 応答の書き込みに失敗したら、購読を登録しない。

### 4. REQUEST_UPDATE の受信ループ

受理後、応答ストリームの readable を読み続ける。

- REQUEST_UPDATE を受けたら、許可 parameter を検証する。
  - AUTHORIZATION_TOKEN
  - PAUSED
  - TRACK_PROPERTY_FILTER
  - TRACK_NAMESPACE_PREFIX
- 未応答の REQUEST_UPDATE 数が上限を超えたら、§9.1.7 の MUST に従ってセッションを閉じる。
- 成功したら REQUEST_UPDATE_OK を 1 つ返す。失敗したら REQUEST_UPDATE_ERROR を 1 つ返す。受信順を守る。
- prefix の更新では、既に PUBLISH した Track を再 PUBLISH しない。新しい prefix に一致する今後の Track だけを対象にする。
- PAUSED は今後の PUBLISH に載せる。既に送った PUBLISH への反映が必要なら、PUBLISH 側の購読状態と整合させる。
- FIN / RESET_STREAM を受けたら購読を削除する。取消は既存の PUBLISH 購読を止めない。
- セッション終了・GOAWAY でも購読を後始末する。

### 5. 一致する Track の PUBLISH

受理時と、その後に公開された Track について、prefix に一致する Track へ PUBLISH を送る。

- 公開済み Track の registry を `PublisherImpl` とは別に持ち、Full Track Name と namespace prefix で引けるようにする。
- 新しい PUBLISH を送る場合は、新しい Request ID と Track Alias を採番し、SUBSCRIBE_TRACKS_ID に受信 SUBSCRIBE_TRACKS の Request ID を載せる。
- SUBSCRIBE_TRACKS の parameter のうち、PUBLISH に載せられるもの (PAUSED、LOCATION_FILTER、GROUP_ORDER、FILL_PARAMETERS、各種 timeout、SUBSCRIBER_PRIORITY、INCLUDE_PROPERTIES など) を引き継ぐ。
- PUBLISH の応答 (REQUEST_OK / REQUEST_ERROR) を待って購読を確立する。REQUEST_ERROR ならその Track の PUBLISH を失敗として記録する。
- PUBLISH_DONE / 取消で PUBLISH 状態を閉じる。
- 同じ Track が複数の SUBSCRIBE_TRACKS に一致した場合の扱いは 5.1 で決める。

#### 5.1 既存 PUBLISH の再利用と常に新規送信

publisher は、同じセッションへ同じ Track の PUBLISH を既に送っていることがある。SUBSCRIBE_TRACKS への応答として PUBLISH を送るとき、既存 PUBLISH を再利用するか、常に新しい PUBLISH を送るかを分けて考える。

用語:

- 既存 PUBLISH: publisher が同じセッションへ既に送っている PUBLISH。
- 新規 PUBLISH: 受信 SUBSCRIBE_TRACKS への応答として送る PUBLISH。
- 再利用: 既存 PUBLISH をその SUBSCRIBE_TRACKS の購読として扱い、新規 PUBLISH を送らない。
- 常に新規: SUBSCRIBE_TRACKS ごとに新規 PUBLISH を送る。

ケース:

1. SUBSCRIBE_TRACKS が Track の公開前に届く
   - Track の公開時に新規 PUBLISH を送る。SUBSCRIBE_TRACKS_ID を載せる。
2. Track の公開後に届き、同じセッションに active な PUBLISH がある
   - 再利用: 既存 PUBLISH をそのまま使う。新規 PUBLISH は送らない。
   - 常に新規: 同じ Track に対して 2 本目の PUBLISH を送る。
3. Track の公開後に届き、既存 PUBLISH が PUBLISH_DONE で終了している
   - Track がまだ配信中なら新規 PUBLISH を送る。
   - Track が終了しているなら PUBLISH_SKIPPED を返す。
4. 複数の SUBSCRIBE_TRACKS が同じ Track に一致する
   - 仕様は要求ごとに PUBLISH を送る。
   - 再利用は 1 本の既存 PUBLISH を複数の要求で共有することになる。
   - リレーが既存 PUBLISH を複数の下流 SUBSCRIBE_TRACKS へ fan-out できるなら 1 本で足りる。下流要求ごとに SUBSCRIBE_TRACKS_ID の対応が必要なら、2 本目以降は新規 PUBLISH を送る。
5. SUBSCRIBE_TRACKS の PAUSED / filters / INCLUDE_PROPERTIES が既存 PUBLISH と異なる
   - 再利用では、既存 PUBLISH の parameter がそのまま使われる。SUBSCRIBE_TRACKS の parameter を PUBLISH に載せ直せない。
   - リレーが下流の PUBLISH を組み立てるときに適用するなら再利用できる。publisher 側の PUBLISH に載せる必要があるなら新規 PUBLISH を送る。
6. 別セッションの直接 subscriber から届く
   - そのセッションに PUBLISH が無ければ新規 PUBLISH を送る。あれば再利用を検討する。

比較:

| 観点                     | 再利用                                                                                                     | 常に新規                                                 |
| ------------------------ | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| 仕様の文言との一致       | 既存 PUBLISH を SUBSCRIBE_TRACKS の PUBLISH とみなす解釈。既存 PUBLISH には SUBSCRIBE_TRACKS_ID が載らない | 文言どおり。SUBSCRIBE_TRACKS_ID を載せられる             |
| リレーとの重複           | 重複しにくい                                                                                               | 2 本目の PUBLISH が重複として拒否される可能性がある      |
| PAUSED / filters         | 既存 PUBLISH の値のまま。SUBSCRIBE_TRACKS の parameter を反映しにくい                                      | SUBSCRIBE_TRACKS の parameter を載せられる               |
| 複数の SUBSCRIBE_TRACKS  | 1 本の PUBLISH を共有する。下流要求の区別が難しい                                                          | 要求ごとに PUBLISH を送れる                              |
| 実装コスト               | 低い。既存の `PublisherImpl` を流用できる                                                                  | 高い。同じ Track を複数の PUBLISH で配信する仕組みが必要 |
| 既存のリレーとの相互接続 | 既存 PUBLISH をブリッジする構成と相性がよい                                                                | リレーが 2 本目を受理するか確認が必要                    |

決定:

- moqt-js の既定は、仕様どおり SUBSCRIBE_TRACKS ごとに新しい PUBLISH を送る。SUBSCRIBE_TRACKS_ID を載せる。既存 PUBLISH の再利用を既定にはしない。
- 既存 PUBLISH の再利用は RFC 準拠の動作ではないため、既定にも通常の相互接続モードにもしない。過去のリレーとの一時的な互換が必要になった場合だけ、明示的な opt-in として別 issue で扱う。
- リレーが既存 PUBLISH で下流 SUBSCRIBE_TRACKS を満たせるなら、上流 SUBSCRIBE_TRACKS を送らないのが RFC 準拠の設計である。§7.7 の下流 PUBLISH の MUST は既存 PUBLISH から満たせる。PAUSED は既存 PUBLISH の REQUEST_UPDATE で扱える。
- 未来の Track や namespace 単位の購読が必要で上流 SUBSCRIBE_TRACKS を送る場合は、publisher の PUBLISH 返却を前提にする。リレーは 2 本目の PUBLISH を正しく扱う。
- sora-moq の現行実装は上流 SUBSCRIBE_TRACKS を制御面として使い、publisher の PUBLISH 返却を期待しない。これは RFC 準拠の publisher と衝突するため、sora-moq 側で修正する。moqt-js はこの独自仕様に合わせない。

#### 5.2 複数 PUBLISH subscription の Object 配信

同じ Track が複数の SUBSCRIBE_TRACKS に一致すると、publisher は要求ごとに PUBLISH を送る。その結果、同じ Track に複数の PUBLISH subscription ができる。

- 各 PUBLISH subscription は、それぞれ Request ID、Track Alias、PAUSED、filters を持つ。
- publisher は、Object を各 subscription の条件に従って配信する。購読ごとの PAUSED と filters を評価し、対象の subscription へ送る。
- 仕様は同じ Track Alias の共有を許すが、購読ごとに PAUSED と filters が異なる場合、同じ Alias を共有すると配信条件の評価が複雑になる。実装では subscription ごとに別の Track Alias を割り当てる方針を既定にする。
- 別の Track Alias を使う場合、同じ Object を複数の Alias で送ることになる。帯域は増えるが、購読ごとの状態を分離できる。
- 既存の `PublisherImpl` をそのまま複数作るだけでは足りない。Track の Object ソースと、PUBLISH subscription ごとの配信状態を分ける層が必要になる。
- PUBLISH subscription の PUBLISH_DONE、取消、セッション終了では、その subscription の配信状態だけを閉じる。同じ Track の他の subscription は維持する。

### 6. PUBLISH_SKIPPED

- 双方向ストリームを開けない、または PUBLISH を送れない場合は、SUBSCRIBE_TRACKS の応答ストリームへ PUBLISH_SKIPPED を送る。
- Track Namespace Suffix は、受信 SUBSCRIBE_TRACKS の prefix を除いた部分にする。
- PUBLISH_SKIPPED を送った Track には、その PUBLISH の間は PUBLISH を送らない。
- PUBLISH_SKIPPED の記録は、新しい PUBLISH の受理、上流購読の終了、要求の破棄で消す。

### 7. 認可

- 受信 SUBSCRIBE_TRACKS を無条件に受理しない。
- 低レベル API に認可コールバックを追加する。候補は `ConnectCallbacks` または publisher 専用のコールバックで、prefix と parameter を受け取り、受理 / 拒否と理由を返す。
- `MediaPublisher` では、`announceNamespace` が有効なときに既存の publisher の Track と prefix を使って受理する。アプリが拒否できるようにする。
- AUTHORIZATION_TOKEN が設定されている場合は検証する。SETUP に載せたトークンとの関係も整理する。
- 認可拒否は REQUEST_ERROR (UNAUTHORIZED) で返し、セッションは閉じない。

### 8. エラー・デバッグ・統計

- SUBSCRIBE_TRACKS / REQUEST_UPDATE / PUBLISH / PUBLISH_SKIPPED の送受信を debug コールバックへ出す。
- 受信購読数、PUBLISH 送信数、PUBLISH_SKIPPED 数、再利用率を統計に出すか検討する。
- Request ID の重複・パリティ違反は INVALID_REQUEST_ID でセッションを閉じる。
- 不正な parameter は REQUEST_ERROR (INVALID_PARAMETER) で返す。
- Mandatory Track Property の未対応は、既存の方針に合わせて UNSUPPORTED_EXTENSION などで拒否する。

### 9. API とドキュメント

- 低レベル API の `ConnectCallbacks` または `Session` の publisher 向けオプションに、受信 SUBSCRIBE_TRACKS の受理コールバックを追加する。
- 高レベル API の `MediaPublisherOptions` に、受信 SUBSCRIBE_TRACKS を受理するかどうかの設定を追加する。`announceNamespace` との関係を明記する。
- `docs/LOW_LEVEL_API.md` / `docs/HIGH_LEVEL_API.md` / `docs/IMPLEMENTATION_STATUS.md` を更新する。
- ソースコードのコメントや docs に issue 番号を書かない。
- `CHANGES.md` は MOQT RFC ドラフト中のため更新しない。

### 10. 前提と未決事項

- PUBLISH_NAMESPACE は、クラスターの publisher-first 発見に必要である。高レベル API の `announceNamespace` は実装済みなので、E2E ではこれを有効にする。devtools の publisher が PUBLISH_NAMESPACE を送らない場合は、別途対応する。
- sora-moq の現行実装は、既存 PUBLISH がある publisher にも上流 SUBSCRIBE_TRACKS を送り、publisher の PUBLISH 返却を期待しない。これは RFC 準拠の publisher と衝突する。sora-moq 側で、既存 PUBLISH で下流を満たせるなら上流 SUBSCRIBE_TRACKS を送らない、または publisher の PUBLISH 返却を正しく扱う修正が必要である。この修正は sora-moq 側の issue として別途追跡する。
- moqt-js は sora-moq の独自仕様に合わせて既定動作を変えない。既定は RFC 準拠とし、E2E は sora-moq の修正後、または仕様準拠のテストピアで確認する。
- 直接 publisher-subscriber 接続で、既に PUBLISH していない Track に SUBSCRIBE_TRACKS が来た場合の PUBLISH 返却と Object 配信をどう扱うかを決める。

## 完了条件

- SUBSCRIBE_TRACKS を受信して REQUEST_OK を返し、応答ストリームを維持できる。
- 一致する公開済み Track と、その後に公開される Track に対して、仕様どおりの PUBLISH を送れる。SUBSCRIBE_TRACKS ごとに新しい PUBLISH を送り、既存 PUBLISH の再利用を既定にしない。
- PUBLISH に SUBSCRIBE_TRACKS_ID を載せ、受信側が要求を対応付けられる。
- 同じ Track に複数の SUBSCRIBE_TRACKS が一致した場合、要求ごとに PUBLISH を送り、購読ごとの PAUSED / filters を評価して Object を配信できる。Track Alias の共有 / 分離の方針を docs に残す。
- PUBLISH_SKIPPED を送る経路と、送った後の再 PUBLISH 禁止を実装する。
- REQUEST_UPDATE の PAUSED / prefix / Authorization Token / Track Property Filter を処理し、REQUEST_UPDATE_OK / REQUEST_UPDATE_ERROR を順序どおり返す。
- 取消、FIN、RESET_STREAM、セッション終了で購読を後始末する。
- 認可コールバックと、拒否時の REQUEST_ERROR を実装する。
- 単体テストで、受理・拒否・REQUEST_UPDATE・取消・PUBLISH_SKIPPED・重複 Request ID・不正 parameter を検証する。
- 別ノードの E2E で、publisher と subscriber を分け、SUBSCRIBE_TRACKS から PUBLISH と Object が届くこと、publisher の再接続後も届くことを確認する。E2E の接続先は環境変数から取得し、リポジトリに URI やホストを書かない。
- E2E は、sora-moq 側が RFC 準拠の publisher の PUBLISH 返却を扱えるようになった後、または仕様準拠のテストピアで通す。現行 sora-moq の独自仕様に合わせるための互換モードを既定にしない。
- 既存の xfail テストを外せる状態にする。外すのは実リレーで通ることを確認した後にする。
- `vp check`、`vp test --run`、`vp run e2e-test:relay` が通る。

## 参照

- `refs/moq/draft-ietf-moq-transport-23.txt` §3.6 / §6.4.2.3 / §7.7 / §9.5 / §9.5.2 / §9.17 / §9.18 / §9.19.21
- `src/session/incoming.ts` の `incomingClassifyFirstBidiMessage` / `incomingHandleFirstBidiMessage` / `incomingValidateRequestId`
- `src/session/incomingPublish.ts` の `incomingPublishStartBidiStreamLoop` / `incomingPublishHandleBidirectionalStream`
- `src/session/bidi.ts` の `BidiSessionInternal` / `PublisherImpl`
- `src/session/types.ts` の `TracksSubscriptionState`
- `src/session/lifecycle.ts` の `sessionMarkRequestObjectsClosed` / `sessionClose`
- `src/session/publicTypes.ts` の `ConnectCallbacks` / `TracksSubscriptionCallbacks`
- `src/message/namespace.ts` の `decodeSubscribeTracksPayload` / `encodeSubscribeTracksPayload`
- `src/message/parameter/messageParameter.ts` の SUBSCRIBE_TRACKS_ID
- `src/createMediaPublisher.ts` の `announceNamespace`
- 関連 issue: 0061 (サーバーからの双方向ストリーム受信の broader な issue。pending)、0317 (subscriber 側の PUBLISH 受信)、0817 (実リレーの E2E 追加)、0906 (namespace prefix 更新)、0930 (購読 error の通知)

## 解決方法

{未着手}
