# FETCH の End of Range に Object Payload Length を含めない

- Created: 2026-09-14
- Completed: 2026-09-14
- Branch: feature/fix-fetch-end-of-range-payload-length
- Polished: 2026-09-14

## 目的

`refs/moq/draft-ietf-moq-transport-21.txt` §11.4.1.2 は End of Range について "the Group ID and Object ID fields are present. Subgroup ID, Priority and Properties are not present." と規定し、present になるフィールドとして Group ID と Object ID のみを挙げる。Table 7 は 0x8C / 0x10C / 0x20C を通常の flags の組み合わせとは別の End of Range indicator として定義する。Figure 28 の Object Payload Length は通常 Object のフィールドであり、EOR indicator には適用されない。

上流の `moq-wg/moq-transport` issue 1861 では、moxygen / quiche / moqtail / moq-go / aiomoqt がいずれも EOR の後で次の Serialization Flags に進み、Object Payload Length を書く実装が無いことが報告されている。refs の記述と各実装の挙動はこの解釈で一致している。

現状の moqt-js は End of Range の encode / decode で Object Payload Length を余分に読み書きしている。このため、EOR の直後に通常 Object が続くストリームではフィールド境界が 1 varint ずれ、相互運用に失敗する。

## 現状

- `src/dataStream/fetch.ts` の `encodeFetchObjectFields` は End of Range 分岐で `encodeVarint(fields.payloadLength)` を追加している。
- `src/dataStream/fetch.ts` の `decodeEndOfRange` は Group ID と Object ID を読んだ後、さらに Object Payload Length を varint として読んでいる。
- `src/session/stream.ts` の `processFetchObjects` は decode 結果の `fields.payloadLength` を常に payload 長として消費する。EOR では余分に読んだ値がそのまま消費対象になる。
- `src/dataStream.fetch.test.ts` の End of Range テストは moqt-js 自身の encode / decode の round-trip のみを検証しており、固定バイト列を pin していない。このため、encode と decode が両方同じ誤りを持っていても検出できない。

## 設計方針

1. `encodeFetchObjectFields` の End of Range 分岐は `Serialization Flags`, `Group ID`, `Object ID` のみを書き、`payloadLength` と `payload` は書かない。
2. `decodeEndOfRange` は Group ID と Object ID までで消費を止める。返却する `DecodedFetchObject.payloadLength` は 0n 固定とし、後続処理が payload 0 バイトとして扱えるようにする。
3. `FetchObjectFields.payloadLength` は通常 Object 用の必須フィールドのまま維持する。End of Range では wire に書かないことをコメントで明記する。
4. End of Range の 3 値それぞれについて固定バイト列の encode テストを追加する。期待値は `encodeVarint(flags) + encodeVarint(groupId) + encodeVarint(objectId)` とする。
5. End of Range の decode テストを追加する。3 フィールドだけで `IncompleteDataError` にならず、`payloadLength` が 0n、`consumed` が 3 フィールド分と一致することを確認する。EOR の直後の通常 Object を残りバッファから正しく decode できることも確認する。

## 完了条件

- 0x8C / 0x10C / 0x20C の encode 結果が `Serialization Flags + Group ID + Object ID` の固定バイト列と一致すること。
- End of Range の decode が Object Payload Length を要求せず、消費バイト数が 3 フィールド分と一致すること。
- End of Range の直後の通常 Object が、EOR を 1 レコードとして処理した残りバッファから正しく decode できること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。
- `CHANGES.md` の `## develop` に `[FIX]` が追加されること。

## 関連

- `src/dataStream/fetch.ts` (`FetchObjectFields` / `DecodedFetchObject` / `encodeFetchObjectFields` / `decodeEndOfRange`)
- `src/session/stream.ts` (`processFetchObjects`)
- `src/dataStream.fetch.test.ts`
- `refs/moq/draft-ietf-moq-transport-21.txt` §11.4.1.2 / Table 7 / Figure 28
- `https://github.com/moq-wg/moq-transport/issues/1861` (End of Range に Object Payload Length を含めないことの上流での明確化)

## 解決方法

- `encodeFetchObjectFields` の End of Range 分岐から `encodeVarint(fields.payloadLength)` を削除し、`Serialization Flags + Group ID + Object ID` のみを書くようにした。
- `decodeEndOfRange` から Object Payload Length の `decodeVarint` を削除した。返却する `DecodedFetchObject.payloadLength` は 0n 固定とし、`processFetchObjects` が payload 0 バイトとして扱えるようにした。
- `FetchObjectFields.payloadLength` と `DecodedFetchObject.payloadLength` に、通常 Object / EOR それぞれの意味をコメントで明記した。
- テストを追加した。0x8C / 0x10C / 0x20C の 3 値について固定バイト列のエンコードを検証し、decode が 3 フィールドで完結して `payloadLength` が 0n になることを確認した。さらに EOR の直後に通常 Object を連結し、EOR の消費バイト数で次の Serialization Flags からデコードできることを確認した。
- `CHANGES.md` の `## develop` に `[FIX]` を追加した。
- 検証: `vp check` / `tsc --noEmit` / `vp test run` (99 ファイル / 2193 テスト) が通ることを確認した。
