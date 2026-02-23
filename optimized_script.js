// ==UserScript==
// @name         灵客API日志看板-V10(旗舰增强版)
// @namespace    http://tampermonkey.net/
// @version      10.0
// @description  适配新版UI，支持录制选区自动跟随、Y轴对数切换、多维平均指标、自动查询、分组/类型筛选
// @author       Jules
// @match        https://lingkeapi.com/console/log*
// @grant        none
// @require      https://cdn.jsdelivr.net/npm/echarts@5.4.3/dist/echarts.min.js
// ==/UserScript==

(function() {
    'use strict';

    // --- 核心变量 ---
    let chartInstance = null;
    let allStoredData = [];
    let isCrawling = false;
    let autoMonitorTimer = null;
    let isRecording = false;
    let recordingStartTime = 0;

    // --- 配色方案 ---
    const THEME = {
        night: 'rgba(100, 100, 250, 0.04)',
        morning: 'rgba(255, 250, 200, 0.12)',
        afternoon: 'rgba(255, 180, 100, 0.08)',
        evening: 'rgba(150, 100, 250, 0.04)',
        line: '#1890ff'
    };

    // --- 样式注入 ---
    const style = document.createElement('style');
    style.innerHTML = `
        #ai-lab-wrapper { padding-top: 60px; }
        #ai-dashboard-root {
            background: #fff; border: 1px solid #d9d9d9; border-radius: 8px;
            margin: 10px 20px; padding: 15px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.08);
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            position: relative; z-index: 999;
        }
        .dash-row { display: flex; gap: 15px; }
        .dash-header { display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #eee; padding-bottom: 10px; margin-bottom: 10px; }
        .chart-area { flex: 1; height: 460px; min-width: 0; }
        .side-panel { width: 280px; display: flex; flex-direction: column; gap: 10px; flex-shrink: 0; }

        .ctrl-bar { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; background: #f5f5f5; padding: 8px; border-radius: 6px; align-items: center; }
        .u-btn { padding: 4px 10px; font-size: 12px; border: 1px solid #d9d9d9; background: #fff; border-radius: 4px; cursor: pointer; transition: all 0.2s; }
        .u-btn:hover { color: #1890ff; border-color: #1890ff; }
        .btn-primary { background: #1890ff; color: #fff; border: none; }
        .btn-danger { color: #ff4d4f; border-color: #ffccc7; }
        .btn-anim { animation: pulse 2s infinite; }

        .rec-panel { border: 2px solid #ffccc7; background: #fff1f0; padding: 10px; border-radius: 6px; }
        .rec-active { animation: glow 1.5s infinite alternate; border-color: #ff4d4f; }
        .info-card { background: #fafafa; border: 1px solid #f0f0f0; padding: 10px; border-radius: 6px; }

        .stat-row { display: flex; justify-content: space-between; font-size: 12px; color: #555; margin-bottom: 4px; }
        .stat-val { font-weight: bold; font-family: monospace; color: #333; }

        /* 开关样式 */
        .chk-label { font-size: 12px; display: flex; align-items: center; cursor: pointer; user-select: none; margin-left: 5px; }
        .chk-input { margin-right: 4px; }

        @keyframes pulse { 0% { box-shadow: 0 0 0 0 rgba(24,144,255,0.4); } 70% { box-shadow: 0 0 0 6px rgba(24,144,255,0); } 100% { box-shadow: 0 0 0 0 rgba(24,144,255,0); } }
        @keyframes glow { from { box-shadow: 0 0 5px #ffccc7; } to { box-shadow: 0 0 15px #ff4d4f; } }
    `;
    document.head.appendChild(style);

    // --- 强力时间解析 ---
    function parseTimeSafe(str) {
        if (!str) return 0;
        let cleanStr = str.replace(/[^\x00-\x7F]/g, "").trim();
        // 尝试正则 YYYY-MM-DD HH:mm:ss
        const match = cleanStr.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})\s+(\d{1,2}):(\d{1,2}):(\d{1,2})/);
        if (match) {
            return new Date(match[1], match[2]-1, match[3], match[4], match[5], match[6]).getTime();
        }
        // 尝试默认
        const ts = Date.parse(cleanStr);
        return isNaN(ts) ? 0 : ts;
    }

    // --- 数据抓取 ---
    function scrapeData() {
        const rows = document.querySelectorAll('.semi-table-tbody tr');
        if (rows.length === 0) return false;

        let hasNew = false;
        rows.forEach(row => {
            const td = row.querySelectorAll('td');
            if (td.length < 9) return;
            try {
                // 1. 获取时间：优先使用 title 属性，其次 innerText
                const timeStr = td[0].getAttribute('title') || td[0].innerText || "";

                // 2. 获取其他字段
                const group = td[2].innerText || "Default";
                const type = td[3].innerText || "Unknown";
                const model = td[4].innerText || "Unknown";

                // 3. 获取消耗：移除所有非数字和非点字符 (处理 💰 等符号)
                const costText = td[8].innerText || "";
                const cost = parseFloat(costText.replace(/[^0-9.]/g, '')) || 0;

                // 4. Tokens: 提示(idx 6) + 补全(idx 7)
                const tokens = (parseInt(td[6].innerText)||0) + (parseInt(td[7].innerText)||0);

                const ts = parseTimeSafe(timeStr);
                if (ts > 0) {
                    // 5. 生成 ID：优先使用 data-row-key，保证唯一性
                    let id = row.getAttribute('data-row-key');
                    if (!id) {
                        // 降级方案
                        id = `${ts}_${model}_${cost}`;
                    }

                    if (!allStoredData.find(x => x.id === id)) {
                        allStoredData.push({ id, ts, model, cost, tokens, group, type });
                        hasNew = true;
                    }
                }
            } catch(e) {
                console.error("Row parsing error:", e);
            }
        });

        if (hasNew) {
            allStoredData.sort((a, b) => a.ts - b.ts);
            localStorage.setItem('lk_api_logs_v9', JSON.stringify(allStoredData));
            return true;
        }
        return false;
    }

    // --- 自动翻页 ---
    async function startCrawling() {
        const btn = document.getElementById('btn-crawl');
        if (isCrawling) { isCrawling = false; btn.innerText = "📥 抓取历史"; btn.classList.remove('btn-anim'); return; }

        isCrawling = true;
        btn.innerText = "🛑 停止";
        btn.classList.add('btn-anim');
        for (let i = 0; i < 300; i++) { // Max 300 pages
            if (!isCrawling) break;
            scrapeData();
            updateChart();
            // 更新选择器以匹配 li 标签按钮
            const nextBtn = document.querySelector('.semi-page-next:not(.semi-page-disabled)');
            if (!nextBtn) break;
            nextBtn.click();
            await new Promise(r => setTimeout(r, 1200));
        }
        isCrawling = false;
        btn.innerText = "✅ 完成";
        btn.classList.remove('btn-anim');
        setTimeout(() => btn.innerText = "📥 抓取历史", 3000);
    }

    // --- 自动监控 (模拟点击查询) ---
    function toggleMonitor() {
        const btn = document.getElementById('btn-monitor');
        const status = document.getElementById('monitor-status');
        if (autoMonitorTimer) {
            clearInterval(autoMonitorTimer);
            autoMonitorTimer = null;
            btn.innerText = "🚀 自动更新";
            btn.classList.remove('btn-primary', 'btn-anim');
            status.style.display = 'none';
        } else {
            if(!confirm('【重要】请先将网页顶部的结束时间设为“明年”。\n否则无法获取最新一秒的数据！\n\n继续吗？')) return;
            btn.innerText = "🛑 停止";
            btn.classList.add('btn-primary', 'btn-anim');
            status.style.display = 'inline-block';
            clickQuery();
            autoMonitorTimer = setInterval(clickQuery, 8000); // 8秒一次
        }
    }

    function clickQuery() {
        // 查找查询按钮
        let qBtn = Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes('查询') || b.innerText.includes('Search'));
        if (!qBtn) qBtn = document.querySelector('.semi-icon-search')?.closest('button');

        if (qBtn) {
            qBtn.click();
            setTimeout(() => { if(scrapeData()) updateChart(); }, 2000);
        }
    }

    // --- 录制逻辑 ---
    function toggleRecording() {
        isRecording = !isRecording;
        const btn = document.getElementById('btn-rec');
        const panel = document.getElementById('rec-panel');

        if (isRecording) {
            recordingStartTime = Date.now(); // 记录开始时间戳
            btn.innerText = "⏹ 停止录制";
            btn.classList.add('btn-danger');
            panel.classList.add('rec-active');
            // 如果勾选了跟随，立即重置视图
            updateChart();
        } else {
            btn.innerText = "⏺ 开始录制";
            btn.classList.remove('btn-danger');
            panel.classList.remove('rec-active');
        }
    }

    // --- UI 初始化 ---
    function initUI() {
        if (document.getElementById('ai-dashboard-root')) return;

        try {
            const raw = localStorage.getItem('lk_api_logs_v9');
            if (raw) allStoredData = JSON.parse(raw);
        } catch(e) { allStoredData = []; }

        const wrapper = document.createElement('div');
        wrapper.id = 'ai-lab-wrapper';
        wrapper.innerHTML = `
            <div id="ai-dashboard-root">
                <div class="dash-header">
                    <div>
                        <span style="font-size:16px; font-weight:bold;">💎 灵客 API 旗舰看板 V10</span>
                        <span id="monitor-status" style="display:none; color:#52c41a; font-size:12px; margin-left:10px;">● 监控中</span>
                    </div>
                    <div style="font-size:12px; color:#888;">数据点: <span id="data-count">0</span></div>
                </div>

                <div class="ctrl-bar">
                    <button id="btn-monitor" class="u-btn">🚀 自动更新</button>
                    <button id="btn-crawl" class="u-btn">📥 抓取历史</button>

                    <span style="border-left:1px solid #ccc; margin:0 4px; height:15px;"></span>

                    <select id="sel-y-scale" class="u-btn" title="Y轴缩放模式">
                        <option value="value">线性坐标 (Linear)</option>
                        <option value="log">对数坐标 (Log)</option>
                    </select>

                    <select id="sel-precision" class="u-btn">
                        <option value="raw">原始精度</option>
                        <option value="60000">1分钟聚合</option>
                        <option value="3600000" selected>1小时聚合</option>
                    </select>

                    <select id="sel-type-chart" class="u-btn">
                        <option value="bar">分段消耗 (柱)</option>
                        <option value="line">累计消耗 (线)</option>
                    </select>

                    <span style="border-left:1px solid #ccc; margin:0 4px; height:15px;"></span>

                    <select id="sel-group" class="u-btn" style="max-width: 100px;"><option value="all">全部分组</option></select>
                    <select id="sel-type" class="u-btn" style="max-width: 100px;"><option value="all">全部类型</option></select>
                    <select id="sel-model" class="u-btn" style="max-width: 120px;"><option value="all">全部模型</option></select>

                    <button id="btn-clear" class="u-btn btn-danger" style="margin-left:auto;">清空</button>
                </div>

                <div class="dash-row">
                    <div id="main-chart" class="chart-area"></div>
                    <div class="side-panel">
                        <div id="rec-panel" class="rec-panel">
                            <div style="display:flex; justify-content:space-between; margin-bottom:8px;">
                                <b>⏱️ 实时压测录制</b>
                                <button id="btn-rec" class="u-btn">⏺ 开始录制</button>
                            </div>
                            <label class="chk-label" style="margin-bottom:8px;">
                                <input type="checkbox" id="chk-follow" class="chk-input" checked>
                                <span>锁定起点，跟随最新 (实时窗口)</span>
                            </label>
                            <div class="stat-row"><span>录制总额:</span> <span id="r-cost" class="stat-val">$0.00</span></div>
                            <div class="stat-row"><span>平均消耗:</span> <span id="r-avg-cost" class="stat-val">$0.00/m</span></div>
                            <div class="stat-row"><span>平均请求:</span> <span id="r-avg-req" class="stat-val">0.0/m</span></div>
                            <div class="stat-row"><span>单次峰值:</span> <span id="r-peak" class="stat-val">$0.00</span></div>
                        </div>

                        <div class="info-card">
                            <div style="font-size:12px; color:#666;">当前选区 (View)</div>
                            <div id="view-total" class="stat-val" style="font-size:20px; color:#1890ff;">$0.000</div>
                            <div class="stat-row" style="margin-top:5px;"><span>Avg/Hour:</span> <span id="view-avg-h" style="font-weight:bold;">$0.00</span></div>
                            <div id="view-tokens" style="font-size:11px; color:#999;">Tokens: 0</div>
                        </div>
                    </div>
                </div>
            </div>
        `;

        const container = document.querySelector('.semi-layout-content') || document.body;
        container.prepend(wrapper);

        chartInstance = echarts.init(document.getElementById('main-chart'));
        window.addEventListener('resize', () => chartInstance.resize());

        // 绑定事件
        document.getElementById('btn-monitor').onclick = toggleMonitor;
        document.getElementById('btn-crawl').onclick = startCrawling;
        document.getElementById('btn-rec').onclick = toggleRecording;
        document.getElementById('btn-clear').onclick = () => { if(confirm('清空数据?')) { allStoredData=[]; localStorage.removeItem('lk_api_logs_v9'); updateChart(); }};

        ['sel-y-scale', 'sel-precision', 'sel-type-chart', 'sel-model', 'sel-group', 'sel-type'].forEach(id => {
            document.getElementById(id).onchange = updateChart;
        });

        scrapeData();
        updateChart();
    }

    // --- 辅助函数：更新下拉框选项 ---
    function updateSelectOptions(id, data, key) {
        const sel = document.getElementById(id);
        const currentVal = sel.value;
        const options = new Set(data.map(d => d[key]).filter(v => v));

        // 检查是否有新选项
        let hasNew = false;
        options.forEach(opt => {
            let exists = false;
            for(let i=0; i<sel.options.length; i++) {
                if(sel.options[i].value === opt) { exists = true; break; }
            }
            if(!exists) {
                sel.add(new Option(opt, opt));
                hasNew = true;
            }
        });
    }

    // --- 图表渲染 ---
    function updateChart() {
        if (!chartInstance) return;
        document.getElementById('data-count').innerText = allStoredData.length;

        const precisionVal = document.getElementById('sel-precision').value;
        const chartType = document.getElementById('sel-type-chart').value;
        const yScaleType = document.getElementById('sel-y-scale').value; // 'value' or 'log'
        const followRecording = document.getElementById('chk-follow').checked;

        // 过滤器
        const modelFilter = document.getElementById('sel-model').value;
        const groupFilter = document.getElementById('sel-group').value;
        const typeFilter = document.getElementById('sel-type').value;

        // 更新下拉框
        updateSelectOptions('sel-model', allStoredData, 'model');
        updateSelectOptions('sel-group', allStoredData, 'group');
        updateSelectOptions('sel-type', allStoredData, 'type');

        // 应用过滤
        const filtered = allStoredData.filter(d => {
            if (modelFilter !== 'all' && d.model !== modelFilter) return false;
            if (groupFilter !== 'all' && d.group !== groupFilter) return false;
            if (typeFilter !== 'all' && d.type !== typeFilter) return false;
            return true;
        });

        // 聚合数据
        let chartData = [];
        if (precisionVal === 'raw') {
            chartData = filtered.map(d => [d.ts, d.cost]);
        } else {
            const gap = parseInt(precisionVal);
            const buckets = {};
            filtered.forEach(d => {
                const k = Math.floor(d.ts / gap) * gap;
                buckets[k] = (buckets[k] || 0) + d.cost;
            });
            chartData = Object.entries(buckets).map(([ts, val]) => [parseInt(ts), val]).sort((a,b)=>a[0]-b[0]);
        }

        // 累计处理
        if (chartType === 'line') {
            let sum = 0;
            chartData = chartData.map(item => { sum += item[1]; return [item[0], sum]; });
        }

        // 背景色块
        const markAreas = [];
        if (chartData.length > 0) {
            const startT = chartData[0][0];
            const endT = chartData[chartData.length-1][0];
            let curr = new Date(startT); curr.setHours(0,0,0,0);
            const limit = endT + 86400000;
            let safe = 0;
            while(curr.getTime() < limit && safe++ < 5000) {
                const h = curr.getHours();
                let color = THEME.night;
                let nextH = 6;
                if(h>=6 && h<12) { color=THEME.morning; nextH=12; }
                else if(h>=12 && h<18) { color=THEME.afternoon; nextH=18; }
                else if(h>=18) { color=THEME.evening; nextH=24; }

                let nextD = new Date(curr);
                if(nextH===24) { nextD.setDate(curr.getDate()+1); nextD.setHours(0,0,0,0); }
                else nextD.setHours(nextH,0,0,0);

                markAreas.push([{ xAxis: curr.getTime(), itemStyle: { color } }, { xAxis: nextD.getTime() }]);
                curr = nextD;
            }
        }

        // 构建 Option
        const option = {
            animation: false,
            tooltip: {
                trigger: 'axis',
                formatter: p => {
                    const d = new Date(p[0].value[0]);
                    return `${d.getHours()}:${String(d.getMinutes()).padStart(2,'0')}<br/>$${p[0].value[1].toFixed(6)}`;
                }
            },
            grid: { left: 50, right: 20, top: 20, bottom: 40 },
            xAxis: {
                type: 'time',
                splitLine: { show: false },
                axisLabel: { formatter: '{MM}-{dd} {HH}:{mm}' }
            },
            yAxis: {
                type: yScaleType, // 支持 Log 坐标
                name: 'Cost ($)',
                splitLine: { lineStyle: { type: 'dashed' } },
                scale: true // 自适应缩放
            },
            dataZoom: [ { type: 'inside' }, { type: 'slider', bottom: 0 } ],
            series: [{
                type: chartType,
                data: chartData,
                itemStyle: { color: '#1890ff' },
                areaStyle: chartType === 'line' ? { opacity: 0.15 } : null,
                markArea: { silent: true, data: markAreas }
            }]
        };

        // --- 核心：DataZoom 逻辑 ---
        const oldZoom = chartInstance.getOption()?.dataZoom;

        // 如果正在录制 且 勾选了跟随
        if (isRecording && followRecording && recordingStartTime > 0) {
            // 锁定起点为 recordingStartTime，终点为最新数据 (100%)
            option.dataZoom[0].startValue = recordingStartTime;
            option.dataZoom[0].end = 100;
            option.dataZoom[1].startValue = recordingStartTime;
            option.dataZoom[1].end = 100;
        } else if (oldZoom) {
            // 否则保持用户当前的缩放
            option.dataZoom = oldZoom;
        }

        chartInstance.setOption(option, { notMerge: true });

        // --- 统计计算 ---
        // 1. 录制面板统计
        if (isRecording) {
            const recData = allStoredData.filter(d => d.ts >= recordingStartTime);
            const rCost = recData.reduce((a,b)=>a+b.cost,0);
            const rTimeMin = Math.max((Date.now() - recordingStartTime)/60000, 0.01); // 分钟数
            const rPeak = Math.max(...recData.map(d=>d.cost), 0);

            document.getElementById('r-cost').innerText = `$${rCost.toFixed(5)}`;
            document.getElementById('r-avg-cost').innerText = `$${(rCost/rTimeMin).toFixed(5)}/m`;
            document.getElementById('r-avg-req').innerText = `${(recData.length/rTimeMin).toFixed(1)}/m`;
            document.getElementById('r-peak').innerText = `$${rPeak.toFixed(5)}`;
        }

        // 2. 选区统计 (View)
        updateViewStats();
        chartInstance.off('datazoom');
        chartInstance.on('datazoom', updateViewStats);
    }

    function updateViewStats() {
        const opt = chartInstance.getOption();
        if(!opt.dataZoom) return;
        const sv = opt.dataZoom[0].startValue; // Time Axis 返回的是时间戳
        const ev = opt.dataZoom[0].endValue;

        let sum = 0, count = 0, toks = 0;
        allStoredData.forEach(d => {
            if (d.ts >= sv && d.ts <= ev) {
                sum += d.cost;
                count++;
                toks += d.tokens;
            }
        });

        const hours = (ev - sv) / 3600000;
        const avgH = hours > 0 ? sum / hours : 0;

        document.getElementById('view-total').innerText = `$${sum.toFixed(5)}`;
        document.getElementById('view-avg-h').innerText = `$${avgH.toFixed(4)}`;
        document.getElementById('view-tokens').innerText = `Tokens: ${toks.toLocaleString()} | Req: ${count}`;
    }

    // --- 启动 ---
    setTimeout(() => {
        const obs = new MutationObserver(() => {
            if (document.querySelector('.semi-table-tbody') && !document.getElementById('ai-dashboard-root')) {
                initUI();
            }
        });
        obs.observe(document.body, { childList: true, subtree: true });
    }, 1000);

})();
