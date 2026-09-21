# REQUEST_UPDATE で範囲を狭めた後の省略 Object を FIN で閉じてしまう

- Created: 2026-09-21
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-request-update-omitted-objects-reset
- Polished: 2026-09-21

## 目的

draft-ietf-moq-transport-21 §11.3.2 は、全 Object を渡し切る前にストリームを閉じる場合は RESET を MUST とし、その例に REQUEST_UPDATE による End Group の縮小と Start Location の拡大を挙げる。現状この経路は FIN で閉じるため、購読者が Subgroup を最後まで受け取ったと誤認する。

## 現状

- `src/publisher.ts` の `sendObject` は `isOutsideLocationFilter` が真のとき、何も送らずに解決済みの Promise を返す (throw もしない)。`sendDatagram` も同じ分岐で何もせず return する。どちらも `onSendObjectSkipped` を呼ばない
- `onSendObjectSkipped` を呼ぶのは `guardSend` が `"skip"` を返す Forward State 0 の経路だけである
- `onSendObjectSkipped` の配線は `src/session/requests.ts` にあり、`PublisherStreamState.omittedObjects` を立てる
- `src/session/publish.ts` の `publishCloseSubgroupStream` は `omittedObjects` が真なら RESET、偽なら FIN を選ぶ
- そのため REQUEST_UPDATE で範囲を狭めた後にスキップされた Object は省略として記録されず、Group 変更時や `done()` 時に FIN で閉じられる
- Forward State 0 による省略は closed/0611 で対応済みである。0611 は Location Filter による見送りを明示的に対象外としており、本 issue はその残りを扱う
- `PublisherImpl` はフィルタの入場元 (REQUEST_UPDATE か初期購読か) を区別する仕組みを持たない。そもそも publisher に初期 Location Filter を設定する経路は無く (`PublishOptions` に `filter` が無く、`src/session/requests.ts` の `impl.setLocationFilter` は `SubscriberImpl` に対する呼び出し)、`PublisherImpl.setLocationFilter` の呼び出し元は `applyPublishRequestUpdate` (REQUEST_UPDATE) と `bidiSendPublishStateNotify` (アプリ起点の更新) の 2 つだけである

## 設計方針

- フィルタ範囲外で送らなかった Object を省略として記録する。`sendObject` の `isOutsideLocationFilter` 分岐で `onSendObjectSkipped` を呼び、Forward State 0 の見送りと同じ扱いに揃える
- アプリが範囲外 Object を送らない場合も取りこぼさない。REQUEST_UPDATE を適用した時点で送信中の Subgroup (`session.publisherStreams.get(trackAlias)`) があり、その Subgroup の次の Object (`PublisherStreamState.previousObjectId` の次の Object。Group は同じ Subgroup の `groupId`) が適用後の解決済みフィルタの範囲外になる場合は、アプリの送信を待たずに省略として記録する。`PublisherImpl.getLargestLocation()` は datagram でも進むため判定に使わない (範囲内の Object が残っているのに記録すると、FIN でよい Subgroup を RESET にしてしまう)
- 記録は session 層で行う。`src/session/bidi.ts` の `applyPublishRequestUpdate` (REQUEST_UPDATE) と `bidiSendPublishStateNotify` (アプリ起点の更新) がフィルタを反映したあとに `session.publisherStreams` を見て `omittedObjects` を立てる
- §11.3.2 の FIN の条件 (Start Location より前の Object を除いて全 Object を渡し切った場合) は、フィルタで見送った Object が無い場合の話である。見送りが 1 つでもあれば RESET 側になり、Start Location の拡大で見送りが生じた場合も RESET の例に含まれる
- `sendDatagram` のフィルタ分岐は Subgroup を持たないため省略の記録対象にしない (datagram の見送りで Subgroup の RESET / FIN を変えない)
- フィルタの入場元による区別はしない。publisher に初期フィルタの経路が無く、フィルタは購読中の範囲変更でしか設定されないため、範囲外の見送りはすべて省略として扱う
- `src/session/publishSubgroupClose.test.ts` の `createHarness` は REQUEST_UPDATE を通らないため、REQUEST_UPDATE 経由の省略を固定するテストは `src/testSupport/bidi.ts` の `createPublishReadTestContext` に `publisherStreams` と `onSendObject` / `onSendObjectSkipped` の配線、および `createUnidirectionalStream` を返すテスト用 transport を足して用意する (`publishSubgroupClose.test.ts` の close / abort 記録と同じ形。`publishSubgroupClose.test.ts` の形は、フィルタを直接設定して送信時の記録を固定する側に使う)

## 完了条件

- REQUEST_UPDATE で範囲を狭めた後に、範囲外として送らなかった Object がある Subgroup が RESET で閉じる
- アプリが範囲外 Object を送らない場合でも、REQUEST_UPDATE の適用時に送信中の Subgroup の次の Object が範囲外になるなら、その Subgroup は省略として記録され RESET で閉じる
- フィルタによる見送りが無い Subgroup は従来どおり FIN で閉じる
- 追加したテストと既存テストが通る

## 参照

- draft-ietf-moq-transport-21 §11.3.2 (全 Object を渡し切る前に閉じる場合は RESET を MUST。例に REQUEST_UPDATE による End Group の縮小と Start Location の拡大)
- draft-ietf-moq-transport-21 §3.3.1 (購読の Location Filter の範囲外 Object は送らない MUST)
- closed/0611 (Forward State 0 による省略の対応。Location Filter による見送りは対象外)

## 解決方法

{未着手}
