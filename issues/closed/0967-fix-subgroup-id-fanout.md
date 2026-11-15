# SUBSCRIBE_TRACKS の結果 PUBLISH で同じ Object を異なる Subgroup ID で送らない

- Created: 2026-11-16
- Completed: 2026-11-16
- Branch: feature/fix-subgroup-id-fanout
- Polished: {YYYY-MM-DD}

## 目的

同じ Track の同じ (Group, Object) を複数の subscription へ送るとき、Subgroup ID と Publisher Priority を Track 全体で一致させる。

draft-ietf-moq-transport-23 §7.1 は「An endpoint that receives a duplicate Object with a different Delivery Mode, Subgroup ID, Priority or Payload MUST treat the track as Malformed.」と定め、§12.1 の 6 も同じ Object を異なる immutable properties で受けたら Malformed Track とする。現状はこの MUST に違反し、relay が MALFORMED_TRACK で下流の購読を終了させる。

## 現状

2026-11-16 の実測 (devtools publisher が SUBSCRIBE_TRACKS を受理し、同じ Track に 2 つの PUBLISH 購読ができた状態) で確認した。

- 起動時の video PUBLISH (trackAlias=1) は、Group G の先頭 Object ID 0 を Subgroup ID 0 として `FIRST_OBJ_EXT` で送る
- SUBSCRIBE_TRACKS の結果 PUBLISH (trackAlias=5) は、同じ Group G の途中 (Object ID 16 / 21 / 26) から購読が始まるため、その Object ID を Subgroup ID として `FIRST_OBJ_EXT` で送る
- relay は同じ (Group, Object) を異なる Subgroup ID で受信し、§12.1 に従って PUBLISH_DONE (MALFORMED_TRACK 0x12) を下流へ送る
- 原因は、`src/publisher.ts` の `recordCurrentSubgroup` が購読ごとに「その Group で最初に送る Object ID」を Subgroup ID にし、`src/session/publish.ts` が常に `SubgroupHeaderType.FIRST_OBJ_EXT` (Subgroup ID = 先頭 Object ID) を使うことである
- `src/session/publishedTracks.ts` の `publishedTracksFanOutObject` は `SendObjectParams` をそのまま渡すため、fan-out 元の Subgroup ID を引き継がない
- Subscription が Group の途中から確立するかはタイミング次第であり、受信 Object 数が実行ごとに変わる

## 設計方針

- Track ごとに現在の Group の Subgroup ID と Publisher Priority を共有する。fan-out 元が現在の Group の値を取得できるようにし、`publishedTracksFanOutObject` から各 subscription へ渡す
- Subgroup ID が先頭 Object ID と一致する場合は従来どおり `FIRST_OBJ_EXT`、一致しない場合は `EXPLICIT_EXT` (Subgroup ID を明示) で送る (`src/dataStream/subgroup.ts` の `SubgroupHeaderType.EXPLICIT_EXT` を使う)
- 同じ Group の途中から購読した subscription でも、以降の Object は同じ Subgroup ID / Priority で送る。Group が変わったら新しい Subgroup ID を Track 全体で決める
- Datagram の fan-out も Delivery Mode / Priority が subscription 間で食い違わないようにする (§7.1 の Delivery Mode 不一致)
- 既存の公開 API (`Publisher.sendObject` の引数) は変えない

## 完了条件

- 同じ Track の同じ (Group, Object) が、すべての subscription で同じ Subgroup ID / Publisher Priority / Delivery Mode で送られる
- Group の途中から確立した subscription への送信が `EXPLICIT_EXT` になり、Subgroup ID が先頭 Object ID と異なることを単体テストで固定する
- fan-out の回帰テストを `publishedTracks.test.ts` に追加する
- announceNamespace 有効 + SUBSCRIBE_TRACKS 有効の devtools publisher / subscriber を実リレーで繋ぎ、MALFORMED_TRACK にならず映像が復号されることを E2E で確認する
- `vp check` と `vp test run` が通る
- 修正後、別ノードの再接続検証を行う (0964 / 0966 と合わせて)

## 参照

- `src/publisher.ts` (`recordCurrentSubgroup` / `sendObjectToSubscription`)
- `src/session/publishedTracks.ts` (`publishedTracksFanOutObject`)
- `src/session/publish.ts` (Subgroup Header の種別)
- `src/dataStream/subgroup.ts` (`SubgroupHeaderType`)
- draft-ietf-moq-transport-23 §7.1 / §11.3.1 / §12.1
- 関連 issue: 0960、0962、0966

## 解決方法

- `PublishedTrackState` に `sharedSubgroup` (`SharedSubgroupState`: Group ID / Subgroup ID / Publisher Priority / 先頭 Object ID) を追加し、その Track に属する全 `PublisherImpl` が同じオブジェクトを参照するようにした。アプリの PUBLISH では registry 登録時に生成し、SUBSCRIBE_TRACKS の結果 PUBLISH では購読確立時に同じオブジェクトを配る
- `PublisherImpl.resolveSubgroupForObject` で、自分が同じ Group の Subgroup を開いていればその値を維持し、まだ送っていなければ Track 共通の値で途中参加し、Track でもまだならその Object を先頭に Subgroup を開く
- `src/session/publish.ts` で、Subgroup ID がストリームの先頭 Object ID と一致するときは `FIRST_OBJ_EXT`、Group の途中から確立した購読では `EXPLICIT_EXT` で Subgroup ID を明示する。FIRST_OBJECT ビットは途中参加では立てず、Publisher Priority も Track 共通の値を使う
- Range Filter の評価値も wire に載る確定値を使うようにした
- 単体テスト (fan-out の同一 Subgroup ID / Priority、Group 途中開始の `EXPLICIT_EXT` / FIRST_OBJECT false) と実リレー E2E を追加した
- 2026-11-16 の実測: publisher objectsSent=18、subscriber は status=connected / framesDecoded 8 → 98 (3 秒後) / objectsReceived 109 / decodeErrors 0 で、MALFORMED_TRACK は発生しなかった。既存の relay E2E 全体も 39 passed / 12 skipped
- 確認: `tsc --noEmit`、`vp check`、`vp test run` (279 ファイル / 5262 テスト)、実リレー E2E が通った{未着手}
