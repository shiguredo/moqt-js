# PUBLISH_STATE_NOTIFY の相対 LOCATION_FILTER を前回値と比較して再解決を避ける

- Created: 2026-09-09
- Completed: 2026-09-14
- Branch: feature/update-publish-state-notify-filter-compare
- Polished: YYYY-MM-DD

## 目的

draft-ietf-moq-transport-20 §10.10 は PUBLISH_STATE_NOTIFY が値の変化したパラメータのみを運ぶと定める。しかし現状は LOCATION_FILTER が届けば内容が同一でも再解決するため、LARGEST_OBJECT が進んだ後に不変の相対 Location Filter が再報告されると開始位置が前進し、Object を破棄し得る。適合 peer 前提では実害がないが、防御的に前回値との比較で再解決を避ける。

## 現状

- `src/session/bidi.ts` の `bidiHandlePublishStateNotify` は LARGEST_OBJECT を反映した後、LOCATION_FILTER が存在すれば無条件に `setLocationFilter` を呼ぶ。
- `src/subscriber.ts` の `setLocationFilter` は常に `resolvedFilterCache` を再計算する。

## 設計方針

1. 受信した LOCATION_FILTER が現在保持しているフィルタと等価なら再解決しない。
2. 等価判定の方法（構造比較または保持値の記録）は実装時に確定する。
3. 不変の相対 LOCATION_FILTER の再報告で開始位置が前進しないテストを追加する。

## 完了条件

- 不変の相対 LOCATION_FILTER を含む PUBLISH_STATE_NOTIFY で開始位置が前進しないこと。
- 変化した LOCATION_FILTER は従来どおり反映されること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 関連

- draft-ietf-moq-transport-20 §5.1.2 / §10.2.9 / §10.10
- `bidiHandlePublishStateNotify` / `setLocationFilter`

## 解決方法

実装した。issue の参照は draft-20 の節番号だが、現在の一次資料 draft-ietf-moq-transport-21 では §9.10 (PUBLISH_STATE_NOTIFY) / §9.20.10 (LOCATION FILTER Parameter) に対応するため、実装とコメントは draft-21 の節番号に合わせている。

### 等価判定の方法

「構造比較」を採用した。保持値の記録 (前回受信した生バイト列を保存して比較する等) は受信専用の状態を増やすうえ、同じフィルタがローカルで設定された場合 (SUBSCRIBE 送信時の `options.filter`、REQUEST_UPDATE 成功時の反映) を拾えない。`SubscriberImpl` が既に保持している `locationFilter` と比較するのが最も少ない状態で済む。

等価判定は `src/message/parameter.ts` の `isSameLocationFilter` に置いた。公開型 `LocationFilter` はフィールドの有無で表現が変わる (Length 0〜4) ため、フィールド列へ写す単射な正規化 (`locationFilterToFields`) を挟んで比較する。未設定 (undefined) 同士は等価、undefined と設定済みは非等価、`{ reset: true }` (Length 0) は空列として他と区別する。

`SubscriberImpl` に `getLocationFilter()` を追加した。`resolvedFilterCache` は解決時点の LARGEST_OBJECT に依存するため、生のフィルタを返す必要がある。`setLocationFilter` の JSDoc には、同じ内容での再設定が再解決を招くため呼び出し側で等価判定を行う旨を明記した。

### ガードの範囲

`bidiHandlePublishStateNotify` の LOCATION_FILTER 反映だけにガードを入れた。REQUEST_UPDATE_OK の反映は購読者が能動的に要求した変更であり、同じ値であっても再解決が要求の意味と一致するため対象外とした (issue も PUBLISH_STATE_NOTIFY に対象を限定している)。

LARGEST_OBJECT と FORWARD は値の代入のみで再解決を伴わないため、ガードを追加していない。

### テスト

- `src/session/bidi.test.ts` に 2 件追加。同じ相対 LOCATION_FILTER の再報告で開始 Group が前進しないこと (Group 10 の Object が配信される)、変化した LOCATION_FILTER は LARGEST_OBJECT で再解決されて反映されること (Group 10 は破棄、Group 21 は配信)。1 件目は修正前のコードで失敗することを実測した
- 検証は FIN の前に置いた。FIN は PUBLISH_DONE 無しの失敗扱いで購読を closed にするため (`notifySubscriberFailure`)、FIN 後は `handleObject` が何も配信しない。この順序を守るためのヘルパー `waitForMacrotask` を追加した
- `src/message/parameter.test.ts` に `isSameLocationFilter` の単体テスト 2 件を追加 (等価 6 ケース、非等価 6 ケース)

### 検証

- `vp check` / `tsc --noEmit` 通過
- `vp test run`: 70 ファイル / 2,126 テスト全通過
- `CHANGES.md` の `## develop` に `[UPDATE]` を追加した
