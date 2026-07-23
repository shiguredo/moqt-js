# SUBSCRIBE_TRACKS のパラメータ対応を draft-19 に追従する

- Priority: Medium
- Created: 2026-07-07
- Model: Fable 5
- Branch: feature/change-draft-19-subscribe-tracks-parameters
- Polished: 2026-07-23

## 目的

draft-ietf-moq-transport-19 で SUBSCRIBE_TRACKS のパラメータ規則が新設・変更された。変更履歴は Appendix A.1 `#1777` ("Move GROUP_ORDER from PUBLISH_OK to SUBSCRIBE_TRACKS")。

draft-19 Section 10.19.1 (Parameters on SUBSCRIBE_TRACKS):

> Any Parameter that can be specified on a Subscription (ie: in
> SUBSCRIBE) is valid in SUBSCRIBE_TRACKS, unless otherwise specified.
> These parameters are copied over as the default Subscription
> parameters when a PUBLISH is sent as a result of SUBSCRIBE_TRACKS.
> The Parameters are not explicitly communicated, with the exception of
> FORWARD and GROUP_ORDER as described below.

同節の FORWARD / GROUP_ORDER 規則:

- FORWARD が 0 なら、結果の PUBLISH も FORWARD=0
- FORWARD が 1 または省略なら、結果の PUBLISH は FORWARD=1 (または省略で同等)
- GROUP_ORDER が存在するなら、結果の PUBLISH に同値を載せる
- GROUP_ORDER が省略なら、結果の PUBLISH は publisher 既定の group order (Section 12.5) を使う

draft-19 Section 10.2.8 (GROUP ORDER Parameter):

> The GROUP_ORDER parameter (Parameter Type 0x22) is a uint8. It MAY
> appear in a SUBSCRIBE, SUBSCRIBE_TRACKS, or FETCH.

つまり GROUP_ORDER の許可コンテキストから PUBLISH_OK が外れ、SUBSCRIBE_TRACKS に入っている。

## 優先度根拠

moqt-js の `subscribeTracks()` はパラメータを一切指定できず、SUBSCRIBE_TRACKS で既定のサブスクリプションパラメータを制御できない。また PUBLISH_OK (REQUEST_OK) の許可パラメータに GROUP_ORDER を残しており仕様と乖離している。直ちに相互運用を壊すものではないが機能ギャップになるため Medium。

## 現状

- `src/session.ts`: `subscribeTracks()` は `parameters: []` で空固定。GROUP_ORDER / FORWARD / フィルタ等を指定する API がない
- `src/message/parameterScope.ts`: SUBSCRIBE_TRACKS の許可パラメータは AUTHORIZATION_TOKEN のみ
- `src/message/parameterScope.ts`: `PUBLISH_OK_ALLOWED_PARAMS` が `GROUP_ORDER` を含む。draft-19 では PUBLISH_OK に GROUP_ORDER は載らない
- `src/session/bidi.ts`: client-as-publisher が受信した PUBLISH_OK の検証に `PUBLISH_OK_ALLOWED_PARAMS` を使用
- `src/session/bidi.ts`: SUBSCRIBE_TRACKS 応答として受信した PUBLISH の FORWARD は反映済み。GROUP_ORDER は解釈していない

## 設計方針

- SUBSCRIBE_TRACKS の許可パラメータ集合を「SUBSCRIBE で指定できるパラメータと同等 (GROUP_ORDER / FORWARD を含む)」に拡張する (Section 10.19.1)
- `subscribeTracks()` にパラメータ指定 (少なくとも groupOrder / forward) を追加する。API の形は `subscribe()` の既存オプションに揃える
- `PUBLISH_OK_ALLOWED_PARAMS` から GROUP_ORDER を削除する (Section 10.2.8)
- SUBSCRIBE_TRACKS の結果として受信する PUBLISH について、Section 10.19.1 の GROUP_ORDER / FORWARD 規則を受信側の検証・反映に組み込む
- 仕様参照コメントを draft-19 Section 10.19.1 / Section 10.2.8 に更新する

## 完了条件

- `subscribeTracks()` で GROUP_ORDER / FORWARD を指定して送信できること (エンコード結果のテストを含む)
- GROUP_ORDER を含む PUBLISH_OK (REQUEST_OK) の受信がスコープ検証で拒否されること
- SUBSCRIBE_TRACKS 応答の PUBLISH に載る GROUP_ORDER を受信処理が受理すること
- lint / build / typecheck / 既存テストが通ること
