import React, { useState, useMemo, useEffect } from "react";
import {
  Search, ArrowUpDown, TrendingUp, DollarSign, Box, RefreshCw, Filter, ExternalLink
} from "lucide-react";

// Mock data placeholder (the real data comes from Netlify function)
const MOCK_DATA = [];

const App = () => {
  const [items, setItems] = useState(MOCK_DATA);
  const [expandedId, setExpandedId] = useState(null);
  const [fx, setFx] = useState(0.14);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [sortConfig, setSortConfig] = useState({ key: "profitPct", direction: "desc" });
  const [limit, setLimit] = useState(30);

  // Fetch data from Netlify Function
  const fetchData = async () => {
    setLoading(true);
    setExpandedId(null);
    setError("");
    try {
      const res = await fetch(`/.netlify/functions/scan?limit=${limit}`);
      const json = await res.json();
      if (!json.ok) throw new Error(json.error || "Scan failed");
      setItems(json.items || []);
      setFx(json.fx || fx);
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    // optional: auto load once
    // fetchData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Compute metrics + filtering + sorting
  const processedData = useMemo(() => {
    const q = query.trim().toLowerCase();

    const filtered = items.filter((item) => {
      if (!q) return true;
      return (item.name || "").toLowerCase().includes(q);
    });

    const mapped = filtered.map((item) => {
      // BUFF is CNY, MarketCSGO buy order is USD
      const buffCny = Number(item.buffPrice || 0);
      const wmUsd = Number(item.wmPrice || 0);

      const buffUsd = buffCny * fx;

      const net = wmUsd - buffUsd;
      const profitPct = buffUsd > 0 ? (net / buffUsd) * 100 : -100;
      const spread = profitPct;

      return {
        ...item,
        buffUsd,
        net,
        profitPct,
        spread,
      };
    });

    const sorted = [...mapped].sort((a, b) => {
      const { key, direction } = sortConfig;
      const av = a[key] ?? 0;
      const bv = b[key] ?? 0;
      const cmp = av > bv ? 1 : av < bv ? -1 : 0;
      return direction === "asc" ? cmp : -cmp;
    });

    return sorted;
  }, [items, fx, query, sortConfig]);

  const stats = useMemo(() => {
    const profitable = processedData.filter((x) => x.net > 0);
    const avgSpread =
      processedData.length > 0
        ? processedData.reduce((sum, x) => sum + (x.spread || 0), 0) / processedData.length
        : 0;

    const totalVolume = processedData.reduce((sum, x) => sum + Number(x.quantity || 0), 0);

    return {
      profitableCount: profitable.length,
      avgSpread,
      totalVolume,
    };
  }, [processedData]);

  const requestSort = (key) => {
    setSortConfig((prev) => {
      if (prev.key === key) {
        return { key, direction: prev.direction === "asc" ? "desc" : "asc" };
      }
      return { key, direction: "desc" };
    });
  };

  return (
    <div className="min-h-screen bg-[#0b0c10] text-white">
      <header className="sticky top-0 z-10 bg-[#0b0c10]/90 backdrop-blur border-b border-gray-800">
        <div className="max-w-6xl mx-auto px-4 py-4 flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold tracking-tight flex items-center gap-2">
              <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-600/20 text-indigo-400">
                <TrendingUp size={18} />
              </span>
              ArbitrageScanner
            </h1>
            <p className="text-xs text-gray-400 mt-1">Buff163 to MarketCSGO</p>
          </div>

          <div className="flex items-center gap-3 text-xs text-gray-400">
            <div className="flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-green-500"></span>
              Buff163 API: Server-side
            </div>
            <div className="flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-green-500"></span>
              MarketCSGO API: Server-side
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-6">
        {/* Stats */}
        <div className="grid grid-cols-1 sm:grid-cols-4 gap-4 mb-6">
          <StatCard
            label="Profitable flips"
            value={stats.profitableCount}
            icon={<TrendingUp size={18} />}
            color="text-green-400"
          />
          <StatCard
            label="Avg. spread"
            value={`${stats.avgSpread.toFixed(2)}%`}
            icon={<DollarSign size={18} />}
            color={stats.avgSpread >= 0 ? "text-green-400" : "text-red-400"}
          />
          <StatCard
            label="Total volume"
            value={stats.totalVolume}
            icon={<Box size={18} />}
            color="text-indigo-400"
          />
          <StatCard
            label="Data status"
            value={loading ? "Scanning..." : "Up to Date"}
            icon={<RefreshCw size={18} className={loading ? "animate-spin" : ""} />}
            color="text-purple-400"
          />
        </div>

        {/* Controls */}
        <div className="flex flex-col sm:flex-row gap-3 sm:items-center sm:justify-between mb-4">
          <div className="flex-1 relative">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search skin name (e.g. Redline)..."
              className="w-full pl-10 pr-3 py-2 rounded-xl bg-[#151619] border border-gray-800 text-sm placeholder:text-gray-600 focus:outline-none focus:ring-2 focus:ring-indigo-600/40"
            />
          </div>

          <div className="flex items-center gap-2">
            <button
              className="px-3 py-2 rounded-xl bg-[#151619] border border-gray-800 text-sm text-gray-300 hover:bg-[#202124] inline-flex items-center gap-2"
              onClick={() => {}}
              title="(placeholder) Advanced filters"
            >
              <Filter size={16} />
              Advanced Filters
            </button>

            <input
              type="number"
              value={limit}
              min={1}
              max={100}
              onChange={(e) => setLimit(Number(e.target.value || 30))}
              className="w-20 px-3 py-2 rounded-xl bg-[#151619] border border-gray-800 text-sm text-gray-200 focus:outline-none"
              title="Scan limit"
            />

            <button
              onClick={fetchData}
              disabled={loading}
              className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-sm font-semibold inline-flex items-center gap-2"
            >
              {loading ? <RefreshCw size={16} className="animate-spin" /> : null}
              Scan
            </button>
          </div>
        </div>

        {error ? (
          <div className="mb-4 rounded-xl border border-red-900/50 bg-red-900/20 px-4 py-3 text-sm text-red-200">
            {error}
          </div>
        ) : null}

        {/* Table */}
        <div className="bg-[#151619] border border-gray-800 rounded-2xl overflow-hidden shadow-lg">
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-800">
              <thead className="bg-[#111214]">
                <tr>
                  <Th label="Item Details" sortKey="name" onClick={() => requestSort("name")} sortConfig={sortConfig} />
                  <Th label="BUFF163 Price" sortKey="buffUsd" onClick={() => requestSort("buffUsd")} sortConfig={sortConfig} align="right" />
                  <Th label="MCSGO Buy Order" sortKey="wmPrice" onClick={() => requestSort("wmPrice")} sortConfig={sortConfig} align="right" />
                  <Th label="Spread" sortKey="profitPct" onClick={() => requestSort("profitPct")} sortConfig={sortConfig} align="center" />
                  <Th label="Net Profit" sortKey="net" onClick={() => requestSort("net")} sortConfig={sortConfig} align="right" />
                  <Th label="Quantity" sortKey="quantity" onClick={() => requestSort("quantity")} sortConfig={sortConfig} align="center" />
                  <th scope="col" className="px-6 py-4 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Actions
                  </th>
                </tr>
              </thead>

              <tbody className="divide-y divide-gray-800">
                {processedData.length ? (
                  processedData.map((item) => (
                    <React.Fragment key={item.id}>
                      <tr
                        key={item.id}
                        onClick={() => setExpandedId(expandedId === item.id ? null : item.id)}
                        className="hover:bg-[#202124] transition-colors group cursor-pointer"
                      >
                        <td className="px-6 py-4 whitespace-nowrap">
                          <div className="flex items-center">
                            <div className="flex-shrink-0 h-12 w-12 bg-[#25262b] rounded-lg overflow-hidden mr-4 border border-gray-700 group-hover:border-indigo-500 transition-colors">
                              <img src={item.image} alt="" className="h-full w-full object-contain p-1" />
                            </div>
                            <div>
                              <div className="text-sm font-medium text-white group-hover:text-indigo-400 transition-colors">{item.name}</div>
                              <div className="text-xs text-gray-500 mt-0.5">{item.wear || "-"}</div>
                              {item.error ? (
                                <div className="text-xs text-amber-400 mt-1">API: {item.error}</div>
                              ) : null}
                            </div>
                          </div>
                        </td>

                        <td className="px-6 py-4 whitespace-nowrap text-right">
                          <div className="text-sm font-medium text-white">¥{Number(item.buffPrice).toFixed(2)}</div>
                          <div className="text-xs text-gray-500">${Number(item.buffUsd).toFixed(2)}</div>
                        </td>

                        <td className="px-6 py-4 whitespace-nowrap text-right">
                          <div className="text-sm font-medium text-white">${Number(item.wmPrice).toFixed(2)}</div>
                          <div className="text-xs text-gray-500">{item.wmBuyQty || 0} orders</div>
                        </td>

                        <td className="px-6 py-4 whitespace-nowrap text-center">
                          <span
                            className={`px-3 py-1 inline-flex text-xs leading-5 font-semibold rounded-full ${
                              item.profitPct > 0
                                ? "bg-green-900/30 text-green-400 border border-green-800"
                                : "bg-red-900/30 text-red-400 border border-red-800"
                            }`}
                          >
                            {item.profitPct.toFixed(2)}%
                          </span>
                        </td>

                        <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                          <span className={item.net > 0 ? "text-green-400" : "text-red-400"}>
                            {item.net > 0 ? "+" : ""}${item.net.toFixed(2)}
                          </span>
                        </td>

                        <td className="px-6 py-4 whitespace-nowrap text-center">
                          <div className="text-sm text-gray-300">{item.quantity}</div>
                          <div className="w-full bg-gray-800 rounded-full h-1.5 mt-1">
                            <div
                              className="bg-indigo-500 h-1.5 rounded-full"
                              style={{ width: `${Math.min(100, (item.quantity / 1000) * 100)}%` }}
                            ></div>
                          </div>
                        </td>

                        <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                          <a
                            href={item.wmUrl || "https://market.csgo.com/en/"}
                            target="_blank"
                            rel="noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            className="text-indigo-400 hover:text-indigo-300 bg-indigo-900/20 p-2 rounded-lg hover:bg-indigo-900/40 transition-colors inline-flex"
                          >
                            <ExternalLink size={16} />
                          </a>
                        </td>
                      </tr>

                      {expandedId === item.id && (
                        <tr className="bg-[#17181b]">
                          <td colSpan={7} className="px-6 py-4">
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                              <div className="bg-[#141517] border border-gray-800 rounded-xl p-4">
                                <div className="text-sm font-semibold text-white mb-2">BUFF lowest 5 listings</div>
                                {Array.isArray(item.buffListings) && item.buffListings.length > 0 ? (
                                  <div className="space-y-1 text-sm text-gray-300">
                                    {item.buffListings.slice(0, 5).map((l, idx) => (
                                      <div key={idx} className="flex items-center justify-between">
                                        <span className="text-gray-400">#{idx + 1}</span>
                                        <span className="font-medium">¥{Number(l.priceCny || 0).toFixed(2)}</span>
                                        <span className="text-gray-400">
                                          float: {l.float == null ? "-" : Number(l.float).toFixed(6)}
                                        </span>
                                      </div>
                                    ))}
                                  </div>
                                ) : (
                                  <div className="text-sm text-gray-500">No float listings returned.</div>
                                )}
                              </div>

                              <div className="bg-[#141517] border border-gray-800 rounded-xl p-4">
                                <div className="text-sm font-semibold text-white mb-2">MarketCSGO buy order</div>
                                <div className="text-sm text-gray-300">
                                  <div className="flex items-center justify-between">
                                    <span className="text-gray-400">Best buy order</span>
                                    <span className="font-semibold text-white">
                                      ${Number(item.wmPrice || 0).toFixed(2)}
                                    </span>
                                  </div>
                                  <div className="flex items-center justify-between mt-2">
                                    <span className="text-gray-400">Avg price (if available)</span>
                                    <span className="text-gray-300">
                                      {item.wmMeta?.avgUsd == null ? "-" : `$${Number(item.wmMeta.avgUsd).toFixed(2)}`}
                                    </span>
                                  </div>
                                  {item.error ? (
                                    <div className="mt-3 text-xs text-amber-400">API note: {item.error}</div>
                                  ) : null}
                                </div>
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  ))
                ) : (
                  <tr>
                    <td colSpan="7" className="px-6 py-12 text-center text-gray-500">
                      <div className="flex flex-col items-center justify-center">
                        <Search size={48} className="text-gray-700 mb-4" />
                        <p className="text-lg font-medium">No items found</p>
                        <p className="text-sm">Try adjusting your search terms</p>
                      </div>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="bg-[#151619] px-4 py-3 border-t border-gray-800 flex items-center justify-between sm:px-6">
            <div className="hidden sm:flex-1 sm:flex sm:items-center sm:justify-between">
              <div>
                <p className="text-sm text-gray-500">
                  Showing <span className="font-medium text-gray-300">1</span> to{" "}
                  <span className="font-medium text-gray-300">{processedData.length}</span> of{" "}
                  <span className="font-medium text-gray-300">{items.length}</span> results
                </p>
              </div>
              <div>
                <nav className="relative z-0 inline-flex rounded-md shadow-sm -space-x-px" aria-label="Pagination">
                  <button className="relative inline-flex items-center px-2 py-2 rounded-l-md border border-gray-700 bg-[#1a1b1e] text-sm font-medium text-gray-400 hover:bg-[#25262b]">
                    Previous
                  </button>
                  <button className="relative inline-flex items-center px-4 py-2 border border-gray-700 bg-[#25262b] text-sm font-medium text-white">
                    1
                  </button>
                  <button className="relative inline-flex items-center px-4 py-2 border border-gray-700 bg-[#1a1b1e] text-sm font-medium text-gray-400 hover:bg-[#25262b]">
                    2
                  </button>
                  <button className="relative inline-flex items-center px-4 py-2 border border-gray-700 bg-[#1a1b1e] text-sm font-medium text-gray-400 hover:bg-[#25262b]">
                    3
                  </button>
                  <button className="relative inline-flex items-center px-2 py-2 rounded-r-md border border-gray-700 bg-[#1a1b1e] text-sm font-medium text-gray-400 hover:bg-[#25262b]">
                    Next
                  </button>
                </nav>
              </div>
            </div>
          </div>

        </div>
      </main>
    </div>
  );
};

// Sub-components
const StatCard = ({ label, value, icon, color }) => (
  <div className="bg-[#1a1b1e] p-4 rounded-xl border border-gray-800 flex items-center justify-between hover:border-gray-700 transition-colors">
    <div>
      <p className="text-gray-500 text-xs font-medium uppercase tracking-wider">{label}</p>
      <p className={`text-2xl font-bold mt-1 ${color ? color : "text-white"}`}>{value}</p>
    </div>
    <div className={`p-3 rounded-lg bg-opacity-10 ${color ? color.replace("text-", "bg-") : "bg-gray-700"} ${color}`}>
      {icon}
    </div>
  </div>
);

const Th = ({ label, sortKey, onClick, sortConfig, align = "left" }) => {
  const isActive = sortConfig.key === sortKey;

  return (
    <th
      scope="col"
      className={`px-6 py-4 text-${align} text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer hover:text-indigo-400 transition-colors select-none group`}
      onClick={onClick}
    >
      <div className={`flex items-center gap-2 ${align === "right" ? "justify-end" : align === "center" ? "justify-center" : "justify-start"}`}>
        {label}
        <span className={`transform transition-opacity ${isActive ? "opacity-100" : "opacity-0 group-hover:opacity-50"}`}>
          <ArrowUpDown size={14} className={isActive && sortConfig.direction === "asc" ? "transform rotate-180" : ""} />
        </span>
      </div>
    </th>
  );
};

export default App;
