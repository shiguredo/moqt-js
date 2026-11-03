# LOC 05 の CODEC_STRING Property を読み書きする

- Created: 2026-11-03
- Completed: {YYYY-MM-DD}
- Branch: feature/add-loc-codec-string
- Polished: {YYYY-MM-DD}

## 目的

draft-ietf-moq-loc-05 §2.3.1.3 は、WebCodecs の codec に対応する UTF-8 の CODEC_STRING (0x11) を追加した。現在の LOC helper は config の description を扱えるが、codec string を取得・生成できない。

## 現状

- `src/loc.ts` の `LOCPropertyId`、`VideoProperties` / `AudioProperties` に CODEC_STRING が無い
- `extractLocProperties` と `resolveVideoProperties` / `resolveAudioProperties` は timestamp / timescale / config などを解決するが、0x11 は抽出しない
- `src/index.ts` が LOC helper を公開している

## 設計方針

- 0x11 の length-prefixed UTF-8 Property を encode / decode する helper と公開型を追加する
- Track / Object 両方から抽出し、既存の config と同様に Object 値を優先、無ければ Track 値へフォールバックする
- `src/properties.ts` 側で対応済み型として扱う場合は Value 形式・scope・重複の検証を 0913 / 0914 と揃える
- MSF catalog の codec と矛盾した際の新しい優先規則や、Object ごとの無条件 decoder 再構成を推測で追加しない。本 issue は LOC Property の公開・解決までを対象とする

## 完了条件

- ASCII / マルチバイト UTF-8、長さ・チャンク境界、Track / Object の各 scope を検証する
- audio / video 両方で resolve と公開 export を利用できる
- CODEC_STRING が無い既存 Object の処理は変わらない
- 仕様参照を LOC 05 にし、0x11 を別 Property と誤認しない

## 参照

- `refs/moq/draft-ietf-moq-loc-05.txt` §2.3.1.3 / §6.1
- `src/loc.ts`、`src/properties.ts`、`src/index.ts`、`src/loc.test.ts` / `loc.prop.ts`

## 解決方法

{未着手}
