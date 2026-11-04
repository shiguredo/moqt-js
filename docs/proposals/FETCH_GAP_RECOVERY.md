# fill / FETCH による欠落回復の検討

SUBSCRIBE を継続しながら、受信できなかった Object を fill または FETCH で取得する
クライアント側の設計案である。汎用の欠落回復 Controller は未実装であり、公開 API の仕様ではない。

2026-10-22 の検討を、2026-11-01 にクライアントの責務へ整理した。
現在の低レベル API は `20985ca8` で確認した。整理前の検討全体は
[当時の文書](https://github.com/shiguredo/moqt-js/blob/20985ca894c69b99bdd4b568472002215b4156a4/docs/FETCH_GAP_RECOVERY.md)
に残る。リレー固有の内部構成、cache の期間、未実装機能の予定をクライアントの契約にしない。

## 取得と再生を分ける

SUBSCRIBE は継続的な配信、FETCH は過去の有限な範囲の取得を担う。
fill は購読に FILL_PARAMETERS を付け、FETCH と同じ framing の stream で範囲を取得する。
それぞれの要求を送れることと、欠落の検出から再生までを自動回復できることは別である。

回復した音声が再生期限を過ぎていれば、すでに出力された無音は戻せない。
映像でも、古い参照フレームを後から渡すだけでは decoder の参照状態を復旧できない。
取得成功数だけでなく、期限内に復号と再生へ利用できた数を評価する。

## 実装済みの入口

| 入口                                                     | 現在できること                                                          |
| -------------------------------------------------------- | ----------------------------------------------------------------------- |
| `Session.fetch()`                                        | 別の request stream で FETCH を要求し、FETCH_OK 後に Fetcher を受け取る |
| `FetchOptions`                                           | Location Filter、fillTimeout、優先度、認可トークンなどを指定する        |
| `Subscriber.update({ fill })`                            | 継続購読へ fill を要求する                                              |
| `MoqtObject.fillDelivered`                               | 購読の object コールバックへ届いた fill の Object を区別する            |
| `SubscribeCallbacks.fillError`                           | fill の失敗を購読そのものの終了と分けて受け取る                         |
| `SubscribeCallbacks.subgroupEnd`                         | Subgroup stream の FIN / RESET と識別子を受け取る                       |
| `Subscriber.largestLocation` / `largestReceivedLocation` | 要求時と受信済みの最大 Location を確認する                              |

型は [低レベル API](../LOW_LEVEL_API.md) と
[session/publicTypes.ts](../../src/session/publicTypes.ts)、
[subscriber.ts](../../src/subscriber.ts) にある。
これらの入口に、汎用の欠落追跡、購読と取得の重複排除、期限管理は含まれない。

## 欠落を確定する前提

Group ID / Object ID の飛びを、常に欠落とみなさない。
トラックの連続性、購読の Location Filter、Properties の Prior Group ID Gap /
Prior Object ID Gap、END_OF_GROUP / END_OF_TRACK を先に確認する。
存在しない Location やフィルタで除外した Object を繰り返し取得しない。

Datagram の順序逆転には猶予を置く。Subgroup の RESET では、最後に処理した Object と
別 stream で届く続きの位置を合わせて判断する。
RESET と続きの stream はどちらが先に届いてもよく、RESET だけで範囲の終端が分かるとは扱わない。
Object を 1 件も受信できず開始位置が不明な場合は、不明として観測し、範囲を推測しない。

## Controller の配置案

汎用 Subscriber の既定動作へメディアの連続性を組み込まず、低レベル API の利用者が
明示的に使う独立した Controller を候補とする。
アプリケーションは通常の購読コールバックで受けた Object を渡し、Controller は
受信済み Location の記録、欠落の判定、取得要求、回復した Object の通知を担う。

fill と FETCH のどちらを使う場合も、通常の購読と同じ重複排除と期限の判定を通す。
回復した Object の利用、媒体順への並べ替え、codec へ渡してよいかの判断は、
トラックの形式と再生期限を知る呼び出し側が持つ。

| 状態       | 操作                                                       |
| ---------- | ---------------------------------------------------------- |
| 欠落の疑い | 通常の遅着を待ち、非存在とフィルタを除外する               |
| 範囲が確定 | 受信済み範囲を差し引き、期限と要求数の予算を確認する       |
| 取得中     | 通常購読、fill、FETCH の受信を同じ Location で突き合わせる |
| 回復       | 期限内の未配送 Object だけを通知する                       |
| 断念       | 期限、取得失敗、不明な結果を理由付きで記録する             |
| 終了       | 購読またはセッションの終了時に要求とタイマーを解放する     |

重複排除のキーは Track Namespace、Track Name、Group ID、Object ID とする。
Subgroup ID は stream の継続と欠落範囲の判断に使い、同じ Object の別の識別子にはしない。
同じ Location の payload が食い違う場合は上書きせず、異常として記録する。

## 実装前に解決する制限

- FETCH と fill の End of Range は [stream.ts](../../src/session/stream.ts) がアプリへ通知せず読み飛ばす。返らない範囲を非存在、unknown、timed out に正確に分類するには API の追加が必要
- fill の正常な stream 終了を受け取る専用コールバックが無い。fillError と REQUEST_UPDATE の応答だけでは、範囲の正常取得完了を確認できない
- fillDelivered は fill 経由であることを示すが、個々の fill 要求との対応を示さない。同時要求を許す前に対応づけを決める必要がある
- Session.fetch の Promise は FETCH_OK まで解決しない。応答待ちの打ち切りと Fetcher.cancel を混同しない
- 応答の End Location は、要求した全 Object が取得できた証明ではない。要求範囲と実受信を突き合わせる

要求数、回復範囲、保持時間、再試行回数には上限を設ける。
応答を正確に分類できないまま、期限まで無制限に再試行する設計にはしない。
fill から FETCH への切替を行う場合も、両方の要求と通常購読から届く重複を処理する。

## 検証と採用の条件

まず実リレーで範囲指定 FETCH と継続購読を同時に実行し、要求範囲、応答、購読への影響を確認する。
次に欠落判定と重複排除を実クラスと実ストリームで検証し、fill の対応づけと失敗経路を追加する。
モックやスタブでリレーの挙動を仮定しない。

音声へ統合する前に、同じ受信列で回復なしの経路と比較し、遅延、期限内の回復、
波形、処理負荷を測る。購読の停止、セッション断、GOAWAY でも処理が残らないことを確認する。
音声の既定の待ちを増やした結果だけで採用を決めない。

再接続、リレー内部の修復、ペイロードの end-to-end 保護は、この Controller の責務に含めない。
保持される Object と取得可能期間を、特定のリレーの内部実装から固定しない。

## 参照

- [MOQT draft-23](../../refs/moq/draft-ietf-moq-transport-23.txt): §3.2 FETCH、§3.4 fill、§9.19.15 FILL_PARAMETERS
- [MSF draft-01](../../refs/moq/draft-ietf-moq-msf-01.txt): トラックと Group の構造
- [低レベル API](../LOW_LEVEL_API.md): 実装済みの要求と通知
- [購読側の再生遅延](../PLAYOUT_DELAY.md): 意図した保持と再生期限
- [音声と映像の再生](../PLAYOUT.md): 復号の追いつきと欠落の補間
