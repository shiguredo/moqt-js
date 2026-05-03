# IMMUTABLE_PROPERTIES の再帰禁止・複数出現禁止 malformed-track 検出が未実装

Created: 2026-05-02
Model: Opus 4.7

## 概要

draft-17 §11.6 は IMMUTABLE_PROPERTIES (0x0B) について 2 つの malformed-track 条件を MUST レベルで定義しているが、`src/properties.ts` のデコード経路はどちらも検出しない。

1. IMMUTABLE_PROPERTIES の中にさらに IMMUTABLE_PROPERTIES が現れた場合 → malformed track
2. 同じ Object に IMMUTABLE_PROPERTIES が複数出現した場合 → MUST NOT

加えて、§11.7 (PRIOR_GROUP_ID_GAP) と §11.8 (PRIOR_OBJECT_ID_GAP) の「Object 当たり 1 つだけ」の MUST も検証されていない。

## RFC 根拠

draft-ietf-moq-transport-17 §11.6 Immutable Properties (line 5394-5455):

> A Track is considered malformed (see Section 2.4.2) if any of the following conditions are detected:
>
> - An Object contains an Immutable Properties property that contains another Immutable Properties key.
> - A Key-Value-Pair cannot be parsed.

> An Object MUST NOT contain more than one instance of this property.

draft-ietf-moq-transport-17 §11.7 Prior Group ID Gap (line 5457-5504):

> A Track is considered malformed (see Section 2.4.2) if any of the following conditions are detected:
>
> - An Object contains more than one instance of Prior Group ID Gap.

> An Object MUST NOT contain more than one instance of this property.

draft-ietf-moq-transport-17 §11.8 Prior Object ID Gap (line 5506-):

> An Object MUST NOT contain more than one instance of this property.

## 該当箇所

- `src/properties.ts:405-482` `parseProperties` — IMMUTABLE_EXTENSIONS に到達した際 (424-461 行) 内側の KVP を平坦化して `extensions` に入れるだけで、内側に 0x0B が現れても普通の奇数 ID プロパティとして格納する
- `src/properties.ts:460` — 2 度目の IMMUTABLE_EXTENSIONS が来た場合 `result.immutableProperties = { extensions }` で前回値を上書きする (重複検出なし)
- `src/properties.ts:416-423` — PRIOR_GROUP_ID_GAP / PRIOR_OBJECT_ID_GAP も 2 度目の出現で `result.priorGroupIdGap` / `result.priorObjectIdGap` を上書き
- `src/properties.ts:360-392` `decodeImmutableProperties` も内側の 0x0B 出現を検出しない

## 期待される動作

- 内側の KVP 解析ループで `extId === MOQTPropertyId.IMMUTABLE_EXTENSIONS` を検出したら `MalformedTrackError` (新規) または `ProtocolViolationError` を throw
- 同一 Object 内で IMMUTABLE_EXTENSIONS / PRIOR_GROUP_ID_GAP / PRIOR_OBJECT_ID_GAP が 2 度目に出現したら同じく throw
- malformed-track は `DataStreamErrorCode.MALFORMED_TRACK` (`error.ts`) でデータストリームをリセットする上位ハンドリングへ伝搬

## 優先度

重要。MUST 違反を検出しない。malformed-track はリレーや再ストリーミングを跨いだトラックの整合性確認に直結するため、Subscriber が壊れたデータを上位 API に流す可能性がある。
