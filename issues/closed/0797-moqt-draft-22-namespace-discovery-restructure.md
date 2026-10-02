# Publisher and Namespace Discovery の再構成に追随する

- Created: 2026-10-02
- Completed: 2026-10-03
- Branch: feature/update-namespace-discovery-sections
- Polished: 2026-10-02

## 目的

draft-ietf-moq-transport-22 で名前空間まわりが再構成された。§4 は「Namespace Discovery」から「Publisher and Namespace Discovery」になり、Namespace Prefix Matching が §2.4.2 として独立し、SUBSCRIBE_TRACKS の意味論が §9.18.x から §3.6 (Subscribing to Tracks by Prefix) に移動した。moqt-js のコメントは v21 の節番号のままなので、誤った節を指す箇所を修正し、実装が新しい記述と整合することを確認する。

対象は次の 2 種類の参照のみとする。1 つ目は節番号が v22 で移動した参照 (§2.4.2 / §2.4.3 / §3.6.x / §4.1 / §4.2 / §7.5 / §7.6) で、2 つ目は番号は変わらないが意味論が §3.6 へ移動した §9.18 / §9.19 を意味論の根拠として引く参照である。番号も意味論も変わっていない節 (§2.4.1 / §6.5 / §8.7 / §9.14 / §9.15 / §9.16 / §9.17 / §9.5.2 など) への参照は他の draft-22 対応 issue (0796 / 0798 / 0801 / 0803 など) の対象であり、本 issue では扱わない。

v21 と v22 の対応 (移動した節のみ):

- §2.4.2 Reserved Namespaces (v21) → §2.4.3 (Reserved Namespaces)
- §4.1 Subscribing to Namespaces (v21) → §4.2。ただし v21 の §4.1 が併記していた SUBSCRIBE_TRACKS の意味論 (ゼロフィールドは全 Track、PREFIX_OVERLAP、キャンセル) と PUBLISH_SKIPPED ("or any other reason") は §3.6 / §3.6.3 へ移動
- §4.2 Publishing Namespaces (v21) → §4.1
- §4.3 Filtering SUBSCRIBE_TRACKS (v21) → §3.6.1
- §4.3.1 Relay Resource Protection in Large Namespaces (v21) → §7.5
- §7.5 Publisher Interactions (v21) → §7.6 (Namespace Prefix Matching の記述は §2.4.2 へ)
- §9.18.1 Parameters on SUBSCRIBE_TRACKS (v21) → §3.6.2
- v22 で新設: §2.4.2 (Namespace Prefix Matching) / §3.6.3 (Skipped Tracks) / §4.3 (Namespace Discovery Example)

## 現状

実ファイルと照合した結果、参照の持ち主は次のとおり。

- `src/session/namespaces.ts`:
  - `namespacesSubscribeTracks` が §4.3 (Range Filter を送信できる) / §9.18.1 (GROUP_ORDER / FORWARD / Range Filters を送信可能) / §9.18 を参照している。v22 ではそれぞれ §3.6.1 / §3.6.2 / §9.18 が正しい
  - `namespacesCloseNamespaceSubscription` / `namespacesCloseTracksSubscription` が §4.1 のキャンセル記述を参照している。SUBSCRIBE_NAMESPACE は §4.2、SUBSCRIBE_TRACKS は §3.6 が正しい
  - `namespacesCloseNamespacePublication` が §4.2 を参照している。draft-21 のアーカイブ URL (#section-4.2) も同じ対応で更新が必要
  - 予約 namespace / .session の送信拒否 (3 箇所) が §2.4.2 / §6.5 を参照している。v22 では Reserved Namespaces は §2.4.3
- `src/session/params.ts`:
  - `buildSubscribeTracksParameters` が §9.18.1 / §4.3 を参照している → §3.6.2 / §3.6.1
  - `matchNamespacePrefix` / `namespacePrefixesOverlap` / `validateNamespacePrefixUpdate` が §9.18 / §9.5.2 を参照している。前方一致の定義の根拠は v22 では §2.4.2
  - Reserved Namespaces を §2.4.2 と参照している箇所 → §2.4.3
- `src/session/publicTypes.ts` の `SubscribeTracksOptions` が §9.18.1 を 2 箇所で参照している → §3.6.2。§4.x の参照はない
- `src/session/incomingPublish.ts` の `incomingPublishApplyParameters` が §9.18.1 (LOCATION_FILTER による join) を参照している → §3.6.2。モジュールヘッダーの §9.18 と、予約 namespace の §2.4.2 も対象
- `src/message/types.ts` / `src/message/namespace.ts` は PUBLISH_SKIPPED の "or any other reason" を §4.1 と参照している → §3.6.3 (Skipped Tracks)
- `src/createMediaPublisher.ts` / `src/createMediaPublisher.prop.ts` は §7.5 (Publisher Interactions) を参照している → §7.6
- 予約 namespace を §2.4.2 (Reserved Namespaces) と参照しているその他のファイル: `src/session/requests.ts` / `src/session/bidi.ts` / `src/session/incoming.ts` / `src/session/incoming.test.ts` / `src/message/parameter/trackNamespace.ts` / `src/message/parameter.test.ts` / `src/session/params.prop.ts`
- テストコメント: `src/session/params.test.ts` / `src/message/parameterScope.test.ts` の §9.18.1、`src/session.test.ts` / `src/session.ts` の §4.1 / §4.2 も同様に対応が必要

- `matchNamespacePrefix` / `namespacePrefixesOverlap` / `validateNamespacePrefixUpdate` はフィールド単位の完全一致で前方一致を判定している。v22 §2.4.2 の例 (Full Track Name foo-bar--x の namespace foo-bar が prefix foo / foo-bar に一致し foobar に一致しない) と実装は整合する
- 初回の `subscribeTracks` 送信 (`namespacesSubscribeTracks`) では既存 subscription との prefix overlap 検証を行わない。overlap 検証は REQUEST_UPDATE 送信経路 (`validateNamespacePrefixUpdate`) のみ。v22 §3.6 の PREFIX_OVERLAP は publisher が応答する MUST であり、subscriber 側の送信時検証は必須ではない

## 設計方針

- 移動した節への参照を上記対応表に従って v22 へ更新する (§2.4.3 / §3.6.x / §4.1 / §4.2 / §7.6)。draft-21 のアーカイブ URL も同じ対応で更新する
- §2.4.2 の例 (フィールド単位の完全一致、prefix の長さの違い、先頭フィールドが異なる場合、複数 namespace への一致) を `matchNamespacePrefix` / `namespacePrefixesOverlap` の単体テストで固定する (`src/session/params.test.ts`。foo-bar--x と example.2ecom-123 の 2 例を使う)
- v22 §3.6 の記述 (0 フィールドの prefix は全 Track、PREFIX_OVERLAP の応答、SUBSCRIBE_TRACKS のパラメータは SUBSCRIBE と同様、Skipped Tracks) と `namespacesSubscribeTracks` / `incomingPublishMatchToSubscription` / `onPublishSkipped` の対応を確認し、差異があれば別 issue として切り出す
- 初回 `subscribeTracks` の overlap 検証を足すかは、仕様の MUST が publisher 側であることを踏まえて判断する (この issue では必須としない)

## 完了条件

- 移動した節への参照 (§2.4.3 / §3.6.x / §4.1 / §4.2 / §7.6) がすべて v22 の正しい節を指している
- §2.4.2 の例がテストで固定されている
- SUBSCRIBE_TRACKS の意味論と実装の対応が確認され、差異の扱い (対応済み / 別 issue) が記録されている
- `vp check` / `tsc --noEmit` / `vp test run` が通る

## 参照

- draft-ietf-moq-transport-22 §2.4.2 (Namespace Prefix Matching) / §2.4.3 (Reserved Namespaces) / §3.6-§3.6.3 (Subscribing to Tracks by Prefix) / §4 (Publisher and Namespace Discovery) / §7.5 (Relay Resource Protection in Large Namespaces) / §7.6 (Publisher Interactions) / §9.18 (SUBSCRIBE_TRACKS)
- `src/session/params.ts` の `matchNamespacePrefix` / `namespacePrefixesOverlap` / `validateNamespacePrefixUpdate` / `buildSubscribeTracksParameters`
- `src/session/namespaces.ts` の `namespacesSubscribeTracks` / `namespacesSubscribeNamespace` / `namespacesCloseNamespaceSubscription` / `namespacesCloseTracksSubscription` / `namespacesCloseNamespacePublication`
- `src/session/incomingPublish.ts` の `incomingPublishMatchToSubscription` / `incomingPublishApplyParameters`
- `src/message/types.ts` / `src/message/namespace.ts` の PUBLISH_SKIPPED 周り / `src/createMediaPublisher.ts` の `resolveAudioConfigToSend`
- `src/session/params.test.ts` / `src/session/params.prop.ts`

## 解決方法

### 1. 移動した節への参照 (完了条件 a)

v21 と v22 の対応表に従い、`src` のコメントと `docs/HIGH_LEVEL_API.md` の節番号を更新した。draft のバージョン表記も、節番号を変えた行だけ 21 から 22 にした。

- Reserved Namespaces §2.4.2 → §2.4.3 (10 ファイル)
- Subscribing to Namespaces §4.1 → §4.2 / Publishing Namespaces §4.2 → §4.1 (購読と公開で入れ替わるため、行ごとに文脈を確認した。アーカイブ URL の `#section-4.2` も `#section-4.1` に更新)
- Filtering SUBSCRIBE_TRACKS §4.3 → §3.6.1 / Parameters on SUBSCRIBE_TRACKS §9.18.1 → §3.6.2 / Publisher Interactions §7.5 → §7.6
- SUBSCRIBE_TRACKS のキャンセルは §4.1 ではなく §3.6 (§4.2 は SUBSCRIBE_NAMESPACE 専用)
- PUBLISH_SKIPPED の "or any other reason" は §3.6.3 (Skipped Tracks)

番号が変わらない §9.18 / §9.19 でも、v22 で §3.6 / §3.6.3 へ移った意味論 (PUBLISH を新規双方向ストリームで送る、応答側の先頭メッセージの MUST、PUBLISH_SKIPPED の理由) を根拠にしている箇所は §3.6 系を指すようにした。メッセージ定義・フレーミング・コードポイントの引用は §9.18 / §9.19 のままでよい (番号は v22 でも同じ)。

あわせて、キャンセルの機構の記述を v22 に合わせた。v22 §6.4.2.3 のキャンセルは「まだ開いている方向を RESET_STREAM と STOP_SENDING で切る」であり、§6.4.2.2 は「FIN はキャンセルではない」と明記している。従来のコメントは「FIN または RESET_STREAM で閉じることでキャンセルできる」と書いており、実装 (`reader.cancel()` + `writer.abort()`) とも食い違っていた。

### 2. §2.4.2 の例のテスト (完了条件 b)

`src/session/params.test.ts` に `matchNamespacePrefix` / `namespacePrefixesOverlap` の単体テストを追加した (§8.8 の直列化形式で `foo-bar--x` は名前空間 (foo, bar) と Track 名 x、`example.2ecom-123` は名前空間 (example.com, 123) を表す)。

- `foo-bar--x` の名前空間は prefix (foo) と (foo, bar) に一致し、foobar には一致しない (フィールド単位の完全一致であり、文字列の前方一致ではない)
- prefix (example.com, 123) は (example.com, 123, 100) と (example.com, 123, 200) に一致する
- 先頭フィールドが異なる場合、prefix の方が長い場合、空の prefix の場合も固定した

### 3. SUBSCRIBE_TRACKS の意味論と実装の対応 (完了条件 c)

v22 §3.6〜§3.6.3 と実装を突き合わせた結果は次のとおり。差異はすべて「対応済み」または「本ライブラリの責務外」であり、別 issue は起こさない。

- 0 フィールドの prefix は全 Track: `matchNamespacePrefix` が空 prefix で名前空間全体を suffix として返し、送信側 (`validateTrackNamespaceForSend`) も空の名前空間を拒否しない。対応済み
- §3.6.1 Range Filter: SUBSCRIBE_TRACKS でも Range Filter を送信できる (`validateRangeFilterLimits` を SUBSCRIBE と共通で使う)。0796 で Location Filter のワイヤ形式も v22 に合わせた。対応済み
- §3.6.2 の初期パラメータ: 結果 PUBLISH の FORWARD / LARGEST_OBJECT / LOCATION_FILTER などを `incomingPublishApplyParameters` で購読へ反映する。対応済み
- §3.6.3 Skipped Tracks: 購読側は `onPublishSkipped` で通知し、`incomingPublishMatchToSubscription` は PUBLISH_SKIPPED の応答ストリームとは独立に PUBLISH を照合する。購読側の対応は完了
- publisher 側の MUST (SUBSCRIBE_TRACKS を受けた側の PREFIX_OVERLAP 応答、PUBLISH_SKIPPED 後に PUBLISH を送らない) は本ライブラリの責務外である。受信した SUBSCRIBE_TRACKS は unsupported request として扱う (`src/session/incoming.ts`)。relay の実装は対象外
- 初回 `subscribeTracks` の送信時に prefix overlap を事前検証しない判断も維持する。§3.6 の PREFIX_OVERLAP は publisher が応答する MUST であり、購読側の送信時検証は必須ではない。overlap の検証は REQUEST_UPDATE の送信経路 (`validateNamespacePrefixUpdate`) のみで行う

### 4. 検証

`vp check` / `tsc --noEmit` / `vp test run` (198 files / 3569 tests) が通る。`/review-diff-code` を 3 周回し、指摘はすべて反映した (最終周で致命的・重要 0 件)。CHANGES.md に [UPDATE] エントリを追加した (挙動は変えず、コメントとテストのみの変更)。

なお `src/session/incomingPublish.ts` の 1 行は §9.18.1 の更新と同じ行に §9.20.10 があり、版表記を 22 にした時点で v22 に存在しない番号になるため、同じ行の §9.20.9 (LOCATION FILTER) へ併せて直した。他の §9.20.x の参照は 0803 の担当のままである。
