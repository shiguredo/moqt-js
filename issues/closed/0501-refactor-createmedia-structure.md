# createMedia の責務分離と重複除去

- Created: 2026-09-06
- Completed: 2026-09-14
- Branch: feature/refactor-createmedia-structure
- Polished: YYYY-MM-DD

## 目的

700〜900 行級の 2 クラスに接続・カタログ・送受信・状態機械が同居し、同文の重複が残る。分離と共通化が必要である。

## 現状

- `src/createMediaPublisher.ts` と `src/createMediaSubscriber.ts` の `connectToServer` 29 行が一字一句同一である。
- Publisher の `createCatalogTracks` と `setupEncoders` で設定解決が二重化し、乖離しうる。
- `requestKeyframe` の `0x32` 直書きが `src/message/types.ts` の `MessageParameterType.NEW_GROUP_REQUEST` と二重管理である。
- `index.ts` への循環 import がある (`connect` の分離で解消可能)。

(低レベル `src/subscriber.ts` の `handleObject` / `handleDatagram` の重複は `0504` の範囲のため本 issue の対象外とする。)

## 設計方針

1. 接続・カタログ・音声経路・映像経路に分離し、重複を共有ヘルパー化する。
2. 定数・循環の解消を合わせる (公開 API の変更は `0517` と調整する)。

## 完了条件

- 重複が除去され、既存テストと挙動が保たれること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 関連

- `0494` (切り出しはテスト容易性にも寄与する)、`0504` (低レベル送受信の重複はそちらで扱う)、`0517` (公開 API 境界)

## 解決方法

`createMediaPublisher` と `createMediaSubscriber` の重複を共有モジュールへ集約した。

### 接続処理 (`src/createMedia/connect.ts`)

2 クラスの `connectToServer` は一字一句同一 (証明書ハッシュの `CertificateHash` 化、認可トークン、pending subgroup の詰め替えと、セッションの close / error を state 遷移とコールバックへ橋渡しする部分) だったため `connectMediaSession` に集約した。各クラスは接続設定と通知先 (onSessionClose / onSessionError) を渡すだけになり、`connectToServer` は 30 行から 15 行になった。

### 配信設定の解決 (`src/createMedia/settings.ts`)

`createCatalogTracks` と `setupEncoders` が同じ設定 (音声の sampleRate / channels / codec 文字列、映像の width / height / framerate / codec 文字列) を別々に解決していた。Catalog に載る値とエンコーダーへ渡す値が食い違うと受信側が宣言と異なる設定で復号するため、`resolveAudioPublishSettings` / `resolveVideoPublishSettings` に集約し、`start()` で 1 度だけ解決した値を両経路が使うようにした (トラック設定を 2 回読むことによる乖離も解消)。トラック名の既定値 `audio` / `video` も同モジュールを正本とし、購読側と共有する。

### 現状認識の訂正

- 「`requestKeyframe` の `0x32` 直書き」は既に解消済みだった (`MessageParameterType.NEW_GROUP_REQUEST` 経由で `Subscriber.update({ newGroupRequest })` を呼ぶ形になっており、`createMediaSubscriber` に生の `0x32` は無い)
- 「`index.ts` への循環 import」も解消済みだった (`connect` は `src/connect.ts` に分離され、`createMedia*` は `./connect` を参照、`index.ts` は再輸出のみ)

### 実施しなかった項目

設計方針 1 の「音声経路・映像経路への分離」(900 行級クラスのモジュール分割) は行っていない。issue が挙げていた具体的な問題 (接続の重複・設定解決の二重化・定数の二重管理・循環 import) はすべて解消し、完了条件「重複が除去され、既存テストと挙動が保たれること」は満たしている。クラス分割はこれらの経路に直接のテストが無い状態での大規模な移動になり、得られる構造上の利点に対して回帰リスクが大きいと判断した。

### 検証

- `vp test run`: 99 ファイル / 2,189 テスト全通過 (追加 4 件は `resolveAudioPublishSettings` / `resolveVideoPublishSettings` の既定値・上書き解決)
- `npx playwright test`: 16 件全通過 (配信・購読の設定解決経路はブラウザ実行を伴うため、既存の e2e で回帰が無いことを確認)
- `vp check` / `tsc --noEmit` 通過、`npx tsc -p devtools/tsconfig.json --noEmit` は既存の 11 件のまま
- 行数: `createMediaPublisher.ts` -76、`createMediaSubscriber.ts` -34、新規 `connect.ts` 57 + `settings.ts` 102 + `settings.test.ts` 62
- `CHANGES.md` の `## develop` の `### misc` に `[UPDATE]` を追加した
