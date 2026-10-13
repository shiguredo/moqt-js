# 配信を止めるときに開いている Subgroup を閉じる手段が無い

- Created: 2026-10-13
- Completed: {YYYY-MM-DD}
- Branch: feature/add-close-paused-subgroup

## 目的

moqt-js の publisher は、配信を止めても開いている Subgroup ストリームを閉じない。`pause()` はループを止めるだけで MOQT のストリームに触れず、devtools の stop-sending も Publisher を active のまま残す。止めた時点で「もうその Subgroup へ Object を送らない」ことは送信側が知っているため、draft-ietf-moq-transport-22 §11.3.2 の FIN の MUST ("If a sender has delivered all objects in a Subgroup to the QUIC stream ... it MUST close the stream with a FIN.") を満たせるのに満たしていない。

開いたままの Subgroup で次の Object を待つ購読側は、§12.2 の DATA_STREAM_TIMEOUT でセッションを閉じうる (moqt-rs の moq-sub は 30 秒でセッションごと閉じる)。catalog は 1 Group 1 Object のため送信のたびに FIN を出すようにした (issues/closed/0846-bug-catalog-subgroup-fin.md) が、映像の最後の Subgroup と、止めた時点で開いていた音声・catalog の Subgroup は依然として開いたままになる。

## 現状

- `src/createMediaPublisher.ts` の `pause()` は `processingActive` を下げて世代を進め、状態を `paused` にするだけである。Publisher のストリームには触れない。`resume()` は同じ状態を戻すだけで、開いていた Subgroup の扱い (同じ Subgroup の続きとして送るのか、新しい Group を始めるのか) も決まっていない。
- `src/createMediaPublisher.ts` の解放経路 (`stop()` / `close()`) は `done()` を通るため FIN が出る。問題になるのは Publisher を active のまま止める経路である。
- `devtools/src/hooks/usePublisher.ts` の stop-sending モード (`sendCompleteCatalog` / `sendPublishDone` / `closeSession` がすべて false) は `stopSendingPaths()` でフレームリーダーと Encoder を止めるだけで、Publisher のストリームを閉じない。PUBLISH とセッションを維持したまま配信だけを止める設計であり、この状態が相手側の timeout に掛かる。
- `SendObjectParams.endOfSubgroup` (issues/closed/0846-bug-catalog-subgroup-fin.md で追加) は「送信する Object が Subgroup の最後である」ことを示す経路であり、送信を止める時点で初めて最後と分かる場合は使えない。止める時点で開いている Subgroup を閉じるには、Object を送らずに Subgroup を閉じる手段が要る。
- Object Status の `END_OF_GROUP` を 1 つ余分に送る方法は採れない。§11.1.1 により Normal 以外の status は payload を持てず、購読側の `handleCatalogObject` は status を見ずに空 payload を復号しようとする (同じ理由で 0846 でも採らなかった)。
- 開いている Subgroup が無い場合 (一度も送っていない、または直前に閉じた) と、省略がある Subgroup (§11.3.2 は FIN ではなく RESET の MUST) の扱いを決める必要がある。
- `pause()` 中に `resume()` した場合、同じ Group の Subgroup を再開することはできない (FIN を送った時点でその Group は閉じる)。次の Object は新しい Group の先頭 Object として送る必要がある。

## 設計方針

- Object を送らずに、その track で開いている Subgroup を閉じる公開 API を `Publisher` に足す。FIN / RESET の選択は既存の `closeSubgroupStreamWithoutWaiting` の判定 (省略がある Subgroup は RESET) を再利用する。
- 送信を止める経路から呼ぶ。対象は `MediaPublisher.pause()` と devtools の stop-sending (`stopSendingPaths()`)。`pause()` から呼ぶか、利用者が明示的に呼ぶかは実装時に決める (`pause()` が暗黙に閉じると、同じ Group を続きとして送りたい利用者の挙動が変わるため、どちらに倒すかを設計方針として確定すること)。
- `resume()` の扱いを決める。閉じた Group へ送り直さないよう、再開後の最初の Object は新しい Group にする (catalog の送り直しと同じ規則。Group ID は単調増加を保つ)。
- 対象は Subgroup ストリームのみとする。Datagram で送っている場合は閉じる対象が無い。
- 実装は高レベル API で閉じてもよいが、低レベル API から使えないと devtools 側だけ直せない (0846 と同じ制約)。公開範囲 (Publisher インタフェースに載せるか、内部経路だけか) を決めて明記すること。

## 完了条件

- 配信を止めたとき (pause / devtools の stop-sending) に、開いていた Subgroup ストリームが FIN で閉じられること。省略がある Subgroup は RESET になること (§11.3.2)。
- 閉じる API の契約 (開いている Subgroup が無い場合の挙動、閉じた Group への後続送信の扱い、FIN の完了を待つかどうか) が JSDoc と `docs/LOW_LEVEL_API.md` に書かれていること。
- `pause()` → `resume()` の往復で、閉じた Group へ送り直さないこと (再開後は新しい Group から送る)。
- 上記が `src/session/` の実 `WritableStream` を使う単体テストで固定されていること。
- moqt-rs の `moq-sub` を相手に配信を止めたとき、約 30 秒後に `0x12 data stream timeout expired` でセッションが閉じないこと。この確認は moqt-rs を別リポジトリで起動する必要があり自動化できない (実施できなかった場合は PR に記録する)。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。
- ソースコードのコメントに issue 番号や issue への言及を書かないこと。

## 解決方法

{対応時に記入}
