# REQUEST_UPDATE で範囲を狭めた後の省略 Object を FIN で閉じてしまう

- Created: 2026-09-21
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-request-update-omitted-objects-reset
- Polished: {YYYY-MM-DD}

## 目的

draft-ietf-moq-transport-21 §11.3.2 は、全 Object を渡し切る前にストリームを閉じる場合は RESET を MUST とし、その例に REQUEST_UPDATE による End Group の縮小と Start Location の拡大を挙げる。現状この経路は FIN で閉じるため、購読者が Subgroup を最後まで受け取ったと誤認する。

## 現状

- `src/publisher.ts` の `sendObject` と `sendDatagram` は `isOutsideLocationFilter` が真のとき、何も送らずに解決済みの Promise を返す (throw もしない)。この分岐は `onSendObjectSkipped` を呼ばない
- `onSendObjectSkipped` を呼ぶのは `guardSend` が `"skip"` を返す Forward State 0 の経路だけである
- `onSendObjectSkipped` の配線は `src/session/requests.ts` にあり、`PublisherStreamState.omittedObjects` を立てる
- `src/session/publish.ts` の `publishCloseSubgroupStream` は `omittedObjects` が真なら RESET、偽なら FIN を選ぶ
- そのため REQUEST_UPDATE で範囲を狭めた後にスキップされた Object は省略として記録されず、Group 変更時や `done()` 時に FIN で閉じられる
- Forward State 0 による省略は closed/0611 で対応済みである

## 設計方針

- Location Filter 外のスキップでも、その原因が REQUEST_UPDATE による範囲変更である場合は省略として記録する
- REQUEST_UPDATE の LOCATION_FILTER を反映するのは `src/session/bidi.ts` の `applyPublishRequestUpdate` で、`publisher.setLocationFilter` を呼ぶ。初期購読の Start Location は `src/session/requests.ts` の `impl.setLocationFilter` で設定される。両者を区別できるようにする
- 初期購読の Start Location より前の Object を FIN で閉じる現在の挙動は、§11.3.2 の第 1 段落 (Start Location より前の Object を除いて全 Object を渡し切った場合は FIN) どおり維持する
- `src/session/publishSubgroupClose.test.ts` と同じ形で、REQUEST_UPDATE 後の省略が RESET になることを固定する

## 完了条件

- REQUEST_UPDATE で範囲を狭めた後にスキップした Object がある Subgroup が RESET で閉じる
- 初期購読の Start Location によるスキップは従来どおり FIN で閉じる
- 追加したテストと既存テストが通る

## 参照

- draft-ietf-moq-transport-21 §11.3.2 (全 Object を渡し切る前に閉じる場合は RESET を MUST。例に REQUEST_UPDATE による End Group の縮小と Start Location の拡大)
- draft-ietf-moq-transport-21 §3.3.1 (購読の Location Filter の範囲外 Object は送らない MUST)

## 解決方法

{未着手}
