# HIGH_LEVEL_API.md を現コードに合わせる

- Created: 2026-09-06
- Completed: YYYY-MM-DD
- Branch: feature/fix-high-level-api-doc
- Polished: YYYY-MM-DD

## 目的

ドキュメント通りに書くと実行時失敗・無視される箇所があり、主要 API の欠落もある。現コードと一致させる必要がある。

## 現状

- 存在しない `setStream()` / `ready` 遷移、幽霊オプション `reorderTimeout`、逆の codec 必須表記がある。
- `onCatalog` / `getCatalog` / `catalog` / 認可系 / `pendingSubgroup` が欠落する。
- VIDEO_CONFIG 等の「未配線」一括りが現コード (送信あり) と矛盾する。

## 設計方針

1. 現コードのシグネチャ・状態遷移・オプションに合わせて書き直す。
2. 自動処理の列挙を実装と一致させる。

## 完了条件

- 記載の全 API が現コードと一致すること。
- `vp check` が通ること (markdownlint 対象のため)。
