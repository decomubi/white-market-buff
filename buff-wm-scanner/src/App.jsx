import React, { useState, useEffect, useMemo } from "react";
import {
  Search,
  ArrowUpDown,
  TrendingUp,
  Box,
  RefreshCw,
  Filter,
  ExternalLink,
} from "lucide-react";

const App = () => {
  const [items, setItems] = useState([]);
  const [fx, setFx] = useState(0.14);
  const [searchTerm, setSearchTerm] = useState("");
  const [limit, setLimit] = useState(10);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [lastUpdated, setLastUpdated] = useState(null);
  const [sortConfig, setSortConfig] = useState({
    key: "netProfitUsd",
    direction: "desc",
  });
  const [onlyProfitable, setOnlyProfitable] = useState(false);

  // ---------- FETCH FROM NETLIFY FUNCTION ----------
  const fetchData = async () => {
    setLoading(true);
    setError("");

    try {
      const res = await fetch(`/.netlify/functions/scan?limit=${limit}`);

      if (!res.ok) {
        throw new Error(`HTTP ${res.status} from scan function`);
      }

      const data = await res.json();

      if (!data.ok) {
        throw new Error(data.error || "Scan failed");
      }

      setItems(Array.isArray(data.items) ? data.items : []);
      if (typeof data.fx === "number") setFx(data.fx);

      setLastUpdated(new Date());
    } catch (err) {
      console.error("Scan error:", err);
      setError(err.message || "Unknown error");
      setItems([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    // Optional: auto-scan on page load
    fetchData();
  }, []);

  // ---------- METRICS ----------
  const profitableItems = useMemo(
    () => items.filter((i) => Number(i.netProfitUsd) > 0),
    [items]
  );

  const profitableFlips = profitableItems.length;

  const avgSpread = useMemo(() => {
    if (!items.length) return 0;
    const sum = items.reduce(
      (acc, item) => acc + (Number(item.spreadPct) || 0),
      0
    );
    return sum / items.length;
  }, [items]);

  const totalVolumeUsd = useMemo(() => {
    return items.reduce(
      (acc, item) => acc + (Number(item.buffUsd) || 0),
      0
    );
  }, [items]);

  // ---------- SORT + FILTER ----------
  const sortedAndFilteredItems = useMemo(() => {
    let result = [...items];

    if (searchTerm.trim()) {
      const q = searchTerm.toLowerCase();
      result = result.filter((item) =>
        (item.name || "").toLowerCase().includes(q)
      );
    }

    if (onlyProfitable) {
      result = result.filter((i) => Number(i.netProfitUsd) > 0);
    }

    if (sortConfig.key) {
      const { key, direction } = sortConfig;
      result.sort((a, b) => {
        const av = a[key] ?? 0;
        const bv = b[key] ?? 0;
        if (typeof av === "string" && typeof bv === "string") {
          return direction === "asc"
            ? av.localeCompare(bv)
            : bv.localeCompare(av);
        }
        const na = Number(av) || 0;
        const nb = Number(bv) || 0;
        return direction === "asc" ? na - nb : nb - na;
      });
    }

    return result;
  }, [items, searchTerm, sortConfig, onlyProfitable]);

  const handleSort = (key) => {
    setSortConfig((prev) => {
      if (prev.key === key) {
        return {
          key,
          direction: prev.direction === "asc" ? "desc" : "asc",
        };
      }
      return { key, direction: "desc" };
    });
  };

  const formatUsd = (value) =>
    typeof value === "number"
      ? `$${value.toFixed(2)}`
      : value
      ? `$${Number(value).toFixed(2)}`
      : "$0.00";

  const formatPct = (value) =>
    typeof value === "number"
      ? `${value.toFixed(2)}%`
      : value
      ? `${Number(value).toFixed(2)}%`
      : "0.00%";

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <div className="max-w-7xl mx-auto px-4 py-6">
        {/* HEADER */}
        <header className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-indigo-600 flex items-center justify-center shadow-lg shadow-indigo-600/40">
              <TrendingUp size={18} />
            </div>
            <div>
              <h1 className="text-lg font-semibold tracking-tight">
                ArbitrageScanner
              </h1>
              <p className="text-xs text-slate-400">
                Buff163 to MarketCSGO
              </p>
            </div>
          </div>

          <div className="flex items-center gap-4 text-xs text-slate-400">
            <div className="flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-emerald-500" />
              <span>Buff163 API: Server-side</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-emerald-500" />
              <span>MarketCSGO API: Server-side</span>
            </div>
          </div>
        </header>

        {/* METRIC CARDS */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
          <MetricCard
            title="Profitable flips"
            value={profitableFlips}
            icon={TrendingUp}
            accent="emerald"
          />
          <MetricCard
            title="Avg. spread"
            value={formatPct(avgSpread)}
            icon={ArrowUpDown}
            accent={avgSpread >= 0 ? "emerald" : "red"}
          />
          <MetricCard
            title="Total volume"
            value={formatUsd(totalVolumeUsd)}
            icon={Box}
            accent="indigo"
          />
          <MetricCard
            title="Data status"
            value="Up to Date"
            sub={`FX CNY→USD: ${fx.toFixed(2)}`}
            icon={RefreshCw}
            accent="violet"
          />
        </div>

        {/* SEARCH + CONTROLS */}
        <div className="flex flex-col md:flex-row gap-3 items-center mb-4">
          <div className="flex-1 w-full relative">
            <Search
              size={16}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500"
            />
            <input
              type="text"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="Search skin name (e.g. Redline)..."
              className="w-full bg-slate-900/70 border border-slate-800 rounded-xl pl-9 pr-3 py-2 text-xs focus:outline-none focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500 placeholder:text-slate-500"
            />
          </div>

          <button
            type="button"
            className="flex items-center gap-2 px-3 py-2 rounded-xl bg-slate-900/70 border border-slate-800 text-xs text-slate-300 hover:border-indigo-500 hover:text-indigo-300 transition-colors"
            onClick={() => setOnlyProfitable((v) => !v)}
          >
            <Filter size={14} />
            {onlyProfitable ? "Only profitable ✓" : "Only profitable"}
          </button>

          <div className="flex items-center gap-2">
            <input
              type="number"
              min={1}
              max={100}
              value={limit}
              onChange={(e) =>
                setLimit(Math.max(1, Math.min(100, Number(e.target.value) || 1)))
              }
              className="w-16 bg-slate-900/70 border border-slate-800 rounded-xl px-2 py-2 text-xs text-center focus:outline-none focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500"
            />
            <button
              onClick={fetchData}
              disabled={loading}
              className="px-4 py-2 text-xs rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:bg-indigo-900 disabled:text-slate-400 font-medium flex items-center gap-2 shadow-lg shadow-indigo-600/40 transition-colors"
            >
              {loading ? (
                <>
                  <RefreshCw size={14} className="animate-spin" /> Scanning…
                </>
              ) : (
                "Scan"
              )}
            </button>
          </div>
        </div>

        {/* ERROR BANNER */}
        {error && (
          <div className="mb-4 rounded-xl border border-red-500/40 bg-red-500/10 text-xs text-red-300 px-4 py-2">
            Scan failed: {error}
          </div>
        )}

        {/* TABLE */}
        <div className="bg-slate-900/60 border border-slate-800/80 rounded-2xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="min-w-full text-xs">
              <thead className="bg-slate-900/80 border-b border-slate-800/80">
                <tr>
                  <th className="px-4 py-3 text-left font-medium text-slate-400 text-[11px]">
                    Item details
                  </th>
                  <SortableHeader
                    label="BUFF163 price"
                    sortKey="buffUsd"
                    sortConfig={sortConfig}
                    onSort={handleSort}
                    align="right"
                  />
                  <SortableHeader
                    label="MCSGO buy order"
                    sortKey="mcsgPrice"
                    sortConfig={sortConfig}
                    onSort={handleSort}
                    align="right"
                  />
                  <SortableHeader
                    label="Spread"
                    sortKey="spreadPct"
                    sortConfig={sortConfig}
                    onSort={handleSort}
                    align="right"
                  />
                  <SortableHeader
                    label="Net profit"
                    sortKey="netProfitUsd"
                    sortConfig={sortConfig}
                    onSort={handleSort}
                    align="right"
                  />
                  <SortableHeader
                    label="Quantity"
                    sortKey="quantity"
                    sortConfig={sortConfig}
                    onSort={handleSort}
                    align="center"
                  />
                  <th className="px-4 py-3 text-center font-medium text-slate-400 text-[11px]">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {!loading && sortedAndFilteredItems.length === 0 && (
                  <tr>
                    <td
                      colSpan={7}
                      className="px-4 py-10 text-center text-slate-500 text-xs"
                    >
                      No items found. Click &quot;Scan&quot;.
                    </td>
                  </tr>
                )}

                {sortedAndFilteredItems.map((item) => {
                  const profit = Number(item.netProfitUsd) || 0;
                  const spread = Number(item.spreadPct) || 0;
                  const spreadColor =
                    spread > 0
                      ? "text-emerald-400 bg-emerald-500/10"
                      : "text-red-400 bg-red-500/10";

                  return (
                    <tr
                      key={item.id}
                      className="border-t border-slate-800/60 hover:bg-slate-900/60 transition-colors"
                    >
                      {/* ITEM DETAILS */}
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-3">
                          <div className="w-10 h-10 rounded-lg bg-slate-800/80 overflow-hidden flex items-center justify-center">
                            {item.image ? (
                              <img
                                src={item.image}
                                alt={item.name}
                                className="w-full h-full object-cover"
                              />
                            ) : (
                              <Box size={16} className="text-slate-500" />
                            )}
                          </div>
                          <div className="flex flex-col">
                            <span className="text-[11px] font-medium">
                              {item.name}
                            </span>
                            <span className="text-[10px] text-slate-500">
                              {item.wear || "-"}
                            </span>
                            {item.note && (
                              <span className="text-[10px] text-amber-400/80 mt-0.5">
                                API: {item.note}
                              </span>
                            )}
                          </div>
                        </div>
                      </td>

                      {/* BUFF PRICE */}
                      <td className="px-4 py-3 text-right text-[11px]">
                        <div className="flex flex-col items-end">
                          <span>{item.buffPrice ?? "-"}</span>
                          <span className="text-slate-500">
                            {formatUsd(item.buffUsd)}
                          </span>
                        </div>
                      </td>

                      {/* MCSGO PRICE */}
                      <td className="px-4 py-3 text-right text-[11px]">
                        <div className="flex flex-col items-end">
                          <span>{formatUsd(item.mcsgPrice)}</span>
                          <span className="text-slate-500">
                            {item.mcsgOrders || 0} orders
                          </span>
                        </div>
                      </td>

                      {/* SPREAD */}
                      <td className="px-4 py-3 text-right text-[11px]">
                        <span
                          className={`inline-flex items-center px-2 py-0.5 rounded-full ${spreadColor}`}
                        >
                          {formatPct(spread)}
                        </span>
                      </td>

                      {/* NET PROFIT */}
                      <td className="px-4 py-3 text-right text-[11px]">
                        <span
                          className={
                            profit > 0 ? "text-emerald-400" : "text-red-400"
                          }
                        >
                          {formatUsd(profit)}
                        </span>
                      </td>

                      {/* QUANTITY */}
                      <td className="px-4 py-3 text-center text-[11px]">
                        {item.quantity ?? "-"}
                      </td>

                      {/* ACTIONS */}
                      <td className="px-4 py-3 text-center text-[11px]">
                        {item.mcsgUrl ? (
                          <a
                            href={item.mcsgUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center justify-center w-7 h-7 rounded-lg bg-slate-900/80 border border-slate-700 hover:border-indigo-500 hover:text-indigo-400 transition-colors"
                          >
                            <ExternalLink size={14} />
                          </a>
                        ) : (
                          <span className="text-slate-600 text-[10px]">
                            —
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="px-4 py-2 border-t border-slate-800/80 text-[10px] text-slate-500 flex items-center justify-between">
            <span>
              Showing {sortedAndFilteredItems.length} results
            </span>
            <span>
              Last updated:{" "}
              {lastUpdated
                ? lastUpdated.toLocaleTimeString()
                : "—"}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
};

// ---------- SMALL COMPONENTS ----------

const MetricCard = ({ title, value, sub, icon: Icon, accent = "indigo" }) => {
  const colorMap = {
    indigo: "text-indigo-400 bg-indigo-500/10",
    emerald: "text-emerald-400 bg-emerald-500/10",
    violet: "text-violet-400 bg-violet-500/10",
    red: "text-red-400 bg-red-500/10",
  };

  return (
    <div className="bg-slate-900/60 border border-slate-800/80 rounded-2xl px-4 py-3 flex items-center justify-between">
      <div>
        <p className="text-[10px] text-slate-400 uppercase tracking-wide mb-1">
          {title}
        </p>
        <p className="text-sm font-semibold">{value}</p>
        {sub && (
          <p className="text-[10px] text-slate-500 mt-1">
            {sub}
          </p>
        )}
      </div>
      <div
        className={`w-9 h-9 rounded-xl flex items-center justify-center ${colorMap[accent]}`}
      >
        <Icon size={16} />
      </div>
    </div>
  );
};

const SortableHeader = ({ label, sortKey, sortConfig, onSort, align }) => {
  const isActive = sortConfig.key === sortKey;
  const justify =
    align === "right"
      ? "justify-end"
      : align === "center"
      ? "justify-center"
      : "justify-start";

  return (
    <th
      className={`px-4 py-3 text-${align} text-[11px] font-medium text-slate-400 select-none`}
      onClick={() => onSort(sortKey)}
    >
      <div className={`flex items-center gap-2 cursor-pointer ${justify}`}>
        <span>{label}</span>
        <ArrowUpDown
          size={14}
          className={
            isActive && sortConfig.direction === "asc"
              ? "transform rotate-180"
              : ""
          }
        />
      </div>
    </th>
  );
};

export default App;
