# Publisher が購読の Location Filter を送信 Object に適用する

- Created: 2026-09-09
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-publisher-location-filter
- Polished: {YYYY-MM-DD}

## 目的

draft-ietf-moq-transport-21 §3.3.1 は publisher に対し「A publisher MUST NOT send subscription-delivered objects from outside the requested range.」を課す。現状は購読の Location Filter を保持しているのに送信 Object の判定に使っておらず、要求範囲外の Object も配信してしまう。

## 現状

- `src/publisher.ts` の `PublisherImpl` は REQUEST_UPDATE で受信した購読の Location Filter を `setLocationFilter` / `getResolvedLocationFilter` で解決済み（`ResolvedFilter`）として保持しているが、参照箇所は fill 範囲の評価（`src/session/bidi.ts` の `applyPublishRequestUpdate`）に限られる。
- `PublisherImpl.sendObject` / `sendDatagram` は `publisherState` / `publisherForwardState` / `endOfTrackSent` のみを検証し、`subscriptionLocationFilter` を参照しない。Forward State = 0 では送信を止めるが、Location Filter による範囲制御は行わない。
- `src/filter.ts` の `objectMatchesFilter` が `ResolvedFilter` に対する Location 通過判定を提供している。
- SUBSCRIBE 受信は `NOT_SUPPORTED` で拒否されるため、購読の Location Filter は REQUEST_UPDATE 経由でのみ届く。フィルタ未受信時は全 Object 通過でよい。
- publisher は track 単位で送信し、同一 track alias を複数購読が共有し得る。`subscriptionLocationFilter` は publisher ごとに 1 つであり、購読ごとのフィルタを区別できない。

## 設計方針

1. `PublisherImpl.sendObject` / `sendDatagram` で、送信対象の Location（`groupId` / `objectId`）が `getResolvedLocationFilter()` を `objectMatchesFilter` で通過するか判定し、不通過なら送信しない。
2. 不通過時は Forward State = 0 と同じ扱いとする。`sendObject` は解決済みの `Promise<void>` を返してエラー通知しない（範囲外は正常なフィルタ動作）。`sendDatagram` は何もせず return する。
3. Largest Object の記録（`recordLargestLocation`）と END_OF_TRACK の記録は実際に送信した Object のみを対象とし、不通過 Object では更新しない。
4. 同一 track alias を複数購読が共有する場合の意味論（最後に受理した REQUEST_UPDATE のフィルタで代表する現状の制約）をコメントに明記する。購読単位の区別が必要なら別 issue に分離する。
5. 範囲内 / 範囲外の `sendObject` / `sendDatagram` テストを追加する。

## 完了条件

- 保持済みの Location Filter の範囲外 Object が `sendObject` / `sendDatagram` で送信されないこと。
- 範囲内 Object は従来どおり送信されること。
- 不通過 Object で Largest Object / END_OF_TRACK の記録が更新されないこと。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 関連

- draft-ietf-moq-transport-21 §3.3.1 / §9.20.10
- `PublisherImpl.sendObject` / `sendDatagram` / `setLocationFilter` / `getResolvedLocationFilter`（`src/publisher.ts`）
- `objectMatchesFilter` / `ResolvedFilter`（`src/filter.ts`）
- `applyPublishRequestUpdate`（`src/session/bidi.ts`）
