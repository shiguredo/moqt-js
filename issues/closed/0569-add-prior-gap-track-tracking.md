# Prior Group ID Gap / Prior Object ID Gap の Track 横断追跡検証を実装する

- Created: 2026-09-10
- Completed: 2026-09-17
- Branch: feature/add-prior-gap-track-tracking
- Polished: 2026-09-17

## 目的

draft-ietf-moq-transport-21 §10.8 / §10.9 の malformed Track 条件のうち、複数 Object と Track 単位の受信状態を必要とする以下の 5 条件が未実装である。違反 Track を malformed として扱えず、§12.1 の MUST (購読 / FETCH の cancel) が機能しない。

- §10.8: A Group contains more than one Object with different values for Prior Group ID Gap
- §10.8: An endpoint receives an Object with a Prior Group ID Gap covering an Object it previously received
- §10.8: An endpoint receives an Object with a Group ID within a previously communicated gap
- §10.9: An endpoint receives an Object with a Prior Object ID Gap covering an Object it previously received
- §10.9: An endpoint receives an Object with an Object ID within a previously communicated gap

## 現状

- `src/properties.ts` の `assertPriorIdGapInObjectProperties` は単一 Object で判定できる「gap が Group ID / Object ID より大きい」のみ検証する。未実装の 5 条件は関数の doc コメントに列挙されている。
- 同一 Object 内の複数出現 (「An Object contains more than one instance of ...」) は実装済みであり、本 issue の対象ではない。`assertObjectPropertyList` が mutable list と IMMUTABLE_PROPERTIES 配下を合算して数え、2 個目で `MalformedTrackError` を送出する。
- Track 単位で「受信済み Object の Location」と「通知済み gap 範囲」を保持する状態がない。
- malformed 検出後の cancel は `src/session/bidi.ts` の `cancelMalformedTrackPeers` が Full Track Name 単位で購読 / FETCH を cancel する経路として既にある。pending の購読 / FETCH も対象に含む。
- 受信経路は subgroup / datagram / FETCH の 3 つで、いずれも Full Track Name を直接は持たない。subgroup は `SubgroupHeader.trackAlias`、datagram は `ObjectDatagram.trackAlias`、FETCH は `FetchHeader.requestId` を持つ。追跡状態を引くためのキーの作り方が未定である。

## 設計方針

1. 追跡状態のキーは `FullTrackNameKey` (`src/fullTrackName.ts` の `fullTrackNameKey` の戻り値) とする。状態は `SessionImpl` に `Map<FullTrackNameKey, PriorGapTracking>` として置き、issue 0561 の `receivedEndOfGroupFinalObjectIds` と同じく `SessionInternal` / `BidiSessionInternal` の双方へ宣言する。購読単位ではなく Track 単位に置くのは、同一 Track の複数購読 / FETCH をまたぐ必要があるためである。3 経路からキーを解決する方法は次のとおり。

   - subgroup: `src/session/incoming.ts` の `incomingProcessSubgroupObjects` で `header.trackAlias` から `session.subscribersByAlias` を引き、先頭の `SubscriberImpl.getFullTrackNameKey()` をキーとして `processSubgroupObjects` へ渡す。購読が特定できた場合のみ Object を decode するため、キーは必ず解決できる。
   - datagram: `incomingHandleDatagram` で同じ経路で解決する。`decodeObjectDatagram` は購読の解決より前に走るため、追跡検証は decode の後 (購読を解決した後) に行う。ただし `incomingHandleDatagram` の既存 catch を素通りさせないため、キーの解決は `decodeObjectDatagram` の前に `decodeDatagramTrackAlias` で行う (設計方針 6 を参照)。
   - FETCH: `FetcherImpl.getFullTrackNameKey()` を使う。`incomingProcessFetchObjects` は `FetchHeader` を受け取っていないため `trackKey` 引数を追加し、`SessionImpl.processFetchObjects` と `SessionImpl.handleFillFetchStream` (fill は `FillFetchTarget.subscriber.getFullTrackNameKey()`) の双方から渡す。

2. 状態は「受信済み Object の位置」と「通知済み gap の範囲」を次の粒度で保持する。1 次元の範囲と 2 要素の Location をそのまま比較してはならない。

   - 受信済み Group ID の集合 (subgroup / datagram / FETCH を問わず、検証を通った Object の Group ID を登録する)。
   - Group ID ごとの受信済み Object ID の集合。
   - 通知済み Prior Group ID Gap の範囲の集合 (`start` / `end` の 2 つの bigint で保持する)。
   - 通知済み Prior Object ID Gap の範囲を、通知元の Object の Group ID と対応付けて保持する (`group` / `start` / `end` の 3 つの bigint)。
   - Group ID ごとに、5 条件すべての検証を通った Object から最初に観測した Prior Group ID Gap の値。malformed と判定した Object の gap 値は含めない (含めると以降の正当な Object を条件 1 で誤検出する。条件 1 の記録条件を参照)。

3. 5 条件の判定式を次のとおり定める。判定はすべて bigint の比較で行い、範囲を配列として実体化しない (`src/properties.ts` の `calculateSkippedGroups` / `calculateSkippedObjects` はスキップされた ID を配列として実体化するため、受信値に対しては呼ばない。gap は varint で最大 2^64-1 であり、Group ID 10 で gap = 2^32 の Object を受信すると数十億要素の確保を試みて受信経路が停止する)。

   - 条件 1 (同一 Group 内で異なる Prior Group ID Gap 値): 受信した Object が Prior Group ID Gap を持ち、その Group ID について保持している最初の観測値と異なる場合に malformed とする。保持値が無ければその値を最初の観測値として記録する。記録するのは 5 条件すべての検証を通った Object の gap 値だけであり、malformed と判定した Object の gap 値は最初の観測値として記録しない (記録すると以降の正当な Object を条件 1 で誤検出する)。gap を持たない Object は比較対象にも記録対象にもしない。
   - 条件 2 (gap が過去に受信した Object を覆う): Prior Group ID Gap では、受信済み Group ID の集合に `[現在の Group ID - gap, 現在の Group ID - 1]` に含まれる値がある場合に malformed とする。Prior Object ID Gap では、受信済み Object ID の集合のうち現在の Group ID に対応するものに `[現在の Object ID - gap, 現在の Object ID - 1]` に含まれる値がある場合に malformed とする。§10.9 の例は「Group 3 の中で Object 8, 9 が存在しない」と述べており、Object ID の範囲は現在の Object を含む Group の中でだけ意味を持つ。Group ID が異なる受信済み Object ID と比較してはならない。
   - 条件 3 (過去に通知された gap 内の ID): Prior Group ID Gap では、受信した Object の Group ID が通知済みの範囲 `[G - gap, G - 1]` に含まれる場合に malformed とする。Prior Object ID Gap では、受信した Object の Group ID が通知元の Group ID と一致し、かつ Object ID が通知済みの範囲 `[O - gap, O - 1]` に含まれる場合に malformed とする。Group ID をまたいで Object ID を比較してはならない。
   - 条件 4 / 5 (§10.9 の条件 2 と 3): 上記の Prior Object ID Gap 側の判定がそのまま対応する。

4. gap の値は mutable list と IMMUTABLE_PROPERTIES 配下の双方から取り出す (§10.7 の「processors MUST search both the mutable properties and the contents of Immutable Properties.」)。既存の `assertPriorIdGapInProperties` と同じ探索を行う。

5. 判定順序は次のとおり。既存の単一 Object 検証 (同一 Object 内の複数出現、gap > Group ID / gap > Object ID) を必ず先に通す。gap > Group ID の Object では範囲の下限が負になり、追跡判定が成立しないためである。その後に上記 5 条件を判定し、配送前に `MalformedTrackError` を投げる。malformed となった Object は受信済みとして登録しない。検証を通った Object だけを受信済みとして登録する。

6. 検出時は `MalformedTrackError` を投げ、既存の malformed 処理 (`cancelMalformedTrackPeers` 等) に乗せる。セッションは閉じない。経路ごとの到達先は次のとおり。

   - subgroup: `src/session/stream.ts` の `processSubgroupObjects` のループ内、既存の `assertPriorIdGapInObjectProperties` の直後・subscriber への配送前に追跡検証を行い throw する。throw は `SessionImpl.handleSubgroupStream` の catch が受け、`handleMalformedSubgroupTrack` から `cancelMalformedTrackPeers` を呼ぶ。
   - datagram: `incomingHandleDatagram` の既存 catch は `decodeObjectDatagram(data)` だけを囲むため、購読解決後に検証すると throw がこの catch を素通りし、`SessionImpl.startDatagramLoop` の catch が datagram 受信ループごと終了させる (§12.1 の cancel が行われない)。これを避けるため、キーの解決 (`decodeDatagramTrackAlias` で alias を取り、`subscribersByAlias` から `FullTrackNameKey` を引く) を try の前で行い、追跡検証を既存 try の内側 (`decodeObjectDatagram` の後) に置く。これにより既存 catch が `MalformedTrackError` を受け、`cancelMalformedTrackPeers` を呼ぶ。キーを解決できない datagram では検証しない。
   - FETCH: `handleIncomingStreamError` から `handleMalformedFetchTrack` が `cancelMalformedTrackPeers` を呼ぶ。
   - fill: `handleFillFetchStream` の catch が `cancelMalformedTrackPeers` を呼ぶ。

   追跡検証の呼び出し位置は session 層に置く。`src/dataStream/` 配下の純粋デコーダ (`decodeObjectDatagram` / `decodeFetchObjectFields`) は現行の単一 Object 検証 (`assertPriorIdGapInObjectProperties`) をそのまま持ち、追跡検証は追加しない (既存の検証を二重に呼ばないため)。subgroup と FETCH は Object の decode が `src/session/stream.ts` のループ内にあるため、`processSubgroupObjects` / `processFetchObjects` に追跡状態を引数で渡し、ループ内の配送前に検証する (issue 0561 が `processSubgroupObjects` に第 8 引数 `endOfGroup` を追加したのと同じ形。`incomingProcessSubgroupObjects` は `streamProcessSubgroupObjects` へ buffer を 1 回渡すだけの薄いブリッジで Object 単位の制御を持たないため、この層では検証できない)。FETCH では `incomingProcessFetchObjects` に `trackKey` 引数を追加して `processFetchObjects` へ渡す。datagram は `incomingHandleDatagram` で `decodeObjectDatagram` が返す `datagram.properties` を使って検証する。

7. 追跡状態のメモリ上限と破棄タイミングを定める。上限は Track ごとに保持する Group 数と Object 数、通知済み gap 範囲の数、およびセッション全体の Track エントリ数で定める (例: 各 1024、Track エントリは 1024)。上限を超えた場合は最古のエントリから破棄し、破棄した範囲では覆い判定ができないことをコメントで明記する。破棄タイミングは「その Track の購読と FETCH が 1 つも残っていない時点」とする。購読が尽きた時点で `subscribersByAlias` から当該 Track の購読が消えていても、`session.fetchers` に `getFullTrackNameKey()` が一致する FETCH が残っていれば破棄しない (FETCH は `trackAlias` を持たないため、購読の消滅だけでは Track の生存を判定できない)。FETCH の終了 (`bidiCancelFetch` / FIN 時の `fetchers.delete`) と購読の終了 (`deleteSubscriber` / `bidiCancelSubscription`) の双方で、購読と FETCH の残存を確認してから購読が尽きた Track のエントリを削除する (issue 0561 の `clearEndOfGroupTracking` は trackAlias 単位で購読の消滅だけを条件にするが、本状態は Track 単位のため同じ条件は使えない)。セッション終了時は `close()` で `receivedEndOfGroupFinalObjectIds.clear()` と並べて全消しする。

8. 対象範囲をコメントで明記する。datagram 経路は `decodeDatagramTrackAlias` で alias を特定でき、かつ `subscribersByAlias` に購読がある場合のみキーを解決でき、その場合だけ検証する (alias 不明・購読 0 件は対象外)。subgroup 経路は購読を特定できた場合のみ Object を decode し、FETCH 経路は fetcher を解決できない場合に Object を decode しないため、いずれも cancel まで到達する。

## 完了条件

- 上記 5 条件それぞれについて malformed として検出されること。
- 検出時に同一 Track の購読 / FETCH が cancel され、セッションは閉じないこと。
- 正常系で誤検出しないこと。少なくとも「Group が異なれば同じ Prior Object ID Gap 値でも誤検出しない」「gap = Group ID / gap = Object ID の境界値で誤検出しない」「gap を持たない Object が挟まっても誤検出しない」「同じ gap 値の反復で誤検出しない」を含めること。
- 上記を検証するテストがあること。判定ロジックの単体テストは新規モジュール `src/session/priorGapTracking.ts` と同名の `src/session/priorGapTracking.test.ts` に置く。3 経路の検証とキー解決は `src/session/incoming.test.ts` に追加し、モックセッションへ追跡マップを追加する (issue 0561 が `receivedEndOfGroupFinalObjectIds` で行ったのと同じ形)。cancel まで含む確認は `src/session.test.ts` に追加する。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。
- `CHANGES.md` の `## develop` に `[ADD]` があること。

## 参照

- `refs/moq/draft-ietf-moq-transport-21.txt` §10.8 / §10.9 (Prior Group ID Gap / Prior Object ID Gap) / §10.7 (Immutable Properties) / §12.1 (Malformed Tracks)
- `assertPriorIdGapInObjectProperties` / `assertPriorIdGapInProperties` / `assertObjectPropertyList` (`src/properties.ts`)
- `cancelMalformedTrackPeers` (`src/session/bidi.ts`)、`clearEndOfGroupTracking` (`src/session/bidi.ts`)
- `incomingProcessSubgroupObjects` / `incomingHandleDatagram` / `incomingProcessFetchObjects` (`src/session/incoming.ts`)、`processSubgroupObjects` / `handleSubgroupStream` / `processFetchObjects` / `handleFillFetchStream` (`src/session.ts`)
- `getFullTrackNameKey` (`src/subscriber.ts` / `src/fetcher.ts`)、`fullTrackNameKey` (`src/fullTrackName.ts`)
- `issues/closed/0568-bug-prior-gap-duplicate-not-detected.md` (closed。同一 Object 内の出現回数。本 issue は Track 横断)
- `issues/closed/0561-add-end-of-group-tracking.md` (closed。同じく Track 横断の malformed 追跡。`receivedEndOfGroupFinalObjectIds` / `clearEndOfGroupTracking` の前例)

## 解決方法

設計方針 1〜8 に従い、Track 単位の追跡状態を追加して 5 条件を検出するようにした。

### 追跡状態

- `src/session/priorGapTracking.ts` を新設し、`PriorGapTracking` (受信済み Group ID、Group ごとの受信済み Object ID、通知済み Prior Group ID Gap / Prior Object ID Gap の範囲、Group ごとに最初に観測した Prior Group ID Gap 値) と `assertNoPriorIdGapTrackViolation` を実装した。判定はすべて bigint の範囲比較で行い、スキップされた ID を配列として実体化しない (`calculateSkippedGroups` / `calculateSkippedObjects` は受信値に対して呼ばない)。
- 追跡は `SessionImpl` の `priorGapTrackingByTrack: Map<FullTrackNameKey, PriorGapTracking>` に置き、`BidiSessionInternal` へ宣言した (`SessionInternal` は継承する)。キーは `fullTrackNameKey` が生成する比較キーであり、購読単位ではなく Track 単位にした。
- 上限は Group 1024 / Group ごとの Object 1024 / 通知済み範囲 1024 / Track エントリ 1024 とし、超過時は最古のエントリから破棄する。破棄した範囲では覆い判定 (条件 2) と同一 Group 内の gap 値の比較 (条件 1) ができないことをコメントで明記した。同じ範囲の再通知は集合として 1 件にまとめ、空の範囲 (gap = 0) は保持しない。
- 破棄は購読と FETCH が尽きた時点で行う。`clearPriorGapTrackingIfUnused` が `subscribersByAlias` と `fetchers` の残存を確認し、`deleteSubscriber` / `bidiCancelSubscription` / `bidiCancelFetch` / FETCH の FIN 時 / peer RESET_STREAM 時から呼ぶ。セッション終了時は `close()` の `receivedEndOfGroupFinalObjectIds.clear()` の並びで全消しする。

### 受信経路

- subgroup: `incomingProcessSubgroupObjects` が `header.trackAlias` から `subscribersByAlias` を引いて先頭の購読の `getFullTrackNameKey()` を解決し、`processSubgroupObjects` のループ内で `assertPriorIdGapInObjectProperties` の直後・配送前に検証する。
- datagram: `incomingHandleDatagram` で `decodeObjectDatagram` の前に `decodeDatagramTrackAlias` から比較キーを解決し、追跡検証を既存 try の内側 (`decodeObjectDatagram` の直後) に置いた。これにより `MalformedTrackError` が既存 catch で処理され、`cancelMalformedTrackPeers` まで到達する。alias 不明・購読 0 件の datagram は検証しない。
- FETCH: `incomingProcessFetchObjects` に `trackKey` 引数を追加し、`SessionImpl.processFetchObjects` が `FetcherImpl.getFullTrackNameKey()`、`handleFillFetchStream` が `FillFetchTarget.subscriber.getFullTrackNameKey()` を渡す。検証は `processFetchObjects` のループ内で配送前に行う (End of Range は Object ではないため対象外)。
- 単一 Object で判定できる条件 (同一 Object 内の複数出現、gap > Group ID / gap > Object ID) は既存のデコード経路の検証に任せ、追跡検証からは重複して呼ばない。`src/dataStream/` 配下の純粋デコーダは変更していない。

### テスト

- `src/session/priorGapTracking.test.ts` を新設し、5 条件の検出、malformed と判定した Object の gap 値を最初の観測値にしないこと、IMMUTABLE_PROPERTIES 配下の gap の取り出し、誤検出しないケース (Group をまたいだ Object ID の比較、gap = Group ID / gap = Object ID の境界値と gap = 0、gap を持たない Object の挿入、同じ gap 値の反復、別 Track)、上限 4 種の破棄を検証する 16 件を追加した。
- `src/session/incoming.test.ts` のモックセッションへ追跡マップを追加し、datagram 経路の検出と購読 cancel / 購読の無い alias の対象外、subgroup 経路の比較キー解決と Subgroup ストリームをまたいだ検出、FETCH 経路の `trackKey` の受け渡しを検証する 4 件を追加した。
- `src/session.test.ts` に、subgroup / FETCH / fill の 3 経路で検出時に同一 Track の購読と FETCH が cancel されセッションを閉じないこと、FETCH が残っている間は購読の終了で追跡状態を破棄しないことを検証する 4 件を追加した。

## 検証

- `vp check` / `tsc --noEmit` / `vp run build` すべて成功
- `vp test run`: 104 ファイル / 2,318 テスト全通過 (追加した 24 件を含む)
- 差分: 12 ファイル (本 issue ファイルを含む)、+1,678 / -7 行
