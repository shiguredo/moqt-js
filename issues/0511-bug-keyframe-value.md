# Request Keyframe の固定値送信で新規 Group が開始されない

- Created: 2026-09-06
- Completed: YYYY-MM-DD
- Branch: feature/fix-devtools-keyframe-value
- Polished: 2026-09-06

## 目的

キーフレーム要求ボタンが実質無機能である。現行 Group 体系で有効な値を送る必要がある。

## 現状

- `devtools/src/hooks/useSubscriber.ts` の `requestKeyframe` は `NEW_GROUP_REQUEST` の値を `1` 固定で送信する。
- ライブラリ正規経路 (`src/createMediaSubscriber.ts` の `requestKeyframe`) も `0x32`=`0x01` 固定のため、devtools 固有でなく共通の問題である。
- §10.2.19 では値は subscriber が知る最大 Group ID + 1 (情報なし時は `0`) である。`0` または現行 Group 超の値を dynamic Groups 対応の Original Publisher が受けると新規 Group 開始を `SHOULD` する (遅延 `MAY`、要求値との一致不要)。relay は Established 予約で non-zero かつ Largest Group 以下の値を upstream へ送らないため、時刻起点の巨大 Group ID に対する `1` は relay 時点で破棄され得る。
- `largestLocation` の live 値は両経路とも参照可能 (`Subscriber.largestLocation`) だが未使用である。devtools の signal 保持値は SUBSCRIBE 直後の snapshot のため stale になり得る。

## 設計方針

1. 送信時点の最新 Group ID + 1 (`Subscriber.largestLocation` の live 参照。情報なし時は `0`) を `encodeVarint` で符号化して送る (正規経路 `params.ts` と同一形式)。SUBSCRIBE 直後の snapshot は stale のため使わない。
2. ライブラリ正規経路と devtools を合わせて修正する (`DYNAMIC_GROUPS` 確認は両経路とも現状維持)。

## 完了条件

- 送信される `NEW_GROUP_REQUEST` 値が `0` または最新 Group ID + 1 であること (ライブラリ側は単体テスト、devtools 側は `0513` の方針に従う)。
- 新規 Group 開始の実効は publisher 側 `SHOULD` のため手動確認に留める。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 関連

- draft-ietf-moq-transport-20 §10.2.19
- `0513` (devtools 側の値検証テストの方針)
