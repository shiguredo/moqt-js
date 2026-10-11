# createMediaSubscriber が moqt-devtools の publisher の catalog を受け取れず catalog receive timeout になる

- Created: 2026-09-25
- Completed: 2026-10-12
- Branch: feature/fix-media-subscriber-catalog-timeout
- Polished: 2026-09-28

## 目的

`examples/high-level-api` の受信 (`createMediaSubscriber`) で、手元の sora-moq の relay に moqt-devtools の publisher が配信しているトラックを購読すると、「catalog receive timeout」で止まる。高レベル API で受信できないと、利用者のアプリが moqt-devtools の配信を視聴できない。

moqt-devtools の publisher は、Forward State が 1 になったときに catalog を新しい Group で送り直す (closed の `0624`)。一方、ライブラリの publisher は catalog を送り直さないため、配信開始後に購読を始めた相手へ catalog が届かない (open の `0683`)。今回の再現は moqt-devtools の publisher が相手であり、`0683` と同じ説明では止まらない経路の疑いがある。ただし `0683` の追記のとおり、sora-moq の relay が prewarm などで Forward State を 1 に保つ場合や別の購読者が居続ける場合は Forward State が変わらず、moqt-devtools の publisher も catalog を送り直さず、`0683` と同じ停止になり得る。どちらの場合かを切り分ける。

## 現状

- 再現 (2026-09-25、手元の sora-moq の relay、Namespace `example`、トラック `video` / `audio`)
  1. moqt-devtools の publisher で、Namespace を `example` にして配信する (ダミー映像、ダミー音声)
  2. `examples/high-level-api` の Start Subscribe で購読する
  3. 5 秒後に「error: catalog receive timeout」になり、購読をやめる
- 同じ relay で moqt-devtools の subscriber は同じ配信を購読でき、catalog を受け取る
- `examples/high-level-api` 自身の `createMediaPublisher` で配信しても同じく止まる (こちらは `0683` で説明がつく)
- `src/createMediaSubscriber.ts` の `subscribeCatalog` は catalog トラックを Next Object の Location Filter で SUBSCRIBE し、`catalogFetchFilter` の範囲で FETCH する。moqt-devtools の subscriber (`devtools/src/hooks/useSubscriber.ts` の catalog 購読) は同じ組み合わせに加えて `rendezvousTimeout` を渡す。違いはまだ確かめていない
- コード上の差は `rendezvousTimeout` 以外にもある。ライブラリは FETCH フェーズ中は `tryResolveCatalog` が早期 return し、フェーズ終了 (`finishCatalogFetchPhase`) まで catalog を resolve しないのに対し、devtools は最初の完全な catalog の適用で resolve する。また、SUBSCRIBE_OK 前に REQUEST_ERROR を受けるとどちらも即時失敗になる (`src/session/requests.ts` の `requestsSubscribe`) ため、「catalog receive timeout」は SUBSCRIBE_OK を受けたうえで 5 秒以内に catalog の Object が届かなかったことを示す

## 設計方針

- relay とライブラリの両方のログで、catalog の SUBSCRIBE / FETCH と、publisher の catalog の送り直し (Forward State の変化) の順を追い、どこで catalog が届かなくなるかを確かめる
- ライブラリと devtools の catalog 購読の差 (現状の最後) が、届く / 届かないの違いと対応するかを確かめる
- 原因がライブラリにあれば直し、relay にあれば sora-moq の issue にする

## 完了条件

- 原因がライブラリ側か relay 側かが判明している。ライブラリ側なら修正し、relay 側なら sora-moq の issue を起票して、原因と確認手順を本 issue に残す
- 上の再現手順で、`createMediaSubscriber` が catalog を受け取り、映像と音声の購読を始める (relay 側が原因の場合は、sora-moq 側の修正後に同じ手順で確認してから closed にする)
- `vp check` / `tsc --noEmit` / `vp test run` / 既存の Playwright の E2E が通る

## 解決方法

- 原因はライブラリ側である。ライブラリは catalog の取得を SUBSCRIBE と FETCH の 2 経路で行うが、FETCH の応答 (end / error) が届くまで live の SUBSCRIBE で届いた catalog をバッファしたまま適用しない。このため FETCH が応答しない (応答が終わらない) リレーでは、受信できていた catalog を使わないまま受信タイムアウトになっていた
- 実リレーの計測 (2026-10-12、`moqt://sora-moq.shiguredo.co.jp/`) では、catalog の cache が無い構成 (moqt-devtools の publisher の `MAX_CACHE_DURATION` を 0 にしたもの) で FETCH の応答が返らず、期限の時点で `catalogFetchInProgress: true` のまま `catalog receive timeout` になった。また、LOCATION FILTER を省略した FETCH には 21.5 秒間応答が返らない (リレーが応答していないのか、応答がライブラリに届いていないのかの切り分けは未完了)
- 受信タイムアウトに達したら live のバッファをドレインし、フル catalog があれば resolve するようにした。これで FETCH の応答が終わらないリレーでも、受信済みの catalog を使える。ドレインは利用者コールバック (`onCatalog`) を呼ぶため、そこで throw しても `onError` へ流したうえで受信タイムアウトとして決着させ、開始がハングしないようにした
- フェーズ終了後に届いた FETCH のオブジェクトは適用しないようにした。FETCH が運ぶ Location は live の窓 (Next Object) より前のものか、live でも同じ Location が届く重複のどちらかであり、適用すると catalog が古い内容へ巻き戻り、delta の再適用はトラックの重複追加になり得るためである
- `catalogFetchFilter` は常に定義済みの Location Filter を返すようにした。`LARGEST_OBJECT` が不明なときと Group 0 のときも、フィルタ無しと同じ範囲 ({0, 0} から Largest Object まで) を絶対位置 {0, 0} の Location Filter Type 0x02 で明示する (draft-ietf-moq-transport-22 §9.20.9)。moqt-devtools の catalog 購読も同じ関数を使う。公開 API のため、戻り値の型が `LocationFilter | undefined` から `LocationFilter` に狭まり、`undefined` を「フィルタ無し」として扱っていたコードはフィルタを載せた FETCH を送るようになる (後方互換なし)
- 2026-09-25 の再現当時の原因は、draft-22 の LOCATION FILTER の形式 (先頭の Length を廃止し Location Filter Type が形式を明示する) にライブラリが追随していなかったことと整合する。当時のライブラリは catalog の live SUBSCRIBE の Next Object を 2 フィールドの 0:0 で表しており、draft-22 のリレーはこれを絶対位置 {0, 0} として扱うため catalog は live で届く一方、FETCH のフィルタは解釈されず、devtools の購読者は最初の 1 件で resolve して成功し、ライブラリだけが FETCH の終了を待って停止した、という説明が取れる。この不一致は 0796 (2026-10-02) で解消済みであり、現在の再現手順は成功する
- 残る制約: 期限のドレインで開始を続けた場合、応答が返らない FETCH は FETCH_OK を受けるまで保留のまま残る (Fetcher を取得できないため取り消す経路が無い)。受信したオブジェクトはフェーズ終了の判定で捨てる
- 触ったファイル: `src/createMediaSubscriber.ts`、`src/createMediaSubscriber.test.ts`、`devtools/src/hooks/useSubscriber.ts`、`docs/HIGH_LEVEL_API.md`、`docs/LOW_LEVEL_API.md`、`CHANGES.md`、`tests/e2e/relay/devtools-publisher-catalog.spec.ts`
- テスト: 単体テストで、受信タイムアウト時に live のフル catalog で resolve すること・delta だけなら失敗すること・フェーズ終了後に届いた FETCH のオブジェクトを適用しないこと・フェーズ終了後の live 更新は適用すること・`LARGEST_OBJECT` が不明 / Group 0 でも絶対位置 {0, 0} のフィルタを載せること・ドレイン中の `onCatalog` の例外を `onError` へ流してから失敗することを固定した。実リレーの E2E を追加し、moqt-devtools の publisher (ダミー映像 + ダミー音声) の catalog を `createMediaSubscriber` が受け取り、映像と音声の Object を受信することを固定した (手元の実リレーで 2.0 秒、映像 5〜6 件、音声 2〜4 件)。この E2E は 2 経路の疎通確認であり、ドレイン経路 (FETCH の応答が届かない場合) の回帰ガードではない (実リレーでは FETCH が期限内に応答するため)
- 確認: `vp check` / `vp exec tsc --noEmit` / `vp test run` (3868 件) / 実リレーの E2E (既存の `pubsub.spec.ts` を含む) が通る
