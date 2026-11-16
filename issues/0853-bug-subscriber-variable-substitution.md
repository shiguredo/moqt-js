# 購読経路が §5.4 の変数置換を行わず、initRef が解決できない

- Created: 2026-10-14
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-subscriber-variable-substitution
- Polished: 2026-11-15

## 目的

§5.4 の変数 (`%name%`) は「delivery time に、catalog を取得した URI の fragment identifier から解決する」と定められる (§5.4.2)。配信側が変数入りの Catalog を送ることは仕様上想定されており、購読側は受け取った Catalog を fragment の値で置換してから使う必要がある。しかし本ライブラリの購読経路は置換を行わないため、変数入りの Catalog を購読すると `initRef` が未解決のまま復号器の初期化データが得られず、description 無しで configure へ進む。

本 issue は、devtools と `createMediaSubscriber` の購読経路を対象にする。devtools は `initRef` / `initDataList` から復号器の description を作るため initRef の未解決が起き、`createMediaSubscriber` は `authInfo` (`%c4m%` など) や `role` / `codec` などの string フィールドを Catalog から読むため、どちらも §5.4 の置換が必要である。

## 現状

- `devtools/src/hooks/useSubscriber.ts` の `processCatalogObject` は `decodeCatalogMessage` で Catalog を decode し、`instance.catalog.value` へそのまま入れる。`buildVideoDecoderConfig` は `resolveInitData` を直接呼び、Catalog の変数置換を行わない
- `initDataList` の id が具体的な値で `initRef` が `%name%` のとき、`resolveInitData` は一致する id を見つけられず `undefined` を返す。`buildVideoDecoderConfig` は description 無しで構成する。`initDataList` の id も `%name%` のときは、置換前でも同じ文字列として一致するため `undefined` にはならない
- `src/createMediaSubscriber.ts` は `initRef` / `initDataList` を参照しないが、`audioTrackInfo.authInfo` / `videoTrackInfo.authInfo` を `subscribeTrack` に渡す。`authInfo` は §5.2.43 により URI の fragment の変数で置換され、`%c4m%` を含み得る (§11.1.1 / 0780) ため、高レベル API でも変数置換が必要である
- `src/msf/variables.ts` の `resolveCatalogVariables` は §5.4 の置換を行うが、プロダクションコードからは呼ばれておらず、呼び出し元はテストと PBT だけである。`src/index.ts` にも再輸出されていない
- §5.4.2 の変数の出所は URI の fragment identifier (query parameter は MUST NOT)。`src/msf/fragment.ts` の `parseMsfFragmentValue` は `msf` fragment の value を解析し、parameter 列を返すが、parameter 列から変数名と値の対応 (`Record<string, string>`) を作る helper は無い
- 未置換の Catalog は配信側の `encodeCatalog` と購読側の `decodeCatalogMessage` を通る。どちらも `%` を含む initRef の参照切れ検証を skip するため、initRef が変数の Catalog はそのまま受理される (issues/closed/0692-bug-catalog-init-ref-substitution-revalidation.md の「残した課題」で確認済み)

## 設計方針

- fragment type が `msf` のとき、`parseMsfFragmentValue` が返す `parameters` から変数名と値の対応を作る helper (`parseMsfFragmentVariables` など) を `src/msf/fragment.ts` に足す。fragment の type (`msf`) と track-identifier は key-value ではないため変数にしない。fragment が無い、type が `msf` でない、parameter が無い場合は空の対応を返す。同一 key が複数ある場合は最初の値を使う (既存の `getConnectionParameter` / `getC4mParameter` と同じ)
- Catalog 内で `%name%` として参照されている parameter だけを `resolveCatalogVariables` に渡す。参照されていない予約キー (例: `location-range=34.0-64` の `.`) を §5.4.1 の値制約の検証に触れさせないためである。参照されている変数名を集める helper を `src/msf/variables.ts` に足し、走査対象は `resolveCatalogVariables` と同じ string フィールドにする。予約キーも §5.4.2 のとおり変数になり得る (`c4m` は §11.1.1 の予約パラメータであり、0780 の authInfo (`%c4m%`) で使う)
- 置換の適用位置は「Catalog を decode して受理した直後、保存する前」とする。devtools は `processCatalogObject` の `decodeCatalogMessage` の直後、`instance.catalog.value` へ入れる前、`createMediaSubscriber` は `processCatalogPayload` が Catalog を返す直前 (delta 適用後を含む) とする。置換後の Catalog の検証は `resolveCatalogVariables` の initRef の参照切れ検証 (0692) に限定する。置換で変わる role / codec の条件付き MUST (0854) と重複 (0855) は本 issue の対象外とする。delta の合成 (`applyCatalogDelta`) 自体の変数扱いは 0856 に委ね、本 issue は購読経路が delta 適用後の Catalog に置換を適用する範囲を扱う
- fragment に parameter が無い場合 (変数が 1 つも無い場合)、または Catalog に `%name%` 参照が無い場合は置換を skip する。これにより、変数を含まない Catalog は従来どおりの挙動になる。fragment に parameter があり、Catalog が `%name%` を参照している場合は、未定義の変数を空文字にする現挙動 (0692) に従う
- devtools の `useSubscriber` は、接続に使う MOQT URI (`resolveSubscriberConnectSettings` が返す `connectUrl`) から `normalizeMoqtUri` で fragment を取り出し、`parseMsfFragmentVariables` に渡す。候補を使う場合も、選んだ候補の URI の fragment になる
- `createMediaSubscriber` は、`createMediaSubscriber` に渡された URL から `normalizeMoqtUri` で fragment を取り出し、`MediaSubscriberImpl` が保持する。`processCatalogPayload` に変数を渡し、full / delta の両方の結果に置換を適用する
- 対象は `src/msf/fragment.ts` / `src/msf/variables.ts` / `devtools/src/hooks/useSubscriber.ts` / `src/createMediaSubscriber.ts` / テスト。helper は `src/msf.ts` から再輸出し、`src/index.ts` へは出さない (公開 API への追加は別途判断する)。`resolveCatalogVariables` は `src/msf.ts` で既に再輸出されている

## 完了条件

- 接続に使う MOQT URI の `msf` fragment に `init=<id>` があり、Catalog の `initRef` が `%init%`、`initDataList` の id が `<id>` のとき、`resolveInitData` がそのエントリの `data` (Base64) を返し、`buildVideoDecoderConfig` の `description` に復号した値が入る
- Catalog の `initDataList` の id も `%init%` のとき、置換後に id と initRef が一致し、`resolveInitData` が `data` を返す
- 高レベル API で、Catalog の `authInfo` (`%c4m%` など) や `role` / `codec` などの string フィールドが fragment の値で置換され、`onCatalog` / `getAuthorizationToken` に置換後の値が渡る
- fragment に parameter が無い場合、または Catalog に `%name%` 参照が無い場合は、置換を行わず従来どおりの挙動になる
- query parameter は変数に使わない (fragment のみを見る)
- fragment に parameter があり、初回の Catalog の置換後の initRef が参照切れのとき、`resolveCatalogVariables` が throw し、devtools / 高レベル API の購読の開始が失敗する。更新の Catalog では高レベル API の `onError` に通知され、devtools はエラーログに残る
- Catalog 内で参照されていない予約キー (例: `location-range=34.0-64`) は、§5.4.1 の値制約の検証で throw しない
- `npx vp check` / `npx tsc --noEmit` / `npx vp test --run` が通る

## 参照

- draft-ietf-moq-msf-02 §5.4 (Variable Substitution) / §5.4.1 (Variable Syntax) / §5.4.2 (Variable Resolution。fragment 由来のみ、query parameter は MUST NOT) / §5.2.14 (initRef) / §5.1.7 (initDataList) / §5.2.42 (Authorization Info) / §5.2.43 (Token Delivery via URI) / §11.1 (URI fragment) / §11.1.1 (Reserved fragment parameters)
- `src/msf/variables.ts` の `resolveCatalogVariables`
- `src/msf/fragment.ts` の `parseMsfFragmentValue`
- `src/msf/tracks.ts` の `resolveInitData`
- `src/createMediaSubscriber.ts` の `processCatalogPayload` / `handleCatalogObject`
- `src/mediaSubscriber/trackSubscriptions.ts` の `resolveAuthorizationToken`
- `devtools/src/hooks/useSubscriber.ts` の `buildVideoDecoderConfig` / `processCatalogObject`
- `devtools/src/signals/connectionSettings.ts` の `resolveConnectTarget` / `buildConnectUrl`
- `src/moqtUri.ts` の `normalizeMoqtUri`
- closed `0692-bug-catalog-init-ref-substitution-revalidation.md` (「残した課題」に本件がある)
- closed `0780-add-catalog-auth-info.md` (`authInfo` の `%c4m%` と §5.2.43)
- open `0856-bug-catalog-delta-variable-init-ref.md` (delta 合成自体の変数扱い)

## 解決方法

{未着手}
