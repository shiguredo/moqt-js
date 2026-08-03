# Delivery Timeout の強制を実装する

- Created: 2026-08-03
- Completed: {YYYY-MM-DD}
- Branch: feature/add-delivery-timeout-enforcement
- Polished: 2026-08-03

## 目的

draft-ietf-moq-transport-19 §8 の MUST 要件（OBJECT_DELIVERY_TIMEOUT 超過時のストリームリセット / データグラム破棄、SUBGROUP_DELIVERY_TIMEOUT タイマー）を実装する。現在は値の抽出・伝搬のみで強制が一切ない。

## 現状

- `src/session/stream.ts` の `processSubgroupObjects()` は subgroup 先頭オブジェクトの Object Property から delivery timeout 値を抽出し `MoqtObject.objectDeliveryTimeout` / `subgroupDeliveryTimeout` に保持するだけ。
- `src/session/publish.ts` の `publishSendObjectInternal()` は `mergeDeliveryTimeoutObjectProperties()` で Object Property として送信するだけ。
- タイマー・ストリームリセット・データグラム破棄の実装が存在しない。§8 の「If the OBJECT_DELIVERY_TIMEOUT is not zero ... it MUST reset the underlying transport stream with the reset stream code DELIVERY_TIMEOUT」「For datagrams, the implementation MUST drop the datagrams」「it MUST start a timer of SUBGROUP_DELIVERY_TIMEOUT duration once it becomes aware that all of the objects on the subgroup have been published」のいずれも未実装。
- `DataStreamErrorCode.DELIVERY_TIMEOUT`（0x2）は定義されているが使用箇所がない。

## 設計方針

- Publisher 側（`src/session/publish.ts` と `src/session.ts` の publisher 部分）に送信時のタイムアウト強制を実装する:
  - OBJECT_DELIVERY_TIMEOUT: `sendObject()` / `sendDatagram()` の入口（送信キュー `publisherSendQueues` に入れる前）でオブジェクトが提供された時刻を記録し、送信（`writer.write()`）の直前に経過時間をチェックする（§8: "the implementation MUST check the time elapsed since the first byte of the object before attempting to pass it to the underlying transport for transmission"）。超過時:
    - subgroup ストリーム: `streamErrorCode` に `DELIVERY_TIMEOUT` を設定した `WebTransportError` を reason に渡して `writer.abort()` を呼び、ストリームをリセットする（W3C WebTransport の abort は committedOffset 付きの RESET_STREAM_AT に該当する）。リセットした subgroup は `closedSubgroups` に追加し、後続の送信を `ClosedSubgroupError` で拒否する（§8 の SHOULD NOT: "SHOULD NOT attempt to open a new stream to deliver additional Objects in that Subgroup"）。失効した先頭オブジェクトは Subgroup Header のみを書き込んでからリセットする（§11.4.3: "If a sender will not deliver any objects from a Subgroup, it MAY send a SUBGROUP_HEADER on a new stream, with no objects, and then send RESET_STREAM_AT with a reliable_size equal to the length of the stream header."）。
    - datagram: 送信せず破棄する。
  - SUBGROUP_DELIVERY_TIMEOUT: subgroup の FIN 送信時（group 遷移時の `writer.close()` と `closePublisherStream` の両方）からタイマーを開始する。満了時に `writer.close()` が未完了なら `writer.abort()` でストリームをリセットする。W3C WebTransport の close() はストリームが "all data committed" 状態に達するまで resolve しないため、close() 完了済みのストリームは配信済みとみなしリセットしない（§8: "If the timer expires before the underlying transport stream reaches 'all data committed' state ... the implementation MUST reset the stream"）。リセットした subgroup は OBJECT_DELIVERY_TIMEOUT 超過時と同様に `closedSubgroups` に追加して後続の送信を `ClosedSubgroupError` で拒否し、close() が完了した時点でタイマーを破棄する。
  - ストリームをリセットする際は、abort() の前に `writer.commit()` を呼び、Subgroup Header を含む書き込み済みバイトを committedOffset（RESET_STREAM_AT の reliable_size）に反映する（§11.4.3: "When RESET_STREAM_AT is used, the reliable_size SHOULD include the stream header so the receiver can identify the corresponding subscription"）。
  - group 遷移時の `writer.close()` 待ちにはタイムアウトガードを設ける（既存の `closePublisherStreamInternal` の 5 秒ガードと同じ方式）。SUBGROUP_DELIVERY_TIMEOUT タイマーが先に発火して abort() した場合、W3C WebTransport の仕様上 abort() は pending の close() を settle させないため、close() の settle を待たずに後続の送信を続行する。
  - datagram には OBJECT_DELIVERY_TIMEOUT と SUBGROUP_DELIVERY_TIMEOUT の両方が作用し、両方非ゼロなら小さい方を適用する（§8: "For objects with Object Forwarding Preference set to Datagram, the SUBGROUP_DELIVERY_TIMEOUT acts the same way as OBJECT_DELIVERY_TIMEOUT; if both are non-zero, the smaller of the two is used"）。`publishSendDatagram()` は同期実行のため、提供時刻から `writer.write()` までの経過時間は実質 0ms であり、送信前チェックは通常発動しない。datagram のキュー滞留による遅延は §8 の SHOULD（"implementations SHOULD either minimize datagram queueing, or use datagram queueing mechanisms that support time bounds (such as the outgoingMaxAge parameter in the W3C WebTransport API)"）に従い、WebTransport の `outgoingMaxAge` の設定で対応する。
  - タイムアウト値は publisher の値を用いる。`publish()` の options（Track Property）の値を PublisherImpl に保持し、subgroup 先頭オブジェクトの `SendObjectParams`（Object Property）で上書きされた値があればそれを使う（§8: "the publisher's value is the Object Property when present on the first object of the subgroup, and the Track Property otherwise"）。subgroup で確立した値はその subgroup 内の全オブジェクトの判定に適用する（§12.2: "it overrides the Track-level value for that subgroup"）。datagram には Track Property 値を適用する。
  - 値 0 はタイムアウトなし（強制しない）。
  - `src/session.ts` の `PublishOptions.deliveryTimeout` の doc コメント（「Publisher と Subscriber の両方が指定した場合、小さい方の値が使用される。」）は subscriber 値との比較が対象外のため、実態に合わせて修正する。
- Subscriber 側は受信値の保持（現状のまま）とし、受信側でのタイムアウト適用は行わない。§8 の強制はすべて転送側の義務として規定されており、受信専用の Subscriber には強制義務がない。
- subscriber 値との比較（§8: "If both the publisher's value and the subscriber's value are non-zero, the smaller of the two is used"）はリレーの責務であり対象外とする。moqt-js は SUBSCRIBE を受信する経路を持たないクライアントライブラリのため（`src/session.ts` の `handleIncomingBidirectionalStream()` は受信双方向ストリームの先頭メッセージを PUBLISH のみ許可）。

## 完了条件

- OBJECT_DELIVERY_TIMEOUT 超過時に subgroup ストリームが `DELIVERY_TIMEOUT` コードでリセットされ、リセットした subgroup への後続送信が拒否される。
- OBJECT_DELIVERY_TIMEOUT / SUBGROUP_DELIVERY_TIMEOUT（両方非ゼロなら小さい方）超過時にデータグラムが破棄される。送信前の経過時間チェックと超過判定は純粋関数として実装され、単体テストで検証されていること（同期 API のため通常は発動しない）。
- SUBGROUP_DELIVERY_TIMEOUT タイマーが発火し、配信未完了の subgroup ストリームがリセットされ、リセットした subgroup への後続送信が拒否される。
- 各タイムアウトの動作を検証するテストがあること。
- `CHANGES.md` の `## develop` に `[ADD]` があること。
- `vp check` / `tsc --noEmit` / `vp test run` が通る。

## 参照

- draft-ietf-moq-transport-19 §3.3.4 (Stream Reset Error Codes)
- draft-ietf-moq-transport-19 §8 (Delivery Timeouts and Data Reliability)
- draft-ietf-moq-transport-19 §10.2.3 / §10.2.4 (SUBGROUP_DELIVERY_TIMEOUT / OBJECT_DELIVERY_TIMEOUT Parameter)
- draft-ietf-moq-transport-19 §11.4.3 (Closing Subgroup Streams)
- draft-ietf-moq-transport-19 §12.1 / §12.2 (SUBGROUP_DELIVERY_TIMEOUT / OBJECT_DELIVERY_TIMEOUT Property)
- W3C WebTransport (WebTransportSendStream の close / abort アルゴリズム)

## 解決方法

未着手。
