# RFC 9626 の本文が refs/ に無く引用をリポジトリ内で検証できない

- Created: 2026-09-24
- Completed: {YYYY-MM-DD}
- Branch: feature/update-add-rfc9626-ref
- Polished: 2026-09-24

## 目的

closed の `0648-bug-loc-video-frame-marking-bits.md` の実装は、`src/loc.ts` の JSDoc とテストで RFC 9626 §3.1 / §3.2 / §3.3 を引用しているが、本文は `refs/` に無く外部 URL に依存している。draft-ietf-moq-loc-04 §2.3.2.2 は RFC 9626 に委ねる形で Video Frame Marking のビット配置を定めるため、RFC 9626 の本文が手元に無いと引用の正しさをリポジトリ内で検証できない。一次資料との突き合わせができないまま、LID のビット幅・L の選び方・§3.2 の扱いが実装とコメントに固定され続ける。

## 現状

- `refs/` 配下は `refs/moq/` のみで、IETF draft が 11 件置かれている。RFC のファイルは 1 件も無い
- `src/loc.ts` は RFC 9626 §3.1 を `LOCPropertyId.VIDEO_FRAME_MARKING` の JSDoc (60-66 行目)、`VideoFrameMarking` の JSDoc (86-93 行目)、`parseVideoFrameMarkingValue` の JSDoc (137-142 行目)、`encodeVideoFrameMarkingValue` の JSDoc と本体コメント (321-344 行目、356-361 行目) で引用し、§3.3 のコーデック別 LID マッピングにも言及する
- 同じ引用が `src/loc.prop.ts` (45 / 56 / 384 / 420 / 442 / 489 / 510 / 532 / 542 / 586 / 610 / 623 / 653 / 739 行目)、`src/loc.test.ts` (55 / 365-367 行目)、`src/createMediaPublisher.ts` (968 行目)、`devtools/src/hooks/usePublisher.ts` (210 行目)、`docs/HIGH_LEVEL_API.md` (450 行目)、`CHANGES.md` (253-259 行目) に広がっている
- `refs/moq/draft-ietf-moq-loc-04.txt` §2.3.2.2 (420-433 行目) は Description で「as defined in [RFC9626], encoded with a length prefix」と定めるだけで、ビット配置は RFC 9626 側にある。References (1013-1016 行目) に RFC 9626 の書誌 (Video Frame Marking RTP Header Extension、March 2025) を持つ
- closed 0648 の「残した課題」に「RFC 9626 は `refs/` に無く、JSDoc / CHANGES の引用は外部本文に依存している (`refs/` への追加は別途)」と記録されている
- 0648 の「参照」節も「本文はこのリポジトリの `refs/` に無いため https://www.rfc-editor.org/rfc/rfc9626.txt を参照する」と書いており、外部 URL 依存が明示されている

## 設計方針

- `refs/moq/rfc9626.txt` を追加する。`update-refs` スキルは RFC を `rfc<番号>.txt`、IETF draft を `draft-<name>-<バージョン>.txt` と定めており、グルーピングディレクトリは既存構成を維持する。RFC 9626 は loc-04 が参照する映像フレームマーキングの仕様であり `refs/moq/` に属する
- 取得元は `https://www.rfc-editor.org/rfc/rfc9626.txt`。`update-refs` スキルの手順に従い、ダウンロード後に先頭を読んで RFC 番号・タイトル・日付を確認する
- RFC 9626 は Experimental であり、`update-refs` は RFC の廃止状況も扱う。追加時に IETF Datatracker API (`https://datatracker.ietf.org/api/v1/doc/document/rfc9626/`) の `obsoleted_by` が空であることを確認する。ローカルの RFC テキストを grep して廃止を判定しない (スキルの禁止事項)
- 本文の追加だけを行い、`src/` の JSDoc と `CHANGES.md` の引用は変更しない。引用の正しさの突き合わせは `polish-refs` の仕事であり、本 issue で引用文を書き換えると検証と修正が混ざる
- `docs/MSF.md` は正本パスを 1 行で書く形 (10 行目) のため、同じ形で `refs/moq/rfc9626.txt` への参照を追加するかは実装時に判断する。追加する場合は RFC 9626 が loc-04 経由の参照であることを併記する
- RFC 9626 は `refs/` の命名規則から見て RFC 種別の最初のファイルになるため、`update-refs` スキルの一覧表示で「種別不明」にならないことを確認する

## 完了条件

- `refs/moq/rfc9626.txt` が存在し、先頭に `Request for Comments: 9626` と `Video Frame Marking RTP Header Extension` を含む
- `src/loc.ts` / `src/loc.prop.ts` / `CHANGES.md` が引用する §3.1 / §3.2 / §3.3 の該当箇所を `refs/moq/rfc9626.txt` 内で確認できる
  - §3.1: L=2 / L=1 / L=0 の長さ、`S|E|I|D|B|TID` のビット配置、LID 8 bits
  - §3.2: Short Extension。残り 4 bits は送信時に 0、受信時に無視する
  - §3.3: コーデック別 LID マッピング
- IETF Datatracker API で RFC 9626 が廃止されていないことを確認している
- `src/` / `devtools/` / テストに変更が無く、`npx vp check` / `npx vp test --run` が通る

## 参照

- RFC 9626 (Video Frame Marking RTP Header Extension、March 2025) https://www.rfc-editor.org/rfc/rfc9626.txt
- `refs/moq/draft-ietf-moq-loc-04.txt` §2.3.2.2 (Video Frame Marking) と References の [RFC9626]
- closed `0648-bug-loc-video-frame-marking-bits.md` (RFC 9626 §3.1 / §3.2 に合わせた LID 8 bit 化と 1 オクテット形。`refs/` への追加を残した課題とした)
- `update-refs` スキル (refs/ の命名規則、RFC の廃止確認、ダウンロード手順)
- 0695 (LID=0 かつ TID≠0 の 1 オクテット形) / 0696 (loc-04 §2.3.2.2 の length prefix の解釈)

## 解決方法

{未着手}
