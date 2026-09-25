# devtools の publisher が catalog を配信の開始時にしか送らず、MAX_CACHE_DURATION を過ぎると後から購読を始めた相手が catalog を得られない

- Created: 2026-09-25
- Completed: 2026-09-25
- Branch: feature/fix-devtools-catalog-republish
- Polished: {YYYY-MM-DD}
- Reporter: @voluntas

## 目的

moqt-devtools で subscriber を停止して購読し直すと、`Failed: failed to get catalog: catalog subscription did not complete within 5000ms` になり、視聴を再開できないことがある。配信を始めてから、publisher が catalog に付けた MAX_CACHE_DURATION (既定 10 分、画面で 10 秒から選べる) を過ぎると、停止した後の購読し直しを含め、新しく購読を始めた相手は catalog を得られない。

draft-ietf-moq-transport-21 Section 10.3 は、relay が MAX_CACHE_DURATION を過ぎた Object を cache から配ることを禁じる (MUST NOT)。draft-ietf-moq-msf-01 Section 5.1 は、catalog を「配信網の cache から落ちうる時間が過ぎたら」publish し直すことを求める (SHOULD)。devtools の publisher はこれを行っていない。

## 現状

- `devtools/src/hooks/usePublisher.ts` の `startPublishing` は、catalog を配信の開始時に 1 回だけ送る (Group ID は Unix epoch ミリ秒)。送り直すのは、catalog の Forward State が 1 に変わったとき (`onForwardStateChange` から `sendCatalogUpdate`) だけである
- catalog の publish には、映像と音声と同じ `maxCacheDuration` (画面の MAX_CACHE_DURATION、既定 600000 ms) を付ける
- relay が購読者の居ない間も Forward State を 1 に保つ (sora-moq の prewarm) 場合や、別の購読者が居続ける場合は、Forward State が変わらないため catalog は送り直されない
- devtools の subscriber は catalog を SUBSCRIBE と FETCH で取りにいく。relay の cache に catalog が無いと FETCH は publisher へ転送され、devtools の publisher は受けた FETCH に応答しない (REQUEST_ERROR)。live の SUBSCRIBE にも catalog は届かず、5 秒の待ちで失敗する

再現 (2026-09-25):

- 手元の sora-moq relay (配備と同じ cache 設定、prewarm 有効) と配備 moqt-devtools で、MAX_CACHE_DURATION を 10 秒にして配信し、停止と購読し直しを 3 秒おきにくり返した。3 回目 (配信の開始から約 20 秒) で `failed to get catalog: catalog subscription did not complete within 5000ms` になった
- 配備 relay と配備 moqt-devtools でも、同じ条件の 3 回目で同じ失敗になった
- 既定 (10 分) のままでも、配信の開始から 10 分を過ぎると同じことが起きる

## 設計方針

- devtools の publisher は、catalog を最後に送ってから一定の時間が過ぎたら、新しい Group で送り直す (`sendCatalogUpdate` を使う。Group ID は前の Group の次)
- 間隔は catalog の MAX_CACHE_DURATION の半分とし、1 秒以上、30 秒以下に収める
  - 半分: relay は MAX_CACHE_DURATION を過ぎた catalog を配れない (Section 10.3)。その前に送り直す
  - 下限 1 秒: MAX_CACHE_DURATION が 0 (no cache) か小さいとき、relay は catalog を cache から配れない。後から購読を始めた相手は live で届く catalog を待つため、送り直しの間隔を devtools の catalog の待ち (既定 5 秒) より十分短くする。0 ms の繰り返しで送り続けない
  - 上限 30 秒: relay は MAX_CACHE_DURATION の前でも実装の制約で Object を捨てうる (Section 10.3 "until implementation constraints cause them to be evicted")。catalog が cache に無い時間を 30 秒以内に抑える
- Forward State の変化での送り直しも含め、catalog を送るたびに次の送り直しの時刻を決め直す
- 配信の停止と後始末 (`stopPublishing` / `cleanupPublisher`) でタイマーを止める

## 完了条件

- 間隔を決める関数の単体テストと PBT (間隔が 1 秒以上 30 秒以下で、MAX_CACHE_DURATION が 2 秒以上なら MAX_CACHE_DURATION より短い)
- sora-moq の相互運用 harness の E2E で、MAX_CACHE_DURATION を 10 秒にした devtools の publisher の配信に、配信の開始から 10 秒を過ぎてから devtools の subscriber が購読を始めても catalog を得て復号できることを確かめる。修正前はこの E2E が失敗することを確かめる
- `vp check` / `tsc --noEmit` / `vp test run` が通る

## 解決方法

- `devtools/src/utils/catalogRepublish.ts` に `catalogRepublishIntervalMs` を足した。catalog の MAX_CACHE_DURATION の半分を、1 秒 (`CATALOG_REPUBLISH_MIN_INTERVAL_MS`) 以上、30 秒 (`CATALOG_REPUBLISH_MAX_INTERVAL_MS`) 以下に収めて返す。負の値と整数でない値は例外にする
- `devtools/src/hooks/usePublisher.ts` は、配信の開始時に catalog を送った直後に送り直しを予約する (`startCatalogRepublish`)。`sendCatalogUpdate` は送るたびに予約し直す (`scheduleCatalogRepublish`)。Forward State の変化による送り直しも、同じ関数を通るので予約し直しになる。`stopPublishing` と `cleanupPublisher` で予約を取り消す (`cancelCatalogRepublish`)。publisher はページに 1 つなので、タイマーはモジュールで 1 つだけ持つ
- テスト: 単体テスト (`catalogRepublish.test.ts`) で 0、10 秒、下限の境界、既定の 10 分、不正な値を固定した。PBT (`catalogRepublish.prop.ts`) で、間隔が下限以上、上限以下の整数であることと、MAX_CACHE_DURATION が 2 秒以上なら MAX_CACHE_DURATION の半分以下であることを確かめた
- sora-moq の相互運用 harness に `test_devtools_subscriber_gets_catalog_after_max_cache_duration` を足した (sora-moq 94d398a9)。MAX_CACHE_DURATION を 10 秒にした devtools の publisher の配信に、開始から 12 秒後に視聴を始める。修正前は `failed to get catalog: catalog subscription did not complete within 5000ms` で失敗し、修正後は catalog を得て復号した
- 配備後 (2026-09-25) に、配備 relay と配備 moqt-devtools で MAX_CACHE_DURATION を 10 秒にし、停止と購読し直しを 3 秒おきに 4 回くり返した。修正前に失敗した 3 回目 (開始から約 20 秒) を含め、4 回とも catalog を得て復号した
- ライブラリの `createMediaPublisher` も catalog を 1 回しか送らない (MAX_CACHE_DURATION は 1 時間)。既存の 0683 (Forward State の変化で送り直さない) に、MAX_CACHE_DURATION を過ぎた後の送り直しも要ることを追記した
