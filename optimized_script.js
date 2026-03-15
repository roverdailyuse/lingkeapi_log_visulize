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

    // --- IndexedDB 封装 ---
    const DB_NAME = 'LingkeApiLogsDB';
    const DB_VERSION = 1;
    const STORE_NAME = 'logs';

    const dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onerror = event => reject("IndexedDB error: " + event.target.errorCode);
        request.onsuccess = event => resolve(event.target.result);
        request.onupgradeneeded = event => {
            const db = event.target.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                // 以 id 作为主键，添加索引
                const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
                store.createIndex('ts', 'ts', { unique: false });
                store.createIndex('model', 'model', { unique: false });
                store.createIndex('group', 'group', { unique: false });
                store.createIndex('type', 'type', { unique: false });
                store.createIndex('token_name', 'token_name', { unique: false });
            }
        };
    });

    async function saveLogsToDB(logs) {
        const db = await dbPromise;
        return new Promise((resolve, reject) => {
            const transaction = db.transaction([STORE_NAME], 'readwrite');
            const store = transaction.objectStore(STORE_NAME);

            // 批量保存
            logs.forEach(log => store.put(log));

            transaction.oncomplete = () => resolve();
            transaction.onerror = (e) => reject(e);
        });
    }

    async function loadLogsFromDB() {
        const db = await dbPromise;
        return new Promise((resolve, reject) => {
            const transaction = db.transaction([STORE_NAME], 'readonly');
            const store = transaction.objectStore(STORE_NAME);
            const request = store.getAll();

            request.onsuccess = () => {
                const data = request.result || [];
                // 按时间戳排序
                data.sort((a, b) => a.ts - b.ts);
                resolve(data);
            };
            request.onerror = (e) => reject(e);
        });
    }

    async function clearLogsDB() {
        const db = await dbPromise;
        return new Promise((resolve, reject) => {
            const transaction = db.transaction([STORE_NAME], 'readwrite');
            const store = transaction.objectStore(STORE_NAME);
            const request = store.clear();
            request.onsuccess = () => resolve();
            request.onerror = (e) => reject(e);
        });
    }

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

        /* 多选下拉框样式 */
        .multi-select-container { position: relative; display: inline-block; }
        .multi-select-header { padding: 4px 20px 4px 10px; font-size: 12px; border: 1px solid #d9d9d9; background: #fff; border-radius: 4px; cursor: pointer; min-width: 80px; max-width: 150px; text-overflow: ellipsis; overflow: hidden; white-space: nowrap; }
        .multi-select-header::after { content: "▼"; font-size: 8px; position: absolute; right: 8px; top: 50%; transform: translateY(-50%); color: #999; }
        .multi-select-dropdown { position: absolute; top: 100%; left: 0; background: white; border: 1px solid #d9d9d9; border-radius: 4px; box-shadow: 0 2px 8px rgba(0,0,0,0.15); z-index: 1000; max-height: 300px; overflow-y: auto; display: none; min-width: 100%; }
        .multi-select-dropdown.show { display: block; }
        .multi-select-option { padding: 6px 10px; display: flex; align-items: center; cursor: pointer; font-size: 12px; white-space: nowrap; }
        .multi-select-option:hover { background: #f5f5f5; }
        .multi-select-option input { margin-right: 8px; cursor: pointer; }
        .multi-select-actions { display: flex; justify-content: space-between; padding: 6px 10px; border-bottom: 1px solid #eee; background: #fafafa; position: sticky; top: 0; z-index: 1; }
        .multi-select-actions span { color: #1890ff; cursor: pointer; font-size: 12px; }

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
    async function scrapeData() {
        const rows = document.querySelectorAll('.semi-table-tbody tr');
        if (rows.length === 0) return false;

        let newLogs = [];
        rows.forEach(row => {
            const td = row.querySelectorAll('td');
            if (td.length < 9) return;
            try {
                // 1. 获取时间：优先使用 title 属性，其次 innerText
                const timeStr = td[0].getAttribute('title') || td[0].innerText || "";

                // 2. 获取其他字段
                const token_name = td[1].innerText || "Unknown"; // 新增令牌名称
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
                        const logEntry = { id, ts, model, cost, tokens, group, type, token_name };
                        allStoredData.push(logEntry);
                        newLogs.push(logEntry);
                    }
                }
            } catch(e) {
                console.error("Row parsing error:", e);
            }
        });

        if (newLogs.length > 0) {
            allStoredData.sort((a, b) => a.ts - b.ts);
            // 保存到 IndexedDB
            await saveLogsToDB(newLogs);
            return true;
        }
        return false;
    }

    // --- 多选组件管理 ---
    const multiSelectStates = {
        group: { selected: new Set(), allOptions: new Set() },
        type: { selected: new Set(), allOptions: new Set() },
        model: { selected: new Set(), allOptions: new Set() },
        token_name: { selected: new Set(), allOptions: new Set() }
    };

    function createMultiSelectUI(id, title, filterKey) {
        const container = document.createElement('div');
        container.className = 'multi-select-container';
        container.id = `ms-container-${id}`;

        const header = document.createElement('div');
        header.className = 'multi-select-header';
        header.id = `ms-header-${id}`;
        header.innerText = title;
        header.title = title;

        const dropdown = document.createElement('div');
        dropdown.className = 'multi-select-dropdown';
        dropdown.id = `ms-dropdown-${id}`;

        // Actions: 全选 / 反选
        const actions = document.createElement('div');
        actions.className = 'multi-select-actions';

        const selectAll = document.createElement('span');
        selectAll.innerText = '全选';
        selectAll.onclick = (e) => {
            e.stopPropagation();
            multiSelectStates[filterKey].selected = new Set(multiSelectStates[filterKey].allOptions);
            renderMultiSelectOptions(id, filterKey);
            updateChart();
        };

        const clearAll = document.createElement('span');
        clearAll.innerText = '清空';
        clearAll.onclick = (e) => {
            e.stopPropagation();
            multiSelectStates[filterKey].selected.clear();
            renderMultiSelectOptions(id, filterKey);
            updateChart();
        };

        actions.appendChild(selectAll);
        actions.appendChild(clearAll);
        dropdown.appendChild(actions);

        const optionsContainer = document.createElement('div');
        optionsContainer.id = `ms-options-${id}`;
        dropdown.appendChild(optionsContainer);

        container.appendChild(header);
        container.appendChild(dropdown);

        // Toggle dropdown
        header.onclick = (e) => {
            e.stopPropagation();
            const isShowing = dropdown.classList.contains('show');
            // Close all other dropdowns
            document.querySelectorAll('.multi-select-dropdown').forEach(d => d.classList.remove('show'));
            if (!isShowing) {
                dropdown.classList.add('show');
            }
        };

        // Close on outside click
        document.addEventListener('click', (e) => {
            if (!container.contains(e.target)) {
                dropdown.classList.remove('show');
            }
        });

        return container;
    }

    function renderMultiSelectOptions(id, filterKey) {
        const optionsContainer = document.getElementById(`ms-options-${id}`);
        const header = document.getElementById(`ms-header-${id}`);
        if (!optionsContainer || !header) return;

        optionsContainer.innerHTML = '';
        const state = multiSelectStates[filterKey];
        const options = Array.from(state.allOptions).sort();

        // 更新 Header 显示
        if (state.selected.size === 0 || state.selected.size === state.allOptions.size) {
            header.innerText = `全部 ${id.replace('sel-', '')}`;
        } else if (state.selected.size === 1) {
            header.innerText = Array.from(state.selected)[0];
        } else {
            header.innerText = `已选 ${state.selected.size} 项`;
        }
        header.title = Array.from(state.selected).join(', ');

        options.forEach(opt => {
            const div = document.createElement('div');
            div.className = 'multi-select-option';

            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.checked = state.selected.size === 0 ? true : state.selected.has(opt); // 空表示全选

            // 修复：如果之前为空，点击后应该只选中当前项
            checkbox.onchange = (e) => {
                if (state.selected.size === 0 && !e.target.checked) {
                    // Originally all selected (implicitly), now unselecting one
                    state.selected = new Set(state.allOptions);
                    state.selected.delete(opt);
                } else if (e.target.checked) {
                    state.selected.add(opt);
                } else {
                    state.selected.delete(opt);
                }

                // Sync header text
                renderMultiSelectOptions(id, filterKey);
                updateChart();
            };

            const label = document.createElement('span');
            label.innerText = opt;

            div.onclick = (e) => {
                if(e.target !== checkbox) checkbox.click();
            };

            div.appendChild(checkbox);
            div.appendChild(label);
            optionsContainer.appendChild(div);
        });
    }

    function updateMultiSelectData(data) {
        let needsUpdate = false;

        const processKey = (filterKey) => {
            const state = multiSelectStates[filterKey];
            const currentSize = state.allOptions.size;
            data.forEach(d => {
                if (d[filterKey]) state.allOptions.add(d[filterKey]);
            });
            if (state.allOptions.size > currentSize) {
                needsUpdate = true;
                // 新增选项默认选中
                data.forEach(d => {
                    if (d[filterKey] && state.selected.size > 0 && !state.selected.has(d[filterKey])) {
                        // 如果用户已经进行了筛选，新选项不一定自动勾选。但为了方便，通常默认勾选或者不干扰当前。
                        // 策略：如果 selected == allOptions，保持同步
                    }
                });
            }
        };

        processKey('group');
        processKey('type');
        processKey('model');
        processKey('token_name');

        if (needsUpdate) {
            renderMultiSelectOptions('sel-group', 'group');
            renderMultiSelectOptions('sel-type', 'type');
            renderMultiSelectOptions('sel-model', 'model');
            renderMultiSelectOptions('sel-token', 'token_name');
        }
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
            const hasNew = await scrapeData();
            if (hasNew) updateChart();

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
            setTimeout(async () => {
                if(await scrapeData()) updateChart();
            }, 2000);
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
    async function initUI() {
        if (document.getElementById('ai-dashboard-root')) return;

        // 从 IndexedDB 加载历史数据
        try {
            allStoredData = await loadLogsFromDB();
        } catch(e) {
            console.error("Failed to load logs from DB:", e);
            allStoredData = [];
        }

        const wrapper = document.createElement('div');
        wrapper.id = 'ai-lab-wrapper';
        wrapper.innerHTML = `
            <div id="ai-dashboard-root">
                <div class="dash-header">
                    <div>
                        <span style="font-size:16px; font-weight:bold;">💎 灵客 API 旗舰看板 V10</span>
                        <span id="monitor-status" style="display:none; color:#52c41a; font-size:12px; margin-left:10px;">● 监控中</span>
                    </div>
                    <div style="font-size:12px; color:#888;">数据点: <span id="data-count">${allStoredData.length}</span></div>
                </div>

                <div class="ctrl-bar" id="main-ctrl-bar">
                    <button id="btn-monitor" class="u-btn">🚀 自动更新</button>
                    <button id="btn-crawl" class="u-btn">📥 抓取历史</button>

                    <span style="border-left:1px solid #ccc; margin:0 4px; height:15px;"></span>

                    <select id="sel-y-scale" class="u-btn" title="Y轴缩放模式">
                        <option value="value">线性坐标 (Linear)</option>
                        <option value="log">对数坐标 (Log)</option>
                    </select>

                    <select id="sel-precision" class="u-btn">
                        <option value="raw" selected>原始精度</option>
                        <option value="60000">1分钟聚合</option>
                        <option value="3600000">1小时聚合</option>
                    </select>

                    <select id="sel-type-chart" class="u-btn">
                        <option value="bar">分段消耗 (柱)</option>
                        <option value="line" selected>累计消耗 (线)</option>
                    </select>

                    <span style="border-left:1px solid #ccc; margin:0 4px; height:15px;"></span>

                    <!-- 多选框将被注入到这里 -->

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

        // 注入多选框
        const ctrlBar = document.getElementById('main-ctrl-bar');
        const clearBtn = document.getElementById('btn-clear');

        ctrlBar.insertBefore(createMultiSelectUI('sel-token', '令牌名称', 'token_name'), clearBtn);
        ctrlBar.insertBefore(createMultiSelectUI('sel-group', '分组', 'group'), clearBtn);
        ctrlBar.insertBefore(createMultiSelectUI('sel-type', '类型', 'type'), clearBtn);
        ctrlBar.insertBefore(createMultiSelectUI('sel-model', '模型', 'model'), clearBtn);

        chartInstance = echarts.init(document.getElementById('main-chart'));
        window.addEventListener('resize', () => chartInstance.resize());

        // 绑定事件
        document.getElementById('btn-monitor').onclick = toggleMonitor;
        document.getElementById('btn-crawl').onclick = startCrawling;
        document.getElementById('btn-rec').onclick = toggleRecording;
        document.getElementById('btn-clear').onclick = async () => {
            if(confirm('清空所有历史数据? 这将无法恢复！')) {
                allStoredData=[];
                await clearLogsDB();

                // 清空多选状态
                ['token_name', 'group', 'type', 'model'].forEach(k => {
                    multiSelectStates[k].allOptions.clear();
                    multiSelectStates[k].selected.clear();
                });
                updateMultiSelectData([]);
                updateChart();
            }
        };

        ['sel-y-scale', 'sel-precision', 'sel-type-chart'].forEach(id => {
            document.getElementById(id).onchange = updateChart;
        });

        await scrapeData();
        updateMultiSelectData(allStoredData);
        updateChart();
    }


    // --- 图表渲染 ---
    function updateChart() {
        if (!chartInstance) return;
        document.getElementById('data-count').innerText = allStoredData.length;

        const precisionVal = document.getElementById('sel-precision').value;
        const chartType = document.getElementById('sel-type-chart').value;
        const yScaleType = document.getElementById('sel-y-scale').value; // 'value' or 'log'
        const followRecording = document.getElementById('chk-follow').checked;

        updateMultiSelectData(allStoredData);

        // 辅助检查函数，空集合代表全选
        const isSelected = (key, val) => {
            const selectedSet = multiSelectStates[key].selected;
            return selectedSet.size === 0 || selectedSet.has(val);
        };

        // 应用过滤
        const filtered = allStoredData.filter(d => {
            if (!isSelected('token_name', d.token_name)) return false;
            if (!isSelected('model', d.model)) return false;
            if (!isSelected('group', d.group)) return false;
            if (!isSelected('type', d.type)) return false;
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
            const recData = filtered.filter(d => d.ts >= recordingStartTime);
            const rCost = recData.reduce((a,b)=>a+b.cost,0);
            const rTimeMin = Math.max((Date.now() - recordingStartTime)/60000, 0.01); // 分钟数
            const rPeak = Math.max(...recData.map(d=>d.cost), 0);

            document.getElementById('r-cost').innerText = `$${rCost.toFixed(5)}`;
            document.getElementById('r-avg-cost').innerText = `$${(rCost/rTimeMin).toFixed(5)}/m`;
            document.getElementById('r-avg-req').innerText = `${(recData.length/rTimeMin).toFixed(1)}/m`;
            document.getElementById('r-peak').innerText = `$${rPeak.toFixed(5)}`;
        }

        // 2. 选区统计 (View)
        updateViewStats(filtered);
        chartInstance.off('datazoom');
        chartInstance.on('datazoom', () => updateViewStats(filtered));
    }

    function updateViewStats(filteredData) {
        const opt = chartInstance.getOption();
        if(!opt.dataZoom) return;
        const sv = opt.dataZoom[0].startValue; // Time Axis 返回的是时间戳
        const ev = opt.dataZoom[0].endValue;

        let sum = 0, count = 0, toks = 0;
        filteredData.forEach(d => {
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
