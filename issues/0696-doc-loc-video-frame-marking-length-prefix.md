# loc-04 §2.3.2.2 の length prefix の解釈が実装コメントにしか無い

- Created: 2026-09-24
- Completed: {YYYY-MM-DD}
- Branch: feature/update-loc-video-frame-marking-length-prefix
- Polished: 2026-09-24

## 目的

draft-ietf-moq-loc-04 §2.3.2.2 は Video Frame Marking を「as defined in [RFC9626], encoded with a length prefix」とだけ定め、この length prefix が RFC 9626 の ID / L ニブルを含むのか、Value (1〜4 バイト) をデータ部とみなすのかを明記していない。実装は Value をデータ部とみなす解釈を採っているが、根拠が `src/loc.ts` の JSDoc の断片にしか無く、docs にも書かれていない。仕様の読み方が一意でない箇所を暗黙のまま残すと、実装の変更時に解釈が揺れる。closed の `0648-bug-loc-video-frame-marking-bits.md` でも残した課題として記録されており、判断と根拠を明文化して固定する。

## 現状

- `refs/moq/draft-ietf-moq-loc-04.txt` §2.3.2.2 (420-433 行目) は Name / Description / ID: 0x09 / Length: Varies (1-4 bytes) / Value: Varies のみを定め、length prefix の内訳を書いていない
- 同ドラフト §2.3 (LOC Properties) は IANA registry に登録する情報として「Length: Length of metadata Value in bytes (vi64 if ID is odd, omitted if ID is even)」と「Value: Value of metadata (vi64 if ID is even, Length bytes if ID is odd)」を定める。Length は Value のバイト数であり、Property の ID は含まない
- `src/loc.ts` の `LOCPropertyId` の JSDoc (39-46 行目) は「ID が偶数の場合: Length 省略、Value は vi64 / ID が奇数の場合: length (varint) + bytes」と書くが、VIDEO_FRAME_MARKING の length prefix が RFC 9626 の ID / L ニブルを含まない根拠までは書いていない
- `src/loc.ts` の `LOCPropertyId.VIDEO_FRAME_MARKING` の JSDoc (60-66 行目) は「受信は length prefix 付きバイト列で Length 1-4 を受理する (3-4 バイト目の TL0PICIDX / 余剰は解釈せず消費のみ)」と書くが、解釈の根拠は示していない
- `src/loc.ts` の `encodeVideoFrameMarking` (377 行目) は Property ID 0x09 を varint で前置し、そのあとに Value 長を varint で置く (378-386 行目)。length prefix は Value 長のみを数える
- `src/loc.ts` の `decodeVideoFrameMarkingAfterId` (185 行目) は length を 1〜4 に制限し (192 行目)、宣言 Length ぶんのバイトを Value として `parseVideoFrameMarkingValue` に渡す (196-203 行目)
- `src/loc.prop.ts` は Length=3 (418 行目) と Length=4 (441 行目) のテストを持ち、3 バイト目以降を TL0PICIDX / 余剰として消費する挙動を固定している。`src/loc.prop.ts` の「Length=1 でも byte1 の TID / B はワイヤの値を読む」テスト (383 行目) も、Value の先頭バイトが RFC 9626 §3.1 の byte1 であることを前提にしている
- `docs/HIGH_LEVEL_API.md` の「LOC コンテナ」節 (443 行目) は高レベル API が扱う Property を列挙し VIDEO_FRAME_MARKING にも触れるが (448-450 行目)、length prefix の解釈には触れていない
- closed 0648 の「残した課題」に「draft-ietf-moq-loc-04 §2.3.2.2 の「length prefix」が RFC 9626 の ID / L ニブルを含むかは仕様に明記が無く、Value (1〜4 バイト) をデータ部とみなす現解釈を維持している」と記録されている

## 設計方針

- 解釈をドキュメントで確定させ、実装は現解釈 (Value をデータ部とみなす) を維持する。コードの挙動とテストの期待値は変えない
- 根拠は次の 3 点で書く
  - LOC の Property は ID + Length + Value の形を取り、Length は「Length of metadata Value in bytes」(§2.3) である。length prefix は LOC の Property Length であり、Value のバイト数のみを数える
  - RFC 9626 の ID と L は RFC 8285 の RTP ヘッダ拡張のフィールドである。ID は extmap で決まる RTP の拡張 ID、L はデータ長を表すニブルで、どちらも LOC のワイヤには存在しない。LOC はこの 2 つを LOC Property ID (0x09) と varint の Length で置き換える
  - したがって Value は RFC 9626 §3.1 の「L ニブルの後ろのデータ」だけを含む。Length 1〜4 は §3.1 の L=0 / L=1 / L=2 のデータ長 (1 / 2 / 3 オクテット) と余剰 1 オクテットを受理する意味になり、3 バイト目以降を解釈せず消費するだけの現挙動と整合する。§3.2 の short extension は L=0 の 1 オクテット形と同じワイヤになるが、LOC の Value は Length で長さが明示されるため §3.2 の「残り 4 bits は受信時に無視する」規則は適用しない
- 書き込み先は `src/loc.ts` の JSDoc と `docs/HIGH_LEVEL_API.md` の「LOC コンテナ」節 (443 行目) の 2 箇所とする。JSDoc は `LOCPropertyId.VIDEO_FRAME_MARKING` / `decodeVideoFrameMarkingAfterId` / `encodeVideoFrameMarking` の 3 つに、節番号つきで同じ根拠を要約する
- `docs/HIGH_LEVEL_API.md` には「length prefix は LOC の Property Length で、RFC 9626 の ID / L ニブルは含まない」を 1 項目として足し、参照する節 (`refs/moq/draft-ietf-moq-loc-04.txt` §2.3 / §2.3.2.2 と RFC 9626 §3.1) を書く。RFC 9626 の本文は 0694 で `refs/moq/rfc9626.txt` に追加する
- 解釈の変更 (Length の意味を変える、§3.2 の規則を取り込む等) が必要と判明した場合は本 issue では扱わず、実装変更の issue を別に立てる。本 issue の完了条件にコード変更を含めない
- 対象は `src/loc.ts` (JSDoc のみ) と `docs/HIGH_LEVEL_API.md` とする。`CHANGES.md` は挙動が変わらないため追記しない

## 完了条件

- `src/loc.ts` の `LOCPropertyId.VIDEO_FRAME_MARKING` / `decodeVideoFrameMarkingAfterId` / `encodeVideoFrameMarking` の JSDoc に、length prefix が LOC の Property Length であり RFC 9626 の ID / L ニブルを含まない根拠が節番号つきで書かれている
- `docs/HIGH_LEVEL_API.md` の「LOC コンテナ」節に同じ解釈が書かれ、参照する節 (`refs/moq/draft-ietf-moq-loc-04.txt` §2.3 / §2.3.2.2、RFC 9626 §3.1) が示されている
- Length 1〜4 の受理と 3 バイト目以降を解釈しない現挙動の説明が、根拠と結び付いている
- コードの挙動とテストの期待値が変わっていない
- `npx vp check` / `npx vp test --run` が通る

## 参照

- `refs/moq/draft-ietf-moq-loc-04.txt` §2.3 (LOC Properties の Length / Value の定義) / §2.3.2.2 (Video Frame Marking。Length: Varies (1-4 bytes)) / §6.1 Table 1 (ID 0x09 と Scope)
- RFC 9626 §3.1 (Long Extension。L=2 / L=1 / L=0 と `S|E|I|D|B|TID` のビット配置) / §3.2 (Short Extension)。本文は 0694 で `refs/moq/rfc9626.txt` に追加する
- RFC 8285 (RTP header extension の ID と L ニブル)
- closed `0648-bug-loc-video-frame-marking-bits.md` (length prefix の解釈を残した課題として記載)
- 0694 (RFC 9626 の `refs/` 追加) / 0695 (LID=0 かつ TID≠0 の 1 オクテット形)

## 解決方法

{未着手}
