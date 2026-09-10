# 受信 PUBLISH の LARGEST_OBJECT を抽出して相対 Location Filter を解決する

- Created: 2026-09-09
- Completed: 2026-09-11
- Branch: feature/fix-publish-largest-object-location-filter
- Polished: 2026-09-11

## 目的

draft-ietf-moq-transport-21 §9.20.18 は LARGEST_OBJECT が PUBLISH に出現し得ると定める。現状は受信 PUBLISH の LOCATION_FILTER を反映する際に LARGEST_OBJECT を抽出しないため、相対 Location Filter が `{0, 0}` のまま固定される。再現例: Next Object フィルタ（`{ startGroup: 0n, startObject: 0n }`）と LARGEST_OBJECT `{7, 2}` を同一 PUBLISH が運ぶ場合、正しい開始位置は `{7, 3}` だが現状は `{0, 0}` になる。開始位置が広がるため通常の受信ではデータ欠落は起きないが、fill を併用したときに subscription と fill の範囲が重なり、同一 Object が重複配信され得る。

## 現状

- `src/session.ts` の `applyIncomingPublishParameters` は LOCATION_FILTER と FORWARD のみを反映し、LARGEST_OBJECT を抽出しない。
- LARGEST_OBJECT は `src/message/parameterScope.ts` の `PUBLISH_ALLOWED_PARAMS` に含まれるため受理はされるが、購読へ反映されない。
- 相対 Location Filter は LARGEST_OBJECT 未受信のとき `resolveFilter` で `{0, 0}` に解決される。
- `src/subscriber.ts` の `resolveLocationFilter` は「LARGEST_OBJECT の更新だけでは再解決しない」契約であり、受信 PUBLISH で largest を設定しても自動では再解決されない。
- draft-ietf-moq-transport-21 §3.3.1 は、再順序や優先制御により LARGEST_OBJECT より小さい Location の Object が後から届き得るが「these Objects do not pass a filter that starts at the Next Object」と定める。`{0, 0}` 固定のフィルタはこれらを通過させてしまう。
- draft-ietf-moq-transport-21 §3.4 は「When the fill range overlaps the subscription's Location filter, an object can be both fill-delivered and subscription-delivered.」と定める。

## 設計方針

1. 受信 PUBLISH の LARGEST_OBJECT を抽出し（`src/session/params.ts` の `extractLargestLocation` を再利用）、`setLocationFilter` より先に `SubscriberImpl.setLargestLocation` へ設定して、フィルタ適用時に一度だけ LARGEST_OBJECT 基準で解決する。LOCATION_FILTER が無い場合は LARGEST_OBJECT の設定のみ行う。抽出・検証は既存の「反映前にすべての値をデコード・検証し、検証通過後にまとめて設定する」方針に合わせる。
2. 既存の `resolveLocationFilter` の契約（LARGEST_OBJECT 更新だけでは再解決しない）と整合させ、`setLocationFilter` 時の解決に一本化する（`resolveLocationFilter` の追加呼び出しは行わない）。
3. 受信 PUBLISH の相対 Location Filter が LARGEST_OBJECT 基準で解決されることを検証するテストを追加する。Next Object フィルタと LARGEST_OBJECT `{7, 2}` のとき開始位置が `{7, 3}` になり、開始位置より前の Object のみが不通過になることを確認する。

## 完了条件

- 受信 PUBLISH の相対 Location Filter が LARGEST_OBJECT 基準で解決されること（例: Next Object フィルタと LARGEST_OBJECT `{7, 2}` のとき開始位置が `{7, 3}`）。
- 修正後も正しい開始位置以降の Object がフィルタで落とされないこと（不通過になるのは開始位置より前の Object のみ）。
- `CHANGES.md` の `## develop` に `[FIX]` があること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 関連

- draft-ietf-moq-transport-21 §3.3.1 / §3.4 / §9.20.10 / §9.20.18
- `applyIncomingPublishParameters` / `setLocationFilter` / `setLargestLocation` / `resolveLocationFilter`
- `extractLargestLocation`（`src/session/params.ts`）/ `PUBLISH_ALLOWED_PARAMS`（`src/message/parameterScope.ts`）

## 解決方法

- `src/session.ts` の `applyIncomingPublishParameters` で受信 PUBLISH の LARGEST_OBJECT を抽出し、LOCATION_FILTER より先に `SubscriberImpl.setLargestLocation` で反映するようにした。相対 Location Filter は `setLocationFilter` 時の一度の解決で PUBLISH の LARGEST_OBJECT 基準に確定する
- `extractLargestLocation` の JSDoc、`Subscriber.largestLocation` / `setLargestLocation`、`resolveFilter` の基準値説明、`docs/LOW_LEVEL_API.md` の更新元一覧を実装に合わせて更新した
- `src/session.test.ts` に Next Object フィルタ / 1 フィールド相対フィルタが PUBLISH の LARGEST_OBJECT で解決されること、LARGEST_OBJECT 単独の反映、不正な LARGEST_OBJECT でセッションが閉じることを検証するテストを追加した
- `CHANGES.md` の `## develop` に `[FIX]` を追記した
- 検証: `vp check` / `tsc --noEmit` / `vp test run`（1952 tests）が通る
