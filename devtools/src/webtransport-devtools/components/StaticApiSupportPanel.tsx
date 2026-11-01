import { signal } from "@preact/signals";
import * as store from "../signals";
import {
  computePresenceSummary,
  presenceBadgeClass,
  presenceBadgeText,
  type StaticApiCheck,
  type StaticApiGroup,
} from "../staticApiSupport";

// 詳細表示の開閉状態
const expanded = signal(false);

/**
 * 項目の存在有無を表示用のラベルにする
 *
 * このパネルは「存在確認のみ」であり、動作を保証しない。そのため OK / NG ではなく
 * present / absent と表示する。deprecated 項目は存在有無に関わらず中立的に表示する。
 */
function itemLabel(item: StaticApiCheck): { text: string; className: string } {
  // deprecated と「サマリでは数えない詳細項目」は、サマリの対象外であることが
  // 分かるように中立的な色で表示する
  if (item.deprecated || item.excludeFromSummary) {
    return item.supported
      ? { text: "present", className: "text-amber-600 font-semibold" }
      : { text: "absent", className: "text-slate-400 font-semibold" };
  }
  return item.supported
    ? { text: "present", className: "text-green-600 font-semibold" }
    : { text: "absent", className: "text-red-500 font-semibold" };
}

function ApiSupportItem({ item }: { item: StaticApiCheck }) {
  const { text, className } = itemLabel(item);
  const noteClass = item.deprecated ? "text-amber-600" : "text-slate-400";
  return (
    <div
      data-testid={`api-presence-${item.name}`}
      class="flex items-baseline gap-2 text-xs font-mono mb-1"
    >
      <span class={`${className} w-16 shrink-0`}>{text}</span>
      <div class="flex-1 min-w-0">
        <div class="text-slate-600 break-all">
          {item.name}
          {item.deprecated && <span class="ml-2 text-amber-600 font-normal">(deprecated)</span>}
          {item.note && <span class={`ml-2 font-normal ${noteClass}`}>({item.note})</span>}
          {item.excludeFromSummary && (
            <span class="ml-2 text-slate-400 font-normal">(not counted in summary)</span>
          )}
        </div>
        {item.description && (
          <div class="text-slate-400 text-[11px] font-sans mt-0.5">{item.description}</div>
        )}
      </div>
    </div>
  );
}

function ApiSupportGroupBlock({ group }: { group: StaticApiGroup }) {
  return (
    <div class="mb-3">
      <div class="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">
        {group.name}
      </div>
      <div class="space-y-0.5 pl-2">
        {group.items.map((item) => (
          <ApiSupportItem key={item.name} item={item} />
        ))}
      </div>
    </div>
  );
}

export function StaticApiSupportPanel() {
  const groups = store.wtStaticApiPresence.value;
  const summary = computePresenceSummary(groups);

  const toggle = () => {
    expanded.value = !expanded.value;
  };

  return (
    <div class="bg-white rounded-xl shadow-sm p-5 mb-6">
      <button
        type="button"
        onClick={toggle}
        data-testid="api-support-toggle"
        class="w-full flex items-center justify-between gap-4 text-left"
      >
        <h2 class="text-lg font-semibold text-slate-700">WebTransport API Presence</h2>
        <div class="flex items-center gap-3">
          <span
            data-testid="api-presence-summary"
            class={`px-3 py-1 text-xs font-semibold rounded-full border ${presenceBadgeClass(summary.state)}`}
          >
            {presenceBadgeText(summary)}
          </span>
          <span class="text-slate-400 text-sm">{expanded.value ? "[-]" : "[+]"}</span>
        </div>
      </button>
      {expanded.value && (
        <div class="mt-4 pt-4 border-t border-slate-200">
          <p class="text-xs text-slate-500 mb-3">
            Presence check only: evaluated on page load against{" "}
            <code class="font-mono">WebTransport.prototype</code> and related globals without
            network access. The WebTransportError constructor defaults are also checked; other
            behavior is not verified. Deprecated and detail-only items are excluded from the
            summary.
          </p>
          {groups.map((group) => (
            <ApiSupportGroupBlock key={group.name} group={group} />
          ))}
        </div>
      )}
    </div>
  );
}
