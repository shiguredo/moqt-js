# catalog 検証の残り (depends の §7.2 規則 / eventtimeline の条件付き depends / keyId と trackBaseKey)

- Created: 2026-11-16
- Completed: 2026-11-16
- Branch: feature/update-msf-draft-02
- Polished: {YYYY-MM-DD}

## 目的

D-51 / D-06 / D-52 の 3 件を実装する。いずれも catalog の検証で閉じられる。

## 現状

- D-51: §7.2 は「renderGroup の全 track が media timeline にあるなら renderGroup を MUST 参照し個別 Track Name を MUST NOT 参照、部分一致ならその逆」を定めるが、`depends` は参照先の解決だけを検証している
- D-06: eventtimeline の `depends` は無条件 MUST を撤廃したが、index が media timeline track を参照する場合の条件付き MUST は payload を見ないと判定できない
- D-52: §4.4.3 は `moq-secure-objects` のとき `cipherSuite` / `keyId` / `trackBaseKey` を MUST とするが、実装は `cipherSuite` の存在だけを見る

## 設計方針

- D-51: `depends` に Number (renderGroup) と、その renderGroup に属する track の Track Name が同居していたら拒否する。全体一致と部分一致の判定は「その renderGroup の track がすべて media timeline の depends に現れるか」では決まらないため、禁止される組み合わせ (同じ renderGroup を group 参照と個別参照の両方で指す) だけを機械的に拒否する
- D-06: catalog 単体では判定できないため、payload を解釈する層向けの検証 helper `assertEventTimelineDepends(track, entries)` を追加する。Location index を持つエントリがあるのに `depends` が無ければ拒否する
- D-52: `encryptionScheme === "moq-secure-objects"` のとき `keyId` と `trackBaseKey` を必須にする。§5.2.40 / §5.2.41 の表は Optional だが、§4.4.3 の条件付き MUST を優先する

## 完了条件

- renderGroup 参照とその配下の Track Name 参照が同居する `depends` を拒否する。単体テストで固定する
- `assertEventTimelineDepends` が Location index で `depends` 無しの track を拒否する。単体テストで固定する
- `moq-secure-objects` で `keyId` / `trackBaseKey` が無い track を拒否する。単体テストで固定する
- `npx vp check` / `npx tsc --noEmit` / `npx vp test --run` が通る

## 解決方法

- `src/msf/catalogValidation.ts` の `assertDependsResolvable` で、同じ renderGroup を Number 参照と配下 track の Track Name 参照で併記する `depends` を拒否するようにした (§7.2)
- `assertEventTimelineDepends(track, entries)` を追加した。Location index を持つ eventtimeline で `depends` が無ければ拒否する。catalog 単体では payload を見られないため、payload を解釈した後の検証 helper とした
- `src/msf/catalogTrackValidation.ts` で、`moq-secure-objects` のとき `cipherSuite` に加えて `keyId` と `trackBaseKey` も必須にした (§4.4.3)
- PBT の arbitrary と既存テストを新しい MUST に合わせて更新した
- issue ファイルが空になっていたため、本文を復元したうえで解決方法を追記した
