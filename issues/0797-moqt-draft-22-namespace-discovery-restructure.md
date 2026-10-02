# Publisher and Namespace Discovery の再構成に追随する

- Created: 2026-10-02
- Completed: {YYYY-MM-DD}
- Branch: feature/update-namespace-discovery-sections
- Polished: {YYYY-MM-DD}

## 目的

draft-ietf-moq-transport-22 で名前空間まわりが再構成された。§4 は「Namespace Discovery」から「Publisher and Namespace Discovery」になり、Namespace Prefix Matching が §2.4.2 として独立し、SUBSCRIBE_TRACKS の意味論が §9.18.x から §3.6 (Subscribing to Tracks by Prefix) に移動した。moqt-js のコメントは v21 の節番号のままなので、誤った節を指す箇所を修正し、実装が新しい記述と整合することを確認する。

v21 と v22 の対応:

- §4.1 Subscribing to Namespaces (v21) → §4.2
- §4.2 Publishing Namespaces (v21) → §4.1
- §4.3 Filtering SUBSCRIBE_TRACKS (v21) → §3.6.1
- §4.3.1 Relay Resource Protection in Large Namespaces (v21) → §7.5
- §7.5 の Namespace Prefix Matching の記述 (v21) → §2.4.2
- §9.18.1 Parameters on SUBSCRIBE_TRACKS (v21) → §3.6.2

## 現状

- `src/session/namespaces.ts` / `src/session/params.ts` / `src/session/publicTypes.ts` は v21 の §4.1 / §4.2 / §4.3 / §4.3.1 を参照している。v22 では §4.3 は Namespace Discovery Example であり、参照先の内容が一致しない
- `src/session/params.ts` の `matchNamespacePrefix` / `namespacePrefixesOverlap` / `validateNamespacePrefixUpdate` が前方一致を実装している。§2.4.2 の例 (foo-bar--x が foo / foo-bar に一致し foobar に一致しない) と実装は整合する
- `buildSubscribeTracksParameters` / `namespacesSubscribeTracks` / `incomingPublishMatchToSubscription` は v21 §9.18.1 / §4.3 を参照している
- 初回の `subscribeTracks` 送信では既存 subscription との prefix overlap 検証を行わない。overlap 検証は REQUEST_UPDATE 送信経路 (`validateNamespacePrefixUpdate`) のみ。v22 §3.6 の PREFIX_OVERLAP は publisher が応答する MUST であり、subscriber 側の送信時検証は必須ではない

## 設計方針

- コメントの節番号を v22 に更新する (§2.4.2 / §4.1 / §4.2 / §3.6.x / §7.5 / §9.18)
- §2.4.2 の例 (フィールド単位の完全一致、prefix の長さの違い、先頭フィールドが異なる場合) を `matchNamespacePrefix` / `namespacePrefixesOverlap` のテストに追加して固定する
- v22 §3.6 の記述 (0 フィールドの prefix は全 Track、PREFIX_OVERLAP の応答、SUBSCRIBE_TRACKS のパラメータは SUBSCRIBE と同様、Skipped Tracks) と `namespacesSubscribeTracks` / `incomingPublishMatchToSubscription` / `onPublishSkipped` の対応を確認し、差異があれば別 issue として切り出す
- 初回 `subscribeTracks` の overlap 検証を足すかは、仕様の MUST が publisher 側であることを踏まえて判断する (この issue では必須としない)

## 完了条件

- コードコメントの節番号が v22 に対応している
- §2.4.2 の例がテストで固定されている
- SUBSCRIBE_TRACKS の意味論と実装の対応が確認され、差異の扱い (対応済み / 別 issue) が記録されている
- `vp check` / `tsc --noEmit` / `vp test run` が通る

## 参照

- draft-ietf-moq-transport-22 §2.4.2 (Namespace Prefix Matching) / §3.6-§3.6.3 (Subscribing to Tracks by Prefix) / §4 (Publisher and Namespace Discovery) / §9.18 (SUBSCRIBE_TRACKS) / §7.5 (Relay Resource Protection in Large Namespaces)
- `src/session/params.ts` の `matchNamespacePrefix` / `namespacePrefixesOverlap` / `validateNamespacePrefixUpdate` / `buildSubscribeTracksParameters`
- `src/session/namespaces.ts` の `namespacesSubscribeTracks` / `namespacesSubscribeNamespace`
- `src/session/incomingPublish.ts` の `incomingPublishMatchToSubscription`

## 解決方法

{未着手}
