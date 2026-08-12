# Range Filter の受信検証 (INVALID_FILTER) が未実装

- Priority: Medium
- Created: 2026-08-06
- Completed: 2026-08-13
- Model: DeepSeek V4 Flash
- Branch: feature/fix-moqt-draft-19-range-filter-value-validation
- Polished: 2026-08-12

## 目的

draft-ietf-moq-transport-19 §5.1.3 / §10.2.12-14 の MUST 要件を満たす検証を実装する。対象は closed issue 0341 の「INVALID_FILTER の MUST 条件 (網羅)」表のうち moqt-js の受信経路に適用可能なもの: PRIORITY_FILTER の値 (255 超)、OBJECT_PROPERTY_FILTER / TRACK_PROPERTY_FILTER の Property Type 偶数、SetID / Property Type 組み合わせの重複、Range delta の累積値 (Start / End) の 2^64-1 超過、構造不正 (SetID / Property Type / Range 列の欠落)。現在は値域・偶数・重複の検証がない (encode 側の構造検証 (負 delta / 途中 End 省略) は既存)。

## 優先度根拠

closed issue 0341 は自側 MAX_FILTER_RANGES を広告しないため仕様準拠ピアは Range Filter を送ってこない (MUST NOT) とし Low とした。本 issue はその防御的検証 (0341 の「自側未広告でも防御的に」) と、role=publish の受信 REQUEST_UPDATE 経路で subscriber 発の Range Filter を検証せず REQUEST_OK で受理している (accept-then-ignore) 現状の是正が対象。MUST 違反の検出不能は REQUEST_ERROR 応答で処理できるため実害は限定的だが、仕様 MUST の充足のため Medium。

## 現状

- `decodeRangeFilter` (`src/message/parameter.ts`) は PRIORITY_FILTER の値域チェック、Property Type の偶数チェック、delta 累積値の 2^64-1 超過チェック、構造不正チェックをいずれも行わない。
- `encodeRangeFilter` (`src/message/parameter.ts`) も propertyType の偶数検証なし。SetID は `& 0xff` で静かに切り捨てられる。
- `decodeParameters` (`src/message/parameter.ts`) は 0x25-0x29 を一律「繰り返し可」として Type 単位の重複検出から除外している。§5.1.3 の「同一組み合わせ (Parameter Type, SetID, Property Type) の重複は in any message で MUST 拒否 (INVALID_FILTER)」は、Type 単位の seenTypes では検出できない (SetID / Property Type は value 内にある)。
- `decodeRangeFilter` は production の受信経路で呼ばれていない (呼び出しは `src/message/parameter.prop.ts` の PBT のみ)。
- role=publish の受信 REQUEST_UPDATE (`src/session/bidi.ts` の `bidiReadRequestStreamMessages`) は、スコープ検証後に Range Filter を検証せず REQUEST_OK で受理している (accept-then-ignore。`extractForwardState` のみ取り出す)。
- 受信リクエスト (SUBSCRIBE / FETCH / SUBSCRIBE_TRACKS / TRACK_STATUS / PUBLISH_NAMESPACE / SUBSCRIBE_NAMESPACE) は 0371 によりペイロード非デコード + NOT_SUPPORTED 応答のため、Range Filter の検証は発火しない。
- ケース 1 REQUEST_UPDATE (受信 PUBLISH ストリーム上、publisher 発) の Range Filters は 0373 / 0377 により REQUEST_ERROR (NOT_SUPPORTED) で応答される。
- 変更対象ファイル: `src/message/parameter.ts` (検証・エラー追加)、`src/session/bidi.ts` (role=publish の受信 REQUEST_UPDATE と PUBLISH_OK 受信への配線)、`src/session/params.ts` (encode 側検証)、`src/message/parameter.test.ts` / `src/session/bidi.test.ts` / `src/session/params.test.ts` / `src/message/parameter.prop.ts` (テスト追加・PBT arbitrary 調整)、`CHANGES.md`。

## 設計方針

- **decode 層の検証**: `decodeRangeFilter` に以下を追加する。(a) PRIORITY_FILTER の Range 値 (delta デコード後の絶対値。Start / End とも) が 255 超の場合は違反、(b) propertyType が偶数の場合のみ有効、(c) delta 累積値 (Start / End) が 2^64-1 を超える場合は違反 (varint の生 delta は構造上 2^64-1 を超えないため、累積値の検証が対象)、(d) 構造不正 (Length > 0 なのに SetID / Property Type / Range 列の欠落)。「途中 Range の End 省略」は受信検証の対象にしない (Start / End は同一の vi64 形式であり、デコーダは body 終端でのみ End 省略を検出するため、ワイヤ構造上「途中 Range の End 省略」は存在しない。0341 の網羅表の該当行はエンコード側の制約であり、`encodeRangeFilter` の既存 throw が担当)。
- **組み合わせ重複検出**: Range Filter パラメータを解釈する受信経路で、(Type, SetID, [PropertyType]) のタプル重複を検出する。§5.1.3 の重複拒否 MUST は「in any message」で一律であり、メッセージ種別で変わるのは MAY 複数回の出現範囲 (0x29 は SUBSCRIBE_TRACKS / その REQUEST_UPDATE のみ、0x25-0x28 は FETCH / SUBSCRIBE / SUBSCRIBE_TRACKS / PUBLISH_OK / subscription の REQUEST_UPDATE) のみ。出現範囲の検証は `parameterScope.ts` のスコープ検証が担当しており、重複検出の実装には影響しない。0x25-0x27 は Property Type を持たないため組み合わせは (Type, SetID)。Length=0 の削除エントリは SetID / Property Type を持たないため重複判定の対象外。
- **検証の配置**: 検証は `decodeParameters` に組み込まず、受信経路で明示的に呼び出す。理由: `decodeParameters` は全メッセージデコードで共通使用され、ケース 1 REQUEST_UPDATE のデコードでも発火してしまう (ケース 1 は 0373 の NOT_SUPPORTED 応答が先に適用されるべきであり、検証違反が PROTOCOL_VIOLATION セッション閉鎖に変換されると「NOT_SUPPORTED 維持」と矛盾する)。検証関数 (値域・構造・組み合わせ重複) を純関数として `src/message/parameter.ts` に実装し、以下の 2 経路から呼び出す:
  - role=publish の受信 REQUEST_UPDATE (`bidiReadRequestStreamMessages` の REQUEST_UPDATE ケース): スコープ検証後に検証し、違反時は REQUEST_ERROR (INVALID_FILTER) で応答する。検証は状態変更 (`setForwardState`) より前に配置する (違反で REQUEST_ERROR を応答したにも関わらず forward state が反映される不整合を防ぐ)。これは moqt-js が REQUEST_ERROR を送信できる唯一の Range Filter 受信経路であり、0341 の「REQUEST_UPDATE 常時 OK 経路を分岐」の引き継ぎ。
  - 受信 OK 応答 (PUBLISH_OK。0x25-0x28 がスコープ許可されている唯一の OK 応答): 検証し、違反時は REQUEST_ERROR を送信できないため PROTOCOL_VIOLATION (セッション閉鎖) で扱う。`bidiReadPublishResponse` の catch に InvalidFilterError → PROTOCOL_VIOLATION 変換を追加する (既存の `toProtocolViolationSessionError` は ProtocolViolationError のみ変換するため)。PUBLISH_OK で Length=0 (削除) を受信した場合は構造不正として InvalidFilterError で拒否する (Length=0 の削除セマンティクスは §5.1.3 により REQUEST_UPDATE のみ)。
- **エラー表現**: 検証違反は専用エラー InvalidFilterError で表現する (closed 0341 の「エラー層の分離」設計の引き継ぎ。「不正は ProtocolViolationError にしない」。`RequestErrorCode.INVALID_FILTER = 0x36` は定義済み)。既存の受信ループの ProtocolViolationError → PROTOCOL_VIOLATION 変換に自動で乗せず、上記の経路ごとの変換を明示する。
- **encode 側検証**: `encodeRangeFilter` 内に propertyType 偶数・priority 255 超・SetID 255 超・Range 絶対値 (Start / End) の 2^64-1 超過の検証を追加し、送信前に throw する (delta 値自体は `encodeVarint` の上限検証 (0363) が担当するが、絶対値の超過は検出されないため)。送信側の組み合わせ重複検証は 0393 が新設する純関数 (`validateRangeFilterSpecs` 相当) に統合する (0393 の「共有の `buildRangeFilterParameters()` にはガードを入れない。REQUEST_UPDATE の削除が壊れるため」と整合させるため)。
- **スコープ外の明記**: ケース 1 REQUEST_UPDATE (0373 / 0377 の NOT_SUPPORTED 応答のまま維持)、受信リクエスト 6 種 (0371 でペイロード非デコード)、受信側 MAX_FILTER_RANGES 超過 (0341 により受信時 Range 総数検証は別 issue とされた。自側が広告しないため仕様準拠ピアは送信してこず実運用で発動しない)、受信側の 0x29 スコープ検証 (REQUEST_UPDATE の由来判別。0393 が別途起票とする)。

## 完了条件

- PRIORITY_FILTER で 255 超の値 (delta デコード後の絶対値) を受信した場合に InvalidFilterError が送出されること。
- OBJECT_PROPERTY_FILTER / TRACK_PROPERTY_FILTER で奇数の Property Type を受信した場合に InvalidFilterError が送出されること。
- Range delta の累積値 (Start / End) が 2^64-1 を超える場合に InvalidFilterError が送出されること。
- 構造不正 (SetID / Property Type / Range 列の欠落) を受信した場合に InvalidFilterError が送出されること。
- 同じ組み合わせ (Parameter Type / SetID / [Property Type]) の重複が、実際にデコードされる受信経路 (role=publish の受信 REQUEST_UPDATE / 受信 PUBLISH_OK) で検出され InvalidFilterError が送出されること (受信リクエスト 6 種は 0371 によりペイロード非デコードのため検証は発火しない)。
- role=publish の受信 REQUEST_UPDATE に不正な Range Filter が含まれる場合、REQUEST_ERROR (INVALID_FILTER) で応答されること。
- 受信 PUBLISH_OK に不正な Range Filter が含まれる場合、PROTOCOL_VIOLATION でセッションが閉じること。
- encode 側でも propertyType 偶数・priority 255 超・SetID 255 超・Range 絶対値 (Start / End) の 2^64-1 超過の検証が働き、送信前に throw されること。
- 上記を検証するテストがあること (PBT の arbitrary は同一 (Type, SetID, [PropertyType]) を生成しないよう調整すること)。
- `CHANGES.md` の `## develop` に `[FIX]` があること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- draft-ietf-moq-transport-19 §5.1.3 (Range Filters / 組み合わせ重複の MUST / delta 累積値 2^64-1 超過の MUST / MAY appear multiple times)
- draft-ietf-moq-transport-19 §10.2.12 (PRIORITY FILTER Parameter / 値域 255 超の MUST)
- draft-ietf-moq-transport-19 §10.2.13 (OBJECT PROPERTY FILTER Parameter / Property Type 偶数 MUST)
- draft-ietf-moq-transport-19 §10.2.14 (TRACK PROPERTY FILTER Parameter / Property Type 偶数 MUST)
- draft-ietf-moq-transport-19 §10.2.1 (Parameter Scope)
- 関連: `issues/closed/0341-draft-19-add-range-filters.md`（Range Filters 導入元。INVALID_FILTER の MUST 条件網羅表とエラー層の分離設計。「途中 Range の End 省略」の受信検証は網羅表の誤りであり本 issue では扱わない）
- 関連: `issues/0362-bug-range-filter-length-encoding.md`（Length 二重エンコード修正。構造不正の検証を本 issue に委譲。実装順は先に 0362。本 issue は 0362 修正後の value 形式 (Length 込み) を前提とする）
- 関連: `issues/closed/0371-moqt-draft-19-incoming-request-not-supported-response.md`（受信リクエスト 6 種のペイロード非デコード + NOT_SUPPORTED 応答）
- 関連: `issues/closed/0373-moqt-draft-19-request-update-on-publish-stream-misdetected.md` / `issues/0377-moqt-draft-19-publish-forward-param-not-applied.md`（ケース 1 REQUEST_UPDATE の NOT_SUPPORTED 決定。本 issue は検証対象外）
- 関連: `issues/0385-moqt-draft-19-range-filter-evaluation-logic.md`（評価ロジック。検証後の value 形式を共有）
- 関連: `issues/0393-add-range-filters-fetch.md`（FETCH 配線と送信ガード。`buildRangeFilterParameters()` にはガードを入れない方針のため、送信側の組み合わせ重複検証は 0393 の純関数に統合する。受信側の 0x29 スコープ検証は 0393 が別途起票とする）

## 注記 (0362 との調整)

- 0362 が委譲した構造不正 (SetID / Property Type / Range 列の欠落) は本 issue のスコープに含める。ただし「途中 Range の End 省略」はワイヤ構造上検出不能なため受信検証の対象にしない (encode 側の既存 throw が担当)。
- 実装順: 0362 を先に実装する (本 issue は 0362 修正後の value 形式 (Length 込み) を前提とする)。

## 注記 (0373 / 0377 との調整)

- ケース 1 REQUEST_UPDATE (受信 PUBLISH ストリーム上、publisher 発) の Range Filters は 0373 / 0377 の NOT_SUPPORTED 応答を維持し、本 issue の検証対象外とする (§5.1.3 の「from the subscriber only」違反の扱いは 0373 の残余リスク (1)(b) に委ねる)。検証を `decodeParameters` に組み込まない設計により、ケース 1 で検証が発火しないことを保証する。
- role=publish の受信 REQUEST_UPDATE (subscriber 発) は 0373 / 0377 の対象外であり、本 issue で INVALID_FILTER 応答を実装する。

## 注記 (0393 との調整)

- 0393 は「共有の `buildRangeFilterParameters()` にはガードを入れない。REQUEST_UPDATE の削除が壊れるため」と定めるため、本 issue の送信側の組み合わせ重複検証は `encodeRangeFilter` 内ではなく、0393 が新設する純関数 (`validateRangeFilterSpecs` 相当) に統合する。0393 側には「送信側の組み合わせ重複検証を 0380 から委譲される」旨の相互注記を追加すること (0393 単独では重複検証の存在に気づけないため)。
- 受信側の 0x29 スコープ検証 (REQUEST_UPDATE の由来判別) は 0393 が別途起票するため、本 issue では扱わない。

## 解決方法

- `src/error.ts` に `InvalidFilterError` を追加した。既存の `ProtocolViolationError` → PROTOCOL_VIOLATION 変換に自動で乗せず、経路ごとの変換を明示するため `ProtocolViolationError` を継承しない
- `src/message/parameter.ts` の `decodeRangeFilter` に検証を追加した:
  - PRIORITY_FILTER の Range 値 (delta デコード後の絶対値。Start / End とも) が 255 超の場合は `InvalidFilterError` (draft-ietf-moq-transport-19 §10.2.12)
  - OBJECT_PROPERTY_FILTER / TRACK_PROPERTY_FILTER の Property Type が奇数の場合は `InvalidFilterError` (§10.2.13 / §10.2.14)
  - delta 累積値 (Start / End) が 2^64-1 を超える場合は `InvalidFilterError` (§5.1.3)
  - 構造不正 (Length > 0 なのに SetID / Property Type / Range 列の欠落) は `InvalidFilterError`。Range 列の varint 途中終端は `IncompleteDataError` のままにせず `decodeRangeFilterVarint` ヘルパで `InvalidFilterError` に変換する (受信ループの `toProtocolViolationSessionError` は IncompleteDataError を変換しないため黙殺される)
- `validateRangeFilterCombination` を追加し、(Parameter Type, SetID, [Property Type]) の組み合わせ重複を検出する (§5.1.3 の MUST)。Length=0 の削除エントリは SetID を持たないため対象外
- 受信経路への配線 (`src/session/bidi.ts`):
  - role=publish の受信 REQUEST_UPDATE: スコープ検証後に `validateRangeFilterCombination` を呼び、違反時は REQUEST_ERROR (INVALID_FILTER) で応答する。検証は forward state 反映 (`setForwardState`) より前に配置し、違反で REQUEST_ERROR を応答したにも関わらず forward state が反映される不整合を防ぐ
  - 受信 PUBLISH_OK: `validateRangeFilterCombination` を呼び、違反時は PROTOCOL_VIOLATION でセッションを閉じる (PUBLISH_OK では REQUEST_ERROR を送信できないため)
- `encodeRangeFilter` に送信前検証を追加した: SetID 範囲外 (非整数・0-255 超) / Property Type 奇数 / PRIORITY_FILTER 255 超 / Range 絶対値 2^64-1 超過 / 空 ranges は送信前に throw する
- テスト: `src/message/parameter.test.ts` に 15 件 (decode 検証 8 件 / encode 検証 5 件 / 組み合わせ重複 2 件)、`src/session/bidi.test.ts` に 3 件 (REQUEST_UPDATE → REQUEST_ERROR / 重複 → REQUEST_ERROR / PUBLISH_OK → PROTOCOL_VIOLATION) を追加した
- PBT: `src/message/parameter.prop.ts` の arbitrary を調整し、PRIORITY_FILTER は 255 以下の値のみ生成するようにした
- `CHANGES.md` の `## develop` に `[FIX]` エントリを追加した
