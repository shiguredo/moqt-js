# エンコーダがデコーダの検証規則を適用せず仕様違反のワイヤを生成しうる

- Created: 2026-09-15
- Completed: 2026-09-17
- Branch: feature/fix-encoder-wire-validation
- Polished: 2026-09-15

## 目的

MOQT ワイヤのエンコーダが、仕様が PROTOCOL_VIOLATION の対象とするワイヤを生成できる。生成したワイヤは moqt-js 自身のデコーダも拒否するため、そのまま送信すると相手がセッションを閉じ、テストも相互運用も破綻する。デコーダ側の検証は実装済みで、エンコーダ側だけが非対称になっている。

対象の 4 関数のうち `encodeObjectDatagram` と `encodeSubgroupHeader` は `src/index.ts` から再エクスポートされている (公開 API)。`encodeTrackNamespace` (`src/message/parameter/trackNamespace.ts`) と `encodeRequestErrorPayload` (`src/message/session.ts`) は `src/message/index.ts` までで止まり `src/index.ts` には再エクスポートされていない (公開 API ではない) が、同じ非対称のためあわせて直す。`src/index.ts` に新たに公開を追加することはしない。

## 現状

- `encodeObjectDatagram` (`src/dataStream/datagram.ts`) は PROPERTIES ビットが立っているのに Properties Length 0 を書きうる (`datagram.properties?.length ?? 0`)。§11.2.1 はこの組み合わせを受信時に PROTOCOL_VIOLATION とする
- `encodeObjectDatagram` と `encodeSubgroupHeader` (`src/dataStream/subgroup.ts`) は Type Flags の妥当性を検証せず、呼び出し側が渡した値をそのまま書く。§11.2.1 と §11.3.1 は不正な Type Flags を列挙し、受信時に PROTOCOL_VIOLATION とする。デコーダ側は `decodeDatagramTypeAndTrackAlias` (`src/dataStream/datagram.ts`) と `decodeSubgroupHeader` (`src/dataStream/subgroup.ts`) で検証済み
- `encodeTrackNamespace` (`src/message/parameter/trackNamespace.ts`) は合計 4,096 バイトのみ検査し、フィールド長 0 と 32 フィールド超を検査しない。§8.7 はフィールドが少なくとも 1 バイトであることを MUST とし、32 フィールド超を受信時に PROTOCOL_VIOLATION とする。`createTrackNamespace` と `decodeTrackNamespace` は同じファイル内でどちらも両方を検査しており、非対称は `encodeTrackNamespace` にだけ残っている
- `encodeRequestErrorPayload` (`src/message/session.ts`) は `if (msg.redirect)` だけで Redirect 構造を付加する。§9.4.2 は "Redirect: Present only when Error Code is REDIRECT. See Section 9.4.1." と定め、`decodeRequestErrorPayload` は双方向 (REDIRECT 以外の Error Code に Redirect がある場合と、REDIRECT なのに Redirect が無い場合) を検証済み
- 内部送信経路 (`publishSendDatagram` / `publishSendObject` / `bidiSendRequestError` / `incomingSendRequestErrorAndClose`) は防御しているため、公開エクスポート経由とモジュール内部 API 経由のどちらの誤用も現状では顕在化しない。本 issue はエンコーダ単体の契約をデコーダと対称にする

draft-ietf-moq-transport-21 §11.2.1:

> If an endpoint receives a datagram with the PROPERTIES bit set and an Properties Length of 0, it MUST close the session with a PROTOCOL_VIOLATION.

## 設計方針

- 各エンコーダの入口でデコーダと同じ妥当性検証を行い throw する。正当な入力のエンコード結果は変えない
- 判定は述語 (`is...`) として抽出し、throw は呼び出し側が行う。既存の `src/length.ts` の `isLengthWithinData` / `assertLengthWithinData` と同じ分担にする
- 例外型は経路で分ける。受信したワイヤの検証はこれまでどおり `ProtocolViolationError`、エンコーダ入口のローカル API 誤用は汎用 `Error` とし、`ProtocolViolationError` は使わない (`createTrackNamespace` のコメント「受信したワイヤの違反ではないため ProtocolViolationError は使わない」と同じ契約)
- エラーメッセージは経路で共有し、既存の文言を変えない
- Object Datagram: `src/dataStream/datagram.ts` に述語を抽出し、`decodeDatagramTypeAndTrackAlias` と `encodeObjectDatagram` の両方から呼ぶ。不正条件は既存デコーダと同じ 2 条件とし、判定のまとめ方も変えない。(1) `(type & 0x10) !== 0 || type > 0x2f` で、既存の `invalid datagram type: 0x..., does not match form 0b00X0XXXX` を出す。(2) `(type & 0x20) !== 0 && (type & 0x02) !== 0` で、既存の `invalid datagram type: 0x..., STATUS and END_OF_GROUP bits are both set` を出す。既存デコーダはこの 2 条件で別々の `ProtocolViolationError` を投げているため、述語も 2 つに分ける (`isValidDatagramTypeForm` と `hasConflictingDatagramStatusBits` が候補)。1 つの述語にまとめると呼び出し側で 2 文言を出し分けられない
- Subgroup Header: `src/dataStream/subgroup.ts` に述語を抽出し、`decodeSubgroupHeader` と `encodeSubgroupHeader` の両方から呼ぶ。不正条件は既存デコーダと同じ 2 条件とし、判定のまとめ方も変えない。(1) `(type & 0x06) >> 1 === 0x03` で、既存の `invalid subgroup header type: 0x..., SUBGROUP_ID_MODE 0b11 is reserved` を出す。(2) `(type & 0x10) === 0 || type > 0x7f` で、既存の `invalid subgroup header type: 0x..., does not match form 0b0XX1XXXX` を出す。述語の分割は Object Datagram と同じ方針にする
- `encodeSubgroupHeader` の判定は `header.firstObject` (0x40) と `header.endOfGroup` (0x08) を OR した後の値で行う。この 2 ビットはフィールドの有無を決めないため、OR 後の値で判定しても `hasSubgroupIdField` / `hasPriorityPresent` の結果は変わらない (既存コメントのとおり)
- Track Namespace: `src/message/parameter/trackNamespace.ts` に `assertTrackNamespaceTuple(tuple: Uint8Array[]): void` を新設し、`createTrackNamespace` (エンコード済みの `tuple`) と `encodeTrackNamespace` の両方から呼ぶ。フィールド数が `MAX_TRACK_NAMESPACE_FIELDS` (32) を超える場合、フィールド長が 0 の場合、合計が `MAX_TRACK_NAMESPACE_SIZE` (4,096) を超える場合の 3 つを 1 箇所に置く。例外は汎用 `Error` とし、既存の `track namespace fields exceeds maximum: ...` / `track namespace field length is zero` / `track namespace exceeds maximum size: ...` を使う
- `createTrackNamespace` は `tuple` を組んだ後に `assertTrackNamespaceTuple(tuple)` を呼ぶ形へ置き換え、既存の検証順 (フィールド数 → フィールド長 0 → 合計サイズ) を保つ。これにより既存テストの期待文言が変わらない
- 0 フィールドの Track Namespace は §2.4.1 の「between 0 and 32 Track Namespace Fields」により正当なため、拒否しない
- `decodeTrackNamespace` の受信側検証は変更しない。`MAX_TRACK_NAMESPACE_FIELDS` の直上と `decodeTrackNamespace` 内にある §9.15 (SUBSCRIBE_NAMESPACE) の既存引用も本 issue では変更しない (32 フィールド上限の根拠節の是正は issue 0619 の担当)。新設する `assertTrackNamespaceTuple` のコメントには §8.7 (Track Namespace Structure) を書く
- Redirect: `encodeRequestErrorPayload` に `decodeRequestErrorPayload` と同じ双方向の検証を入れる。REDIRECT (0x34) 以外の Error Code に Redirect がある場合は拒否し、REDIRECT (0x34) なのに Redirect が無い場合も拒否する。エラーは汎用 `Error` とし、デコーダ側の `unexpected redirect in REQUEST_ERROR with error code 0x...` / `missing redirect structure in REQUEST_ERROR with error code REDIRECT (0x34)` に対応する文言にする
- `encodeObjectFields` (`src/dataStream/subgroup.ts`) は本 issue の対象外とする。Subgroup Header の型を引数で受けるだけで型自体は生成せず、§11.3.1 は「Objects with no properties set Properties Length to 0.」と Properties Length 0 を明示的に許容する。`decodeObjectFields` も Properties Length 0 を拒否しないため、「デコーダと対称にする」という本 issue の規則の対象外である
- `encodeFetchObjectFields` (`src/dataStream/fetch.ts`) も対象外とする。同関数が書くのは Fetch Serialization Flags (§11.4.1.1) であり、§11.2.1 / §11.3.1 の Type Flags とは別のフィールドである。`decodeFetchObjectFields` の検証規則との非対称も本 issue では扱わない

## 完了条件

- PROPERTIES ビットが立った Object Datagram で Properties Length が 0 になる場合 (properties 未指定または長さ 0) が生成前に拒否される
- 不正な Type Flags の Object Datagram (`encodeObjectDatagram`) と Subgroup Header (`encodeSubgroupHeader`) が生成前に拒否される。Object Datagram は bit 4 / 0x2f 超 / STATUS と END_OF_GROUP の同時設定、Subgroup Header は SUBGROUP_ID_MODE 0b11 / bit 4 が 0 / 0x7f 超を拒否する。`encodeObjectFields` と `encodeFetchObjectFields` は対象外とする
- フィールド長 0 または 32 フィールド超の Track Namespace が `encodeTrackNamespace` で生成前に拒否される。33 フィールド以上を渡すと `track namespace fields exceeds maximum`、長さ 0 のフィールドを渡すと `track namespace field length is zero` で拒否される
- 0 フィールドの Track Namespace は従来どおりエンコードでき、`decodeTrackNamespace` でラウンドトリップする。32 フィールドも従来どおりエンコードできる
- REDIRECT 以外の Error Code に Redirect を付けた REQUEST_ERROR と、REDIRECT (0x34) なのに Redirect が無い REQUEST_ERROR が、いずれも生成前に拒否される
- エンコーダ入口の新しい拒否はすべて汎用 `Error` を throw する (`ProtocolViolationError` は使わない)
- 正当な入力のエンコード結果が変わらない。`createTrackNamespace` の既存テスト (4,096 バイト超拒否 / 制限内成功 / 32 フィールド許可と 33 フィールド拒否) と `encodeTrackNamespace` の既存テスト (4,096 バイト超拒否) は変更せずに通る。0 フィールド tuple のラウンドトリップ (`src/message/namespace.test.ts` の `decodeNamespacePayload` が空の Track Namespace Suffix を通過するテスト) と、`createTrackNamespace([])` を使う `validateFullTrackNameBytes` のテスト、32 フィールド tuple のラウンドトリップも変更せずに通る
- 長さ 0 フィールドの拒否を検証する既存テストは `decodeTrackNamespace` にだけあり、`createTrackNamespace` には無い。`assertTrackNamespaceTuple` を `createTrackNamespace` が呼ぶことによる長さ 0 拒否のテストを新設する。`createTrackNamespace([""])` が `track namespace field length is zero` で拒否されることと、`encodeTrackNamespace({ tuple: [new Uint8Array(0)] })` が同じ文言で拒否されることを検証する
- 上の各検証のテストがある
- `vp check` / `tsc --noEmit` / `vp test run` が通る

## 参照

- draft-ietf-moq-transport-21 §2.4.1 (Track Naming)
- draft-ietf-moq-transport-21 §8.7 (Track Namespace Structure)
- draft-ietf-moq-transport-21 §9.4.1 (Redirect Structure)
- draft-ietf-moq-transport-21 §9.4.2 (REQUEST_ERROR Message Format)
- draft-ietf-moq-transport-21 §11.1.3 (Object Properties)
- draft-ietf-moq-transport-21 §11.2.1 (Object Datagram)
- draft-ietf-moq-transport-21 §11.3.1 (Subgroup Header)

## 解決方法

### Object Datagram (`src/dataStream/datagram.ts`)

- Type Flags の 2 条件を `isValidDatagramTypeForm` (bit 4 が 0 かつ 0x2f 以下) と
  `hasConflictingDatagramStatusBits` (STATUS と END_OF_GROUP の同時設定) に抽出し、`decodeDatagramTypeAndTrackAlias` と
  `encodeObjectDatagram` の双方から使う
- `encodeObjectDatagram` の入口で両者を検査し、既存のデコーダと同じ文言で汎用 `Error` を throw する
- PROPERTIES ビットが立っている場合は Properties Length 0 を拒否する (§11.2.1 の MUST。Properties を持たない Object は
  ビットを立てない)。properties 未指定と空配列の双方を拒否する

### Subgroup Header (`src/dataStream/subgroup.ts`)

- Type Flags の 2 条件を `hasReservedSubgroupIdMode` (SUBGROUP_ID_MODE 0b11) と
  `isValidSubgroupHeaderTypeForm` (bit 4 が 1 かつ 0x7f 以下) に抽出し、`decodeSubgroupHeader` と
  `encodeSubgroupHeader` の双方から使う
- `encodeSubgroupHeader` では FIRST_OBJECT / END_OF_GROUP を OR した後の値で検査する (両ビットはフィールドの有無を
  決めないため判定結果は変わらない)

### Track Namespace (`src/message/parameter/trackNamespace.ts`)

- `assertTrackNamespaceTuple(tuple)` を新設し、フィールド数 32 以下 / 各フィールド 1 バイト以上 / 合計 4,096 バイト以下の
  3 つを 1 箇所に集約した。検証順は既存の `createTrackNamespace` と同じ (フィールド数 → フィールド長 0 → 合計サイズ) とし、
  既存の期待文言を変えない
- `createTrackNamespace` のインライン検証を同関数の呼び出しに置き換え、`encodeTrackNamespace` も同関数を呼ぶようにした
  (従来は合計サイズのみ検査していた)
- 0 フィールドの Track Namespace は §2.4.1 の "between 0 and 32 Track Namespace Fields" により正当なため拒否しない

### REQUEST_ERROR (`src/message/session.ts`)

- `encodeRequestErrorPayload` に `decodeRequestErrorPayload` と同じ双方向の検証を追加した。REDIRECT (0x34) 以外の
  Error Code に Redirect を付けた場合は `unexpected redirect in REQUEST_ERROR with error code 0x...`、
  REDIRECT なのに Redirect が無い場合は `missing redirect structure in REQUEST_ERROR with error code REDIRECT (0x34)`
  で汎用 `Error` を throw する
- `src/message/session.prop.ts` の「REDIRECT 以外のエラーコードで Redirect バイトが存在すると ProtocolViolationError」は、
  エンコーダが同じ組み合わせを生成しなくなったため、Redirect バイト列を手で連結したワイヤでデコーダを検証する形に更新した。
  あわせて送信側の拒否 2 件を新規テストとして追加した

### テスト

`src/dataStream.datagram.test.ts` (4 本) / `src/dataStream.subgroup.test.ts` (3 本) / `src/message/parameter.test.ts` (4 本) /
`src/message/session.prop.ts` (2 本追加・1 本更新) を追加・更新し、正当な入力のエンコード結果が変わらないことは既存テストで確認した。

検証は `pnpm exec tsc --noEmit` / `pnpm exec vp check` / `pnpm test --run` (2269 passed) の通過で確認した。
