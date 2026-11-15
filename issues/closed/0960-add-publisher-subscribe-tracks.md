# publisher として SUBSCRIBE_TRACKS をフル実装する

- Created: 2026-11-15
- Completed: 2026-11-15
- Branch: feature/add-publisher-subscribe-tracks
- Polished: 2026-11-15

## 目的

moqt-js を publisher として使ったとき、リレーなどの相手から送られる SUBSCRIBE_TRACKS を受理し、仕様どおりに PUBLISH と PUBLISH_SKIPPED を返せるようにする。

現状は、受信した双方向ストリームの先頭が SUBSCRIBE_TRACKS だと、未対応リクエストとして REQUEST_ERROR (NOT_SUPPORTED) を返して FIN している。このため、SUBSCRIBE_TRACKS で namespace を購読する相手には、moqt-js が公開している Track が PUBLISH として届かず、購読が確立しない。

制御面だけの最小対応 (REQUEST_OK を返して応答ストリームを維持する) では相互接続はできるが、publisher 側の仕様である「一致する Track の PUBLISH を返す」「PUBLISH_SKIPPED を返す」「購読ごとの状態を持つ」が欠けたままになる。本 issue ではこのデータ面まで実装する。

## 現状

- `src/session/incoming.ts` の `incomingClassifyFirstBidiMessage` は SUBSCRIBE_TRACKS を `"unsupported-request"` に分類し、`incomingHandleFirstBidiMessage` は REQUEST_ERROR (NOT_SUPPORTED) を返して応答方向を FIN している。
- `src/session/incomingPublish.ts` の `incomingPublishStartBidiStreamLoop` / `incomingPublishHandleBidirectionalStream` は、受信 PUBLISH を subscriber として処理する経路だけを持つ。publisher として SUBSCRIBE_TRACKS を受ける経路は無い。
- `src/message/namespace.ts` の `decodeSubscribeTracksPayload` / `encodeSubscribeTracksPayload` と、`src/message/parameter/messageParameter.ts` の SUBSCRIBE_TRACKS_ID の codec は存在する。ただし publisher の PUBLISH 送信経路は SUBSCRIBE_TRACKS_ID を載せていない。
- `src/createMediaPublisher.ts` の `announceNamespace` は PUBLISH_NAMESPACE を送れるが、受信 SUBSCRIBE_TRACKS の受理や PUBLISH の返却は行わない。
- `src/session/bidi.ts` の `BidiSessionInternal` は `publishers: Map<bigint, PublisherImpl>` を持ち、PUBLISH の状態を Request ID で保持する。Full Track Name から公開済み Track を引く registry は無い。
- 受信 SUBSCRIBE_TRACKS を認可・受理する公開 API やコールバックは無い。`ConnectCallbacks` は close / error / debug / goaway だけを持つ。
- `src/publisher.ts` の `PublisherImpl` は、1 つの PUBLISH と Track Alias を前提にしている。Track Namespace / Track Name も保持しない。同じ Track を複数の PUBLISH subscription で配信する状態を持っていない。
- 同じ Track に複数の PUBLISH subscription ができた場合の Object の fan-out と、購読ごとの PAUSED / filters の評価が未実装である。
- §3.6.2 は SUBSCRIBE_TRACKS の parameter のうち AUTHORIZATION_TOKEN と TRACK_PROPERTY_FILTER 以外を結果 PUBLISH に載せると述べ、§9.19.21 は結果 PUBLISH にだけ SUBSCRIBE_TRACKS_ID を載せると定める。既存の PUBLISH にはどちらも無いため、SUBSCRIBE_TRACKS への応答として PUBLISH を新しく送るか、既存 PUBLISH を再利用するかの方針が必要である。

## 仕様根拠

- draft-ietf-moq-transport-23 §1.5 (Response Message Naming)
  - SUBSCRIBE_TRACKS_OK / SUBSCRIBE_TRACKS_ERROR は、それぞれ REQUEST_OK / REQUEST_ERROR の別名である。
- draft-ietf-moq-transport-23 §3.6 (Subscribing to Tracks by Prefix)
  - publisher は REQUEST_OK または REQUEST_ERROR を応答側で返す。
  - 成功した場合、publisher は一致する Track の PUBLISH を新しい双方向ストリームで送る。
  - 各 PUBLISH には SUBSCRIBE_TRACKS_ID を載せ、元の SUBSCRIBE_TRACKS の Request ID を示す。
  - 同じ Track が複数の SUBSCRIBE_TRACKS に一致した場合、publisher は要求ごとに PUBLISH を送る。
  - publisher は購読者がその namespace の購読を認可されていることを確認する (MUST)。
  - Track Namespace Prefix が 0 フィールドの SUBSCRIBE_TRACKS は、publisher の全 Track の購読を意味する。
  - SUBSCRIBE_TRACKS の取消は、既存の購読に影響しない。
- draft-ietf-moq-transport-23 §6.4.2.2 (Graceful Request Stream Closure)
  - FIN は「その方向で以後メッセージを送らない」ことだけを意味し、要求の取消ではない。
  - REQUEST_UPDATE を送らない requester は、要求メッセージの直後に FIN してよい。
- draft-ietf-moq-transport-23 §6.4.2.3 (Request Cancellation and Rejection)
  - 取消は、自分の送信方向への RESET_STREAM と、自分の受信方向への STOP_SENDING で行う。
- draft-ietf-moq-transport-23 §3.6.1 (Filtering SUBSCRIBE_TRACKS) / §3.3.2 (Range Filters)
  - TRACK_PROPERTY_FILTER は namespace 内の Track を絞り込む。フィルタを通らない PUBLISH は送らず、Object も送らない。
  - Range Filters は、自 endpoint が SETUP で広告した MAX_FILTER_RANGES が 0 でない場合だけ使える。上限超過やフィルタの不正は REQUEST_ERROR (INVALID_FILTER) で拒否する (MUST)。
- draft-ietf-moq-transport-23 §9.17 (SUBSCRIBE_TRACKS)
  - メッセージ形式と、SUBSCRIBE_TRACKS で許可される parameter を定める。
- draft-ietf-moq-transport-23 §9.18 (PUBLISH_SKIPPED)
  - PUBLISH_SKIPPED のメッセージ形式と、Track Namespace Suffix の意味を定める。
- draft-ietf-moq-transport-23 §3.6.3 (Skipped Tracks)
  - 双方向ストリームを確保できないなど、購読を作れない場合は、SUBSCRIBE_TRACKS の応答ストリームへ PUBLISH_SKIPPED を送る。
  - PUBLISH_SKIPPED を送った Track には、その SUBSCRIBE_TRACKS について、以降 PUBLISH を送ってはならない (MUST NOT)。適用範囲は「scoped to a single PUBLISH」であり、新しい PUBLISH の公開単位になれば改めて送れる。
- draft-ietf-moq-transport-23 §9.19.21 (SUBSCRIBE_TRACKS_ID Parameter)
  - SUBSCRIBE_TRACKS_ID は、SUBSCRIBE_TRACKS の結果として送る PUBLISH にだけ載せ、値はその SUBSCRIBE_TRACKS の Request ID とする。
- draft-ietf-moq-transport-23 §9.8 (PUBLISH) / §3.6.2 (Parameters on SUBSCRIBE_TRACKS)
  - PUBLISH に載せられる parameter は、§9.8 の明示一覧 (OBJECT_DELIVERY_TIMEOUT、AUTHORIZATION_TOKEN、SUBGROUP_DELIVERY_TIMEOUT、EXPIRES、LARGEST_OBJECT、PAUSED、SUBSCRIBER_PRIORITY、LOCATION_FILTER、GROUP_ORDER、FILL_PARAMETERS、SUBSCRIBE_TRACKS_ID) に限る。
  - §3.6.2 は SUBSCRIBE_TRACKS の parameter のうち AUTHORIZATION_TOKEN と TRACK_PROPERTY_FILTER 以外を結果 PUBLISH に載せると述べるが、Range Filters と INCLUDE_PROPERTIES は §9.8 の一覧に無い。両節が衝突する場合は §9.8 の明示一覧を優先し、一般文だけを根拠に PUBLISH の許可集合を広げない (closed 0907 と同じ判断)。
- draft-ietf-moq-transport-23 §9.19.2 (AUTHORIZATION TOKEN Parameter)
  - AUTHORIZATION_TOKEN は、SUBSCRIBE_TRACKS から結果 PUBLISH の parameter へコピーしてはならない (MUST NOT)。
- draft-ietf-moq-transport-23 §9.19.22 (INCLUDE_PROPERTIES Parameter)
  - INCLUDE_PROPERTIES は PUBLISH の parameter ではない。SUBSCRIBE_TRACKS では、結果 PUBLISH が Track Properties を含むかどうかを決める。0 のときは Track Properties を空にする。
- draft-ietf-moq-transport-23 §9.19.1 (Parameter Scope)
  - メッセージ定義の許可一覧に無い parameter を受けた endpoint は、セッションを INVALID_PARAMETER で閉じる (MUST)。値域違反も parameter 定義の MUST に従う。
- draft-ietf-moq-transport-23 §9.5 (REQUEST_UPDATE)
  - SUBSCRIBE_TRACKS の REQUEST_UPDATE で更新できるのは AUTHORIZATION_TOKEN、PAUSED、TRACK_PROPERTY_FILTER、TRACK_NAMESPACE_PREFIX である。
  - receiver は REQUEST_UPDATE ごとに REQUEST_UPDATE_OK または REQUEST_UPDATE_ERROR を 1 つ返し、受信順を守る。
  - SUBSCRIBE_TRACKS の REQUEST_UPDATE が失敗した場合、responder は bidi ストリームを閉じる (MUST)。
- draft-ietf-moq-transport-23 §9.5.2 (Updating Namespace Subscriptions)
  - prefix の更新は既存の購読に影響しない。
  - 同じ SUBSCRIBE_TRACKS で既に PUBLISH した Track を再 PUBLISH してはならない (MUST NOT)。
- draft-ietf-moq-transport-23 §9.19.18 (PAUSED Parameter)
  - SUBSCRIBE_TRACKS の REQUEST_UPDATE の PAUSED は、以後に一致する購読だけに適用する。既存の購読は影響を受けない。
- draft-ietf-moq-transport-23 §9.1.7 (MAX_REQUEST_UPDATES)
  - 上限は自 endpoint が広告した値で、0 は無制限である。上限に達した状態でさらに REQUEST_UPDATE を受けたら、セッションを TOO_MANY_REQUEST_UPDATES で閉じる (MUST)。
- draft-ietf-moq-transport-23 §3.1 (Subscriptions) / §3.1.3 (Track Alias)
  - 同じ Track に複数の concurrent subscription を作れる。Object が複数の購読のフィルタに一致する場合、publisher は購読ごとに 1 回ずつ送る (MUST)。Track Alias は購読ごとに同じでも異なってもよい。
  - 別の Track に同じ Track Alias を使ってはならない。同じ Track の複数購読で Alias を共有すると、到着した Object がどちらの購読のものかを受信側が判別できない。
- draft-ietf-moq-transport-23 §7.7 (Publisher Interactions)
  - namespace への購読を自分へルーティングしてほしい publisher は、PUBLISH_NAMESPACE を明示的に送る (MUST)。
  - リレーが PUBLISH を受けたときに下流 SUBSCRIBE_TRACKS へ PUBLISH を送る MUST はリレー側の責務であり、本 issue の publisher 側実装とは別である。

## 設計方針

### 1. 受信分類とハンドラ

- `incomingClassifyFirstBidiMessage` に `"subscribe-tracks"` を追加し、SUBSCRIBE_TRACKS を対応メッセージとして扱う。
- `incomingHandleFirstBidiMessage` は SUBSCRIBE_TRACKS を新しいハンドラ `incomingSubscribeTracksHandleFirstMessage` へディスパッチする。
- Request ID のパリティ (server 発の奇数) と重複を `incomingValidateRequestId` で検証する。
- メッセージのデコードは `decodeSubscribeTracksPayload` を使う。切詰め・trailing data は MALFORMED_MESSAGE としてセッションを閉じる。
- parameter の許可一覧は、§9.17 の一覧に対応する SUBSCRIBE_TRACKS 用の集合として `src/message/parameterScope.ts` に追加し、既存の `validateParameterScope` で検証する。許可外 parameter・値域違反は、§9.19.1 の MUST に従ってセッションを INVALID_PARAMETER で閉じる。REQUEST_ERROR では返さない。
- Range Filters は、既存の受信 REQUEST_UPDATE と同じ規則 (`src/session/bidi.ts` の `validateIncomingRangeFilterLimits`) で検証する。自 endpoint の MAX_FILTER_RANGES が 0 で Range Filter を含む場合、または合計 Ranges が上限を超える場合は、REQUEST_ERROR (INVALID_FILTER) で拒否する。
- 予約 namespace は DOES_NOT_EXIST で拒否する。既存の受信 PUBLISH と同じ判定 (`isRejectedReceiveNamespace`) を使う。0 フィールドの prefix は全 Track 購読として扱い、拒否しない。

### 2. 受信購読の状態

`SessionImpl` に受信 SUBSCRIBE_TRACKS 用の registry を追加する。キーは Request ID。

- 型 `IncomingTracksSubscriptionState` を `src/session/types.ts` に追加し、`BidiSessionInternal` に `incomingTracksSubscriptions: Map<bigint, IncomingTracksSubscriptionState>` を追加する。初期化は `src/session.ts` で行う。
- 保持するもの:
  - Request ID
  - Track Namespace Prefix
  - 応答ストリームの writer と control reader
  - 受理した parameter (PAUSED、TRACK_PROPERTY_FILTER、Range Filters、AUTHORIZATION_TOKEN)
  - 状態 (active / closed)
  - この要求から PUBLISH 済みの Full Track Name の集合
  - PUBLISH_SKIPPED を送った Full Track Name の集合
- 未応答の REQUEST_UPDATE 数は、既存の受信 REQUEST_UPDATE と同じ数え方 (`receivedRequestUpdateCounts` の規則) を使い、この要求のストリームをキーにする。

既存の `TracksSubscriptionState` は送信側 (subscriber としての SUBSCRIBE_TRACKS) の状態である。受信側は上記の別の型と Map を用意し、送信側と混ぜない。

セッション終了時は `src/session/lifecycle.ts` の後始末で、受信 SUBSCRIBE_TRACKS の writer / reader を閉じ、Map を clear する。

### 3. 応答

- 受理したら REQUEST_OK を応答側へ書く (SUBSCRIBE_TRACKS_OK。§1.5 の別名)。Track Properties は空、Parameters も空でよい。
- 応答方向は FIN しない。REQUEST_UPDATE_OK / REQUEST_UPDATE_ERROR と PUBLISH_SKIPPED を同じストリームで送るため、writer を保持する。
- 拒否する場合は REQUEST_ERROR を書いて FIN する (§6.4.2.3)。認可拒否は UNAUTHORIZED、予約 namespace と購読対象の Track / namespace が無い場合は DOES_NOT_EXIST を使う。
- Filter の不正・上限超過は REQUEST_ERROR (INVALID_FILTER) で拒否する。
- 許可外 parameter・値域違反は、セッションを INVALID_PARAMETER で閉じる (§9.19.1)。REQUEST_ERROR では返さない。
- 応答の書き込みに失敗したら、購読を登録しない。

### 4. REQUEST_UPDATE の受信ループ

受理後、応答ストリームの readable を読み続ける。

- REQUEST_UPDATE を受けたら、許可 parameter (AUTHORIZATION_TOKEN、PAUSED、TRACK_PROPERTY_FILTER、TRACK_NAMESPACE_PREFIX) を検証する。
  - 許可外 parameter は、セッションを INVALID_PARAMETER で閉じる (§9.19.1)。
  - Range Filter の値が不正な場合は REQUEST_UPDATE_ERROR (INVALID_FILTER) を返す。
- 未応答の REQUEST_UPDATE 数が、自 endpoint が SETUP で広告した MAX_REQUEST_UPDATES に達した状態でさらに REQUEST_UPDATE を受けたら、セッションを TOO_MANY_REQUEST_UPDATES で閉じる (§9.1.7)。0 は無制限である。
- 成功したら REQUEST_UPDATE_OK を 1 つ返す。失敗したら REQUEST_UPDATE_ERROR を 1 つ返す。受信順を守る。
- REQUEST_UPDATE_ERROR を返したら、§9.5 の MUST に従って応答ストリームを閉じる。以後その要求の REQUEST_UPDATE を処理せず、購読を closed にする。既に PUBLISH した購読は終了しない。
- prefix の更新では、既に PUBLISH した Track を再 PUBLISH しない。新しい prefix に一致する今後の Track だけを対象にする。既存の購読は変更しない。
- TRACK_PROPERTY_FILTER の更新は Length 0 で削除、非 0 で全置換とし、今後の一致判定にだけ使う。既存の購読は変更しない。
- PAUSED は今後の一致 PUBLISH に載せる。既存の購読は変更しない (§9.19.18)。
- AUTHORIZATION_TOKEN の更新は、その要求の再認可にだけ使う。結果 PUBLISH には載せない (§9.19.2 の MUST NOT)。
- FIN を受けたら、REQUEST_UPDATE を送ってこない意思表示として読み取りループだけを終了する。購読は active のまま維持し、以降に公開される一致 Track へ PUBLISH を送る (§6.4.2.2)。
- RESET_STREAM / STOP_SENDING を受けたら取消として扱い、購読を削除する。以後その要求のために新しい PUBLISH は送らない。既存の PUBLISH 購読は止めない (§3.6 / §6.4.2.3)。
- セッション終了・GOAWAY でも購読を後始末する。

### 5. 一致する Track の PUBLISH

- 公開済み Track の registry を Session に持つ。型 `PublishedTrackState`、Map `session.publishedTracks` とし、キーは `fullTrackNameKey` が返す Full Track Name の比較キーにする。
  - 同じ Session で同じ Full Track Name を複数回 `Session.publish` した場合は、1 つの `PublishedTrackState` を共有する (0948 の公開 Track 管理と同じ規則)。
  - 登録は最初の `Session.publish` が PUBLISH を送った時点、削除はその Full Track Name の `Publisher` が 1 つも残らなくなった時点 (done / peer cancel / PUBLISH_ERROR) とセッション終了の時点で行う。
  - `Session.publish` は登録の後、受信 SUBSCRIBE_TRACKS のうち一致する要求のうち、その要求からまだ PUBLISH していない Track に限り、`requestsPublish` と同じ送信経路で結果 PUBLISH を送る (§9.5.2 の再 PUBLISH 禁止と同じ集合を使う)。受理時に既に登録済みだった Track についても同じ経路で送る。
  - `PublishedTrackState` は Track Namespace / Track Name、`buildPublishTrackProperties` で組み立てた Track Properties、アプリへ返した `Publisher` の集合、その Track の PUBLISH subscription の集合を持つ。
- 一致判定は「Track Namespace Prefix に一致」かつ「TRACK_PROPERTY_FILTER を通過」とする (§3.6.1 / §3.3.2)。フィルタを通らない Track には PUBLISH も Object も送らない。PUBLISH_SKIPPED も送らない。
- 受理時と、その後に公開された Track について、一致する Track へ PUBLISH を送る。
- 新しい PUBLISH を送る場合は、新しい Request ID と Track Alias を採番し、SUBSCRIBE_TRACKS_ID に受信 SUBSCRIBE_TRACKS の Request ID を載せる。
- 結果 PUBLISH の parameter は §9.8 の一覧に限る。SUBSCRIBE_TRACKS の PAUSED、LOCATION_FILTER、GROUP_ORDER、FILL_PARAMETERS、OBJECT_DELIVERY_TIMEOUT、SUBGROUP_DELIVERY_TIMEOUT、SUBSCRIBER_PRIORITY を載せる。AUTHORIZATION_TOKEN は載せない (§9.19.2 の MUST NOT)。Range Filters と TRACK_PROPERTY_FILTER は PUBLISH に載せず、送信時の評価に使う。INCLUDE_PROPERTIES は PUBLISH の parameter ではなく、0 のときに結果 PUBLISH の Track Properties を空にする (§9.19.22)。
- PUBLISH の応答 (REQUEST_OK / REQUEST_ERROR) を待って購読を確立する。REQUEST_ERROR を受けたら、その PUBLISH subscription を閉じ、以降その Track の購読として扱わない。
- PUBLISH_DONE / 取消で PUBLISH 状態を閉じる。
- 同じ Track が複数の SUBSCRIBE_TRACKS に一致した場合の扱いは 5.1 と 5.2 で決める。

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
   - 新規 PUBLISH を送る。既存 PUBLISH はそのまま維持し、同じ Track の 2 つの concurrent subscription として扱う (§3.1)。SUBSCRIBE_TRACKS_ID と、§9.8 の一覧にある SUBSCRIBE_TRACKS の parameter を新規 PUBLISH に載せる。
3. Track の公開後に届き、既存 PUBLISH が PUBLISH_DONE で終了している
   - Track がまだ配信中なら新規 PUBLISH を送る。
   - Track が終了しているなら PUBLISH_SKIPPED を返す。
4. 複数の SUBSCRIBE_TRACKS が同じ Track に一致する
   - 要求ごとに新規 PUBLISH を送る。Track Alias は要求ごとに別の値を割り当てる。
5. SUBSCRIBE_TRACKS の PAUSED / filters / INCLUDE_PROPERTIES が既存 PUBLISH と異なる
   - 新規 PUBLISH には §9.8 の一覧にある parameter だけを載せる。PAUSED と LOCATION_FILTER は PUBLISH の初期条件として載せ、Range Filters は送信時の評価に使い、INCLUDE_PROPERTIES は結果 PUBLISH の Track Properties の空 / 非空に反映する。既存 PUBLISH の parameter は変更しない。
6. 別セッションの直接 subscriber から届く
   - そのセッションの公開 Track registry を引いて、一致する Track へ新規 PUBLISH を送る。

決定:

- moqt-js の既定は、仕様どおり SUBSCRIBE_TRACKS ごとに新しい PUBLISH を送る。SUBSCRIBE_TRACKS_ID を載せる。既存 PUBLISH の再利用は既定にしない。
- 理由: §9.19.21 は SUBSCRIBE_TRACKS_ID を「SUBSCRIBE_TRACKS の結果として送る PUBLISH」にだけ載せると定め、§3.6.2 は SUBSCRIBE_TRACKS の parameter を結果 PUBLISH に載せると定める。既存 PUBLISH にはどちらも無く、購読者ごとの parameter も反映できない。
- 既存 PUBLISH を再利用する動作は、RFC 準拠の動作ではないため、既定にも通常の相互接続モードにもしない。必要になった場合だけ、明示的な opt-in として別 issue で扱う。
- リレーが既存 PUBLISH で下流の購読を満たせるなら、上流へ SUBSCRIBE_TRACKS を送らないのが §7.7 に沿う設計である。上流 SUBSCRIBE_TRACKS を送るリレーは、publisher が返す PUBLISH を購読者へ配信する責務を負う (§7.7 の MUST)。moqt-js はこのリレー側の動作を実装しない (CODEBASE.md のクライアント限定方針)。

#### 5.2 複数 PUBLISH subscription の Object 配信

同じ Track が複数の SUBSCRIBE_TRACKS に一致すると、publisher は要求ごとに PUBLISH を送る。その結果、同じ Track に複数の PUBLISH subscription ができる (§3.1)。

- 各 PUBLISH subscription は、それぞれ Request ID、Track Alias、PAUSED、Location Filter、Range Filters、writer、配信状態を持つ。
- PUBLISH subscription 状態は `PublisherImpl` に持たせず、`PublishedTrackState` の subscription 一覧 (`PublishedTrackSubscriptionState`) として Track ごとに持つ。
- アプリの `Publisher.sendObject` / `sendDatagram` は、その Track の全 subscription のうち、PAUSED でなく、その購読の filters を通る subscription にだけ送る。既存の `publisherStreams` / `publisherSendQueues` は Track Alias をキーにしているため、購読ごとに別の Track Alias を割り当てることで、この 2 つの Map をそのまま subscription ごとの配信状態の分離に使う。`sendObject` は subscription ごとに 1 回ずつ実行する。
- 仕様は同じ Track Alias の共有を許す (§3.1)。それでも購読ごとに別の Track Alias を割り当てる方針を既定にする。同じ Alias を共有すると、購読ごとに異なる PAUSED の解除やフィルタ変更を適用したときに、到着した Object がどの購読のものかを受信側が判別できなくなるためである (§3.1.3)。
- Track Alias を分けても帯域は増えない。§3.1 が「Object が複数の購読のフィルタに一致する場合、publisher は購読ごとに 1 回ずつ送る」MUST を定めており、Alias の共有では送信回数が減らない。
- 同じ Object を複数の subscription に送るため、Group の切り替えと Subgroup の終端は subscription ごとに扱う。
- PUBLISH subscription の PUBLISH_DONE、取消、セッション終了では、その subscription の配信状態だけを閉じる。同じ Track の他の subscription は維持する。
- アプリの `Publisher.done()` は PAUSED と filters を評価せず、その `Publisher` が持つ PUBLISH subscription だけへ PUBLISH_DONE を送る (§3.1.1。PUBLISH_DONE などの制御メッセージは paused でも送る)。その Full Track Name の最後の `Publisher` が終了したら、SUBSCRIBE_TRACKS 由来の subscription にも PUBLISH_DONE (TRACK_ENDED) を送り、`publishedTracks` から Track を削除する。
- peer cancel (STOP_SENDING / RESET_STREAM) は、その subscription だけを閉じる。最後のアプリ `Publisher` の subscription が peer cancel で閉じた場合も、その Full Track Name の最後の `Publisher` が終了したものとして扱う。

### 6. PUBLISH_SKIPPED

- 双方向ストリームを開けない、または PUBLISH を送れない場合は、SUBSCRIBE_TRACKS の応答ストリームへ PUBLISH_SKIPPED を送る (§3.6.3)。
- Track Namespace Suffix は、受信 SUBSCRIBE_TRACKS の prefix を除いた部分にする (§9.18)。
- PUBLISH_SKIPPED を送った Track には、その SUBSCRIBE_TRACKS について、アプリがその Track を新たに公開するまで PUBLISH を送らない (§3.6.3 の MUST NOT。同節の「scoped to a single PUBLISH」は、公開単位が変われば改めて PUBLISH を送れることを示す)。TRACK_PROPERTY_FILTER を通らない Track は、PUBLISH_SKIPPED を送らずに PUBLISH もしない (§3.3.2)。
- 記録は、その要求の状態に Full Track Name 単位で持つ。アプリがその Track を新たに公開したとき、または要求が取消・終了したときに消す。新しい PUBLISH の受理や上流購読の終了は、このリポジトリの publisher には存在しない事象であるため使わない。

### 7. 認可

- 受信 SUBSCRIBE_TRACKS を無条件に受理しない (§3.6 の MUST)。
- 低レベル API の `ConnectCallbacks` に `authorizeSubscribeTracks?: SubscribeTracksHandler` を追加する。
  - `SubscribeTracksHandler` は `(request: IncomingSubscribeTracksRequest) => SubscribeTracksDecision | Promise<SubscribeTracksDecision>`。
  - `IncomingSubscribeTracksRequest` は Request ID、Track Namespace Prefix、解決済み parameter を持つ。
  - `SubscribeTracksDecision` は受理 / 拒否と、拒否時の `RequestErrorCode` (既定は UNAUTHORIZED) と reason phrase を持つ。
- コールバックは、protocol の検証 (Request ID、parameter scope、Range Filter 上限、予約 namespace) を通過した後に呼ぶ。拒否時は REQUEST_ERROR を書いて FIN し、セッションは閉じない。
- `authorizeSubscribeTracks` が無い場合の既定は、prefix が active な PUBLISH_NAMESPACE または公開済み Track に一致すれば受理し、一致しなければ DOES_NOT_EXIST で拒否する。0 フィールドの prefix は、PUBLISH_NAMESPACE または公開済み Track が 1 つ以上あれば一致とみなす。
- 受信 AUTHORIZATION_TOKEN は、既存の受信 PUBLISH と同じ処理 (`src/session/incomingPublish.ts` の `incomingPublishProcessAuthorizationTokens` と `AuthTokenCache`) を通してからコールバックへ渡す。ライブラリは SETUP に載せたトークンとの同一性を要求せず、認可の判断はコールバックに委ねる。結果 PUBLISH には載せない (§9.19.2 の MUST NOT)。
- 認可拒否は REQUEST_ERROR (UNAUTHORIZED) で返し、セッションは閉じない。

### 8. エラー・デバッグ・統計

- SUBSCRIBE_TRACKS / REQUEST_UPDATE / PUBLISH / PUBLISH_SKIPPED の送受信を debug コールバックへ出す。
- 受信購読数、PUBLISH 送信数、PUBLISH_SKIPPED 数を統計に出す。再利用率は、既存 PUBLISH の再利用を実装しないため出さない。
- Request ID の重複・パリティ違反は INVALID_REQUEST_ID でセッションを閉じる。
- 許可外 parameter・値域違反は、セッションを INVALID_PARAMETER で閉じる (§9.19.1)。Filter の不正・上限超過は REQUEST_ERROR (INVALID_FILTER) で返す。
- 結果 PUBLISH が PUBLISH_ERROR (UNSUPPORTED_EXTENSION など) で拒否された場合は、§5 のとおり subscription を閉じる。

### 9. API とドキュメント

- 低レベル API: `ConnectCallbacks.authorizeSubscribeTracks` と、その引数・戻り値の型 (§7) を `src/session/publicTypes.ts` に追加する。
- 高レベル API: `MediaPublisherOptions` に `acceptSubscribeTracks?: boolean` と `authorizeSubscribeTracks?: SubscribeTracksHandler` を追加する。
  - `acceptSubscribeTracks` の既定は `announceNamespace` と同じ値とし、false のときは受信 SUBSCRIBE_TRACKS を DOES_NOT_EXIST で拒否する。
  - `authorizeSubscribeTracks` を指定した場合は、そちらの判断を優先する。
  - `announceNamespace` が false のまま PUBLISH_NAMESPACE を送っていない場合、リレーは namespace 購読をルーティングしないため、既定 false でも既存の視聴経路は変わらない。高レベル API は、この状態で届いた SUBSCRIBE_TRACKS を想定しないため、低レベル API の既定 (公開済み Track または active な PUBLISH_NAMESPACE に一致すれば受理) より厳しく拒否する。
- `docs/LOW_LEVEL_API.md` / `docs/HIGH_LEVEL_API.md` / `docs/IMPLEMENTATION_STATUS.md` を更新する。
  - `docs/IMPLEMENTATION_STATUS.md` の SUBSCRIBE_TRACKS_ID の説明は現在「SUBSCRIBE_TRACKS の REQUEST_UPDATE で対象の SUBSCRIBE_TRACKS を指定する」と書かれているが、§9.19.21 は結果 PUBLISH に載る parameter と定める。実装に合わせて訂正する。
- ソースコードのコメントや docs に issue 番号を書かない。
- `CHANGES.md` は MOQT RFC ドラフト中のため更新しない。

### 10. 前提

- PUBLISH_NAMESPACE (§7.7 の MUST) を送っていない publisher には、リレーは namespace 購読をルーティングしない。高レベル API の `announceNamespace` は実装済みであり、E2E ではこれを有効にする。devtools の publisher は PUBLISH_NAMESPACE を送らないため、devtools を使う E2E には別途対応が必要である。
- 実リレー E2E は、draft-23 に対応したリレーが検証環境に用意できるまで実行できない (`.github/workflows/e2e-test.yml` は TEST_MOQT_URI 未設定で relay project を skip する)。0817 が同じ blocker を pending の理由にしており、SUBSCRIBE_TRACKS の実リレー E2E も 0817 の範囲に含まれる。本 issue では単体テストまでを完了条件とする。
- 直接 publisher-subscriber 接続で、まだ PUBLISH していない Track に SUBSCRIBE_TRACKS が来た場合も、§7 の既定受理条件 (prefix が active な PUBLISH_NAMESPACE または公開済み Track に一致する、または `authorizeSubscribeTracks` が受理する) を満たせば、§5 ケース 1 のとおり受理して待ち、その Track が公開された時点で PUBLISH を送る。満たさなければ DOES_NOT_EXIST を返す。公開されないまま要求が終了した場合は何も送らない。

## 完了条件

- SUBSCRIBE_TRACKS を受信して REQUEST_OK を返し、応答ストリームを維持できる。
- 一致する公開済み Track と、その後に公開される Track に対して、仕様どおりの PUBLISH を送れる。SUBSCRIBE_TRACKS ごとに新しい PUBLISH を送り、既存 PUBLISH の再利用を既定にしない。TRACK_PROPERTY_FILTER を通らない Track には PUBLISH を送らない。
- PUBLISH に SUBSCRIBE_TRACKS_ID を載せ、受信側が要求を対応付けられる。
- 同じ Track に複数の SUBSCRIBE_TRACKS が一致した場合、要求ごとに PUBLISH を送り、購読ごとの PAUSED / filters を評価して Object を配信できる。Track Alias の分離方針を docs に残す。
- PUBLISH_SKIPPED を送る経路と、アプリがその Track を新たに公開するまで PUBLISH を送らない規則を実装する。
- REQUEST_UPDATE の PAUSED / prefix / Authorization Token / Track Property Filter を処理し、REQUEST_UPDATE_OK / REQUEST_UPDATE_ERROR を順序どおり返す。REQUEST_UPDATE_ERROR の後は応答ストリームを閉じる。MAX_REQUEST_UPDATES 超過は TOO_MANY_REQUEST_UPDATES でセッションを閉じる。
- 取消 (RESET_STREAM / STOP_SENDING)、セッション終了、GOAWAY で購読を後始末する。FIN では購読を維持する。
- 認可コールバックと、拒否時の REQUEST_ERROR (UNAUTHORIZED / DOES_NOT_EXIST) を実装する。
- 単体テストで、受理・拒否・REQUEST_UPDATE・取消・FIN・PUBLISH_SKIPPED・重複 Request ID・許可外 parameter・INVALID_FILTER を検証する。
- `src/session/incoming.prop.ts` の先頭メッセージ分類表と、`src/session/incoming.test.ts` の未対応リクエスト 6 種を対象にしたテスト (予約 namespace の DOES_NOT_EXIST 期待) から SUBSCRIBE_TRACKS の扱いを外し、新しい挙動に更新する。
- docs の SUBSCRIBE_TRACKS_ID の説明を訂正し、追加する公開 API を反映する。
- `vp check` と `vp test run` が通る。

## 参照

- `refs/moq/draft-ietf-moq-transport-23.txt` §1.5 / §3.1 / §3.1.3 / §3.3.2 / §3.6 / §3.6.1 / §3.6.2 / §3.6.3 / §6.4.2.2 / §6.4.2.3 / §7.7 / §9.1.7 / §9.5 / §9.5.2 / §9.8 / §9.17 / §9.18 / §9.19.1 / §9.19.2 / §9.19.18 / §9.19.21 / §9.19.22
- `src/session/incoming.ts` の `incomingClassifyFirstBidiMessage` / `incomingHandleFirstBidiMessage` / `incomingValidateRequestId`
- `src/session/incomingPublish.ts` の `incomingPublishStartBidiStreamLoop` / `incomingPublishHandleBidirectionalStream` / `incomingPublishProcessAuthorizationTokens`
- `src/session/bidi.ts` の `BidiSessionInternal` / `validateIncomingRangeFilterLimits` / `receivedRequestUpdateCounts`
- `src/publisher.ts` の `PublisherImpl` / `Publisher`
- `src/session/types.ts` の `TracksSubscriptionState`
- `src/session/lifecycle.ts` の `sessionMarkRequestObjectsClosed` / `sessionClose`
- `src/session/publicTypes.ts` の `ConnectCallbacks` / `TracksSubscriptionCallbacks`
- `src/session/params.ts` の `buildSubscribeTracksParameters` / `buildPublishTrackProperties` / `matchNamespacePrefix`
- `src/message/namespace.ts` の `decodeSubscribeTracksPayload` / `encodeSubscribeTracksPayload`
- `src/message/parameter/messageParameter.ts` の SUBSCRIBE_TRACKS_ID
- `src/message/parameterScope.ts` の `validateParameterScope` / `PUBLISH_ALLOWED_PARAMS`
- `src/session/requests.ts` の `requestsPublish`
- `src/createMediaPublisher.ts` の `announceNamespace`
- `src/codec/types.ts` の `MediaPublisherOptions`
- `src/session/statistics.ts` の `SessionStatistics`
- 関連 issue: 0061 (サーバーからの双方向ストリーム受信の broader な issue。pending)、0317 (subscriber 側の PUBLISH 受信)、0817 (実リレーの E2E 追加。pending)、0905 (SUBSCRIBE_TRACKS_ID での PUBLISH の関連付け)、0906 (namespace prefix 更新)、0907 (SUBSCRIBE_TRACKS の初期パラメータ)、0930 (購読 error の通知)、0948 (公開 Track の状態管理。本 issue が導入する `publishedTracks` と重複しないよう、先行した側の管理層を共有する)

## 解決方法

- 受信双方向ストリームの先頭 SUBSCRIBE_TRACKS を `incomingClassifyFirstBidiMessage` の `"subscribe-tracks"` として分類し、`src/session/incomingSubscribeTracks.ts` で受理する。Request ID のパリティ・重複、parameter scope (§9.19.1)、Range Filter の組み合わせと上限、LOCATION_FILTER / FILL_PARAMETERS の値域 (§9.19.9 / §9.19.15)、予約 namespace を検証し、認可は `ConnectCallbacks.authorizeSubscribeTracks` (既定は active な PUBLISH_NAMESPACE または公開済み Track との prefix 一致) で判定する。
- 受理後は REQUEST_OK を返して応答ストリームを維持し、REQUEST_UPDATE の AUTHORIZATION_TOKEN / PAUSED / TRACK_PROPERTY_FILTER / TRACK_NAMESPACE_PREFIX を処理して REQUEST_UPDATE_OK / ERROR を順序どおり返す。失敗時は応答ストリームを閉じる (§9.5)。MAX_REQUEST_UPDATES 超過は TOO_MANY_REQUEST_UPDATES でセッションを閉じる (§9.1.7)。FIN は購読を維持し、RESET_STREAM / STOP_SENDING を取消として扱う。
- 公開済み Track の registry (`PublishedTrackState`) を追加し、prefix と TRACK_PROPERTY_FILTER に一致する Track へ SUBSCRIBE_TRACKS_ID 付きの PUBLISH を送る (§3.6 / §9.19.21)。AUTHORIZATION_TOKEN はコピーせず (§9.19.2)、FILL_PARAMETERS は publisher 側 fill fetch を実装していないため載せない。送れない Track は PUBLISH_SKIPPED を送り、アプリがその Track を新たに公開するまで PUBLISH を送らない (§3.6.3)。
- 同じ Track の複数 PUBLISH subscription へ Object / Datagram を fan-out し、購読ごとの PAUSED / Location Filter / Range Filters を評価する。Track Alias は購読ごとに分離する。`Publisher.done()` は自身の subscription だけを閉じ、最後の Publisher の終了で派生 subscription と registry を閉じる。
- 高レベル API は `MediaPublisherOptions.acceptSubscribeTracks` / `authorizeSubscribeTracks` を追加し、`announceNamespace` と連動する。統計に `activeIncomingTracksSubscriptions` / `subscribeTracksPublishSent` / `publishSkipped` を追加した。
- `docs/LOW_LEVEL_API.md` / `docs/HIGH_LEVEL_API.md` / `docs/IMPLEMENTATION_STATUS.md` を更新した。`CHANGES.md` は MOQT RFC ドラフト中のため更新していない (CODEBASE.md)。
