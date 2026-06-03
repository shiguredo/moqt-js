# CHANGES.md のエントリ種別順序を修正する

- Priority: Medium
- Created: 2026-06-03
- Model: deepseek-v4-pro
- Branch: feature/draft-18

## 目的

AGENTS.md:97「エントリは種別の順番を守って記載すること (CHANGE → ADD → UPDATE → FIX の順)」に反するエントリが複数あるため、正しい順序に並べ替える。

## 優先度根拠

リリース時の品質に直結する。プロジェクト規約違反。

## 現状

CHANGES.md `## develop` セクション内で以下の順序違反がある:

1. Line 79: [CHANGE] #0182 が [ADD] の後に出現
2. Line 85: [FIX] #0231 が [ADD] の前に出現
3. Line 92-104: [ADD] #0236, #0241, #0242 が [FIX] の後に配置
4. Line 109-137: [FIX] 群の中に [ADD] が混在
5. Line 141-147: [ADD] #0263-#0265 が [FIX] の後に出現
6. Line 157-160: [UPDATE] #0269, #0266 が [FIX] の前後に分散
7. `### misc` セクション内でも [UPDATE] → [ADD] → [UPDATE] と順序違反

## 設計方針

- 全エントリを `[CHANGE] → [ADD] → [UPDATE] → [FIX]` の順に並べ替える
- `### misc` 内も同様の順序に修正する
- 各エントリの内容は変更しない

## 完了条件

- CHANGES.md `## develop` セクションの全エントリが正しい種別順序になっている
- `### misc` セクションも正しい順序になっている
