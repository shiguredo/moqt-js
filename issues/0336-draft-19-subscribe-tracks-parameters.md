# SUBSCRIBE_TRACKS のパラメータ対応を draft-19 Section 10.19.1 に追従する

- Priority: Medium
- Created: 2026-07-07
- Model: Fable 5
- Branch: feature/change-draft-19-subscribe-tracks-parameters
- Polished: 2026-07-23

## 目的

draft-ietf-moq-transport-19 で SUBSCRIBE_TRACKS のパラメータ規則が新設・変更された (draft-18 → 19 変更履歴 "Move GROUP_ORDER from PUBLISH_OK to SUBSCRIBE_TRACKS (#1777)"、および PR #1788 "SUBSCRIBE_TRACKS Parameters copied to PUBLISH")。

draft-19 Section 10.19.1 (Parameters on SUBSCRIBE_TRACKS、新設):

> Any Parameter that can be specified on a Subscription (ie: in
> SUBSCRIBE) is valid in SUBSCRIBE_TRACKS, unless otherwise specified.
> These parameters are copied over as the default Subscription
> parameters when a PUBLISH is sent as a result of SUBSCRIBE_TRACKS.
> The Parameters are not explicitly communicated, with the exception of
> FORWARD and GROUP_ORDER as described below.

draft-19 Section 10.2.8 (GROUP ORDER Parameter):

> The GROUP_ORDER parameter (Parameter Type 0x22) is a uint8. It MAY
> appear in a SUBSCRIBE, SUBSCRIBE_TRACKS, or FETCH.

draft-18 Section 10.2.8 では "SUBSCRIBE, PUBLISH_OK, or FETCH" だった。つまり GROUP_ORDER の許可コンテキストから PUBLISH_OK が外れ、SUBSCRIBE_TRACKS に移動した。

## 優先度根拠

moqt-js の `subscribeTracks()` はパラメータを一切指定できず、draft-19 の「SUBSCRIBE_TRACKS にサブスクリプションパラメータを載せて、結果として届く PUBLISH の既定値を制御する」機能が使えない。また PUBLISH_OK (REQUEST_OK) の許可パラメータに GROUP_ORDER を残しており仕様と乖離している。相互運用を直ちに壊すものではないが、SUBSCRIBE_TRACKS を使うアプリケーションの機能ギャップになるため Medium。

## 現状

- `src/session.ts:1794-1834`: `subscribeTracks()` は `parameters: [] as []` (`src/session.ts:1823`) で空固定。GROUP_ORDER / FORWARD / フィルタ等を指定する API がない
- `src/message/parameterScope.ts:87-88`: SUBSCRIBE_TRACKS の許可パラメータは `NAMESPACE_ALLOWED_PARAMS` (AUTHORIZATION_TOKEN のみ)
- `src/message/parameterScope.ts:39-48`: `PUBLISH_OK_ALLOWED_PARAMS` が `MessageParameterType.GROUP_ORDER` を含む (`src/message/parameterScope.ts:42`)。draft-19 では PUBLISH_OK に GROUP_ORDER は載らない
- `src/session/bidi.ts:316-323`: client-as-publisher が受信した PUBLISH_OK (REQUEST_OK) の検証に `PUBLISH_OK_ALLOWED_PARAMS` を使用
- `src/session/bidi.ts:345-346`: SUBSCRIBE_TRACKS 応答として受信した PUBLISH の FORWARD は `extractForwardState` で反映済み。GROUP_ORDER は解釈していない

## 設計方針

- SUBSCRIBE_TRACKS の許可パラメータ集合を「SUBSCRIBE で指定できるパラメータと同等 (GROUP_ORDER / FORWARD を含む)」に拡張する
- `subscribeTracks()` にパラメータ指定 (少なくとも groupOrder / forward) を追加する。API の形は `subscribe()` の既存オプション (`src/session.ts:395` 以降の SubscribeOptions) に揃える
- `PUBLISH_OK_ALLOWED_PARAMS` から GROUP_ORDER を削除する
- SUBSCRIBE_TRACKS の結果として受信する PUBLISH について、draft-19 Section 10.19.1 の「SUBSCRIBE_TRACKS に GROUP_ORDER があれば、結果の PUBLISH にも同値の GROUP_ORDER が載る」規則を受信側の検証・反映に組み込む
- 仕様参照コメントを draft-19 Section 10.19.1 / 10.2.8 に更新する

## 完了条件

- `subscribeTracks()` で GROUP_ORDER / FORWARD を指定して送信できること (エンコード結果のテストを含む)
- GROUP_ORDER を含む PUBLISH_OK (REQUEST_OK) の受信がスコープ検証で拒否されること
- SUBSCRIBE_TRACKS 応答の PUBLISH に載る GROUP_ORDER を受信処理が受理すること
- lint / build / typecheck / 既存テストが通ること
