import { test, assert } from "vite-plus/test";
import { AuthorizationTokenAliasType, C4M, validateTrackNamespaceForSend } from "moqt-js";
import {
  applyC4mFromUrl,
  applyRelayUriInput,
  audioTrackNameLocked,
  authorizationTokenAlias,
  authorizationTokenAliasType,
  authorizationTokenBase64,
  authorizationTokenType,
  authorizationTokenValue,
  buildAuthorizationToken,
  buildConnectUrl,
  buildQueryString,
  buildQueryStringForMode,
  c4mTrackNames,
  catalogSubscriptionTimeout,
  CATALOG_SUBSCRIPTION_TIMEOUTS,
  clearImportedC4mToken,
  discardImportedC4mToken,
  fragment,
  initFromUrl,
  isAudioSourceType,
  isVideoSourceType,
  jitterBufferEnabled,
  keyframeInterval,
  mode,
  namespace,
  namespaceArray,
  namespaceLocked,
  namespaceProblem,
  refreshMsfFragmentSettings,
  renderGroup,
  requireConnectNamespace,
  RENDER_GROUP_OPTIONS,
  resolveOptionNumber,
  targetLatency,
  TARGET_LATENCY_OPTIONS,
  audioAutoGainControl,
  audioEchoCancellation,
  audioNoiseSuppression,
  audioSource,
  audioDelivery,
  selectedMicrophoneDeviceId,
  selectedAudioOutputDeviceId,
  url,
  useDedicatedWorker,
  videoSource,
  videoTrackName,
  videoTrackNameLocked,
  audioTrackName,
} from "./connectionSettings";
import {
  buildCat,
  buildCatWithTrackNames,
  buildCatWithoutMoqtClaim,
} from "../utils/c4mTestSupport";
import { KEYFRAME_INTERVAL_OPTIONS } from "../utils/keyframeInterval";

// 接続設定の Keyframe Interval の初期値 (秒)。signal の初期値と一致していなければ
// ならない (既定値を変えるときは両方を直す)
const CONNECTION_SETTINGS_KEYFRAME_INTERVAL_DEFAULT = 10;

// テスト間で Authorization Token の signal を持ち越さないためのリセット
function resetAuthorizationTokenSettings(): void {
  authorizationTokenAliasType.value = "useValue";
  authorizationTokenAlias.value = "0";
  authorizationTokenType.value = "0";
  authorizationTokenValue.value = "";
  authorizationTokenBase64.value = "";
}

// テスト間で msf fragment の取り込み (namespace の固定とトラック名) を持ち越さないためのリセット
const INITIAL_NAMESPACE = namespace.value;
function resetMsfFragmentSettings(): void {
  // MOQT URI を空にして、URL 由来の fragment と固定を解除する
  applyRelayUriInput("");
  // 手入力の fragment もテスト間で持ち越さない
  fragment.value = "";
  refreshMsfFragmentSettings();
  namespace.value = INITIAL_NAMESPACE;
  videoTrackName.value = "video";
  audioTrackName.value = "audio";
}

// バイト列を Base64 文字列に変換する (C4M トークンの入力を作る)
function toBase64(bytes: number[]): string {
  return btoa(String.fromCharCode(...bytes));
}

// MSF URL の c4m を読み込むと、Token Value をクリアして Base64 トークンと
// USE_VALUE / Token Type 0x01 (CAT, draft-ietf-moq-c4m-01 §7.1 Table 4) が設定される。
test("applyC4mFromUrl: c4m から Base64 トークンと USE_VALUE / Token Type 0x01 を反映する", () => {
  resetAuthorizationTokenSettings();
  authorizationTokenValue.value = "manual-token";

  const applied = applyC4mFromUrl("moqt://example.com/moqt#msf:room-123--catalog&c4m=QUFB");

  assert.equal(applied, true);
  assert.equal(authorizationTokenBase64.value, "QUFB");
  assert.equal(authorizationTokenValue.value, "");
  assert.equal(authorizationTokenAliasType.value, "useValue");
  assert.equal(authorizationTokenType.value, "1");
});

// URI Fragment 欄への貼り付けを想定し、fragment 単体でも c4m を読み込める。
test("applyC4mFromUrl: msf fragment 単体から c4m を読み込む", () => {
  resetAuthorizationTokenSettings();

  const applied = applyC4mFromUrl("msf:room-123--catalog&c4m=QUFB");

  assert.equal(applied, true);
  assert.equal(authorizationTokenBase64.value, "QUFB");
});

// c4m が無い URL では false を返し、設定済みの Authorization Token を変更しない。
test("applyC4mFromUrl: c4m が無い場合は false を返し設定を変更しない", () => {
  resetAuthorizationTokenSettings();
  authorizationTokenValue.value = "manual-token";

  const applied = applyC4mFromUrl("moqt://example.com/moqt#msf:room-123--catalog");

  assert.equal(applied, false);
  assert.equal(authorizationTokenBase64.value, "");
  assert.equal(authorizationTokenValue.value, "manual-token");
});

// 不正な Base64 の c4m は反映せず、false を返す。
test("applyC4mFromUrl: 不正な Base64 の c4m は反映しない", () => {
  resetAuthorizationTokenSettings();

  const applied = applyC4mFromUrl("msf:room-123--catalog&c4m=not base64!!");

  assert.equal(applied, false);
  assert.equal(authorizationTokenBase64.value, "");
});

// c4m から読み込んだトークンは Base64 を復号した生バイト列として、Token Type 0x01 (CAT) で
// SETUP に載る (draft-ietf-moq-c4m-01 §7.1 Table 4 / §7.1.1)。
test("buildAuthorizationToken: c4m の Base64 トークンを CAT (Token Type 0x01) として復号する", () => {
  resetAuthorizationTokenSettings();
  const bytes = [0x83, 0x68, 0x61, 0x00, 0xff];
  applyC4mFromUrl(`moqt://example.com/moqt#msf:room-123--catalog&c4m=${toBase64(bytes)}`);

  const token = buildAuthorizationToken();
  assert.equal(token?.aliasType, AuthorizationTokenAliasType.USE_VALUE);
  if (token?.aliasType === AuthorizationTokenAliasType.USE_VALUE) {
    assert.equal(token.tokenType, 1n);
    assert.deepEqual(token.tokenValue, new Uint8Array(bytes));
  }
});

// Token Type が空文字のときは 0n になる (手入力で空にした場合のフォールバック)。
test("buildAuthorizationToken: Token Type が空文字のときは 0n になる", () => {
  resetAuthorizationTokenSettings();
  authorizationTokenValue.value = "manual-token";
  authorizationTokenType.value = "";

  const token = buildAuthorizationToken();
  assert.equal(token?.aliasType, AuthorizationTokenAliasType.USE_VALUE);
  if (token?.aliasType === AuthorizationTokenAliasType.USE_VALUE) {
    assert.equal(token.tokenType, 0n);
  }
});

// 手書きの共有 URL を想定し、c4m を持つ url パラメータと Authorization Token の
// クエリパラメータを同時に持つ検索文字列では c4m を優先する。
test("initFromUrl: c4m を持つ URL はクエリの Token Type / Token Value より優先する", () => {
  resetAuthorizationTokenSettings();
  const c4mBase64 = toBase64([0x01, 0x02, 0x03]);
  const params = new URLSearchParams();
  params.set("url", `moqt://example.com/moqt#msf:room-123--catalog&c4m=${c4mBase64}`);
  params.set("authorizationTokenType", "0");
  params.set("authorizationTokenValue", "manual-token");

  initFromUrl(params.toString());

  // c4m の取り込みで Token Type は 0x01 (CAT)、Token Value は取り込んだトークンになる
  assert.equal(authorizationTokenType.value, "1");
  assert.equal(authorizationTokenValue.value, "");
  const token = buildAuthorizationToken();
  assert.equal(token?.aliasType, AuthorizationTokenAliasType.USE_VALUE);
  if (token?.aliasType === AuthorizationTokenAliasType.USE_VALUE) {
    assert.equal(token.tokenType, 1n);
    assert.deepEqual(token.tokenValue, new Uint8Array([0x01, 0x02, 0x03]));
  }
});

// fragment の c4m は url の c4m より優先する。
test("initFromUrl: fragment の c4m を url の c4m より優先する", () => {
  resetAuthorizationTokenSettings();
  const urlC4m = toBase64([0x0a]);
  const fragmentC4m = toBase64([0x0b]);
  const params = new URLSearchParams();
  params.set("url", `moqt://example.com/moqt#msf:room-123--catalog&c4m=${urlC4m}`);
  params.set("fragment", `msf:room-123--catalog&c4m=${fragmentC4m}`);

  initFromUrl(params.toString());

  assert.equal(authorizationTokenBase64.value, fragmentC4m);
  assert.equal(authorizationTokenType.value, "1");
});

// fragment に c4m が無い場合でも url の c4m を取り込む (develop からの回帰の固定)。
test("initFromUrl: fragment に c4m が無くても url の c4m を取り込む", () => {
  resetAuthorizationTokenSettings();
  const c4mBase64 = toBase64([0x01, 0x02]);
  const params = new URLSearchParams();
  params.set("url", `moqt://example.com/moqt#msf:room-123--catalog&c4m=${c4mBase64}`);
  // c4m を含まない fragment (Copy URL が url と fragment を同時に書き出す形)
  params.set("fragment", "msf:room-123--catalog--track:video");

  initFromUrl(params.toString());

  assert.equal(authorizationTokenBase64.value, c4mBase64);
  assert.equal(authorizationTokenType.value, "1");
  const token = buildAuthorizationToken();
  if (token?.aliasType === AuthorizationTokenAliasType.USE_VALUE) {
    assert.equal(token.tokenType, 1n);
    assert.deepEqual(token.tokenValue, new Uint8Array([0x01, 0x02]));
  }
});

// fragment の c4m が不正な場合は url の c4m を使う (不正な値で取り込みを壊さない)。
test("initFromUrl: fragment の c4m が不正な場合は url の c4m を使う", () => {
  resetAuthorizationTokenSettings();
  const urlC4m = toBase64([0x01, 0x02]);
  const params = new URLSearchParams();
  params.set("url", `moqt://example.com/moqt#msf:room-123--catalog&c4m=${urlC4m}`);
  params.set("fragment", "msf:room-123--catalog--track:video&c4m=not base64!!");

  initFromUrl(params.toString());

  assert.equal(authorizationTokenBase64.value, urlC4m);
  assert.equal(authorizationTokenType.value, "1");
});

// c4m が無い検索文字列ではクエリの Authorization Token 設定をそのまま適用する。
test("initFromUrl: c4m が無い場合はクエリの Token Type / Token Value を適用する", () => {
  resetAuthorizationTokenSettings();
  const params = new URLSearchParams();
  params.set("url", "moqt://example.com/moqt");
  params.set("authorizationTokenType", "2");
  params.set("authorizationTokenValue", "manual-token");

  initFromUrl(params.toString());

  assert.equal(authorizationTokenType.value, "2");
  assert.equal(authorizationTokenValue.value, "manual-token");
  assert.equal(authorizationTokenBase64.value, "");
});

// Base64 トークンが無い場合は従来どおり Token Value を UTF-8 として送る。
test("buildAuthorizationToken: Base64 トークンが無い場合は Token Value を UTF-8 として使う", () => {
  resetAuthorizationTokenSettings();
  authorizationTokenValue.value = "manual-token";

  const token = buildAuthorizationToken();
  assert.equal(token?.aliasType, AuthorizationTokenAliasType.USE_VALUE);
  if (token?.aliasType === AuthorizationTokenAliasType.USE_VALUE) {
    assert.deepEqual(token.tokenValue, new TextEncoder().encode("manual-token"));
  }
});

// c4m 読み込み後に Token Value が残っていても、Base64 トークンを優先する。
test("buildAuthorizationToken: Base64 トークンを Token Value より優先する", () => {
  resetAuthorizationTokenSettings();
  authorizationTokenBase64.value = toBase64([0x01, 0x02]);
  authorizationTokenValue.value = "manual-token";

  const token = buildAuthorizationToken();
  assert.equal(token?.aliasType, AuthorizationTokenAliasType.USE_VALUE);
  if (token?.aliasType === AuthorizationTokenAliasType.USE_VALUE) {
    assert.deepEqual(token.tokenValue, new Uint8Array([0x01, 0x02]));
  }
});

// REGISTER / Token Alias を選択した場合は c4m のバイト列をそのまま使い、Alias 設定を尊重する。
test("buildAuthorizationToken: REGISTER の設定でも c4m のバイト列を使う", () => {
  resetAuthorizationTokenSettings();
  authorizationTokenBase64.value = toBase64([0x10, 0x20]);
  authorizationTokenAliasType.value = "register";
  authorizationTokenAlias.value = "7";

  const token = buildAuthorizationToken();
  assert.equal(token?.aliasType, AuthorizationTokenAliasType.REGISTER);
  if (token?.aliasType === AuthorizationTokenAliasType.REGISTER) {
    assert.equal(token.tokenAlias, 7n);
    assert.deepEqual(token.tokenValue, new Uint8Array([0x10, 0x20]));
  }
});

// 購読した映像を LOC TIMESTAMP (壁時計) の間隔どおりに表示する jitter buffer は既定で
// 有効にする。無効にすると従来どおり届いたタイミングのまま表示する
test("jitterBufferEnabled: 既定は有効", () => {
  assert.isTrue(jitterBufferEnabled.value);
});

// URL の jitterBuffer=0 で無効、jitterBuffer=1 で有効にする。それ以外の値は無視する
test("initFromUrl: jitterBuffer で jitter buffer の有効・無効を反映する", () => {
  jitterBufferEnabled.value = true;
  initFromUrl("jitterBuffer=0");
  assert.isFalse(jitterBufferEnabled.value);
  initFromUrl("jitterBuffer=yes");
  assert.isFalse(jitterBufferEnabled.value);
  initFromUrl("jitterBuffer=1");
  assert.isTrue(jitterBufferEnabled.value);
});

// Copy URL が作る URL は無効のときだけ jitterBuffer=0 を載せ (既定の有効は載せない)、
// その URL から設定を復元できる
test("buildQueryString: jitter buffer を無効にした設定を URL で往復できる", () => {
  jitterBufferEnabled.value = true;
  assert.isNull(new URLSearchParams(buildQueryString()).get("jitterBuffer"));

  jitterBufferEnabled.value = false;
  const query = buildQueryString();
  assert.equal(new URLSearchParams(query).get("jitterBuffer"), "0");

  jitterBufferEnabled.value = true;
  initFromUrl(query);
  assert.isFalse(jitterBufferEnabled.value);
  jitterBufferEnabled.value = true;
});

// 開いた時点の音声入力は Web Audio で作る音 (値は dummy)。映像の Canvas と揃える
test("audioSource: 既定は dummy", () => {
  assert.equal(audioSource.value, "dummy");
});

// 音声の入力にマイクを選べる。URL の audioSource=microphone も受理する
test("isAudioSourceType: microphone を音声の入力として受理する", () => {
  assert.isTrue(isAudioSourceType("microphone"));
  assert.isFalse(isAudioSourceType("line-in"));
  audioSource.value = "none";
  initFromUrl("audioSource=microphone");
  assert.equal(audioSource.value, "microphone");
  audioSource.value = "none";
});

// 映像の入力に None (映像を送らず音声だけを配信する) を選べる。URL の videoSource=none も
// 受理し、Copy URL で往復できる
test("isVideoSourceType: none を映像の入力として受理し、URL で往復できる", () => {
  assert.isTrue(isVideoSourceType("none"));
  assert.isTrue(isVideoSourceType("dummy"));
  assert.isTrue(isVideoSourceType("camera"));
  assert.isFalse(isVideoSourceType("screen"));

  videoSource.value = "none";
  const query = buildQueryString();
  assert.equal(new URLSearchParams(query).get("videoSource"), "none");
  videoSource.value = "dummy";
  initFromUrl(query);
  assert.equal(videoSource.value, "none");

  // 選択肢に無い値は受理せず、今の設定のまま残す
  initFromUrl("videoSource=screen");
  assert.equal(videoSource.value, "none");
  videoSource.value = "dummy";
});

// トラック名は映像と音声で別々に設定でき、Copy URL で往復できる。
// 旧 URL の trackName は映像トラック名として読み続ける (共有済みの URL を壊さない)
test("buildQueryString / initFromUrl: 映像と音声のトラック名を URL で往復できる", () => {
  videoTrackName.value = "cam";
  audioTrackName.value = "mic";

  const query = buildQueryString();
  const params = new URLSearchParams(query);
  assert.equal(params.get("videoTrackName"), "cam");
  assert.equal(params.get("audioTrackName"), "mic");
  // 書き出しは新しいキーだけにする (旧 trackName は載せない)
  assert.isNull(params.get("trackName"));

  // 既定値へ戻してから、書き出した URL で復元する
  videoTrackName.value = "video";
  audioTrackName.value = "audio";
  initFromUrl(query);
  assert.equal(videoTrackName.value, "cam");
  assert.equal(audioTrackName.value, "mic");

  // 旧 URL の trackName は映像トラック名として読む
  initFromUrl("trackName=legacy");
  assert.equal(videoTrackName.value, "legacy");
  assert.equal(audioTrackName.value, "mic");

  // 新しいキーがあるときは新しいキーを優先する
  initFromUrl("videoTrackName=new&trackName=legacy");
  assert.equal(videoTrackName.value, "new");

  videoTrackName.value = "video";
  audioTrackName.value = "audio";
});

// トラック名の既定は、ライブラリの DEFAULT_VIDEO_TRACK_NAME / DEFAULT_AUDIO_TRACK_NAME と
// 同じ値にする (既定のまま配信すると、高レベル API の購読側と名前が一致する)
test("videoTrackName / audioTrackName: 既定は video と audio", () => {
  assert.equal(videoTrackName.peek(), "video");
  assert.equal(audioTrackName.peek(), "audio");
});

// 音声処理 (エコー除去 / ノイズ抑制 / 自動ゲイン) の既定はブラウザの既定と同じ有効
test("音声処理の切り替え: 既定は有効", () => {
  assert.isTrue(audioEchoCancellation.value);
  assert.isTrue(audioNoiseSuppression.value);
  assert.isTrue(audioAutoGainControl.value);
});

// Copy URL は無効にした音声処理だけを =0 で載せ、その URL から設定を復元できる。
// 選んだマイクのデバイスも載せる (カメラの cameraDeviceId と同じ)
test("buildQueryString: マイクのデバイスと音声処理を URL で往復できる", () => {
  selectedMicrophoneDeviceId.value = "mic-1";
  audioEchoCancellation.value = false;
  audioNoiseSuppression.value = true;
  audioAutoGainControl.value = false;
  const params = new URLSearchParams(buildQueryString());
  assert.equal(params.get("microphoneDeviceId"), "mic-1");
  assert.equal(params.get("audioEchoCancellation"), "0");
  assert.isNull(params.get("audioNoiseSuppression"));
  assert.equal(params.get("audioAutoGainControl"), "0");

  selectedMicrophoneDeviceId.value = "";
  audioEchoCancellation.value = true;
  audioAutoGainControl.value = true;
  initFromUrl(params.toString());
  assert.equal(selectedMicrophoneDeviceId.value, "mic-1");
  assert.isFalse(audioEchoCancellation.value);
  assert.isTrue(audioNoiseSuppression.value);
  assert.isFalse(audioAutoGainControl.value);

  selectedMicrophoneDeviceId.value = "";
  audioEchoCancellation.value = true;
  audioAutoGainControl.value = true;
});

// 再生先の音声出力デバイス。空のときは URL に載せず、選んだときだけ往復する
test("buildQueryString: 音声出力デバイスを URL で往復できる", () => {
  selectedAudioOutputDeviceId.value = "";
  assert.isNull(new URLSearchParams(buildQueryString()).get("audioOutputDeviceId"));

  selectedAudioOutputDeviceId.value = "speaker-1";
  const params = new URLSearchParams(buildQueryString());
  assert.equal(params.get("audioOutputDeviceId"), "speaker-1");

  selectedAudioOutputDeviceId.value = "";
  initFromUrl(params.toString());
  assert.equal(selectedAudioOutputDeviceId.value, "speaker-1");
  selectedAudioOutputDeviceId.value = "";
});

// 音声の送り方。既定の subgroup は URL に載せず、datagram だけ往復する
test("buildQueryString: audioDelivery=datagram を URL で往復でき、未知の値は無視する", () => {
  audioDelivery.value = "subgroup";
  assert.isNull(new URLSearchParams(buildQueryString()).get("audioDelivery"));

  audioDelivery.value = "datagram";
  const params = new URLSearchParams(buildQueryString());
  assert.equal(params.get("audioDelivery"), "datagram");

  audioDelivery.value = "subgroup";
  initFromUrl(params.toString());
  assert.equal(audioDelivery.value, "datagram");

  initFromUrl("audioDelivery=stream");
  assert.equal(audioDelivery.value, "datagram");
  audioDelivery.value = "subgroup";
});

// URL の mode で表示モードを決める。both は既定のため Copy URL に載せず、publisher /
// subscriber のときだけ載せて開き直しても同じモードで表示できる
test("initFromUrl / buildQueryString: mode を URL で往復できる", () => {
  mode.value = "both";
  assert.isNull(new URLSearchParams(buildQueryString()).get("mode"));

  initFromUrl("mode=publisher");
  assert.equal(mode.value, "publisher");
  const publisherQuery = buildQueryString();
  assert.equal(new URLSearchParams(publisherQuery).get("mode"), "publisher");

  // 開き直しても publisher のままになる
  mode.value = "both";
  initFromUrl(publisherQuery);
  assert.equal(mode.value, "publisher");

  initFromUrl("mode=subscriber");
  assert.equal(mode.value, "subscriber");
  assert.equal(new URLSearchParams(buildQueryString()).get("mode"), "subscriber");

  mode.value = "both";
});

// 許可リストに無い mode は無視し、両方を表示する both のままにする
test("initFromUrl: 許可リストに無い mode は無視する", () => {
  mode.value = "both";
  initFromUrl("mode=foo");
  assert.equal(mode.value, "both");
});

// mode の無い URL では both (両方の表示) のままにする。許可リストにある both は
// 明示的に指定しても受理し、publisher から both へ戻せる
test("initFromUrl: mode が無い URL と mode=both は both にする", () => {
  mode.value = "both";
  initFromUrl("url=moqt%3A%2F%2Fexample.com");
  assert.equal(mode.value, "both");

  mode.value = "publisher";
  initFromUrl("mode=both");
  assert.equal(mode.value, "both");
});

// 副題のリンク用のクエリは、今の接続設定を保ったまま mode だけを差し替える。
// both のリンクでは mode を載せない
test("buildQueryStringForMode: 今の設定を保ったまま mode だけを差し替える", () => {
  mode.value = "both";
  url.value = "moqt://example.com/moqt";
  try {
    const publisherQuery = new URLSearchParams(buildQueryStringForMode("publisher"));
    assert.equal(publisherQuery.get("mode"), "publisher");
    assert.equal(publisherQuery.get("url"), "moqt://example.com/moqt");

    const subscriberQuery = new URLSearchParams(buildQueryStringForMode("subscriber"));
    assert.equal(subscriberQuery.get("mode"), "subscriber");
    assert.equal(subscriberQuery.get("url"), "moqt://example.com/moqt");

    const bothQuery = new URLSearchParams(buildQueryStringForMode("both"));
    assert.isNull(bothQuery.get("mode"));
    assert.equal(bothQuery.get("url"), "moqt://example.com/moqt");

    // 今のモードの signal は変えない
    assert.equal(mode.value, "both");
  } finally {
    url.value = "";
  }
});

// 副題のリンクのクエリは、mode 以外の設定を buildQueryString と同じ形で保つ
test("buildQueryStringForMode: mode 以外の設定は buildQueryString と同じクエリになる", () => {
  mode.value = "both";
  url.value = "moqt://example.com/moqt";
  catalogSubscriptionTimeout.value = 30000;
  useDedicatedWorker.value = false;
  try {
    const baseParams = new URLSearchParams(buildQueryString());
    const publisherParams = new URLSearchParams(buildQueryStringForMode("publisher"));
    // mode 以外のキーと値が一致する
    for (const [key, value] of baseParams) {
      assert.equal(publisherParams.get(key), value, `${key} が保たれる`);
    }
    assert.equal(publisherParams.get("mode"), "publisher");
    // both のクエリには mode が載らない
    assert.isNull(baseParams.get("mode"));
  } finally {
    url.value = "";
    catalogSubscriptionTimeout.value = 5000;
    useDedicatedWorker.value = true;
  }
  mode.value = "both";
});

// Catalog Timeout は他の数値の設定と同じく Copy URL に常に載せ、開き直すと select の値が戻る
test("buildQueryString: catalogSubscriptionTimeout を URL で往復できる", () => {
  catalogSubscriptionTimeout.value = 5000;
  assert.equal(new URLSearchParams(buildQueryString()).get("catalogSubscriptionTimeout"), "5000");

  initFromUrl("catalogSubscriptionTimeout=30000");
  assert.equal(catalogSubscriptionTimeout.value, 30000);
  assert.equal(new URLSearchParams(buildQueryString()).get("catalogSubscriptionTimeout"), "30000");

  catalogSubscriptionTimeout.value = 5000;
});

// Catalog Timeout は選択肢のどの値も URL で往復できる
test("initFromUrl / buildQueryString: catalogSubscriptionTimeout は全ての選択肢を往復できる", () => {
  for (const timeout of CATALOG_SUBSCRIPTION_TIMEOUTS) {
    catalogSubscriptionTimeout.value = 5000;
    initFromUrl(`catalogSubscriptionTimeout=${timeout}`);
    assert.equal(catalogSubscriptionTimeout.value, timeout, `${timeout} を復元する`);
    assert.equal(
      new URLSearchParams(buildQueryString()).get("catalogSubscriptionTimeout"),
      String(timeout),
      `${timeout} を URL に載せる`,
    );
  }
  catalogSubscriptionTimeout.value = 5000;
});

// 選択肢に無い値や空文字の catalogSubscriptionTimeout は無視する
// (select の表示が空にならないようにする)
test("initFromUrl: 選択肢に無い catalogSubscriptionTimeout は無視する", () => {
  catalogSubscriptionTimeout.value = 5000;
  initFromUrl("catalogSubscriptionTimeout=12345");
  assert.equal(catalogSubscriptionTimeout.value, 5000);
  initFromUrl("catalogSubscriptionTimeout=");
  assert.equal(catalogSubscriptionTimeout.value, 5000);
  initFromUrl("catalogSubscriptionTimeout=0");
  assert.equal(catalogSubscriptionTimeout.value, 5000);
});

// Keyframe Interval は ConnectionSettings の select と同じ許可リストで検証する。
// 選択肢と URL が受理する値は KEYFRAME_INTERVAL_OPTIONS の 1 箇所で一致するため、
// 画面で選べる値は Copy URL で往復できる
test("initFromUrl / buildQueryString: keyframeInterval を全ての選択肢で往復できる", () => {
  for (const interval of KEYFRAME_INTERVAL_OPTIONS) {
    keyframeInterval.value = interval;
    const query = buildQueryString();
    assert.equal(
      new URLSearchParams(query).get("keyframeInterval"),
      String(interval),
      `${interval} を URL に載せる`,
    );

    // 復元の検証では、いったん初期値へ戻してから URL を適用する
    keyframeInterval.value = CONNECTION_SETTINGS_KEYFRAME_INTERVAL_DEFAULT;
    initFromUrl(query);
    assert.equal(keyframeInterval.value, interval, `${interval} を復元する`);
  }
  keyframeInterval.value = CONNECTION_SETTINGS_KEYFRAME_INTERVAL_DEFAULT;
});

// 0 / 負値 / 非整数 / 10 進表記でない値 / 選択肢に無い値 / 空文字の keyframeInterval は
// 無視し、初期値のまま残す。0 以下を受理すると経過時間の比較が成立せず、キーフレームの
// 要求が意図した周期で出ない。選択肢に無い正の整数 (3 / 7 / 121 / 3601 / 12345) を
// 受理すると、select の表示が空になって表示と実際の設定が食い違う
test("initFromUrl: 無効な keyframeInterval は初期値のまま残す", () => {
  const invalidValues = [
    // 0 と負値 (経過時間の比較が成立しない値)
    "0",
    "-5",
    // 非整数と 10 進表記でない値 (Number.parseInt の結果だけを見ると通ってしまう値)。
    // %2B は + そのもので、表記としての符号は受理しない
    "1.5",
    "30.0",
    "30abc",
    "abc",
    "%2B30",
    "0x1e",
    "1e2",
    // 空文字 (select の「未指定」)
    "",
    // 選択肢に無い正の整数
    "3",
    "7",
    "121",
    "3601",
    "12345",
  ];
  for (const invalid of invalidValues) {
    keyframeInterval.value = CONNECTION_SETTINGS_KEYFRAME_INTERVAL_DEFAULT;
    initFromUrl(`keyframeInterval=${invalid}`);
    assert.equal(
      keyframeInterval.value,
      CONNECTION_SETTINGS_KEYFRAME_INTERVAL_DEFAULT,
      `${invalid} を無視する`,
    );
  }

  // 既に選んでいる値も、不正な URL では上書きしない
  keyframeInterval.value = 60;
  initFromUrl("keyframeInterval=0");
  assert.equal(keyframeInterval.value, 60);
  initFromUrl("keyframeInterval=-5");
  assert.equal(keyframeInterval.value, 60);

  // パラメータを持たない URL でも現在の値のまま残る
  initFromUrl("mode=both");
  assert.equal(keyframeInterval.value, 60);

  keyframeInterval.value = CONNECTION_SETTINGS_KEYFRAME_INTERVAL_DEFAULT;
});

// 許可リストの判定は targetLatency と同じく resolveOptionNumber に任せるため、整数の
// 表記であれば先頭に 0 が付いた値も値として受理する (値は許可リストに一致するので
// select の表示は空にならない)。前後の空白も取り除いてから検証する
test("initFromUrl: 整数の表記として解釈できる keyframeInterval を受理する", () => {
  // 先頭に 0 が付いた表記
  keyframeInterval.value = CONNECTION_SETTINGS_KEYFRAME_INTERVAL_DEFAULT;
  initFromUrl("keyframeInterval=030");
  assert.equal(keyframeInterval.value, 30);

  keyframeInterval.value = CONNECTION_SETTINGS_KEYFRAME_INTERVAL_DEFAULT;
  initFromUrl("keyframeInterval=0240");
  assert.equal(keyframeInterval.value, 240);

  // 前後の空白 (URL では %20) は resolveOptionNumber が取り除く
  keyframeInterval.value = CONNECTION_SETTINGS_KEYFRAME_INTERVAL_DEFAULT;
  initFromUrl("keyframeInterval=%2030");
  assert.equal(keyframeInterval.value, 30);

  keyframeInterval.value = CONNECTION_SETTINGS_KEYFRAME_INTERVAL_DEFAULT;
  initFromUrl("keyframeInterval=30%20");
  assert.equal(keyframeInterval.value, 30);

  // URLSearchParams は + を空白として復号する。表記としての符号ではなく空白として
  // 取り除かれるため受理する (%2B の + は符号であり、上の無効値のテストで拒否する)
  keyframeInterval.value = CONNECTION_SETTINGS_KEYFRAME_INTERVAL_DEFAULT;
  initFromUrl("keyframeInterval=+30");
  assert.equal(keyframeInterval.value, 30);

  // 空白だけの値は「未指定」として扱い、初期値のまま残す
  keyframeInterval.value = CONNECTION_SETTINGS_KEYFRAME_INTERVAL_DEFAULT;
  initFromUrl("keyframeInterval=%20");
  assert.equal(keyframeInterval.value, CONNECTION_SETTINGS_KEYFRAME_INTERVAL_DEFAULT);

  keyframeInterval.value = CONNECTION_SETTINGS_KEYFRAME_INTERVAL_DEFAULT;
});

// Dedicated Worker は既定で有効のため Copy URL に載せず、無効のときだけ載せる
test("buildQueryString: useDedicatedWorker を無効にした設定を URL で往復できる", () => {
  useDedicatedWorker.value = true;
  assert.isNull(new URLSearchParams(buildQueryString()).get("useDedicatedWorker"));

  useDedicatedWorker.value = false;
  const query = buildQueryString();
  assert.equal(new URLSearchParams(query).get("useDedicatedWorker"), "0");

  useDedicatedWorker.value = true;
  initFromUrl(query);
  assert.isFalse(useDedicatedWorker.value);

  useDedicatedWorker.value = true;
});

// 目標遅延 (draft-ietf-moq-msf-01 §5.2.8) と同時レンダリンググループ (§5.2.11) の既定は
// 「未指定」(null)。未指定のときは catalog に載せないため、Copy URL にも載せない
test("buildQueryString: 未指定の targetLatency と renderGroup は URL に載せない", () => {
  targetLatency.value = null;
  renderGroup.value = null;

  const params = new URLSearchParams(buildQueryString());
  assert.isNull(params.get("targetLatency"));
  assert.isNull(params.get("renderGroup"));
});

// 指定した値は Copy URL に載り、開き直すと select の値が戻る。
// 0 ms と renderGroup の 0 はどちらも有効値であり、「未指定」と区別して往復する
test("initFromUrl / buildQueryString: targetLatency を全ての選択肢で往復できる", () => {
  for (const latency of TARGET_LATENCY_OPTIONS) {
    targetLatency.value = null;

    targetLatency.value = latency;
    const query = buildQueryString();
    assert.equal(
      new URLSearchParams(query).get("targetLatency"),
      String(latency),
      `${latency} ms を URL に載せる`,
    );

    targetLatency.value = null;
    initFromUrl(query);
    assert.equal(targetLatency.value, latency, `${latency} ms を復元する`);
  }
  targetLatency.value = null;
});

test("initFromUrl / buildQueryString: renderGroup を全ての選択肢で往復できる", () => {
  for (const group of RENDER_GROUP_OPTIONS) {
    renderGroup.value = null;

    renderGroup.value = group;
    const query = buildQueryString();
    assert.equal(
      new URLSearchParams(query).get("renderGroup"),
      String(group),
      `renderGroup ${group} を URL に載せる`,
    );

    renderGroup.value = null;
    initFromUrl(query);
    assert.equal(renderGroup.value, group, `renderGroup ${group} を復元する`);
  }
  renderGroup.value = null;
});

// 許可リストに無い値と非整数は無視する。小数表記や指数表記も整数の値としては等しくても、
// select の選択肢が作る表記ではないため受理しない。既に指定済みの値は不正な URL で
// 上書きしない (空文字は「未指定」であり、下のテストで別に固定する)
test("initFromUrl: 許可リストに無い値と非整数の targetLatency は無視する", () => {
  for (const invalid of ["12345", "50.5", "50.0", "1e2", "abc", "-50", "0.0.0"]) {
    targetLatency.value = null;
    initFromUrl(`targetLatency=${invalid}`);
    assert.isNull(targetLatency.value, `${invalid} を無視する`);
  }

  // 既に指定済みの値は、不正な URL で上書きしない
  targetLatency.value = 100;
  initFromUrl("targetLatency=12345");
  assert.equal(targetLatency.value, 100);
  targetLatency.value = null;
});

test("initFromUrl: 許可リストに無い値と非整数の renderGroup は無視する", () => {
  for (const invalid of ["2", "0.5", "1.0", "yes", "0.0.0"]) {
    renderGroup.value = null;
    initFromUrl(`renderGroup=${invalid}`);
    assert.isNull(renderGroup.value, `${invalid} を無視する`);
  }

  // 既に指定済みの値は、不正な URL で上書きしない
  renderGroup.value = 0;
  initFromUrl("renderGroup=2");
  assert.equal(renderGroup.value, 0);
  renderGroup.value = null;
});

// 空文字は select の「未指定」であり、URL でも未指定 (null) として反映する。
// Number("") が 0 になることにつられて 0 ms / renderGroup 0 を設定しない
// (0 は有効値であり、未指定とは別の指定である)
test("initFromUrl: 空文字の targetLatency と renderGroup は未指定 (null) にする", () => {
  targetLatency.value = 200;
  initFromUrl("targetLatency=");
  assert.isNull(targetLatency.value);

  renderGroup.value = 1;
  initFromUrl("renderGroup=");
  assert.isNull(renderGroup.value);
});

// select の onChange と URL の復元 (initFromUrl) は同じ変換関数 (resolveOptionNumber) を通る。
// ここでは画面の select が作る値 (空文字 = 未指定、0、許可リストの値) を固定し、URL 側は上の
// initFromUrl のテストで固定する。0 が有効値の targetLatency / renderGroup では、空文字を
// null にすることと 0 を 0 のまま残すことが要になる
test("resolveOptionNumber: 空文字 (未指定) は null にする", () => {
  assert.isNull(resolveOptionNumber("", TARGET_LATENCY_OPTIONS, 200));
  assert.isNull(resolveOptionNumber("", RENDER_GROUP_OPTIONS, 1));
  // select は空文字だけを「未指定」に使う。空白だけの値も未指定として扱う
  assert.isNull(resolveOptionNumber(" ", TARGET_LATENCY_OPTIONS, 200));
});

// Number("") は 0 になるため、空文字を 0 として扱うと 0 ms / renderGroup 0 を指定した
// ことになってしまう。0 は有効値であり、未指定とは別の指定である
test("resolveOptionNumber: 0 は未指定にせず 0 を返す", () => {
  assert.equal(resolveOptionNumber("0", TARGET_LATENCY_OPTIONS, null), 0);
  assert.equal(resolveOptionNumber("0", RENDER_GROUP_OPTIONS, null), 0);
});

// select の選択肢から来た値はそのまま採用する。選択肢と同じ許可リストを渡しているため、
// select で選べる値は必ず受理される
test("resolveOptionNumber: 許可リストの値はその値を返す", () => {
  for (const latency of TARGET_LATENCY_OPTIONS) {
    assert.equal(resolveOptionNumber(String(latency), TARGET_LATENCY_OPTIONS, null), latency);
  }
  for (const group of RENDER_GROUP_OPTIONS) {
    assert.equal(resolveOptionNumber(String(group), RENDER_GROUP_OPTIONS, null), group);
  }
});

// 許可リストに無い値 (initFromUrl の検証と同じ規則) と、整数の表記でない値は受理せず、
// 現在の値のまま保つ。URL の不正な値で表示と実際の設定が食い違わないようにするため
test("resolveOptionNumber: 許可リストに無い値と非整数は既存の値を保つ", () => {
  for (const invalid of ["12345", "50.5", "50.0", "1e2", "abc", "-50", "0.0.0"]) {
    assert.equal(
      resolveOptionNumber(invalid, TARGET_LATENCY_OPTIONS, 100),
      100,
      `${invalid} は既存値を保つ`,
    );
  }
  for (const invalid of ["2", "0.5", "1.0", "yes", "0.0.0"]) {
    assert.equal(
      resolveOptionNumber(invalid, RENDER_GROUP_OPTIONS, 0),
      0,
      `${invalid} は既存値を保つ`,
    );
  }
});

// useDedicatedWorker は =0 / =1 だけを受け付け、それ以外の値は無視する
test("initFromUrl: 0 / 1 以外の useDedicatedWorker は無視する", () => {
  useDedicatedWorker.value = true;
  initFromUrl("useDedicatedWorker=yes");
  assert.isTrue(useDedicatedWorker.value);
  initFromUrl("useDedicatedWorker=0");
  assert.isFalse(useDedicatedWorker.value);
  initFromUrl("useDedicatedWorker=1");
  assert.isTrue(useDedicatedWorker.value);
});

// namespace の初期値は moqt-devtools- + ランダム 16 文字 (a-zA-Z0-9)。複数の devtools が
// 同じ relay に繋がっても namespace が衝突しないようにする。
// 接続設定を読み込むテストが namespace を書き換えるため、信号の初期値ではなく読み込み直後の値を確かめる
test("namespace の初期値は moqt-devtools- + ランダム 16 文字", () => {
  assert.match(INITIAL_NAMESPACE, /^moqt-devtools-[a-zA-Z0-9]{16}$/);
});

// --- Namespace の欄の表記 (draft-ietf-moq-transport-22 §8.8) ---

// 欄は namespace-name 文字列であり、Track Namespace のフィールドは "-" で並ぶ
test("namespaceArray: Namespace の欄を - 区切りで分解する", () => {
  resetMsfFragmentSettings();
  namespace.value = "15551-spam";

  assert.equal(namespaceProblem.value, null);
  assert.deepEqual(namespaceArray.value, ["15551", "spam"]);

  resetMsfFragmentSettings();
});

// フィールド自身に "-" や "/" を含むときは §8.8 の percent-encoding で書く。区切りと
// エスケープを区別するため、欄の文字列からフィールド列が一意に戻る
test("namespaceArray: フィールドの - と / を percent-encoding から復号する", () => {
  resetMsfFragmentSettings();
  namespace.value = "a.2db.2fc-d";

  assert.equal(namespaceProblem.value, null);
  assert.deepEqual(namespaceArray.value, ["a-b/c", "d"]);

  resetMsfFragmentSettings();
});

// 0 フィールドの Track Namespace (§8.7 が許す) は空文字列で表す
test("namespaceArray: 空の Namespace は 0 フィールドにする", () => {
  resetMsfFragmentSettings();
  namespace.value = "";

  assert.equal(namespaceProblem.value, null);
  assert.deepEqual(namespaceArray.value, []);

  resetMsfFragmentSettings();
});

// §8.8 の namespace-name 文字列として読めない値では接続に使うフィールド列が無いことを、
// 画面の警告 (namespaceProblem) と接続に使う値の要求 (requireConnectNamespace) で示す。
// 警告の文言は解析の失敗理由 (位置と文字) をそのまま使う
test("namespaceProblem: 解析できない Namespace では理由を出して接続を拒否する", () => {
  resetMsfFragmentSettings();
  // 旧表記の "/" は literal でもエスケープでもない
  namespace.value = "moqt/devtools/a1B2c3D4e5F6g7H8";

  assert.match(
    namespaceProblem.value ?? "",
    /character "\/" in track namespace field at index 0 is not in \[A-Za-z0-9_\]/,
  );
  assert.deepEqual(namespaceArray.value, []);
  assert.throws(
    () => requireConnectNamespace(),
    /character "\/" in track namespace field at index 0 is not in \[A-Za-z0-9_\]/,
  );

  resetMsfFragmentSettings();
});

// 解析できる値では namespaceProblem が null になり、接続に使うフィールド列が返る
test("requireConnectNamespace: 解析できる Namespace ではフィールド列を返す", () => {
  resetMsfFragmentSettings();
  namespace.value = "15551-spam";

  assert.equal(namespaceProblem.value, null);
  assert.deepEqual(requireConnectNamespace(), ["15551", "spam"]);

  resetMsfFragmentSettings();
});

// 空のフィールド (§8.7 違反) は末尾の区切りとしても表せない
test("namespaceProblem: 空のフィールドを含む Namespace では理由を出して接続を拒否する", () => {
  resetMsfFragmentSettings();
  namespace.value = "15551--spam";

  assert.match(namespaceProblem.value ?? "", /track namespace field at index 1 must not be empty/);
  assert.deepEqual(namespaceArray.value, []);
  assert.throws(
    () => requireConnectNamespace(),
    /track namespace field at index 1 must not be empty/,
  );

  resetMsfFragmentSettings();
});

// §2.4.3 の予約 namespace (先頭フィールドが "." で始まる) は、§8.8 の表記としては読めても
// 送信できない。接続の前に理由を出して拒否する (検証はライブラリの送信時のものを共有する)
test("namespaceProblem: 予約 namespace では理由を出して接続を拒否する", () => {
  resetMsfFragmentSettings();
  // "." は literal で書けないため、§8.8 では .2e と書く
  namespace.value = ".2esession";

  assert.match(namespaceProblem.value ?? "", /session-level namespace \.session is reserved/);
  assert.deepEqual(namespaceArray.value, [".session"]);
  assert.throws(() => requireConnectNamespace(), /reserved/);

  resetMsfFragmentSettings();
});

// §8.7 の 32 フィールド上限も接続の前に見る (33 フィールドは送信時に拒否される)
test("namespaceProblem: 33 フィールドの Namespace では理由を出して接続を拒否する", () => {
  resetMsfFragmentSettings();
  namespace.value = Array.from({ length: 33 }, (_value, index) => `n${index}`).join("-");

  assert.match(namespaceProblem.value ?? "", /track namespace fields exceeds maximum: 33 > 32/);
  assert.throws(() => requireConnectNamespace(), /track namespace fields exceeds maximum: 33 > 32/);

  resetMsfFragmentSettings();
});

// 32 フィールド (上限ちょうど) は接続に使える。devtools の配線が上限を過剰に拒否しないことを固定する
test("namespaceProblem: 32 フィールドの Namespace は接続に使える", () => {
  resetMsfFragmentSettings();
  namespace.value = Array.from({ length: 32 }, (_value, index) => `n${index}`).join("-");

  assert.equal(namespaceProblem.value, null);
  assert.equal(requireConnectNamespace().length, 32);

  resetMsfFragmentSettings();
});

// devtools はリポジトリ内で公開 API を使う利用者である。`src/index.ts` の公開リストから検証関数を
// 取り出して実行できることを固定する (境界値・error path・メッセージの意味論は src/session/params.test.ts
// と src/session/params.prop.ts が担う)
test("公開 API の validateTrackNamespaceForSend を実行できる", () => {
  assert.doesNotThrow(() => validateTrackNamespaceForSend(["15551", "spam"]));
  assert.throws(() => validateTrackNamespaceForSend([".session"]), /reserved/);
});

// --- msf fragment の namespace ---

// MOQT URI に msf fragment があるときは、その namespace を Namespace 欄へ反映して固定する。
// msf fragment が接続先の namespace を決めるため、ユーザーの編集で認可された namespace から
// 外れないようにする (draft-ietf-moq-msf-01 §11.1.2)
test("refreshMsfFragmentSettings: msf fragment の namespace を反映して固定する", () => {
  resetMsfFragmentSettings();
  url.value = "moqt://sora-moq.example/#msf:15551-spam--catalog&c4m=QUFB";

  refreshMsfFragmentSettings();

  // 欄は §8.8 の namespace-name 文字列 (`-` 区切り) になる
  assert.equal(namespace.value, "15551-spam");
  assert.isTrue(namespaceLocked.value);
  assert.equal(namespaceProblem.value, null);
  assert.deepEqual(namespaceArray.value, ["15551", "spam"]);
  resetMsfFragmentSettings();
});

// 解析できない msf fragment では固定しない (入力途中の値で固定されない)
test("refreshMsfFragmentSettings: 解析できない msf fragment では固定しない", () => {
  resetMsfFragmentSettings();
  url.value = "moqt://sora-moq.example/#msf:15551-spam-";

  refreshMsfFragmentSettings();

  assert.isFalse(namespaceLocked.value);
  assert.equal(namespace.value, INITIAL_NAMESPACE);
  resetMsfFragmentSettings();
});

// msf fragment が無くなると固定を解除する。直前の値は Namespace 欄に残り、編集できる
test("refreshMsfFragmentSettings: msf fragment が無くなると固定を解除する", () => {
  resetMsfFragmentSettings();
  url.value = "moqt://sora-moq.example/#msf:15551-spam--catalog";
  refreshMsfFragmentSettings();
  assert.isTrue(namespaceLocked.value);

  url.value = "moqt://sora-moq.example/";
  refreshMsfFragmentSettings();

  assert.isFalse(namespaceLocked.value);
  assert.equal(namespace.value, "15551-spam");
  resetMsfFragmentSettings();
});

// namespace フィールドの percent-encoding (msf fragment の §11.1.2 の `.HH`) を decode し、
// 欄へは §8.8 の表記 (`-` 区切り、literal で書けない byte は `.HH`) で組み立て直して反映する
test("refreshMsfFragmentSettings: percent-encoded な namespace フィールドを decode する", () => {
  resetMsfFragmentSettings();
  url.value = "moqt://sora-moq.example/#msf:a.2db-c--video";

  refreshMsfFragmentSettings();

  assert.equal(namespace.value, "a.2db-c");
  assert.deepEqual(namespaceArray.value, ["a-b", "c"]);
  resetMsfFragmentSettings();
});

// フィールド自身に "/" を含んでも §8.8 のエスケープで書けるため、欄の文字列から
// フィールド列を復元できる (以前の "/" 区切りでは復元できなかった)
test("refreshMsfFragmentSettings: フィールドに / を含む namespace でも欄の文字列から復元できる", () => {
  resetMsfFragmentSettings();
  url.value = "moqt://sora-moq.example/#msf:a.2fb-c--video";

  refreshMsfFragmentSettings();

  assert.equal(namespace.value, "a.2fb-c");
  assert.deepEqual(namespaceArray.value, ["a/b", "c"]);

  // msf fragment を消して固定を解除しても、欄の文字列から同じフィールド列になる
  url.value = "moqt://sora-moq.example/";
  refreshMsfFragmentSettings();

  assert.isFalse(namespaceLocked.value);
  assert.equal(namespaceProblem.value, null);
  assert.deepEqual(namespaceArray.value, ["a/b", "c"]);
  resetMsfFragmentSettings();
});

// §8.7 に反する空のフィールドを含む msf fragment は §8.8 の表記にできないため、解析できない
// 値として扱う (固定しない)。欄は直前の値を保ち、ユーザーが編集できる状態のままにする
test("refreshMsfFragmentSettings: 空のフィールドを含む msf fragment では固定しない", () => {
  resetMsfFragmentSettings();
  url.value = "moqt://sora-moq.example/#msf:-x--catalog";

  refreshMsfFragmentSettings();

  assert.isFalse(namespaceLocked.value);
  assert.equal(namespace.value, INITIAL_NAMESPACE);
  assert.equal(namespaceProblem.value, null);
  // 欄の初期値 (moqt-devtools-{16 文字}) はそのまま 3 フィールドとして読める
  assert.deepEqual(namespaceArray.value, [
    "moqt",
    "devtools",
    INITIAL_NAMESPACE.replace("moqt-devtools-", ""),
  ]);
  resetMsfFragmentSettings();
});

// msf fragment が予約 namespace を指定した場合も、欄 (読み取り専用) に理由を出して接続を拒否する
test("refreshMsfFragmentSettings: 予約 namespace を指定する msf fragment では理由を出して接続を拒否する", () => {
  resetMsfFragmentSettings();
  url.value = "moqt://sora-moq.example/#msf:.2esession--catalog";

  refreshMsfFragmentSettings();

  assert.isTrue(namespaceLocked.value);
  assert.deepEqual(namespaceArray.value, [".session"]);
  assert.match(namespaceProblem.value ?? "", /session-level namespace \.session is reserved/);
  assert.throws(() => requireConnectNamespace(), /reserved/);
  resetMsfFragmentSettings();
});

// URL で開いたときも msf fragment の namespace を反映する。namespace クエリより優先する
// (msf fragment が接続先の namespace を決めるため)
test("initFromUrl: msf fragment の namespace を namespace クエリより優先する", () => {
  resetMsfFragmentSettings();
  const params = new URLSearchParams();
  params.set("url", "moqt://example.com/moqt#msf:15551-spam--catalog");
  params.set("namespace", "other-namespace");

  initFromUrl(params.toString());

  assert.equal(namespace.value, "15551-spam");
  assert.isTrue(namespaceLocked.value);
  assert.deepEqual(namespaceArray.value, ["15551", "spam"]);
  resetMsfFragmentSettings();
});

// namespace クエリは §8.8 の namespace-name 文字列として読み、フィールドへ分解する
test("initFromUrl: namespace クエリを - 区切りのフィールドへ分解する", () => {
  resetMsfFragmentSettings();
  const params = new URLSearchParams();
  params.set("namespace", "moqt-devtools-a1B2c3D4e5F6g7H8");

  initFromUrl(params.toString());

  assert.equal(namespace.value, "moqt-devtools-a1B2c3D4e5F6g7H8");
  assert.equal(namespaceProblem.value, null);
  assert.deepEqual(namespaceArray.value, ["moqt", "devtools", "a1B2c3D4e5F6g7H8"]);
  resetMsfFragmentSettings();
});

// 旧 URL の "/" 区切りの namespace クエリは §8.8 の namespace-name 文字列として読めない。
// 黙って別の namespace へ繋がないよう、欄に警告を出して接続に使うフィールド列を空にする
test("initFromUrl: / 区切りの namespace クエリは警告を出して接続に使わない", () => {
  resetMsfFragmentSettings();
  const params = new URLSearchParams();
  params.set("namespace", "moqt/devtools/a1B2c3D4e5F6g7H8");

  initFromUrl(params.toString());

  assert.equal(namespace.value, "moqt/devtools/a1B2c3D4e5F6g7H8");
  assert.match(namespaceProblem.value ?? "", /character "\/" in track namespace field at index 0/);
  assert.deepEqual(namespaceArray.value, []);
  resetMsfFragmentSettings();
});

// 旧 URL ( "/" 区切り) の値でも "/" を含まなければ §8.8 の表記として読めるため、`-` が
// フィールドの区切りとして読まれる。区切りが変わったことは検出できない (後方互換なし)
test("initFromUrl: - を含む旧 URL の namespace は - 区切りとして読む", () => {
  resetMsfFragmentSettings();
  const params = new URLSearchParams();
  params.set("namespace", "spam-egg");

  initFromUrl(params.toString());

  assert.equal(namespaceProblem.value, null);
  assert.deepEqual(namespaceArray.value, ["spam", "egg"]);
  resetMsfFragmentSettings();
});

// namespace は Copy URL のクエリへ常に書き出し、開いた URL から同じ値へ戻す。空 (0 フィールド) も
// §2.4.1 が許す指定であるため、初期値のランダム値へ戻さず指定どおりに復元する
test("buildQueryString / initFromUrl: namespace を URL で往復できる", () => {
  resetMsfFragmentSettings();
  namespace.value = "15551-spam";
  const query = buildQueryString();
  assert.equal(new URLSearchParams(query).get("namespace"), "15551-spam");

  namespace.value = "moqt-devtools-a1B2c3D4e5F6g7H8";
  initFromUrl(query);
  assert.equal(namespace.value, "15551-spam");
  assert.deepEqual(namespaceArray.value, ["15551", "spam"]);

  // 0 フィールドの namespace も key ごと書き出す
  namespace.value = "";
  const emptyQuery = buildQueryString();
  assert.isTrue(new URLSearchParams(emptyQuery).has("namespace"));
  assert.equal(new URLSearchParams(emptyQuery).get("namespace"), "");

  namespace.value = "15551-spam";
  initFromUrl(emptyQuery);
  assert.equal(namespace.value, "");
  assert.deepEqual(namespaceArray.value, []);

  resetMsfFragmentSettings();
});

// クエリに url が無いとき (Save で覚えていた MOQT URI を戻したとき) も、入力欄の MOQT URI の
// msf fragment と c4m を取り込む。namespace の固定だけが適用されて Authorization Token が
// 取り込まれない、という食い違いを作らない
test("initFromUrl: クエリの url が無いときも入力欄の MOQT URI の msf fragment と c4m を取り込む", () => {
  resetAuthorizationTokenSettings();
  resetMsfFragmentSettings();
  url.value = "moqt://sora-moq.example/#msf:15551-spam--catalog&c4m=QUFB";

  initFromUrl("");

  // MOQT URI は fragment を含めたまま、URI Fragment 欄へ映す
  assert.equal(url.value, "moqt://sora-moq.example/#msf:15551-spam--catalog&c4m=QUFB");
  assert.equal(fragment.value, "msf:15551-spam--catalog&c4m=QUFB");
  assert.equal(authorizationTokenBase64.value, "QUFB");
  assert.equal(authorizationTokenType.value, "1");
  assert.equal(namespace.value, "15551-spam");
  assert.isTrue(namespaceLocked.value);
  resetMsfFragmentSettings();
});

// --- MOQT URI と URI Fragment ---

// MOQT URI に URL 全体を貼り付けても fragment は消さず、URI Fragment 欄へ映す。
// fragment から c4m を取り込み、msf fragment の namespace を固定する
test("applyRelayUriInput: MOQT URI の fragment を URI Fragment 欄へ映す", () => {
  resetAuthorizationTokenSettings();
  resetMsfFragmentSettings();

  applyRelayUriInput("moqt://sora-moq.example/#msf:15551-spam--catalog&c4m=QUFB");

  // 貼り付けた URL はそのまま残る (fragment が消えない)
  assert.equal(url.value, "moqt://sora-moq.example/#msf:15551-spam--catalog&c4m=QUFB");
  assert.equal(fragment.value, "msf:15551-spam--catalog&c4m=QUFB");
  // 映した fragment から c4m を取り込み、namespace を固定する
  assert.equal(authorizationTokenBase64.value, "QUFB");
  assert.equal(authorizationTokenType.value, "1");
  assert.equal(namespace.value, "15551-spam");
  assert.isTrue(namespaceLocked.value);
  // 接続に使う URL は貼り付けた URL と同じ
  assert.equal(buildConnectUrl(), "moqt://sora-moq.example/#msf:15551-spam--catalog&c4m=QUFB");
  resetMsfFragmentSettings();
});

// MOQT URI から fragment を消すと URI Fragment 欄も消え、namespace の固定が解除される
test("applyRelayUriInput: MOQT URI から fragment を消すと URI Fragment 欄も消える", () => {
  resetMsfFragmentSettings();
  applyRelayUriInput("moqt://sora-moq.example/#msf:15551-spam--catalog");
  assert.equal(fragment.value, "msf:15551-spam--catalog");
  assert.isTrue(namespaceLocked.value);

  applyRelayUriInput("moqt://sora-moq.example/");

  assert.equal(url.value, "moqt://sora-moq.example/");
  assert.equal(fragment.value, "");
  assert.isFalse(namespaceLocked.value);
  resetMsfFragmentSettings();
});

// `type:value` の形でない `#` 以降は fragment ではないため、URI Fragment 欄へ映さない
test("applyRelayUriInput: type:value でない # 以降は映さない", () => {
  resetMsfFragmentSettings();

  applyRelayUriInput("moqt://example.com/moqt#foo");

  assert.equal(url.value, "moqt://example.com/moqt#foo");
  assert.equal(fragment.value, "");
  resetMsfFragmentSettings();
});

// クエリの url に fragment が含まれる共有リンクでも、MOQT URI はそのままに URI Fragment 欄へ映す
test("initFromUrl: クエリの url の fragment を URI Fragment 欄へ映して復元する", () => {
  resetAuthorizationTokenSettings();
  resetMsfFragmentSettings();
  const params = new URLSearchParams();
  params.set("url", "moqt://example.com/moqt#msf:15551-spam--catalog&c4m=QUFB");

  initFromUrl(params.toString());

  assert.equal(url.value, "moqt://example.com/moqt#msf:15551-spam--catalog&c4m=QUFB");
  assert.equal(fragment.value, "msf:15551-spam--catalog&c4m=QUFB");
  assert.equal(authorizationTokenBase64.value, "QUFB");
  assert.equal(namespace.value, "15551-spam");
  resetMsfFragmentSettings();
});

// クエリの fragment は MOQT URI の fragment より優先する (共有リンクの値)
test("initFromUrl: クエリの fragment を MOQT URI の fragment より優先する", () => {
  resetMsfFragmentSettings();
  const params = new URLSearchParams();
  params.set("url", "moqt://example.com/moqt#msf:15551-spam--catalog");
  params.set("fragment", "msf:room-123--video");

  initFromUrl(params.toString());

  assert.equal(url.value, "moqt://example.com/moqt#msf:15551-spam--catalog");
  assert.equal(fragment.value, "msf:room-123--video");
  assert.equal(namespace.value, "room-123");
  assert.isTrue(namespaceLocked.value);
  resetMsfFragmentSettings();
});

// --- c4m の track name ---

// 取り込んだトークンの exact な track name を画面表示用に取り出せる。
// トークンを解除すると空になる (取り込みの表示と送信内容が食い違わない)
test("c4mTrackNames: 取り込んだトークンの track name を返し、解除で空になる", async () => {
  resetAuthorizationTokenSettings();
  const base64Url = await buildCatWithTrackNames(["catalog", "audio", "video", "events"]);

  applyC4mFromUrl(`moqt://example.com/moqt#msf:15551-spam--catalog&c4m=${base64Url}`);

  assert.deepEqual(c4mTrackNames.value, ["catalog", "audio", "video", "events"]);
  resetAuthorizationTokenSettings();
  assert.deepEqual(c4mTrackNames.value, []);
});

// c4m の moqt クレームが exact で audio / video を許可しているときは、その名前を
// それぞれのトラック名の欄へ反映する (署名検証はしない)
test("applyC4mFromUrl: c4m の exact な track name を audio / video の欄へ反映する", async () => {
  resetAuthorizationTokenSettings();
  resetMsfFragmentSettings();
  videoTrackName.value = "camera";
  audioTrackName.value = "microphone";
  const base64Url = await buildCatWithTrackNames(["catalog", "audio", "video", "events"]);

  const applied = applyC4mFromUrl(
    `moqt://example.com/moqt#msf:15551-spam--catalog&c4m=${base64Url}`,
  );

  assert.equal(applied, true);
  assert.equal(audioTrackName.value, "audio");
  assert.equal(videoTrackName.value, "video");
  // トークンが固定したトラック名は編集できない (トークンを解除するまで読み取り専用)
  assert.isTrue(audioTrackNameLocked.value);
  assert.isTrue(videoTrackNameLocked.value);
  resetMsfFragmentSettings();
});

// moqt クレームが audio / video を許可していないときは、トラック名の欄を変えない
// (トークンは track の役割を持たないため、名前が一致するものだけを反映する)
test("applyC4mFromUrl: トークンに無い track name の欄は変えない", async () => {
  resetAuthorizationTokenSettings();
  resetMsfFragmentSettings();
  videoTrackName.value = "camera";
  audioTrackName.value = "microphone";
  const base64Url = await buildCatWithoutMoqtClaim();

  const applied = applyC4mFromUrl(
    `moqt://example.com/moqt#msf:15551-spam--catalog&c4m=${base64Url}`,
  );

  assert.equal(applied, true);
  assert.equal(audioTrackName.value, "microphone");
  assert.equal(videoTrackName.value, "camera");
  // トークンが名前を固定していないため、トラック名の欄は編集できる
  assert.isFalse(audioTrackNameLocked.value);
  assert.isFalse(videoTrackNameLocked.value);
  resetMsfFragmentSettings();
});

// prefix の track match は 1 つの名前を表さないため、トラック名の欄へ反映しない
test("applyC4mFromUrl: prefix の track match はトラック名の欄へ反映しない", async () => {
  resetAuthorizationTokenSettings();
  resetMsfFragmentSettings();
  videoTrackName.value = "camera";
  const scope = C4M.createMoqtScope(["Publish"]);
  // track match だけの scope は表現できないため、namespace match を置く
  scope.namespace.push(C4M.namespaceMatchValue(C4M.exactMatch(new TextEncoder().encode("15551"))));
  scope.track = C4M.prefixMatch(new TextEncoder().encode("cam"));
  const base64Url = await buildCat([scope]);

  applyC4mFromUrl(`moqt://example.com/moqt#msf:15551-spam--catalog&c4m=${base64Url}`);

  assert.equal(videoTrackName.value, "camera");
  resetMsfFragmentSettings();
});

// base64url (パディング省略) で発行された c4m でも、復号した生バイト列を CAT として送る。
// 標準 Base64 の atob では復号できないため、C4M のデコーダと同じ規則を使う
test("buildAuthorizationToken: base64url の c4m を復号して CAT として送る", async () => {
  resetAuthorizationTokenSettings();
  const base64Url = await buildCatWithTrackNames(["audio"]);

  const applied = applyC4mFromUrl(
    `moqt://example.com/moqt#msf:15551-spam--catalog&c4m=${base64Url}`,
  );

  assert.equal(applied, true);
  assert.equal(authorizationTokenBase64.value, base64Url);
  const token = buildAuthorizationToken();
  assert.equal(token?.aliasType, AuthorizationTokenAliasType.USE_VALUE);
  if (token?.aliasType === AuthorizationTokenAliasType.USE_VALUE) {
    assert.equal(token.tokenType, 1n);
    // COSE 形式のトークンは CWT タグ (61) から始まる (draft-ietf-moq-c4m-01 §2)
    assert.equal(token.tokenValue[0], 0xd8);
    assert.equal(token.tokenValue[1], 0x3d);
  }
});

// --- clearImportedC4mToken / discardImportedC4mToken ---
// moqt-js の connect() は MOQT URI の msf fragment の c4m を SETUP の Authorization Token として
// 送る (draft-ietf-moq-msf-01 §11.1.1 / §11.4.3)。画面で取り込みを解除しただけでは URL に
// c4m が残って送信が止まらないため、解除では URL からも c4m を取り除く。

// Clear (clearImportedC4mToken) で、取り込みの状態と Token Type が戻り、
// MOQT URI からも c4m が消える。接続 URL に c4m が残らないことを固定する。
test("clearImportedC4mToken: MOQT URI からも c4m を取り除き Token Type を 0 に戻す", () => {
  resetAuthorizationTokenSettings();
  resetMsfFragmentSettings();
  applyRelayUriInput("moqt://example.com/moqt#msf:room-123--catalog&c4m=QUFB&connection=wt");

  clearImportedC4mToken();

  assert.equal(authorizationTokenBase64.value, "");
  assert.equal(authorizationTokenType.value, "0");
  // c4m 以外の parameter と track-identifier は残す
  assert.equal(url.value, "moqt://example.com/moqt#msf:room-123--catalog&connection=wt");
  assert.equal(fragment.value, "msf:room-123--catalog&connection=wt");
  assert.equal(buildConnectUrl(), "moqt://example.com/moqt#msf:room-123--catalog&connection=wt");
  resetMsfFragmentSettings();
});

// URI Fragment 欄へ手入力した c4m も同じように取り除く (MOQT URI に fragment が無い場合)
test("clearImportedC4mToken: URI Fragment 欄の c4m も取り除く", () => {
  resetAuthorizationTokenSettings();
  resetMsfFragmentSettings();
  url.value = "moqt://example.com/moqt";
  fragment.value = "msf:room-123--catalog&c4m=QUFB";
  applyC4mFromUrl(fragment.value);

  clearImportedC4mToken();

  assert.equal(url.value, "moqt://example.com/moqt");
  assert.equal(fragment.value, "msf:room-123--catalog");
  resetMsfFragmentSettings();
});

// Token Type の編集では、入力した Token Type を残したまま c4m の取り込みだけを解除する。
// URL に c4m が残っていると moqt-js が SETUP に載せてしまうため、取り除くことも固定する。
test("discardImportedC4mToken: Token Type を残して c4m を取り除く", () => {
  resetAuthorizationTokenSettings();
  resetMsfFragmentSettings();
  applyRelayUriInput("moqt://example.com/moqt#msf:room-123--catalog&c4m=QUFB");
  authorizationTokenType.value = "2";

  discardImportedC4mToken();

  assert.equal(authorizationTokenBase64.value, "");
  assert.equal(authorizationTokenType.value, "2");
  assert.equal(url.value, "moqt://example.com/moqt#msf:room-123--catalog");
  assert.equal(fragment.value, "msf:room-123--catalog");
  resetMsfFragmentSettings();
});

// c4m を持たない URL では何も変えない (取り込みを解除する経路で URL を壊さない)
test("discardImportedC4mToken: c4m を持たない URL は変えない", () => {
  resetAuthorizationTokenSettings();
  resetMsfFragmentSettings();
  url.value = "moqt://example.com/moqt#msf:room-123--catalog&connection=wt";

  discardImportedC4mToken();

  assert.equal(url.value, "moqt://example.com/moqt#msf:room-123--catalog&connection=wt");
  resetMsfFragmentSettings();
});
