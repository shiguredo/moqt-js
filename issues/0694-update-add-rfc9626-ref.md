# RFC 9626 の本文が refs/ に無く引用をリポジトリ内で検証できない

- Created: 2026-09-24
- Completed: {YYYY-MM-DD}
- Branch: feature/update-add-rfc9626-ref
- Polished: 2026-10-26

## 目的

closed の `0648-bug-loc-video-frame-marking-bits.md` の実装は、`src/loc.ts` の JSDoc とテストで RFC 9626 §3.1 / §3.2 を、`src/loc.ts` の JSDoc で §3.3 を引用しているが、本文は `refs/` に無く外部 URL に依存している。draft-ietf-moq-loc-04 §2.3.2.2 は Video Frame Marking を「as defined in [RFC9626], encoded with a length prefix」と定めて RFC 9626 に委ねるため、RFC 9626 の本文が手元に無いと引用の正しさをリポジトリ内で検証できない。一次資料との突き合わせができないまま、LID のビット幅・L の選び方・§3.2 の扱いが実装とコメントに固定され続ける。

## 現状

- `refs/moq/` には IETF draft が 14 件置かれているが RFC のファイルは無い。`refs/cbor/` には RFC が 12 件あるが、RFC 9626 は `refs/` のどこにも無い
- `src/loc.ts` は RFC 9626 §3.1 を `LOCPropertyId.VIDEO_FRAME_MARKING` / `VideoFrameMarking` / `parseVideoFrameMarkingValue` / `encodeVideoFrameMarkingValue` の JSDoc と本体コメントで引用し、`VideoFrameMarking` の JSDoc で §3.3 のコーデック別 LID マッピングにも言及する
- `src/loc.prop.ts` は `videoFrameMarkingArb` と `decodeVideoFrameMarking` / `decodeVideoProperties` / `encodeVideoFrameMarking` のテストで §3.1 / §3.2 を引用する。`src/loc.test.ts` は `keyFrameMarking` と `encodeVideoFrameMarking` のテストで §3.1 を引用する。`src/testSupport/mediaSubscriberTestSupport.ts` と `devtools/src/hooks/usePublisher.test.ts` にも §3.1 の引用がある
- `src/createMediaPublisher.ts` の `handleVideoEncodedChunk` と `devtools/src/hooks/usePublisher.ts` の `buildObjectSendPlan` は §3.1 D を引用する。`docs/HIGH_LEVEL_API.md` の「LOC コンテナ」節にも §3.1 の引用がある
- `CHANGES.md` は CODEBASE.md の「MOQT RFC ドラフト中の特別ルール」(CHANGES.md を更新しない) により RFC 9626 を引用していない。0648 の「残した課題」にある「JSDoc / CHANGES の引用は外部本文に依存している」は 0648 当時の記録である
- `refs/moq/draft-ietf-moq-loc-04.txt` §2.3.2.2 (Video Frame Marking) は Description で「as defined in [RFC9626], encoded with a length prefix」と定めるだけで、ビット配置は RFC 9626 側にある。References に RFC 9626 の書誌 (Video Frame Marking RTP Header Extension、March 2025) を持つ
- closed 0648 の「残した課題」に「RFC 9626 は `refs/` に無く、JSDoc / CHANGES の引用は外部本文に依存している (`refs/` への追加は別途)」と記録されている
- 0648 の「参照」節も「本文はこのリポジトリの `refs/` に無いため https://www.rfc-editor.org/rfc/rfc9626.txt を参照する」と書いており、外部 URL 依存が明示されている

## 設計方針

- `refs/moq/rfc9626.txt` を追加する。`update-refs` スキルは RFC を `rfc<番号>.txt`、IETF draft を `draft-<name>-<バージョン>.txt` と定めており、グルーピングディレクトリは既存構成を維持する。RFC 9626 は loc-04 が参照する映像フレームマーキングの仕様であり `refs/moq/` に属する
- 取得元は `https://www.rfc-editor.org/rfc/rfc9626.txt`。`update-refs` スキルの手順に従い、ダウンロード後に先頭を読んで RFC 番号・タイトル・日付を確認する
- RFC 9626 は Experimental であり、`update-refs` は RFC の廃止状況も扱う。追加時に IETF Datatracker API (`https://datatracker.ietf.org/api/v1/doc/document/rfc9626/`) の `obsoleted_by` が空であることを確認する。ローカルの RFC テキストを grep して廃止を判定しない (スキルの禁止事項)
- RFC 本文の追加を主目的とし、`src/` の JSDoc は変更しない。`CHANGES.md` は CODEBASE.md の「MOQT RFC ドラフト中の特別ルール」により更新しない。引用の正しさの突き合わせは `polish-refs` の仕事であり、本 issue で引用文を書き換えると検証と修正が混ざる
- `docs/MSF.md` の「仕様参照」は正本パスを 1 行で書く形のため、同じ形で `refs/moq/rfc9626.txt` への参照を追加してよい。追加する場合は RFC 9626 が loc-04 経由の参照であることを併記する。追加は完了条件に含めない (実装時の判断に委ねる)
- `refs/moq/` では RFC 種別の最初のファイルになる (`refs/cbor/` には既に RFC がある) ため、`update-refs` スキルの一覧表示で「種別不明」にならないことを確認する

## 完了条件

- `refs/moq/rfc9626.txt` が存在し、先頭に `Request for Comments: 9626` と `Video Frame Marking RTP Header Extension` を含む
- `src/loc.ts` と `src/loc.prop.ts` が引用する §3.1 / §3.2、および `src/loc.ts` が言及する §3.3 の該当箇所を `refs/moq/rfc9626.txt` 内で確認できる
  - §3.1: L=2 / L=1 / L=0 の長さ、`S|E|I|D|B|TID` のビット配置、LID 8 bits
  - §3.2: Short Extension。残り 4 bits は送信時に 0、受信時に無視する
  - §3.3: コーデック別 LID マッピング
- IETF Datatracker API で RFC 9626 が廃止されていないことを確認している
- `update-refs` スキルの一覧表示で `refs/moq/rfc9626.txt` が RFC 種別として扱われ、「種別不明」にならない
- `src/` / `devtools/` / テストに変更が無く、`npx vp check` / `npx vp test --run` が通る

## 参照

- RFC 9626 (Video Frame Marking RTP Header Extension、March 2025) https://www.rfc-editor.org/rfc/rfc9626.txt
- `refs/moq/draft-ietf-moq-loc-04.txt` §2.3.2.2 (Video Frame Marking) と References の [RFC9626]
- closed `0648-bug-loc-video-frame-marking-bits.md` (RFC 9626 §3.1 / §3.2 に合わせた LID 8 bit 化と 1 オクテット形。`refs/` への追加を残した課題とした)
- `update-refs` スキル (refs/ の命名規則、RFC の廃止確認、ダウンロード手順)
- 0695 (LID=0 かつ TID≠0 の 1 オクテット形) / 0696 (loc-04 §2.3.2.2 の length prefix の解釈)

## 解決方法

{未着手}
