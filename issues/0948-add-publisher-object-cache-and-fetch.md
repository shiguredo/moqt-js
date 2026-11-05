# 低レベル publisher が Object を保持し relay からの FETCH に応答できるようにする

- Created: 2026-11-04
- Completed: {YYYY-MM-DD}
- Branch: feature/add-publisher-object-cache-and-fetch
- Polished: {YYYY-MM-DD}

## 目的

draft-ietf-moq-transport-23 §3.2.3 は、relay が要求範囲内の Object をすぐに提供できず、その状態が Unknown の場合に、1 件以上の upstream FETCH で取得する動作を定める。§7.7 は publisher の照合方法を定め、PUBLISH_NAMESPACE によって subscriber の要求に応じた FETCH を publisher へ送れると説明している。

moqt-js の低レベル publisher に Object の保持と受信 FETCH への応答を追加し、relay のキャッシュにない公開済み Object を、保持範囲内で提供できるようにする。これはブラウザクライアントが original publisher として応答する機能であり、サーバーや relay として動作する機能は追加しない。仕様がすべての publisher に無期限の保持を要求しているという前提にはしない。

対象は `Session.publish`、`Publisher.sendObject` / `sendDatagram`、保持設定とセッション内部の FETCH 応答である。低レベルは Object / Group の識別子に基づいて保持を実行し、高レベルがメディア構成と A/V Sync の方針から保持設定を選べるようにする。高レベル API への組み込み、キーフレームの解析、Catalog・音声・映像固有の保持量や A/V Sync の実装は対象外とする。

## 現状

- `src/session/incoming.ts` の `incomingClassifyFirstBidiMessage` は FETCH を `unsupported-request` に分類する。`incomingHandleFirstBidiMessage` は通常の Track への FETCH を REQUEST_ERROR の NOT_SUPPORTED で拒否する
- `src/publisher.ts` の `PublisherImpl.sendObject` / `sendDatagram` と `src/session/publish.ts` の送信処理には、過去の Object を再取得する保持機構がない。Publisher は購読ごとの Request ID / Track Alias を持ち、Full Track Name を保持する共通の公開 Track 管理も必要になる
- `PublisherImpl.guardSend` は paused 中の送信を見送り、Location Filter の範囲外の Object も送信しない。ネットワーク送信の成功後だけに保存する構成では、これらの Object は保持対象に入らない
- `src/session/publicTypes.ts` の `PublishOptions.maxCacheDuration` は relay に送る MAX_CACHE_DURATION の設定であり、publisher 自身の保持期間や容量の設定ではない
- `src/message/fetch.ts` の `decodeFetchPayload`、`src/dataStream/fetch.ts` の `encodeFetchHeader` / `encodeFetchObjectFields` は存在するが、publisher が受信 FETCH に応答するセッション処理には接続されていない。現行 codec は draft-22 の形式を前提とし、draft-23 への移行は別 issue で管理されている

## 設計方針

### 保持の単位と範囲

- 保存する実体は Object とし、Track ごとに最新 N Object または最新 N Group を保持する方針を選べるようにする。これはローカルの保持方針であり、MOQT の FETCH の要求範囲自体を制限するものではない。Datagram / Subgroup の配送方式から保持方針を自動判定しない
- 「最新」は Location (Group ID、同じ Group 内では Object ID) の大小で決め、API の呼び出し順、送信の完了順、FETCH の参照順で更新しない。Group / Object ID の連続性を仮定せず、実在する一意な Object / Group の件数で数える。遅れて受け入れた古い位置によって新しい位置を追い出さない
- Object モードでは最新 N 件の一意な Normal Object を保持し、古い Object から破棄する。空 payload の Normal Object も 1 件として数える。Group をまたいだ件数とし、Group の先頭や完結性は保証しない。同じ Group ID / Object ID の冗長送信・再送では件数や保持期限を増やさない
- Group モードでは実在する最新 N Group を保持し、範囲から外れた Group を丸ごと破棄する。現在公開中の未完了 Group も件数に含め、その受け入れ済み Object を保持する。N に 2 という固定の上限は設けず、アプリが必要量を指定する。N 件分を指定時に先行して確保しない
- End of Group / End of Track、不存在や Gone の状態記録は、Normal Object の保持件数とは別に有限の予算で保持する。終端通知だけで最新 N Object の枠を消費し、必要な Normal Object を押し出す構成にしない
- 件数に加えて、Track ごとと Session 全体の容量上限を適用する。Track の超過ではその Track の古い保持単位から、Session 全体の超過では保持開始時刻が古い保持単位から破棄する。保持単位は Object モードで 1 Object、Group モードで 1 Group とし、Group モードの履歴を Object 単位で間引かない
- 単体 Object が容量上限を超える場合、Object モードではその Object の保持を見送り、次の保持可能な Object は受け入れる。Group モードで 1 Group 自体が容量・管理件数の上限を超えた場合は、その Group の保持分を解放し、同じ Group の後続 Object の保持も見送る。通常の公開は継続し、次の保持可能な Group から再開する
- 保持対象から外れた履歴への FETCH は Gone / Unknown を仕様どおりに返す。要求された過去の位置に最新 Object を代入しない。低レベルは音声・映像の判別や A/V Sync のための保持期間計算を行わない

### 公開 Track と Object の保持

#### 保存先と所有者

- キャッシュの所有者は Session とし、同じ Session の複数 Publisher が共有する。モジュールのグローバル変数やタブ間の共有領域には置かず、別 Session や再読み込み後の履歴復元は要求しない
- アプリが指定する N Object / N Group と容量上限に基づき、Uint8Array と Blob を主要な比較候補とする。Object / Group のサイズ分布によるため、件数だけで保存方式を確定しない
- 保存媒体と実行場所を別々に評価する。Worker は保存媒体ではなく、I/O や符号化の実行場所である。キャッシュだけを Worker に移す場合と、Session とキャッシュを同じ Worker に置く場合ではバッファ受け渡しのコストが異なる。既存の低レベル API と入力バッファの所有権を保てるか確認する

| 候補 | ブラウザ API の性質と本用途での評価点 |
| --- | --- |
| Uint8Array + Map | 直接バイト列を参照できる比較基準。保持する二進データと索引の容量をアプリ側で制限する。短期・少量の応答速度を重視する場合の候補 |
| Blob + Object の位置索引 | Blob は不変の二進データで、範囲の切り出しと非同期の読み出しができる。Chromium にはメモリからディスクへ退避する実装があるが、その配置や閾値は API で制御できず、他のエンジンでも同じ挙動とは限らない。Object ごとの小さい Blob と、上限サイズにまとめた Blob の両方を比較する |
| IndexedDB | Object store、複合キー、範囲検索を持ち、Object とメタデータを同じトランザクションで管理できる。値のシリアライズとトランザクションのコストがある。採用候補にする場合は小さな処理の都度アクセスする方式だけでなく、上限付きのバッチ読み書きと Blob 値も比較する |
| OPFS + Dedicated Worker | 同期アクセスハンドルでバイト位置を指定して読み書きできる。バイト列をファイルに置く候補。採用するならサイズ上限付きファイルと Object の位置索引で管理し、JS の索引と I/O キューを制限する。Object ごとにファイルを作る方式や、無制限に成長する 1 本のファイルを前提にしない |
| Cache API | Request / Response の保存を扱う。MOQT の ID と範囲検索には変換・索引の管理が別途必要であり、今回のデータモデルとの適合性は低い。ブラウザの「キャッシュ」という名前だけを理由に選ばない |

- Blob の生成時も BufferSource のバイト列はスナップショットになるため、コピーが必ずなくなるとは説明しない。Blob のディスク退避や GC 負荷低減も、全ブラウザでの保証にはしない
- 初期実装の採用方式は、N Object / N Group のサイズ分布、公開しながらの FETCH 応答、保持中のメモリ、メインスレッドへの影響を測定して決め、理由と制約を記録する。メモリ方式だけを最適と断定したり、比較前に複数 backend やメモリ・ディスクの二段構成を必須にしたりしない
- 複数 Object を同じ Blob / ファイルへまとめる場合は、Object 単位で破棄しても実体の一部が残る。死んだ領域を含む保持中の実体全体を容量へ計上し、回収・再構成時の一時コピーと作業量にも上限を設ける。論理上 N Object を守っていても物理データが蓄積する構成にしない
- IndexedDB / OPFS を選ぶ場合も目的は Session 中のキャッシュである。保存失敗、quota 超過、データ消失、異常終了後の残存データの清掃を扱い、他の稼働中 Session のデータを消さない。`navigator.storage.estimate()` は概算であり、アプリ指定上限の代わりにはしない
- キャッシュは専用の内部モジュールに分離し、`Session.publish` と `Publisher.sendObject` / `sendDatagram` から利用する。時計・タイマーは Session が渡し、保持範囲の選択や期限判定は時刻を引数に取れる形にする。保存先を差し替える利用者向けの汎用ストレージ API は必須にしない

#### 保存方式の簡易比較

2026-11-04 に macOS 上の Playwright の Chromium 156.0.8078.4、Firefox 157.0、WebKit 27.2 で、実際のブラウザ API を Dedicated Worker から呼んで比較した。各ケースの合計は 16 MiB で、入力生成と初期化を除いた保存・全件順次読み出しを各 1 回測定した。以下は保存 / 読み出しの合計時間で、単位は ms。0 は計時の分解能未満を含む。

| エンジン | Object の構成 | Uint8Array | Blob をまとめて保持 | IndexedDB のバッチ処理 | OPFS のバッチ処理 |
| --- | --- | --- | --- | --- | --- |
| Chromium | 128 KiB × 128 件 | 1.9 / 0.1 | 4.9 / 5.0 | 13.5 / 9.5 | 25.7 / 5.2 |
| Chromium | 4 KiB × 4,096 件 | 4.9 / 0.9 | 17.9 / 10.8 | 76.3 / 46.6 | 34.9 / 11.9 |
| Firefox | 128 KiB × 128 件 | 1 / 0 | 2 / 4 | 69 / 17 | 8 / 2 |
| Firefox | 4 KiB × 4,096 件 | 4 / 1 | 3 / 9 | 210 / 40 | 10 / 3 |
| WebKit | 128 KiB × 128 件 | 2 / 0 | 3 / 14 | 16 / 16 | UnknownError で測定不可 |
| WebKit | 4 KiB × 4,096 件 | 4 / 1 | 4 / 26 | 122 / 36 | UnknownError で測定不可 |

Blob / IndexedDB / OPFS は最大 64 Object かつ最大 1 MiB のまとまりで処理した。Blob はそのまとまりを arrayBuffer へ読み出し、IndexedDB はバッチの書き込み完了を待ってから getAll による範囲読み出し、OPFS は同期ハンドルでのバッチ書き込み後に flush してから読み出した。入力変更後も元の値が読めることを確認した。

この測定では Uint8Array が低コストだったが、単発の API 比較であり、GC、常駐メモリ、Blob の退避、Blob.stream()、IndexedDB の Blob 値、低速ネットワーク、MOQT の送信処理、モバイル端末、長時間運転は未評価である。特に Worker 内で生成・読み出しており、Window と Worker 間の転送コストを含まない。WebKit の OPFS の失敗はこの測定環境の結果であり、Safari 全体の非対応を意味しない。これらを実装性能や最適性の証明には使わない。

#### データ構造とバッファの所有権

- Full Track Name → Group ID → Object ID の索引と、保持方針に従って古い Object / Group を選べる順序索引を持つ。保持している実在 ID だけを管理する。メモリ方式では Map、Blob / OPFS ではバイト範囲の索引、IndexedDB では複合キーを候補とする。Full Track Name は既存の `src/fullTrackName.ts` の `fullTrackNameKey` を利用し、内部の ID は bigint で扱う。IndexedDB のキーに bigint を直接使わず、全 64 bit の順序を保つ固定長の文字列やバイト列へ符号化する。購読ごとの Request ID / Track Alias は Object の識別子にしない
- 各エントリーは payload の実体または保存位置、Object Properties、実際の Publisher Priority、Subgroup ID の有無、Delivery Mode、終端情報、初回受け入れ時刻、保持バイト数、進行中の送信の参照を管理する。同一 Object を複数購読へ送っても重複保持しない
- 同じ位置の再送は保存内容の同一性を確認する。保持済み Object の payload、Delivery Mode、Subgroup ID、Priority が矛盾する入力はローカル API で拒否し、既存の履歴を上書きしない。Object Properties の変更は仕様が許す範囲を検証し、送信中の応答を変更しない。破棄後の再送でも保持期間や最新位置を巻き戻さない
- ローカル入力の ID・status・payload・Properties・優先度を検証してから保持する。検証失敗ではキャッシュ、保持順、Largest Object、状態記録、容量計上を変更しない。キャッシュ容量の不足や保存先の障害による保持の見送りは、入力の不正や通常送信の失敗と区別して観測できるようにする
- 受け入れ時に入力の payload / properties の view が示す範囲をスナップショットとして確保する。Uint8Array を保持する場合は必要範囲だけを専用バッファへコピーする。Blob / IndexedDB を選ぶ場合は各 API のスナップショットの性質を利用し、不要な事前コピーを重ねない。大きな backing buffer の小さい view を保存する場合の保持量も確認する。呼び出し元の ArrayBuffer を transfer / detach しない
- キャッシュ有効時の通常送信と履歴は同じ受け入れ時点の内容を使い、呼び出し元が入力バッファを変更しても内容がずれないようにする。Blob やファイルを選んだ場合に、通常送信のために必ず保存・読み戻しを往復する構成にはしない。購読数や FETCH 数に応じて payload を丸ごと複製しない
- Object の生成・保持と各購読への送信を分け、paused や Location Filter による送信の見送りが保持を妨げないようにする。保持された位置と、§3.1.4 の公開済み Largest Object を区別し、保持しただけの未公開 Object によって FETCH の応答上限を進めない
- Delivery Mode は §2.1.1 の最初の実送信で確定する。未送信の保持候補の値を確定済みとして扱わず、Subgroup のヘッダーで実際に使う優先度や ID も含めて、FETCH が元の公開内容と一致するようにする。保持開始時の API 引数をそのまま wire の確定値と仮定しない
- payload は内容を解釈せずに扱う。特定のメディアを優先保持せず、要求と異なる位置の Object を代入したり、FETCH のために新しい ID で作り直したりしない
- 公開 Track の状態は購読ごとの Publisher から分離して管理する。保持方針、Track Properties、公開済み Largest Object、Publisher の所有参照、保持データの世代を Full Track Name に関連付け、FETCH 成功応答に必要な情報を揃える

#### アプリが指定する保持上限

Session 全体の資源予算と、Track ごとの保持方針を分ける。`ConnectOptions.publisherCache` に全体予算、`PublishOptions.cache` に Track の方針を指定する案とする。高レベル API への設定追加は行わない。

| 指定先 | 設定案 | 意味 |
| --- | --- | --- |
| `ConnectOptions.publisherCache` | `maxBytes` | Session 全体で保持する二進データの容量上限。キャッシュを有効にする場合は必須 |
| `PublishOptions.cache` | `retention` | 必須。`{ unit: "objects", count: N }` または `{ unit: "groups", count: N }` の選択式 |
| `PublishOptions.cache` | `maxBytes` | 必須。その Track の保持容量上限。Session 全体の上限と両方を適用する |
| `PublishOptions.cache` | `maxAgeMs` | 任意。Object モードでは各 Object、Group モードでは最初の Object を受け入れてからの有効期間。追加・FETCH で延長しない |

- Session / Track の設定の省略または false は、それぞれのキャッシュを無効にする。Session のキャッシュが無効な状態で Track のキャッシュを有効にする指定は、publish の副作用前に拒否する。保持件数・容量・有効期間の数値をアプリが明示し、隠れたメディア別既定値は設けない
- count と容量、指定された有効期間は正の有限な安全整数として検証する。Session の設定は接続開始前、Track の設定は Request ID 消費やストリーム生成より前に検証する。0 や Infinity を無制限の意味に使わない。publisher 自身の保持設定と relay に送る MAX_CACHE_DURATION は独立させる
- 同じ Session / Full Track Name に複数 Publisher がある場合は保持方針と容量を共有する。同じ設定なら利用者を追加し、設定が矛盾する publish は副作用前に拒否する。後から呼んだ Publisher の設定で既存の保持範囲を暗黙に変更しない。動的な設定変更 API は初期実装の必須要件にしない
- 保持件数とバイト数に加えて、空 payload の大量投入や索引 / gap 記録の増加を抑える有限の件数上限を設ける。特に Group モードの Object 数は N では制限されないため、状態記録数・同時 FETCH 数とともに有限の上限値を確定する。これらの内部上限と、アプリ指定の保持方針の関係を文書化する
- `maxBytes` は所有している二進データを計上する上限であり、JS ヒープやブラウザプロセス全体、ストレージの物理使用量と同じ値とは説明しない。入力スナップショット、I/O 待ち、削除待ち、進行中 FETCH の参照があるデータも計上し、符号化や保存媒体の再構成に必要な一時使用量の上限を別に定義する。既存の受信バッファ上限は別の予算として説明する
- 上限超過では前述の保持単位に従って破棄する。公開 Track の登録自体は維持し、コピーや書き込みの前に受入可否を判断する。送信中の参照のために空きを確保できない場合もキャッシュを見送り、容量を理由に通常送信を停止・遅延させない。失効・容量超過・内部件数上限・保存失敗を統計で区別し、保持可能な件数を保証する値ではなく上限であることを明記する
- Gone / 不存在 / 終端の記録も Track ごとに有限の件数で保持する。範囲は区間で記録し、実 Object ごとに展開しない。状態記録の上限超過で根拠を失った範囲は Unknown とし、不存在を推測しない。状態記録の具体的な上限値も実装時に確定する

#### ブラウザでの期限管理と解放

- `maxAgeMs` を指定する場合の保持時刻は `performance.now()` の単調時計を使う。最も近い保持単位の期限に対する Session ごと 1 個のタイマーを補助として使い、Object ごとのタイマーは作らない。追加・FETCH の検索・各 Object の送信着手時にも現在時刻から期限を確認する。Object モードでは期限切れの Object、Group モードでは期限切れの Group 全体を破棄し、同じ識別子の再送や追加で復活させない
- ブラウザのタイマーは予定時刻どおりの実行が保証されず、バックグラウンドで遅延・停止し得るため、タイマー発火だけに期限判定を依存させない。再開後は期限を再評価してから利用し、長時間操作がなくてもキャッシュの容量・件数上限は維持する
- 同じ Session の同一 Track を公開する複数 Publisher は参照を共有する。最後の Publisher が done / peer cancel で終了したら、その Track を新規 FETCH の対象から外して索引とタイマー予約を整理する。既に受理した FETCH の送信中 Object は終了処理まで参照できるようにし、新しい公開世代と混同しない
- Session 終了時は全 FETCH を終了させ、索引、保持データ、状態記録、タイマー、送信中の参照を解放する。採用した API に応じて Blob の参照、DB 接続、ファイルハンドル、Worker、削除待ちのデータも整理する。JS からの参照の除去やストレージ API の解放処理を保証範囲とし、OS への即時のメモリ返却は保証しない。unload のイベント処理を解放の唯一の経路にしない

#### FETCH 中の保持とバックプレッシャー

- FETCH 受理時に応答上限を固定し、実在する Group / Object の ID だけを範囲検索する。保持件数の上限内の ID 索引は作成できるが、要求範囲全体の payload のコピーや全件の参照固定は行わない
- 送信直前に Object の存在と期限を再確認し、送信中の Object だけ参照数を増やす。未送信の Object が途中で破棄された場合は Gone / Unknown の範囲通知へ反映する。既に送信を始めた Object は途中で別の内容に差し替えず、完了かストリームの reset まで参照を保持する
- 最新 N Object / N Group の検索対象から外れても送信中の参照が残るデータは、容量と内部の件数予算に計上し続け、最後の参照の解放時に減算する。同じバッファや Blob のまとまりを複数 FETCH が参照している場合の計上は 1 回とする。古いデータの送信参照があることを理由に新規 FETCH へ提供する履歴範囲を広げない
- FETCH データはヘッダーと上限サイズの payload チャンクを順に書き、バックプレッシャーを待つ。要求範囲を 1 個の巨大な Uint8Array に連結したり、全 Object の write Promise を一括生成したりしない。符号化用の一時バッファと送信待ちキューにも上限を設け、通常の公開処理を長時間塞がない
- 遅い FETCH による参照保持は Fill Timeout と送信待ちの有限なローカル期限で打ち切る。同時実行上限を超える新規 FETCH は仕様に沿って拒否し、待機要求を無制限に蓄積しない。途中の Object の送信を完了できない場合はデータストリームを reset し、どの終了経路でも finally 相当の処理で参照と一時バッファを解放する
- 低レベルの統計から、検索可能な Object の件数・バイト数、索引から外れた送信参照分、期限切れ・容量超過・受入見送りの件数、進行中 FETCH 数を確認できるようにし、ブラウザで上限と解放を検証できるようにする

### 受信 FETCH への応答

- 受信 FETCH をデコードし、Request ID、Track 名、AUTHORIZATION TOKEN、パラメータのスコープ・値・対応範囲を検証して、公開 Track に関連付ける。未公開 Track や拒否対象は仕様に沿って応答し、保持データを返さない
- draft-23 §3.2 / §9.3 / §9.11 に従って要求処理時点の Largest Object と応答上限を確定する。成功応答は REQUEST_OK の FETCH_OK とし、既に削除された専用の 0x18 応答を新設しない。実 Object は FETCH_HEADER に続く 1 本の単方向ストリームで返す
- Location Filter、Group Order、Range Filters、INCLUDE_PROPERTIES、Fill Timeout、優先度を仕様に沿って扱う。Group 内は Object ID の昇順とし、Datagram で公開した Object も FETCH ストリームで返す。購読の paused 状態や Location Filter を、独立した FETCH の送信可否・取得範囲へ流用しない
- 保持を打ち切り再提供できない過去の範囲は original publisher として Gone を通知する。状態を確定できない範囲は Unknown とし、不存在を確実に知る場合だけ Does Not Exist を通知する。容量超過や期限切れを、不存在の証拠として扱わない
- §3.2.2 / §11.4.2 に従って gap と既知の Group / Track 終端を符号化する。広い欠落範囲を Object ごとの配列に展開しない。Object がない有効範囲も FETCH_HEADER と必要な indicator を送り FIN で終了する
- 同時 FETCH、FETCH 中の期限切れ・破棄・新規公開、STOP_SENDING、送信失敗、GOAWAY、Session 終了を扱う。進行中の応答の範囲と内容を不整合にせず、reader / writer、タイマー、保持参照を解放する。公開 Track の所有権と停止・再開時の破棄方針を定義し、別世代の履歴を混同しない

### 既存 issue との関係

- draft-23 の制御フレーミングは 0894、PAUSED は 0896、FETCH 成功応答は 0897、Object ID Delta は 0898、範囲 indicator と Gone は 0899、Group / Track 終端 indicator は 0900 の対応を前提とする。これらの共通実装を利用し、publisher 用の旧形式 codec を別に作らない
- 0908 は subscriber として PUBLISH の初期 fill を受ける対応であり、本 issue の publisher 側の保持・通常 FETCH 応答とは別である。PUBLISH / SUBSCRIBE に付随する fill fetch の送信は本 issue に含めない
- 0901 の受信 Object の矛盾検出は同 issue で扱い、本 issue では低レベル publisher の保持と応答を扱う

## 完了条件

- 保存方式と実行場所を、最新 N Object / N Group の保持規模、公開しながらの FETCH、常駐メモリとメインスレッドへの影響を含めて選定し、採用理由と未検証の制約を記録する
- `Session.publish` と `Publisher.sendObject` / `sendDatagram` で公開した Object を保持し、relay からの FETCH に要求どおりの Object と Properties を返せる
- Object モードは Group をまたぐ最新 N 件、空の Normal Object、冗長送信の重複除外、件数に含めない終端・状態記録を検証する。Group モードは N=1 / 2 / それ以外、未完了 Group、Group ID の飛び番を検証する。両モードで逆順・遅延・重複の受け入れと、Location 順での選択が一致する
- Session 全体と Track ごとの容量制限、複数 Publisher の設定の一致 / 矛盾、Object モードの単体超過後の継続、Group モードの途中超過での全体破棄と後続 Group の保持を検証する。再送で保持件数や期限が増えず、破棄したデータを暗黙に復活させない
- 同じ Object ID を持つ別 Track・別 Group、複数購読、入力バッファの変更、paused / フィルタによる送信見送りを混同せず、保持と公開済み Largest Object の区別を検証する
- 同じ位置への矛盾した入力と不正なローカル入力が既存のキャッシュ・容量・公開状態を変更しないこと、未送信候補と実送信の Delivery Mode / 優先度の確定を区別することを検証する
- 期間・バイト数・件数の境界、保持無効化、上限を超える Object、保持データの破棄、進行中 FETCH の参照を含む解放を検証する
- 実ブラウザで、巨大な backing buffer の小さい view、空 payload の大量投入、期限管理タイマーの発火前に期限を過ぎた検索、遅い FETCH と公開の並行実行、Track の解放と Session の再作成を確認する。統計の件数・計上バイト・参照数が上限に収まり、終了時にゼロへ戻ることを検証する。JS ヒープ全体のサイズや即時 GC の発生は合否条件にしない
- 要求範囲の先頭・途中・末尾の欠落、全件破棄済みの範囲、Unknown / Gone / 不存在の区別、Group Order、Range Filters、Datagram 由来 Object、Group / Track 終端、未公開の将来範囲を検証する
- 不正・未対応・認可されない要求で保持データを返さず、キャンセル・タイムアウト・送信失敗・Session 終了後に FETCH の状態とリソースが残らない
- 保持と範囲選択の不変条件を PBT で検証し、実際の ReadableStream / WritableStream を使うセッション処理のテストで受信 FETCH から応答・終了まで確認する。モックやスタブは利用しない。固定ワイヤの検証も含め、同じ誤りを持つ encoder / decoder の round-trip だけに依存しない
- 低レベル API を使い、実リレーのキャッシュミスから publisher への FETCH と subscriber への配送まで相互運用を確認する。外部実装・環境の制約で確認できない項目は、ローカル検証結果と分けて記録する
- `docs/LOW_LEVEL_API.md` に保存方式、Track ごとの N Object / N Group 保持、Session 全体と Track ごとの容量・有効期間、保持単位に応じた破棄、ライフサイクルと FETCH の対応範囲を記載する。低レベルの設定が A/V Sync やキーフレームの自動判別を行わないことも説明し、`vp check` / `vp run typecheck` / `vp test run` が通る

## 参照

- `refs/moq/draft-ietf-moq-transport-23.txt` §2.1.1 / §2.1.2 / §3.1.4 / §3.2 / §3.2.1 / §3.2.2 / §3.2.3 / §3.2.4 / §6.4.2 / §7.7 / §9.3 / §9.11 / §10.3 / §11.4
- [draft-ietf-moq-transport-23 §3.2.3 Relay Fetch Handling](https://www.ietf.org/archive/id/draft-ietf-moq-transport-23.html#section-3.2.3)
- `src/session/incoming.ts` の `incomingClassifyFirstBidiMessage` / `incomingHandleFirstBidiMessage`
- `src/publisher.ts` の `PublisherImpl`、`src/session/requests.ts` の `requestsPublish`、`src/session/publish.ts` の `publishSendObject` / `publishSendDatagram`
- `src/session/publicTypes.ts` の `PublishOptions`、`src/fullTrackName.ts` の `fullTrackNameKey`
- `src/message/fetch.ts` の `decodeFetchPayload`、`src/dataStream/fetch.ts` の `encodeFetchHeader` / `encodeFetchObjectFields`
- `src/connect.ts` の `connect`、`src/session/publicTypes.ts` の `ConnectOptions`、`src/session/lifecycle.ts` の Session 終了処理
- [High Resolution Time: Clocks](https://w3c.github.io/hr-time/#clocks) / [HTML Standard: Timers](https://html.spec.whatwg.org/multipage/timers-and-user-prompts.html#timers)
- [Service Workers: Cache interface](https://w3c.github.io/ServiceWorker/#cache-interface) / [Indexed Database API](https://w3c.github.io/IndexedDB/)
- [File API: Blob](https://w3c.github.io/FileAPI/#blob-section) / [Chromium: Blob Storage System Design](https://chromium.googlesource.com/chromium/src/+/main/storage/browser/blob/README.md)
- [File System Standard: Sync Access Handle](https://fs.spec.whatwg.org/#api-filesystemsyncaccesshandle) / [Storage Standard: Usage and quota](https://storage.spec.whatwg.org/#usage-and-quota)

## 解決方法

{未着手}
