# MessageParameterType のヘッダコメントを draft-20 の dual namespace 実態に合わせる

- Created: 2026-08-12
- Updated: 2026-09-05
- Completed: 2026-09-13
- Branch: feature/fix-message-parameter-type-header-comment
- Polished: {YYYY-MM-DD}

## 目的

`src/message/types.ts` の `MessageParameterType` ヘッダコメントの「移動」記述を、draft-20 の実態 (Message Parameter と Track Property の両 namespace に併存する) に合わせて修正する。0392 (セクション番号の修正) の polish で分離された、文言の判断を要するコメント修正。

## 現状

- `src/message/types.ts` のヘッダコメント「Track Properties (OBJECT_DELIVERY_TIMEOUT, MAX_CACHE_DURATION, DEFAULT_PUBLISHER_PRIORITY, DEFAULT_PUBLISHER_GROUP_ORDER, DYNAMIC_GROUPS) は PUBLISH/SUBSCRIBE_OK/FETCH_OK の Track Properties に移動」は、draft-20 の実態と不一致:
  - OBJECT_DELIVERY_TIMEOUT (0x02) / SUBGROUP_DELIVERY_TIMEOUT (0x06) は §10.2.4 / §10.2.3 により Message Parameter としても出現可能 (SUBSCRIBE / PUBLISH / REQUEST_UPDATE)。「移動」ではなく両 namespace に併存する (§8「The publisher communicates both timeout values as a Track Property; the subscriber communicates them as Message Parameters.」)。
  - 一覧に SUBGROUP_DELIVERY_TIMEOUT が欠落している。
- 続く「注意: SUBSCRIBE では OBJECT_DELIVERY_TIMEOUT, GROUP_ORDER は引き続き Message Parameter として使用される」も、PUBLISH / REQUEST_UPDATE への出現 (§10.2.3 / §10.2.4) を欠く。

## 設計方針

- ヘッダコメントを §8 / §10.2.3 / §10.2.4 の実態に合わせて書き換える (「移動」を「両 namespace に併存」の記述に修正し、SUBGROUP_DELIVERY_TIMEOUT を一覧に追加する)。
- 「注意」の出現メッセージ (SUBSCRIBE / PUBLISH / REQUEST_UPDATE) を補う。

## 完了条件

- `MessageParameterType` のヘッダコメントが draft-20 の実態 (Message Parameter と Track Property の併存) と一致すること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- draft-ietf-moq-transport-20 §8 (Delivery Timeout / publisher は Track Property、subscriber は Message Parameter)
- draft-ietf-moq-transport-20 §10.2.3 (SUBGROUP_DELIVERY_TIMEOUT Parameter / SUBSCRIBE, PUBLISH, REQUEST_UPDATE に出現)
- draft-ietf-moq-transport-20 §10.2.4 (OBJECT_DELIVERY_TIMEOUT Parameter / 同上)
- 関連: `issues/closed/0392-moqt-draft-19-comment-section-number.md`（セクション番号の修正。本 issue は polish で分離された）

## 解決方法

`src/message/types.ts` の `MessageParameterType` ヘッダコメントを draft-21 の実態に合わせて修正した。コメントのみで、コード・公開 API は変更していない。

- ヘッダの「Track Properties (OBJECT_DELIVERY_TIMEOUT, MAX_CACHE_DURATION, DEFAULT_PUBLISHER_PRIORITY, DEFAULT_PUBLISHER_GROUP_ORDER, DYNAMIC_GROUPS) は PUBLISH/SUBSCRIBE_OK/FETCH_OK の Track Properties に移動」を、「MAX_CACHE_DURATION / DEFAULT_PUBLISHER_PRIORITY / DEFAULT_PUBLISHER_GROUP_ORDER / DYNAMIC_GROUPS は Track Properties でのみ使用する」と「OBJECT_DELIVERY_TIMEOUT / SUBGROUP_DELIVERY_TIMEOUT は Track Properties と Message Parameters の両方に出現する」の 2 項目に分けた。「移動」ではなく両 namespace に併存するという draft-21 §5.2 の記述 ("The publisher communicates both timeout values as a Track Property; the subscriber communicates them as Message Parameters.") を根拠として引用した。
- 続く注意書きを「SUBSCRIBE / PUBLISH / REQUEST_UPDATE では OBJECT_DELIVERY_TIMEOUT と SUBGROUP_DELIVERY_TIMEOUT が Message Parameter として出現する。GROUP_ORDER は SUBSCRIBE / PUBLISH / SUBSCRIBE_TRACKS / FETCH / FILL_PARAMETERS に出現する」に修正した。GROUP_ORDER の出現先は §9.20.19 の明文による。
- あわせて `OBJECT_DELIVERY_TIMEOUT` のエントリコメントも「SUBSCRIBE では Subscriber の希望値として Message Parameter で使用。PUBLISH/SUBSCRIBE_OK/FETCH_OK では Track Property として使用。」から、§9.20.5 の出現メッセージと §5.2 の役割分担を明記する形に修正した。
- `CHANGES.md` の `## develop` の `### misc` に `[UPDATE]` を追加した (0570 と同じエントリに含めた)。

## 検証

- `pnpm test run`: 70 ファイル / 2,090 テスト全通過
- `pnpm typecheck` / `pnpm lint` / `pnpm fmt` すべて成功
