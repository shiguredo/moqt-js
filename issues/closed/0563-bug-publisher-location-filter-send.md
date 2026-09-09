# Publisher が購読の Location Filter を送信 Object に適用する

- Created: 2026-09-09
- Completed: 2026-09-09
- Branch: feature/fix-publisher-location-filter
- Polished: 2026-09-09

## 目的

draft-ietf-moq-transport-21 §3.3.1 は publisher に対し「A publisher MUST NOT send subscription-delivered objects from outside the requested range.」を課す。現状は購読の Location Filter を保持しているのに送信 Object の判定に使っておらず、要求範囲外の Object も配信してしまう。

## 現状

- `src/publisher.ts` の `PublisherImpl` は REQUEST_UPDATE で受信した購読の Location Filter を `setLocationFilter` / `getResolvedLocationFilter` で解決済み（`ResolvedFilter`）として保持しているが、参照箇所は fill 範囲の評価（`src/session/bidi.ts` の `applyPublishRequestUpdate`）に限られる。
- `PublisherImpl.sendObject` / `sendDatagram` は `publisherState` / `publisherForwardState` / `endOfTrackSent` のみを検証し、`subscriptionLocationFilter` を参照しない。Forward State = 0 では送信を止めるが、Location Filter による範囲制御は行わない。
- `src/filter.ts` の `objectMatchesFilter` が `ResolvedFilter` に対する Location 通過判定を提供している。
- SUBSCRIBE 受信は `NOT_SUPPORTED` で拒否されるため、購読の Location Filter は REQUEST_UPDATE 経由でのみ届く。フィルタ未受信時は全 Object 通過でよい。
- 現行実装は `publish()` 呼び出しごとに一意の track alias を採番して 1 つの `PublisherImpl` を生成し、受信 SUBSCRIBE も拒否するため、購読の Location Filter は publisher（= PUBLISH 要求）単位で 1 つに定まる。

## 設計方針

1. `PublisherImpl.sendObject` / `sendDatagram` で、送信対象の Location が `getResolvedLocationFilter()` を `objectMatchesFilter` で通過するか判定し、不通過なら送信しない。
2. 判定位置は `endOfTrackSent` の検証後、`recordLargestLocation` と送信委譲の前とする。END_OF_TRACK 後の呼び出しは従来どおり fail-fast で拒否し、既存の `Publisher` JSDoc の契約を変えない。
3. `groupId` / `objectId` は number のため、`BigInt` 変換は `recordLargestLocation` と同じ「非整数・負値は対象外」ガードの後に行う。範囲外 ID の fail-fast 検証は既存の送信経路（`publishSendObject` / `publishSendDatagram`）に委ね、`PublisherImpl` に新たな throw を追加しない。フィルタ未保持（`undefined`）のときは変換せず通過扱いにする。
4. 不通過時は Forward State = 0 と同じ扱いとする。`sendObject` は解決済みの `Promise<void>` を返してエラー通知しない（範囲外は正常なフィルタ動作）。`sendDatagram` は何もせず return する。
5. Largest Object の記録と END_OF_TRACK の記録は実際に送信した Object のみを対象とし、不通過 Object では更新しない。その結果、不通過の END_OF_TRACK は記録されず、以降の送信が可能になる（「EOT を送信した後のみ拒否」という既存契約と整合する）。
6. `PublisherImpl.subscriptionLocationFilter` の JSDoc にある「送信 Object への適用は未実装」の記述を実装に合わせて更新する。
7. 範囲内 / 範囲外の `sendObject` / `sendDatagram` テストを追加する。

## 完了条件

- 保持済みの Location Filter の範囲外 Object が `sendObject` / `sendDatagram` で送信されないこと。
- 範囲内 Object は従来どおり送信されること。
- 不通過 Object で Largest Object / END_OF_TRACK の記録が更新されないこと。
- 非整数・負値 ID の既存 fail-fast 契約が変わらないこと。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 関連

- draft-ietf-moq-transport-21 §3.1 / §3.1.3 / §3.3.1 / §9.20.10 / §9.20.18 / §9.20.19
- `PublisherImpl.sendObject` / `sendDatagram` / `setLocationFilter` / `getResolvedLocationFilter`（`src/publisher.ts`）
- `objectMatchesFilter` / `ResolvedFilter`（`src/filter.ts`）
- `applyPublishRequestUpdate`（`src/session/bidi.ts`）
- `publishSendObject` / `publishSendDatagram`（`src/session/publish.ts`）

## 解決方法

publisher が購読の Location Filter の範囲外 Object を送信しないようにした。

- `src/publisher.ts` に `isOutsideLocationFilter` を追加し、`objectMatchesFilter` で範囲外を判定する。非整数・負値は `recordLargestLocation` と同じガードで除外し、フィルタ未保持時は全通過とする
- `PublisherImpl.sendObject` / `sendDatagram` で、`endOfTrackSent` の検証後・`recordLargestLocation` と送信委譲の前に範囲外をスキップする（`sendObject` は解決済み Promise、`sendDatagram` は return。エラー通知はしない）
- 範囲外 Object では Largest Object / END_OF_TRACK を記録しない
- `Publisher` インターフェースと実装の JSDoc、`subscriptionLocationFilter` のコメントを実装に合わせて更新する
- `src/publisher.test.ts` に範囲内 / 範囲外の送信有無・Largest Object 非更新・範囲外 END_OF_TRACK 非記録のテストを追加する
- `CHANGES.md` の `## develop` に `[FIX]` を追記する
