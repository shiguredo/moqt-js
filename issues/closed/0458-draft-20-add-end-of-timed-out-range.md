# End of Timed-Out Range (0x20C) を FETCH オブジェクトに追加する

- Created: 2026-09-01
- Completed: 2026-09-05
- Branch: feature/add-end-of-timed-out-range
- Polished: 2026-09-02

## 目的

draft-ietf-moq-transport-20 §11.4.4 で Fill Timeout 失効により放棄された Object 範囲を示す `End of Timed-Out Range` (serialization flags 0x20C) が追加された。FETCH / fill fetch オブジェクトの encode / decode に対応する。

## 現状

- `FetchSerializationFlags` (`src/dataStream.ts`) は `END_OF_NON_EXISTENT_RANGE` (0x8C) / `END_OF_UNKNOWN_RANGE` (0x10C) を扱うが 0x20C は無い。
- 未知 flags は invalid として PROTOCOL_VIOLATION になり得る。
- fill fetch (0450) と組み合わせて意味を持つが、ワイヤ対応自体は独立して追加できる。

## 設計方針

- `FetchSerializationFlags.END_OF_TIMED_OUT_RANGE = 0x20C` を追加する。
- `encodeFetchObjectFields` / `decodeFetchObjectFields` で 0x8C / 0x10C と同様の status オブジェクトとして扱う。
- アプリ向け表現として、公開型 `EndOfRangeType` に `"timed_out"` を追加し、`decodeEndOfRange` を 0x8C / 0x10C / 0x20C の 3 値マッピングに変更する (両者とも `src/dataStream.ts`)。0x20C の round-trip ではアプリ向け status 種別が `"timed_out"` になることを検証する。

## 完了条件

- 0x20C の encode / decode round-trip テストがあり、アプリ向け status 種別が `"timed_out"` になることを検証していること。
- 不正な組み合わせ flags の既存検証を壊さないこと。
- `CHANGES.md` の `## develop` に `[ADD]` があること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- draft-ietf-moq-transport-20 §11.4.4 (FETCH Objects / Table 7)
- draft-ietf-moq-transport-20 §10.2.5 (FILL TIMEOUT Parameter)
- draft-ietf-moq-transport-20 Appendix A.1 (#1822)
- 関連: `issues/0450-draft-20-add-fill-parameters-and-fill-fetch.md`

## 解決方法

- FetchSerializationFlags に END_OF_TIMED_OUT_RANGE (0x20C) を追加し、encode / decode を既存 2 値と同様の status オブジェクトとして扱うようにした。
- 公開型 EndOfRangeType に timed_out を追加し、decodeEndOfRange を 3 値マッピングに変更した。
- End of Range 判定を isEndOfRangeFlags に抽出し、不正 flags の検証と回帰テストを追加した。
- 変更履歴の develop に後方互換の追加を追記した。
