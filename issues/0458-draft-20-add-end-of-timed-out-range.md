# End of Timed-Out Range (0x20C) を FETCH オブジェクトに追加する

- Created: 2026-09-01
- Completed: {YYYY-MM-DD}
- Branch: feature/add-end-of-timed-out-range
- Polished: {YYYY-MM-DD}

## 目的

draft-ietf-moq-transport-20 §11.4.4 で Fill Timeout 失効により放棄された Object 範囲を示す `End of Timed-Out Range` (serialization flags 0x20C) が追加された。FETCH / fill fetch オブジェクトの encode / decode に対応する。

## 現状

- `FetchSerializationFlags` (`src/dataStream.ts`) は `END_OF_NON_EXISTENT_RANGE` (0x8C) / `END_OF_UNKNOWN_RANGE` (0x10C) を扱うが 0x20C は無い。
- 未知 flags は invalid として PROTOCOL_VIOLATION になり得る。
- fill fetch (0450) と組み合わせて意味を持つが、ワイヤ対応自体は独立して追加できる。

## 設計方針

- `FetchSerializationFlags.END_OF_TIMED_OUT_RANGE = 0x20C` を追加する。
- `encodeFetchObjectFields` / `decodeFetchObjectFields` で 0x8C / 0x10C と同様の status オブジェクトとして扱う。
- アプリ向け表現 (status 種別) を既存 End of * Range と揃えて公開する。

## 完了条件

- 0x20C の encode / decode round-trip テストがあること。
- 不正な組み合わせ flags の既存検証を壊さないこと。
- `CHANGES.md` の `## develop` に `[ADD]` があること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- draft-ietf-moq-transport-20 §11.4.4 (FETCH Objects / Table 7)
- draft-ietf-moq-transport-20 §10.2.5 (FILL TIMEOUT Parameter)
- draft-ietf-moq-transport-20 Appendix A.1 (#1822)
- 関連: `issues/0450-draft-20-add-fill-parameters-and-fill-fetch.md`
