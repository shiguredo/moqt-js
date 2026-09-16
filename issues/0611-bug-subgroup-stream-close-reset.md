# Forward State と END_OF_GROUP で省略した Subgroup を reset せず FIN で閉じる

- Created: 2026-09-15
- Completed: 2026-09-17
- Branch: feature/fix-subgroup-stream-close-reset
- Polished: 2026-09-15

## 目的

draft-ietf-moq-transport-21 §11.3.2 は、Subgroup の全 Object を渡し切る前にストリームを閉じる場合に reset を MUST とし、その例に Forward State による Object の省略を明示的に挙げる。現状は Forward State が 0 の間に省略した Object の存在をどこにも記録しないため、Group 変更 / `done()` / セッション終了の各経路が FIN で閉じる。購読者は「Subgroup を最後まで受け取った」と誤認する。

## 現状

- Forward State が 0 の間、`publishSendObject` (`src/session/publish.ts`) は先頭の `if (!publisher.forwardState) { return Promise.resolve(); }` で送信せず resolve する。`PublisherImpl.sendObject` (`src/publisher.ts`) の `guardSend` も Forward State 0 では `"skip"` を返すため、公開 API の経路では `publishSendObject` に到達しない。いずれの経路でも「省略した」事実を記録しない
- Forward State の変更 (`PublisherImpl.setForwardState`) はフラグ代入と `forwardStateChangeCallback` の呼び出しのみでストリームに触れない。REQUEST_UPDATE の FORWARD を反映する `applyPublishRequestUpdate` (`src/session/bidi.ts`) も `publisher.setForwardState(...)` を呼ぶだけで、開いたままの Subgroup ストリームを残す
- Group 変更時は `publishSendObjectInternal` (`src/session/publish.ts`) が前のストリームを `writer.close()` (FIN) で閉じる
- `done()` 時は `PublisherImpl.done` → `terminate` → `onDoneInternal` (`src/session.ts` の設定箇所) → `closePublisherStream` → `publishClosePublisherStream` → `publishClosePublisherStreamInternal` (`src/session/publish.ts`) の順に呼ばれ、`writer.close()` (FIN) で閉じる
- peer cancel (STOP_SENDING / RESET_STREAM) 時は `handlePublishPeerCancel` (`src/session/bidi.ts`) が `publishResetPublisherStream` (`src/session/publish.ts`) を呼び `writer.abort()` (RESET) する
- セッション終了 (`SessionImpl.close`) は `closeWriterSafely` (`src/session.ts`) で `publisherStreams` の全 writer を `writer.close()` (FIN) で閉じる
- RESET する経路は peer cancel の `publishResetPublisherStream` のほかに、`publishSendObjectInternal` のストリーム生成 await 中に closed になった場合の `writer.abort()`、`publishClosePublisherStreamInternal` の close タイムアウト時の `writer.abort("publisher stream cleanup")` がある。いずれも「省略した Object があるか」を参照しない
- END_OF_GROUP status を送った時点でも §11.3.2 の FIN 条件は「その Subgroup で省略が起きていない場合に限り」成立するが、現状は FIN もせず、同一 Group への後続送信も拒否しない (`PublisherImpl` の送信ガードは END_OF_TRACK 後のみ拒否)
- 到達条件: 購読が確立している (Forward State 1) → Group G で 1 件以上送信してストリームが開く → REQUEST_UPDATE (FORWARD=0) を受信し `publisher.setForwardState(false)` が反映される → アプリが G の残り Object を `sendObject` する (省略される) → Forward State 0 のまま Group を変更するか `done()` を呼ぶ。Group 変更は Forward State 0 では送信経路に入らないため FIN に到達しないが、`done()` は Forward State に関係なく必ず close 経路に入る

draft-ietf-moq-transport-21 §11.3.2:

> If a sender closes the stream before delivering all such objects to the QUIC stream, it MUST reset the stream. This includes, but is not limited to:
>
> - Omitting a Subgroup Object due to the subscriber's Forward State

(原文の箇条書きは 5 項目であり、引用は間の 4 項目を省略している)

## 設計方針

- Subgroup ストリーム単位で「省略した Object があるか」を保持する。追加するのは `PublisherStreamState` (`src/session/types.ts`) の `omittedObjects: boolean` とし、ストリーム生成時に `false` で初期化する。省略の記録は、省略が実際に起きた送信呼び出しの時点で行う。記録するのは Forward State が 0 の間に送信を見送った場合である。§11.3.2 の「閉じる時点で全 Object を渡し切っていれば FIN、渡し切っていなければ RESET」の判定を閉じる時点だけで行おうとすると、最後に送信した Object より後の見送りを検出できないため、見送りの時点で記録する
- 見送りを記録する場所は次の 3 箇所とする。(a) 公開 API 経由の見送り。`PublisherImpl.sendObject` (`src/publisher.ts`) の `guardSend` は Forward State 0 で `"skip"` を返し、`onSendObject` を呼ばずに resolve するため、`SessionImpl.sendObject` → `publishSendObject` (`src/session/publish.ts`) には到達しない。`PublisherImpl` に `onSendObjectSkipped?: () => void` を追加し、`guardSend` ではなく `sendObject` 側の `"skip"` 分岐で呼ぶ (`guardSend` は `sendDatagram` とも共有しており、Datagram の見送りは Subgroup の省略ではないため)。`src/session.ts` の `publish()` が `impl.onSendObject` を設定している箇所で `session.publisherStreams.get(trackAlias)` のエントリに `omittedObjects = true` を設定する。同じ Group への後続送信で新しいストリームは開かない (Forward State 0 の間は送信しないため) ので、`publisherStreams` のエントリは省略の記録先として十分である。(b) 見送りの前にストリームが開いていない場合の保険として、`publishSendObject` の Forward State 0 の early return の位置でも `publisherStreams` に当該 `trackAlias` のエントリがあれば `omittedObjects = true` を設定する。`publishSendObject` を直接呼ぶ内部経路のために置く。(c) キュー投入後に Forward State が 0 へ変わった場合。`publishSendObjectInternal` の先頭 (現行の `isPublisherClosed` ガードと同じ位置) に Forward State 0 の early return を新設し、`omittedObjects = true` を設定して return する。現行はキュー投入時の Forward State しか見ないためこの窓が残る。新しい Subgroup のストリームを Forward State 0 で開かない点でも §3.1 と整合する
- ストリームが未生成のときは省略を記録する先が無い。最初の Object から Forward State 0 で一度もストリームが開いていない Subgroup は `publisherStreams` にエントリが無いため何も記録せず現状どおり送信しない (ストリームが開いていないため閉じる対象も無く、§11.3.2 の RESET 対象にならない)
- §11.3.2 の判定を `src/session/publish.ts` の 1 関数 `publishCloseSubgroupStream(session, trackAlias, timeoutMs = 5000): Promise<"fin" | "reset">` に集約する。この関数は `session.publisherStreams` から当該 Subgroup のストリーム状態を取り出して Map から削除し、`omittedObjects` が `true` なら `writer.abort("subgroup omitted objects")` (RESET)、`false` なら `writer.close()` (FIN) を、現行の `publishClosePublisherStreamInternal` と同じく `timeoutMs` の打ち切り付きで `await` する。ストリーム状態が無ければ何もせず `return "fin"` とする (Group 変更の経路では Map に残っている場合のみ呼ぶため実際には到達しないが、`SessionImpl.close` のように一括で呼ぶ経路のために必要)。`writer.close()` が `timeoutMs` で打ち切られた場合は FIN を諦めて `writer.abort("publisher stream cleanup")` で RESET し、戻り値は `"reset"` とする (タイムアウト時は常に RESET で、`omittedObjects` の判定によらない)。RESET の abort は現行の `publishClosePublisherStreamInternal` と同じく完了を待たず、`timeoutMs` の打ち切りも掛けない。例外は現行と同じく黙殺する
- 呼び出し側は次のとおり。(a) Group 変更時の前ストリームのクローズは `publishSendObjectInternal` から呼び、戻り値が `"fin"` なら `closedSubgroups` に `${trackAlias}:${streamState.groupId}` を追加する (追加するのは閉じた前のストリームの Group ID であり、送信しようとしている新しい `groupId` ではない。省略がある場合の RESET では追加しない。省略があるのに FIN 済みとして記録し、購読者の再送を拒否するのを避けるため)。(b) `publishClosePublisherStreamInternal` は、まず自身の中で `session.publisherStreams.get(trackAlias)` の存在を確認してからこの関数を呼ぶ (ストリームが無いときに何もしない現行の挙動を維持する)。呼び出し後に `clearClosedSubgroupsForTrack` を実行する現行の順序を維持し、`publishClosePublisherStream` の `timeoutMs` はそのまま渡す。(c) `SessionImpl.close` の `publisherStreams` のクローズは、現行の `closeWriterSafely` と同じく完了を待たずに各 `trackAlias` についてこの関数を呼ぶ (await しない)。終了処理の遅延を増やさないためであり、判定結果も `closedSubgroups` への追加もセッション終了時には使わない (`closedSubgroups` のクリアは `SessionImpl.close` の先頭で完了している)
- `publisherStreams` のストリーム状態の型を変更するため、追随が必要な箇所は `src/session/types.ts` / `src/session.ts` / `src/session/publish.ts` と、テスト用 session を組み立てている `src/testSupport/bidi.ts`、および `publisherStreams.set` でストリーム状態を直接構築している `src/session/publish.test.ts` / `src/session/bidiReadRequestStreamMessages.test.ts` / `src/session/bidiSubscribeFinReset.test.ts` である
- END_OF_GROUP status 送信後はその場で FIN する。`publishSendObjectInternal` の送信成功後に、当該 Subgroup のストリームを同じ判定関数で閉じる (`omittedObjects` が `true` なら RESET、`false` なら FIN)。FIN の場合は当該 Group を `closedSubgroups` に追加する。`PublisherImpl` に `endOfGroupSentGroupId: bigint | null` を追加し、END_OF_GROUP を受理した Group ID を記録する。同一 Group への後続 `sendObject` / `sendDatagram` が来たら END_OF_TRACK 後と同じ形で `ProtocolViolationError` を通知し、`sendObject` は返値 Promise を reject する (別の Group への送信は妨げない)。`sendDatagram` は現状 `closedSubgroups` を参照しないため、このガードを `guardSend` に置くことで拒否する。`endOfGroupSentGroupId` は購読終了 (done / peer cancel / セッション終了) で `null` に戻す。キュー内で待機していた送信は FIN 済みストリームへの write と `closedSubgroups` の検査で拒否され、error 通知のみで resolve するが、これは上述のガードとは別の防御である
- 判定関数の集約は、閉じる経路ごとに散っている FIN の判断を RESET へ置き換えるための実装手段であり、本 issue の主目的は §11.3.2 の MUST 違反の解消である。無関係なリファクタリングは行わない
- `closedSubgroups` は「FIN 済みの Subgroup への送信拒否」用であり、省略の有無とは別の状態として扱う (既存の意味と利用箇所を変えない)
- 購読の Location Filter の範囲外 Object は `PublisherImpl.isOutsideLocationFilter` により `onSendObject` を呼ばずに送信を見送るため、§11.3.2 の「送信しなかった Object」に当たる。本 issue では対象外とし、Forward State と END_OF_GROUP の省略だけを扱う (フィルタによる見送りは購読の指定に沿った正常動作であり、省略の記録方法も別途決める必要があるため)
- delivery timeout (OBJECT_DELIVERY_TIMEOUT / SUBGROUP_DELIVERY_TIMEOUT) の強制は本 issue の対象外とする。強制は未実装であり `issues/pending/0366-add-delivery-timeout-enforcement.md` が担当する。0366 は「END_OF_GROUP 送信ではストリームを閉じない」前提でタイマー開始点を定めているため、END_OF_GROUP 送信時に FIN する本 issue の変更でその前提は変わる (0366 側の記述更新が必要)

## 完了条件

- Forward State 0 による省略を含む Subgroup が RESET で閉じられる。対象は Group 変更時、`done()` 時、セッション終了時、END_OF_GROUP status 送信時の各経路とする
- END_OF_GROUP status 送信後に FIN され、同一 Group への後続 `sendObject` が `ProtocolViolationError` の通知と返値 Promise の reject で拒否される。`sendDatagram` も同じ状態で拒否する
- 省略のない Subgroup は従来どおり FIN で閉じられる
- peer cancel 経路の RESET が変わらない
- `src/session/publish.test.ts` に、実ストリームの sink で `close` (FIN) と `abort` (RESET) を区別して観測するテストを追加する (モックは使わない)。検証するのは次の 6 点とする。(1) Forward State 0 で省略した後に Group を変更すると `abort` が呼ばれ `close` は呼ばれない、(2) 省略のない Subgroup では `close` が呼ばれ `abort` は呼ばれない、(3) 省略した後に `done()` を呼ぶと `abort` が呼ばれる、(4) END_OF_GROUP status 送信で `close` が呼ばれ、同一 Group への後続 `sendObject` が拒否される、(5) peer cancel 経路の RESET が変わらない、(6) 省略のない Subgroup を END_OF_GROUP status 送信で閉じるときは `close` が呼ばれる。省略の発生は公開経路 (`PublisherImpl.sendObject`) から駆動する (`publishSendObject` を直接呼ぶテストでは、公開経路の見送りが記録されない実装でも通ってしまうため)
- `vp check` / `tsc --noEmit` / `vp test run` が通る

## 参照

- draft-ietf-moq-transport-21 §11.3.2 (Closing Subgroup Streams)
- draft-ietf-moq-transport-21 §11.1.2 (Object Status。END_OF_GROUP は Group の最終 Object を宣言するものであり、Subgroup の終端は FIN で通知する)
- draft-ietf-moq-transport-21 §3.1 (Subscriptions)
- draft-ietf-moq-transport-21 §5.2 (Delivery Timeouts and Data Reliability。強制は `issues/pending/0366-add-delivery-timeout-enforcement.md` が担当)
- `issues/closed/0441-bug-publish-partial-object-fin.md` (同じ §11.3.2 の MUST のうち、Object 途中の FIN を解消した先行 issue。残キューを抱えたまま FIN する経路は対象外とされ、本 issue がその残りを扱う)

## 解決方法

### 省略の記録

`src/session/types.ts` の `PublisherStreamState` に `omittedObjects: boolean` を追加し、`false` で初期化した。
記録は次の 3 箇所で行う (閉じる時点だけの判定では、最後に送信した Object より後の見送りを検出できないため、
見送りの時点で記録する)。

- `src/publisher.ts`: `onSendObjectSkipped?: () => void` を追加し、`sendObject` の `guardSend` が `"skip"` を返した分岐で呼ぶ。
  `guardSend` は `sendDatagram` とも共有しており Datagram の見送りは Subgroup の省略ではないため、`guardSend` 内では呼ばない。
  `src/session.ts` の `publish()` が `impl.onSendObject` を設定している箇所で、`publisherStreams.get(trackAlias)` の
  `omittedObjects` を立てる配線にした
- `src/session/publish.ts` の `publishSendObject` の Forward State 0 early return (内部送信関数を直接呼ぶ経路の防御)
- `publishSendObjectInternal` の先頭に Forward State 0 の early return を新設した (キュー投入時は 1 でも待機中に 0 へ変わり得る窓を塞ぐ)

ストリームが未生成 (最初の Object から Forward State 0) の場合は記録先が無いため何もせず、従来どおり送信しない。

### FIN / RESET の判定を 1 箇所へ集約

`publishCloseSubgroupStream(session, trackAlias, timeoutMs = 5000): Promise<"fin" | "reset">` を追加し、
`omittedObjects` が真なら `writer.abort("subgroup omitted objects")` (RESET)、偽なら `writer.close()` (FIN) を
タイムアウト付きで実行する。FIN が打ち切られた場合は FIN を諦めて RESET で後始末する。
ストリーム状態は Map から削除し、ストリームが無ければ何もせず `"fin"` を返す。

呼び出し側は次のとおり。

- Group 変更時: 前のストリームの Group ID を保持して呼び、`"fin"` のときだけ `closedSubgroups` に追加する
  (RESET は「渡し切っていない」ため FIN 済みとして再送を拒否しない)
- `publishClosePublisherStreamInternal`: ストリームが存在する場合だけ呼び、その後 `clearClosedSubgroupsForTrack` を
  実行する現行順序を維持する。`publishClosePublisherStream` の `timeoutMs` はそのまま渡す
- `SessionImpl.close`: `publisherStreams` の各 trackAlias について完了を待たずに呼ぶ (`closeWriterSafely` は不要になったため削除)

### END_OF_GROUP

`publishSendObjectInternal` の送信成功後に同じ判定関数でストリームを閉じ、`"fin"` のときだけ `closedSubgroups` に追加する。
`PublisherImpl` に `endOfGroupSentGroupId: number | null` を追加し、`sendObject` が END_OF_GROUP を受理した時点で
Group ID を記録 (委譲先の失敗時は取り消して再送可能)、`guardSend(kind, groupId)` で同一 Group への後続
`sendObject` / `sendDatagram` を `ProtocolViolationError` として拒否する。`markClosed()` で `null` に戻す。

### テスト

`src/session/publishSubgroupClose.test.ts` を新設し、実 WritableStream の sink で `close` (FIN) と `abort` (RESET) を
区別して 6 点を検証する。省略は公開経路 (`PublisherImpl.sendObject`) から駆動する。

1. 省略した Subgroup は Group 変更で RESET (`abortReasons[0] === "subgroup omitted objects"`、`closedSubgroups` 未登録)
2. 省略のない Subgroup は Group 変更で FIN (`closedSubgroups` 登録)
3. 省略した Subgroup は `done()` で RESET
4. END_OF_GROUP で FIN され、同一 Group への後続 `sendObject` が `ProtocolViolationError` で拒否され、別 Group へは送信できる
5. 省略がある END_OF_GROUP は RESET
6. peer cancel (`publishResetPublisherStream`) の RESET は不変

`PublisherStreamState` の型変更に追随して `src/session/bidiReadRequestStreamMessages.test.ts` /
`src/session/bidiSubscribeFinReset.test.ts` / `src/session/publish.test.ts` のストリーム状態リテラルに
`omittedObjects: false` を追加した。あわせて `issues/pending/0366-add-delivery-timeout-enforcement.md` の
「END_OF_GROUP 送信ではストリームを閉じない」前提を更新する注記を追加した。

検証は `pnpm exec tsc --noEmit` / `pnpm exec vp check` / `pnpm test --run` (2275 passed) の通過で確認した。
