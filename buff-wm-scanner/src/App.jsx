import React, { useState, useEffect, useMemo } from "react";
import { Search, ArrowUpDown, TrendingUp, Box, RefreshCw, Filter, ExternalLink } from "lucide-react";

// fallback while backend is empty
const MOCK_DATA = [
  { id: 1, name: "AK-47 | Redline", wear: "Field-Tested", image: "https://community.cloudflare.steamstatic.com/economy/image/-9a81dlWLwJ2UUGcVs_nsVtzdOEdtWwKGZZLQHTxDZ7I56KU0Zwwo4NUX4oFJZEHLbXH5ApeO4YmlhxYQknCRvCo04DEVlxkKgpot7HxfDhjxszJemkV09-5lpKKqPrxN7LEmyVQ7MEpiLuSrYmnjQO3-UdsZGrwIdKQegA4N1iF_gDQyL3n1sS56M_LznygnXP-n1DwJzs", buffPrice: 14.5, wmPrice: 18.2, quantity: 124, fx: 0.14 },
  { id: 2, name: "AWP | Asiimov", wear: "Battle-Scarred", image: "https://community.cloudflare.steamstatic.com/economy/image/-9a81dlWLwJ2UUGcVs_nsVtzdOEdtWwKGZZLQHTxDZ7I56KU0Zwwo4NUX4oFJZEHLbXH5ApeO4YmlhxYQknCRvCo04DEVlxkKgpot621FAR17PLfYQJD_9W7m5a0mvLwOq7c2DlQsZ0kJ-vF846i2gK3-RZsY270LdTHI1Q5YlzR-FfsxLzmh569vMvAyHZnuiRz4XmJl0es1x1McKUx0v-N3b0d", buffPrice: 98, wmPrice: 105.5, quantity: 12, fx: 0.14 }
];

const App = () => {
  const [searchTerm, setSearchTerm] = useState("");
  const [sortConfig, setSortConfig] = useState({ key: "spread", direction: "desc" });
  const [loading, setLoading] = useState(false);
  const [items, setItems] = useState(MOCK_DATA);

  const fetchData = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/.netlify/functions/scan?limit=30`);
      const data = await res.json();
      if (data?.ok) setItems(data.items || []);
    } catch (e) {
      // keep current items
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Metrics (IMPORTANT): BUFF is CNY, WM is USD.
  // We compute profit/spread using BUFF converted to USD via item.fx (defaults 0.14).
  const calculateMetrics = (item) => {
    const fx = Number(item.fx ?? 0.14);
    const buffUsd = Number(item.buffUsd ?? (Number(item.buffPrice) * fx));
    const wmUsd = Number(item.wmPrice);

    const profit = wmUsd - buffUsd;
    const spread = buffUsd > 0 ? ((wmUsd - buffUsd) / buffUsd) * 100 : 0;

    return { ...item, profit, spread, buffUsd };
  };

  const processedData = useMemo(() => {
    let data = items.map(calculateMetrics);

    if (searchTerm) {
      const lowerTerm = searchTerm.toLowerCase();
      data = data.filter(
        (item) =>
          String(item.name).toLowerCase().includes(lowerTerm) ||
          String(item.wear).toLowerCase().includes(lowerTerm)
      );
    }

    if (sortConfig.key) {
      data.sort((a, b) => {
        if (a[sortConfig.key] < b[sortConfig.key]) return sortConfig.direction === "asc" ? -1 : 1;
        if (a[sortConfig.key] > b[sortConfig.key]) return sortConfig.direction === "asc" ? 1 : -1;
        return 0;
      });
    }

    return data;
  }, [items, searchTerm, sortConfig]);

  const handleSort = (key) => {
    let direction = "desc";
    if (sortConfig.key === key && sortConfig.direction === "desc") direction = "asc";
    setSortConfig({ key, direction });
  };

  const refreshData = async () => {
    await fetchData();
  };

  return (
    <div className="min-h-screen bg-[#121212] text-gray-200 font-sans selection:bg-indigo-500 selection:text-white">
      {/* Navbar */}
      <nav className="border-b border-gray-800 bg-[#1a1b1e] sticky top-0 z-10 shadow-lg">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-16">
            <div className="flex items-center gap-3">
              <div className="bg-indigo-600 p-2 rounded-lg">
                <TrendingUp size={20} className="text-white" />
              </div>
              <div>
                <h1 className="text-xl font-bold text-white tracking-tight">
                  Arbitrage<span className="text-indigo-400">Scanner</span>
                </h1>
                <p className="text-xs text-gray-500">Buff163 to WhiteMarket</p>
              </div>
            </div>

            <div className="hidden md:flex items-center gap-6 text-sm text-gray-400">
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 bg-green-500 rounded-full animate-pulse"></span>
                Buff163: Server-side
              </div>
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 bg-green-500 rounded-full animate-pulse"></span>
                WhiteMarket: Server-side
              </div>
            </div>
          </div>
        </div>
      </nav>

      {/* Main */}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Stats */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
          <StatCard
            label="Profitable Flips"
            value={processedData.filter((i) => i.profit > 0).length}
            icon={<TrendingUp size={18} />}
            variant="green"
          />
          <StatCard
            label="Avg. Spread"
            value={`${(
              processedData.reduce((acc, curr) => acc + curr.spread, 0) / (processedData.length || 1)
            ).toFixed(2)}%`}
            icon={<Box size={18} />}
            variant="blue"
          />
          <StatCard
            label="Total Volume"
            value={processedData.reduce((acc, curr) => acc + (Number(curr.quantity) || 0), 0)}
            icon={<Filter size={18} />}
            variant="purple"
          />
          <div
            className="bg-[#1a1b1e] p-4 rounded-xl border border-gray-800 flex items-center justify-between hover:border-gray-700 transition-colors cursor-pointer group"
            onClick={refreshData}
          >
            <div>
              <p className="text-gray-500 text-xs font-medium uppercase tracking-wider">Data Status</p>
              <p className="text-xl font-bold text-white mt-1 group-hover:text-indigo-400 transition-colors">
                {loading ? "Updating..." : "Up to Date"}
              </p>
            </div>
            <RefreshCw size={24} className={`text-gray-500 group-hover:text-indigo-400 transition-all ${loading ? "animate-spin" : ""}`} />
          </div>
        </div>

        {/* Filters */}
        <div className="flex flex-col sm:flex-row gap-4 mb-6">
          <div className="relative flex-grow">
            <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
              <Search size={18} className="text-gray-500" />
            </div>
            <input
              type="text"
              className="block w-full pl-10 pr-3 py-3 border border-gray-800 rounded-xl leading-5 bg-[#1a1b1e] text-gray-300 placeholder-gray-500 focus:outline-none focus:bg-[#202124] focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 sm:text-sm transition-all shadow-sm"
              placeholder="Search skin name (e.g. Redline)..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
          </div>
          <button className="flex items-center justify-center gap-2 px-6 py-3 border border-gray-800 text-sm font-medium rounded-xl text-gray-300 bg-[#1a1b1e] hover:bg-[#25262b] focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 focus:ring-offset-[#121212] transition-colors">
            <Filter size={18} />
            Advanced Filters
          </button>
        </div>

        {/* Table */}
        <div className="bg-[#1a1b1e] rounded-xl border border-gray-800 shadow-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-800">
              <thead className="bg-[#151619]">
                <tr>
                  <Th label="Item Details" align="left" onClick={() => handleSort("name")} />
                  <Th label="Buff163 Price" align="right" onClick={() => handleSort("buffPrice")} />
                  <Th label="WM Buy Order" align="right" onClick={() => handleSort("wmPrice")} />
                  <Th label="Spread" align="right" onClick={() => handleSort("spread")} />
                  <Th label="Net Profit" align="right" onClick={() => handleSort("profit")} />
                  <Th label="Quantity" align="center" onClick={() => handleSort("quantity")} />
                  <th className="px-6 py-4 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Actions</th>
                </tr>
              </thead>

              <tbody className="divide-y divide-gray-800">
                {processedData.length > 0 ? (
                  processedData.map((item) => (
                    <tr key={item.id} className="hover:bg-[#202124] transition-colors group">
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="flex items-center">
                          <div className="flex-shrink-0 h-12 w-16 relative bg-gray-800 rounded-md flex items-center justify-center overflow-hidden border border-gray-700">
                            <img className="h-full object-contain transform group-hover:scale-110 transition-transform duration-300" src={item.image} alt="" />
                          </div>
                          <div className="ml-4">
                            <div className="text-sm font-medium text-white">{item.name}</div>
                            <div className="text-xs text-gray-500 flex items-center gap-2">{item.wear}</div>
                          </div>
                        </div>
                      </td>

                      <td className="px-6 py-4 whitespace-nowrap text-right">
                        <div className="flex items-center justify-end text-sm text-gray-300 font-mono">
                          <span className="text-xs text-gray-600 mr-1">¥</span>
                          {Number(item.buffPrice || 0).toFixed(2)}
                        </div>
                        <div className="text-[10px] text-gray-500">Listing</div>
                      </td>

                      <td className="px-6 py-4 whitespace-nowrap text-right">
                        <div className="flex items-center justify-end text-sm text-gray-300 font-mono">
                          <span className="text-xs text-gray-600 mr-1">$</span>
                          {Number(item.wmPrice || 0).toFixed(2)}
                        </div>
                        <div className="text-[10px] text-gray-500">Buy Order</div>
                      </td>

                      <td className="px-6 py-4 whitespace-nowrap text-right">
                        <span
                          className={`px-2 py-1 inline-flex text-xs leading-5 font-semibold rounded-md ${
                            item.spread > 0
                              ? "bg-green-900/30 text-green-400 border border-green-900"
                              : "bg-red-900/30 text-red-400 border border-red-900"
                          }`}
                        >
                          {item.spread > 0 ? "+" : ""}
                          {Number(item.spread || 0).toFixed(2)}%
                        </span>
                      </td>

                      <td className="px-6 py-4 whitespace-nowrap text-right">
                        <div className={`text-sm font-mono font-bold ${item.profit > 0 ? "text-green-400" : "text-red-400"}`}>
                          ${Number(item.profit || 0).toFixed(2)}
                        </div>
                      </td>

                      <td className="px-6 py-4 whitespace-nowrap text-center">
                        <div className="text-sm text-gray-300">{Number(item.quantity || 0)}</div>
                        <div className="w-full bg-gray-800 rounded-full h-1 mt-1">
                          <div className="bg-indigo-500 h-1 rounded-full" style={{ width: `${Math.min(Number(item.quantity || 0) * 2, 100)}%` }}></div>
                        </div>
                      </td>

                      <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                        <a
                          href={item.wmUrl || "#"}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex text-indigo-400 hover:text-indigo-300 bg-indigo-900/20 p-2 rounded-lg hover:bg-indigo-900/40 transition-colors"
                          title="Open on White.Market"
                        >
                          <ExternalLink size={16} />
                        </a>
                      </td>
                    </tr>
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

          {/* Footer */}
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

// --- Components ---
const StatCard = ({ label, value, icon, variant = "green" }) => {
  const variants = {
    green: { text: "text-green-400", bg: "bg-green-900/20" },
    blue: { text: "text-blue-400", bg: "bg-blue-900/20" },
    purple: { text: "text-purple-400", bg: "bg-purple-900/20" }
  };
  const v = variants[variant] || variants.green;

  return (
    <div className="bg-[#1a1b1e] p-4 rounded-xl border border-gray-800 flex items-center justify-between hover:border-gray-700 transition-colors">
      <div>
        <p className="text-gray-500 text-xs font-medium uppercase tracking-wider">{label}</p>
        <p className={`text-2xl font-bold mt-1 ${v.text}`}>{value}</p>
      </div>
      <div className={`p-3 rounded-lg ${v.bg} ${v.text}`}>{icon}</div>
    </div>
  );
};

const Th = ({ label, onClick, align = "left" }) => {
  const alignClass = align === "right" ? "text-right" : align === "center" ? "text-center" : "text-left";
  const justifyClass = align === "right" ? "justify-end" : align === "center" ? "justify-center" : "justify-start";

  return (
    <th
      scope="col"
      className={`px-6 py-4 ${alignClass} text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer hover:text-indigo-400 transition-colors select-none group`}
      onClick={onClick}
    >
      <div className={`flex items-center gap-2 ${justifyClass}`}>
        {label}
        <span className="opacity-50">
          <ArrowUpDown size={14} />
        </span>
      </div>
    </th>
  );
};

export default App;

