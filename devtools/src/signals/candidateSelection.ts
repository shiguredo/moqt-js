/**
 * パネルごとの接続先の選択 (自動 / 固定) を URL とやり取りする
 *
 * Publisher と各 Subscriber の選択は接続設定ではなくパネルの状態なので、Copy URL では
 * 別のクエリパラメータとして載せる。購読は複数あり得るため、購読ごとの選択は配列で持つ。
 */

import { enabledServerUrlCandidateUrls, serverUrlCandidatesSuspended } from "./connectionSettings";
import * as pub from "./publisher";
import {
  AUTO_CANDIDATE_SELECTION,
  fixedCandidateUrl,
  formatSubscriberCandidateSelections,
  parseSubscriberCandidateSelections,
  type CandidateSelection,
} from "../utils/candidateSelection";

/** Copy URL に載せる、Publisher の選択 (固定した候補の URI) */
export const PUBLISHER_CANDIDATE_QUERY_KEY = "publisherCandidate";
/** Copy URL に載せる、購読ごとの選択 (固定した候補の URI と null の配列) */
export const SUBSCRIBER_CANDIDATES_QUERY_KEY = "subscriberCandidates";

// URL から復元した購読ごとの選択。購読は page の読み込み後に作られるため、作られる順に
// 1 つずつ取り出す (足りない分は自動選択)
let initialSubscriberSelections: CandidateSelection[] = [];

/** 次に作る Subscriber の初期選択を取り出す */
export function takeInitialSubscriberCandidateSelection(): CandidateSelection {
  return initialSubscriberSelections.shift() ?? AUTO_CANDIDATE_SELECTION;
}

/** 有効な候補として登録されている URI かどうか */
function isEnabledCandidate(url: string): boolean {
  return enabledServerUrlCandidateUrls.value.includes(url);
}

/**
 * 候補を固定して共有できる状態かどうか
 *
 * 有効な候補が 2 件以上あり、共有リンクの接続先で候補の使用を止めていないときだけ。
 * 1 件以下では Auto と固定の区別が付かないため、選択は URL に載せない。
 */
function canFixCandidate(): boolean {
  return !serverUrlCandidatesSuspended.value && enabledServerUrlCandidateUrls.value.length >= 2;
}

/**
 * URL のクエリからパネルごとの選択を復元する
 *
 * 候補を使わない page や、固定できる候補が無いときは無視する。壊れた値や無効な候補も
 * 無視し、自動選択に戻す。購読の選択は Subscriber が作られるときに順に使う。
 */
export function applyCandidateSelectionsFromUrl(search: string): void {
  initialSubscriberSelections = [];
  pub.pubCandidateSelection.value = AUTO_CANDIDATE_SELECTION;
  if (!canFixCandidate()) {
    return;
  }
  const params = new URLSearchParams(search);
  const publisherParam = params.get(PUBLISHER_CANDIDATE_QUERY_KEY);
  if (publisherParam !== null && isEnabledCandidate(publisherParam)) {
    pub.pubCandidateSelection.value = { mode: "fixed", url: publisherParam };
  }

  const subscribersParam = params.get(SUBSCRIBER_CANDIDATES_QUERY_KEY);
  if (subscribersParam === null) {
    return;
  }
  const parsed = parseSubscriberCandidateSelections(subscribersParam);
  if (parsed === null) {
    return;
  }
  initialSubscriberSelections = parsed.map((url) =>
    url !== null && isEnabledCandidate(url) ? { mode: "fixed", url } : AUTO_CANDIDATE_SELECTION,
  );
}

/**
 * パネルごとの選択を Copy URL のクエリに載せる
 *
 * 固定した候補が無効なときや、固定できる候補が無いときは載せない (共有先で選べない
 * ため)。購読の選択は、固定した候補が 1 つも無ければ載せない。
 */
export function appendCandidateSelections(
  search: string,
  subscriberSelections: readonly CandidateSelection[],
): string {
  const params = new URLSearchParams(search);
  params.delete(PUBLISHER_CANDIDATE_QUERY_KEY);
  params.delete(SUBSCRIBER_CANDIDATES_QUERY_KEY);
  if (!canFixCandidate()) {
    return params.toString();
  }

  const publisherUrl = fixedCandidateUrl(pub.pubCandidateSelection.value);
  if (publisherUrl !== null && isEnabledCandidate(publisherUrl)) {
    params.set(PUBLISHER_CANDIDATE_QUERY_KEY, publisherUrl);
  }

  const validSelections = subscriberSelections.map((selection) => {
    const url = fixedCandidateUrl(selection);
    return url !== null && isEnabledCandidate(url)
      ? ({ mode: "fixed", url } satisfies CandidateSelection)
      : AUTO_CANDIDATE_SELECTION;
  });
  const subscribersParam = formatSubscriberCandidateSelections(validSelections);
  if (subscribersParam !== null) {
    params.set(SUBSCRIBER_CANDIDATES_QUERY_KEY, subscribersParam);
  }
  return params.toString();
}
