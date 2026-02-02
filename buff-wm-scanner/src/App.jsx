import React, { useState, useEffect, useMemo } from "react";
import {
  Search,
  ArrowUpDown,
  TrendingUp,
  TrendingDown,
  Box,
  RefreshCw,
  Filter,
  ExternalLink,
  Activity,
} from "lucide-react";

// --------------- utility ---------------
const fmt = (n) => `$${Number(n || 0).toFixed(2)}`;
const fmtPct = (n) => `${Number(n || 0).toFixed(2)}%`;

// --------------- sub-components ---------------
const MetricCard = ({ title, value, sub, icon: Icon, accent = "indigo" }) => {
  const colors = {
    indigo: "text-indigo-400 bg-indigo-500/10",
    emerald: "text-emerald-400 bg-emerald-500/10",
    violet: "text-violet-400 bg-violet-500/10",
    red: "text-red-400 bg-red-500/10",
  };
  return (
    <div className="bg-slate-900/60 border border-slate-800/80 rounded-2xl px-4 py-3 flex items-center justify-between">
      <div>
        <p className="text-[10px] text-slate-400 uppercase tracking-wide mb-1">{title}</p>
        <p className="text-sm font-semibold">{value}</p>
        {sub && <p className="text-[10px] text-slate-500 mt-1">{sub}</p>}
      </div>
      <div className={`w-9 h-9 rounded-xl flex items-center justify-center ${colors[accent]}`}>
        <Icon size={16} />
      </div>
    </div>
  );
};

const SortHeader = ({ label, sortKey, sortConfig, onSort, align = "right" }) => {
  const active = sortConfig.key === sortKey;
  const justify = align === "center" ? "justify-center" : "justify-end";
  return (
    <th
      className="px-4 py-3 text-[11px] font-medium text-slate-400 select-none cursor-pointer hover:text-slate-200 transition-colors"
      onClick={() => onSort(sortKey)}
    >
      <div className={`flex items-center gap-1.5 ${justify}`}>
        <span>{label}</span>
        <ArrowUpDown
          size={12}
          className={`transition-transform ${active ? (sortConfig.direction === "asc" ? "rotate-180" : "") : "opacity-40"}`}
        />
      </div>
    </th>
  );
};

// --------------- main app ---------------
const App = () => {
  const [items, setItems] = useState([]);
  const [fx, setFx] = useState(0.14);
  const [search, setSearch] = useState("");
  const [limit, setLimit] = useState(20);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [lastUpdated, setLastUpdated] = useState(null);
  const [sortConfig, setSortConfig] = useState({ key: "profitUsd", direction: "desc" });
  const [onlyProfitable, setOnlyProfitable] = useState(false);
  const [priceMin, setPriceMin] = useState("");
  const [priceMax, setPriceMax] = useState("");

  // --------------- fetch ---------------
  const fetchData = async () => {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({ limit: String(limit) });
      if (search.trim()) params.set("search", search.trim());

      const res = await fetch(`/.netlify/functions/scan?${params}`);
      if (!res.ok) throw new Error(`HTTP ${res.status} from scan function`);

      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Scan failed");

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
    fetchData();
  }, []);

  // --------------- derived metrics ---------------
  const profitableCount = useMemo(() => items.filter((i) => i.profitUsd > 0).length, [items]);

  const avgSpread = useMemo(() => {
    if (!items.length) return 0;
    return items.reduce((sum, i) => sum + (Number(i.spreadPct) || 0), 0) / items.length;
  }, [items]);

  const totalVolume = useMemo(
    () => items.reduce((sum, i) => sum + (Number(i.buffPriceUsd) || 0), 0),
    [items]
  );

  // --------------- sort + filter ---------------
  const handleSort = (key) => {
    setSortConfig((prev) =>
      prev.key === key
        ? { key, direction: prev.direction === "asc" ? "desc" : "asc" }
        : { key, direction: "desc" }
    );
  };

  const visible = useMemo(() => {
    let res = [...items];

    if (search.trim()) {
      const q = search.toLowerCase();
      res = res.filter((i) => (i.name || "").toLowerCase().includes(q));
    }
    if (onlyProfitable) res = res.filter((i) => i.profitUsd > 0);
    if (priceMin !== "") res = res.filter((i) => Number(i.buffPriceUsd) >= Number(priceMin));
    if (priceMax !== "") res = res.filter((i) => Number(i.buffPriceUsd) <= Number(priceMax));

    const { key, direction } = sortConfig;
    res.sort((a, b) => {
      const av = Number(a[key]) || 0;
      const bv = Number(b[key]) || 0;
      return direction === "asc" ? av - bv : bv - av;
    });

    return res;
  }, [items, search, onlyProfitable, priceMin, priceMax, sortConfig]);

  // --------------- render ---------------
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <div className="max-w-7xl mx-auto px-4 py-6">

        {/* HEADER */}
        <header className="flex flex-col md:flex-row md:items-center justify-between mb-6 gap-3">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-indigo-600 flex items-center justify-center shadow-lg shadow-indigo-600/40">
              <Activity size={18} />
            </div>
            <div>
              <h1 className="text-lg font-semibold tracking-tight">ArbitrageScanner</h1>
              <p className="text-xs text-slate-400">Buff163 → White.Market buy orders</p>
            </div>
          </div>
          <div className="flex items-center gap-4 text-xs text-slate-400">
            <div className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-emerald-500" />
              <span>Buff163 API</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-emerald-500" />
              <span>White.Market API</span>
            </div>
          </div>
        </header>

        {/* METRIC CARDS */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
          <MetricCard title="Profitable flips" value={profitableCount} icon={TrendingUp} accent="emerald" />
          <MetricCard
            title="Avg. spread"
            value={fmtPct(avgSpread)}
            icon={ArrowUpDown}
            accent={avgSpread >= 0 ? "emerald" : "red"}
          />
          <MetricCard title="Total volume" value={fmt(totalVolume)} icon={Box} accent="indigo" />
          <MetricCard
            title="Data status"
            value={loading ? "Scanning…" : lastUpdated ? "Up to Date" : "Ready"}
            sub={`FX CNY→USD: ${fx.toFixed(2)}`}
            icon={RefreshCw}
            accent="violet"
          />
        </div>

        {/* SEARCH + CONTROLS */}
        <div className="flex flex-col md:flex-row gap-3 items-center mb-4">
          <div className="flex-1 w-full relative">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search skin name (e.g. Redline)…"
              className="w-full bg-slate-900/70 border border-slate-800 rounded-xl pl-9 pr-3 py-2 text-xs focus:outline-none focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500 placeholder:text-slate-500"
            />
          </div>

          <button
            type="button"
            onClick={() => setOnlyProfitable((v) => !v)}
            className={`flex items-center gap-2 px-3 py-2 rounded-xl border text-xs transition-colors ${
              onlyProfitable
                ? "bg-emerald-500/10 border-emerald-500/40 text-emerald-300"
                : "bg-slate-900/70 border-slate-800 text-slate-300 hover:border-indigo-500 hover:text-indigo-300"
            }`}
          >
            <Filter size={14} />
            Only profitable{onlyProfitable ? " ✓" : ""}
          </button>

          <div className="flex items-center gap-2">
            <input
              type="number"
              min={1}
              max={50}
              value={limit}
              onChange={(e) => setLimit(Math.max(1, Math.min(50, Number(e.target.value) || 1)))}
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

        {/* PRICE FILTER ROW */}
        <div className="flex flex-col md:flex-row gap-3 items-center mb-4">
          <span className="text-xs text-slate-400 whitespace-nowrap">Buff price (USD)</span>
          <div className="flex items-center gap-2 w-full md:w-auto">
            <div className="relative flex-1 md:flex-none md:w-32">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 text-xs">$</span>
              <input
                type="number"
                min={0}
                step={0.01}
                value={priceMin}
                onChange={(e) => setPriceMin(e.target.value)}
                placeholder="Min"
                className="w-full bg-slate-900/70 border border-slate-800 rounded-xl pl-6 pr-3 py-2 text-xs focus:outline-none focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500 placeholder:text-slate-600"
              />
            </div>
            <span className="text-slate-600 text-xs">–</span>
            <div className="relative flex-1 md:flex-none md:w-32">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 text-xs">$</span>
              <input
                type="number"
                min={0}
                step={0.01}
                value={priceMax}
                onChange={(e) => setPriceMax(e.target.value)}
                placeholder="Max"
                className="w-full bg-slate-900/70 border border-slate-800 rounded-xl pl-6 pr-3 py-2 text-xs focus:outline-none focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500 placeholder:text-slate-600"
              />
            </div>
            {(priceMin !== "" || priceMax !== "") && (
              <button
                type="button"
                onClick={() => { setPriceMin(""); setPriceMax(""); }}
                className="text-xs text-slate-500 hover:text-slate-300 transition-colors px-2 py-1 rounded-lg hover:bg-slate-800"
              >
                Clear
              </button>
            )}
          </div>
        </div>

        {/* ERROR BANNER */}
        {error && (
          <div className="mb-4 rounded-xl border border-red-500/40 bg-red-500/10 text-xs text-red-300 px-4 py-2.5">
            Scan failed: {error}
          </div>
        )}

        {/* TABLE */}
        <div className="bg-slate-900/60 border border-slate-800/80 rounded-2xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="min-w-full text-xs">
              <thead className="bg-slate-900/80 border-b border-slate-800/80">
                <tr>
                  <th className="px-4 py-3 text-left font-medium text-slate-400 text-[11px]">Item</th>
                  <SortHeader label="Buff price" sortKey="buffPriceUsd" sortConfig={sortConfig} onSort={handleSort} />
                  <SortHeader label="WM buy order" sortKey="wmBuyOrderUsd" sortConfig={sortConfig} onSort={handleSort} />
                  <SortHeader label="Spread" sortKey="spreadPct" sortConfig={sortConfig} onSort={handleSort} />
                  <SortHeader label="Profit" sortKey="profitUsd" sortConfig={sortConfig} onSort={handleSort} />
                  <SortHeader label="Qty" sortKey="buffQuantity" sortConfig={sortConfig} onSort={handleSort} align="center" />
                  <th className="px-4 py-3 text-center font-medium text-slate-400 text-[11px]">Links</th>
                </tr>
              </thead>
              <tbody>
                {!loading && visible.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-4 py-10 text-center text-slate-500 text-xs">
                      {items.length === 0 ? 'No items found. Click "Scan".' : "No items match your filter."}
                    </td>
                  </tr>
                )}

                {visible.map((item) => {
                  const profit = Number(item.profitUsd) || 0;
                  const spread = Number(item.spreadPct) || 0;
                  const isPositive = profit > 0;

                  return (
                    <tr key={item.id} className="border-t border-slate-800/60 hover:bg-slate-800/30 transition-colors">
                      {/* ITEM */}
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-3">
                          <div className="w-10 h-10 rounded-lg bg-slate-800/80 overflow-hidden flex items-center justify-center flex-shrink-0">
                            {item.image ? (
                              <img src={item.image} alt={item.name} className="w-full h-full object-cover" />
                            ) : (
                              <Box size={16} className="text-slate-600" />
                            )}
                          </div>
                          <span className="text-[11px] font-medium leading-snug">{item.name}</span>
                        </div>
                      </td>

                      {/* BUFF PRICE */}
                      <td className="px-4 py-3 text-right text-[11px]">
                        <div className="flex flex-col items-end">
                          <span className="font-medium">{fmt(item.buffPriceUsd)}</span>
                          <span className="text-slate-500 text-[10px]">¥{Number(item.buffPriceCny || 0).toFixed(2)}</span>
                        </div>
                      </td>

                      {/* WM BUY ORDER */}
                      <td className="px-4 py-3 text-right text-[11px]">
                        <div className="flex flex-col items-end">
                          <span className="font-medium">{item.wmBuyOrderUsd > 0 ? fmt(item.wmBuyOrderUsd) : <span className="text-slate-600">—</span>}</span>
                          <span className="text-slate-500 text-[10px]">{item.wmOrderCount || 0} orders</span>
                        </div>
                      </td>

                      {/* SPREAD */}
                      <td className="px-4 py-3 text-right text-[11px]">
                        <span
                          className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium ${
                            isPositive ? "text-emerald-400 bg-emerald-500/10" : "text-red-400 bg-red-500/10"
                          }`}
                        >
                          {isPositive ? "+" : ""}{fmtPct(spread)}
                        </span>
                      </td>

                      {/* PROFIT */}
                      <td className="px-4 py-3 text-right text-[11px] font-semibold">
                        <span className={isPositive ? "text-emerald-400" : "text-red-400"}>
                          {isPositive ? "+" : ""}{fmt(profit)}
                        </span>
                      </td>

                      {/* QUANTITY */}
                      <td className="px-4 py-3 text-center text-[11px] text-slate-300">
                        {item.buffQuantity || "—"}
                      </td>

                      {/* LINKS */}
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-center gap-2">
                          <a
                            href={`https://buff.163.com/market/csgo?search=${encodeURIComponent(item.name)}`}
                            target="_blank"
                            rel="noreferrer"
                            title="Open on Buff163"
                            className="inline-flex items-center justify-center w-7 h-7 rounded-lg bg-slate-800 border border-slate-700 text-slate-400 hover:border-indigo-500 hover:text-indigo-400 transition-colors"
                          >
                            <ExternalLink size={13} />
                          </a>
                          <a
                            href={`https://white.market/csgo/search?search=${encodeURIComponent(item.name)}`}
                            target="_blank"
                            rel="noreferrer"
                            title="Open on White.Market"
                            className="inline-flex items-center justify-center w-7 h-7 rounded-lg bg-slate-800 border border-slate-700 text-slate-400 hover:border-emerald-500 hover:text-emerald-400 transition-colors"
                          >
                            <ExternalLink size={13} />
                          </a>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* FOOTER */}
          <div className="px-4 py-2 border-t border-slate-800/80 text-[10px] text-slate-500 flex items-center justify-between">
            <span>Showing {visible.length} result{visible.length !== 1 ? "s" : ""}</span>
            <span>Last updated: {lastUpdated ? lastUpdated.toLocaleTimeString() : "—"}</span>
          </div>
        </div>
      </div>
    </div>
  );
};

export default App;
