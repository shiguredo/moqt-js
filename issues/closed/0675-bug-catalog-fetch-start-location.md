# 後着の購読者が catalog の FETCH で最新 Group を取得できない

- Created: 2026-09-22
- Completed: 2026-09-22
- Branch: feature/fix-catalog-fetch-start-location
- Polished: {YYYY-MM-DD}

## 目的

配信が始まってから視聴を始めた subscriber が、catalog を取得できずに購読を
開始できない経路がある。catalog を FETCH するときの要求範囲が、relay の object
cache が覆える範囲と一致していないためである。

draft-ietf-moq-transport-21 §7.1 は relay が Object を cache してよい (MAY) とし、
cache を持つ relay は購読が確立した時点で cache が持つ最新 Group の先頭から
下流へ配る。catalog の live 購読 (Next Object) では既存の catalog は届かないため、
後着の subscriber は FETCH で既存 catalog を取得する。この FETCH が cache で
覆えない範囲を要求すると、relay は上流へ転送する。上流の publisher が FETCH に
応答しない場合 (本リポジトリの publisher は §1.5 の SHOULD に従って
REQUEST_ERROR (NOT_SUPPORTED) を返す)、catalog は届かず catalog 受信タイムアウトで
購読が失敗する。

## 現状

- `src/createMediaSubscriber.ts` の `subscribeCatalog` は、catalog を 2 経路で
  取得する。Next Object 形式の Location Filter で live 更新を購読し、独立した
  FETCH で既存 catalog を取得する。FETCH はフィルタ無し = `{0, 0}` から
  Largest Object までを要求する
- `devtools/src/hooks/useSubscriber.ts` の `handleCatalogSubscribed` も同じ 2 経路を
  持つ。こちらも FETCH はフィルタ無しで要求する
- catalog track の Group ID は publisher の再起動を跨いだ単調増加 MUST
  (draft-ietf-moq-msf-01 §6.1) を満たすため Unix epoch ミリ秒から始まる。
  `devtools/src/hooks/usePublisher.ts` の `startPublishing` は `Date.now()` を
  開始値にし、Forward State が 1 になった時点で次の Group として送り直す
- `{0, 0}` 起点の要求範囲は Group 0 から Largest Object までになる。cache が持つ
  のは Group ID が大きい最新 Group だけなので、relay はこの範囲を cache だけで
  覆えない (§7.1 の cache は「cache が持つ最新 Group の先頭から配る」「cache だけで
  要求範囲を覆える FETCH に応答する」という形で下流から観測できる)
- SUBSCRIBE_OK は LARGEST_OBJECT を運び (`src/session/bidi.ts`)、
  `Subscriber.largestLocation` から最新 Group が分かる。しかし FETCH では
  これを使っていない
- 再現: devtools publisher → relay (object cache 有効) → 後着の subscriber の
  経路で、後着の subscriber が
  `failed to get catalog: catalog subscription did not complete within 5000ms` で
  失敗する (実 Chromium の E2E で実測)
- `src/createMediaPublisher.ts` の `publishCatalog` は Group 0 Object 0 を送る。
  この publisher を相手にする場合も、Forward State 0 の間に送った Object は
  relay へ届かないため、Forward State が 1 になった時点の再送で Group が進む

## 設計方針

- 既存 catalog の FETCH の開始位置を「購読確立時の LARGEST_OBJECT が示す Group の
  先頭 Object」にする。catalog track は Group の先頭 Object が独立した catalog を
  持つ (draft-ietf-moq-msf-01 §5) ため、最新 Group の先頭から読めば完全な catalog が
  得られる。この範囲は cache が持つ最新 Group と一致する
- 規則は純関数 `catalogFetchFilter` として 1 箇所に置き、ライブラリ
  (`src/createMediaSubscriber.ts`) と devtools (`devtools/src/hooks/useSubscriber.ts`)
  の両方から呼ぶ。`src/index.ts` から公開する
- LARGEST_OBJECT が不明な場合はフィルタを付けない (従来どおり `{0, 0}` から
  Largest Object まで)。Group 0 のときもフィルタを付けない。§9.20.10 は 2 フィールドで
  StartGroup = StartObject = 0 を Next Object と定めており、Group 0 では絶対開始に
  ならないためである (Group 0 はフィルタ無しの要求範囲と一致する)
- 対象は catalog の FETCH のみとする。SUBSCRIBE の Next Object と live の経路は
  変えない
- 上流 publisher の FETCH 対応 (受信した双方向ストリームのリクエスト処理) は
  `issues/pending/0061-enhance-incoming-bidi-stream-handling.md` の担当とし、
  本 issue では扱わない
- `CHANGES.md` の `## develop` に `[FIX]` を追記する (セクション内は新しい順)

## 完了条件

- 後着の subscriber が FETCH で要求する範囲が、relay の cache が覆える範囲
  (LARGEST_OBJECT が示す Group の先頭から Largest Object まで) になる
- `catalogFetchFilter` が、LARGEST_OBJECT があるときは `{ startGroup: G, startObject: 0 }`
  を返し、LARGEST_OBJECT が無いときと Group 0 のときは undefined を返す
- `src/createMediaSubscriber.test.ts` に `catalogFetchFilter` の単体テストと、
  `subscribeCatalog` が FETCH に載せる filter のテストが追加される
- devtools とライブラリの両方の catalog FETCH が同じ規則を使う
- 実 Chromium の E2E で、devtools publisher の配信に後から参加した devtools
  subscriber が catalog を取得して object を受け取れる
- `vp check` / `vp test run` / `vp exec tsc --noEmit` が通る

## 参照

- draft-ietf-moq-transport-21 §7.1 (relay の cache。cache を使った配信は MAY)
- draft-ietf-moq-transport-21 §9.11 (FETCH) / §9.20.10 (LOCATION_FILTER。2 フィールドで
  StartGroup = StartObject = 0 は Next Object) / §9.20.18 (LARGEST_OBJECT) /
  §1.5 (未対応メッセージへの NOT_SUPPORTED)
- draft-ietf-moq-msf-01 §5 (Group の先頭 Object が独立した catalog を持つ) /
  §6.1 (Group ID の単調増加 MUST)
- `issues/closed/0624-bug-devtools-catalog-forward-resend.md` (devtools の catalog を
  Forward State 1 で送り直す変更。本 issue はその後着購読側の追補である)
- `issues/pending/0061-enhance-incoming-bidi-stream-handling.md` (受信 FETCH 未対応)

## 解決方法

- `src/createMediaSubscriber.ts` に純関数 `catalogFetchFilter` を追加した。購読確立時の
  LARGEST_OBJECT が示す Group の先頭 Object を開始位置として返し、LARGEST_OBJECT が
  不明な場合と Group 0 の場合は undefined (フィルタ無し) を返す
- `subscribeCatalog` (`src/createMediaSubscriber.ts`) と devtools の
  `handleCatalogSubscribed` (`devtools/src/hooks/useSubscriber.ts`) が、この開始位置で
  既存 catalog を FETCH するようにした。規則は 1 箇所に置き、`src/index.ts` から
  公開して両方から使う
- `src/createMediaSubscriber.test.ts` に `catalogFetchFilter` の単体テスト
  (LARGEST_OBJECT あり / Group 0 / 不明) と、`subscribeCatalog` が FETCH に載せる
  filter のテストを追加した
- リレーを挟んだ実 Chromium の E2E で、devtools publisher の配信に後から参加した
  devtools subscriber が catalog を取得し、映像 object を受け取って復号まで進む
  ことを確認した
- `CHANGES.md` の `## develop` に `[FIX]` を追記した

## 未対応

- 上流 publisher が受信 FETCH に応答する経路は
  `issues/pending/0061-enhance-incoming-bidi-stream-handling.md` の担当のままである。
  本 issue は cache が覆える範囲を要求することで、publisher の FETCH 対応に依存せず
  後着の購読を成立させた
