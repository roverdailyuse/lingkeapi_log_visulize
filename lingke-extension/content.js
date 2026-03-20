// --- 核心变量 ---
let mainChartInstance = null;
let pieChartInstances = {};
let allStoredData = [];
let isCrawling = false;
let autoMonitorTimer = null;
let isRecording = false;
let recordingStartTime = 0;

// --- IndexedDB 封装 ---
const DB_NAME = 'LingkeApiLogsDB_Ext';
const DB_VERSION = 1;
const STORE_NAME = 'logs';

const dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = event => reject("IndexedDB error: " + event.target.errorCode);
    request.onsuccess = event => resolve(event.target.result);
    request.onupgradeneeded = event => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
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

// --- 强力时间解析 ---
function parseTimeSafe(str) {
    if (!str) return 0;
    let cleanStr = str.replace(/[^\x00-\x7F]/g, "").trim();
    const match = cleanStr.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})\s+(\d{1,2}):(\d{1,2}):(\d{1,2})/);
    if (match) {
        return new Date(match[1], match[2]-1, match[3], match[4], match[5], match[6]).getTime();
    }
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
            const timeStr = td[0].getAttribute('title') || td[0].innerText || "";
            const token_name = td[1].innerText || "Unknown";
            const group = td[2].innerText || "Default";
            const type = td[3].innerText || "Unknown";
            const model = td[4].innerText || "Unknown";

            const costText = td[8].innerText || "";
            const costMatch = costText.match(/-?\d+(\.\d+)?([eE][+-]?\d+)?/);
            const cost = costMatch ? parseFloat(costMatch[0]) : 0;

            const tokens = (parseInt(td[6].innerText)||0) + (parseInt(td[7].innerText)||0);

            const ts = parseTimeSafe(timeStr);
            if (ts > 0) {
                let id = row.getAttribute('data-row-key') || `${ts}_${model}_${cost}`;
                if (!allStoredData.find(x => x.id === id)) {
                    const logEntry = { id, ts, model, cost, tokens, group, type, token_name };
                    allStoredData.push(logEntry);
                    newLogs.push(logEntry);
                }
            }
        } catch(e) { console.error("Ext parse error:", e); }
    });

    if (newLogs.length > 0) {
        allStoredData.sort((a, b) => a.ts - b.ts);
        await saveLogsToDB(newLogs);
        return true;
    }
    return false;
}

// --- 多选组件 ---
const msStates = {
    group: { selected: new Set(), allOptions: new Set() },
    type: { selected: new Set(), allOptions: new Set() },
    model: { selected: new Set(), allOptions: new Set() },
    token_name: { selected: new Set(), allOptions: new Set() }
};

function createMsUI(id, title, filterKey) {
    const container = document.createElement('div');
    container.className = 'lk-ms-container';
    container.id = `ms-container-${id}`;

    const header = document.createElement('div');
    header.className = 'lk-ms-header';
    header.id = `ms-header-${id}`;
    header.innerText = title;

    const dropdown = document.createElement('div');
    dropdown.className = 'lk-ms-dropdown';
    dropdown.id = `ms-dropdown-${id}`;

    const actions = document.createElement('div');
    actions.className = 'lk-ms-actions';

    const selAll = document.createElement('span');
    selAll.className = 'lk-ms-act-btn';
    selAll.innerText = '全选';
    selAll.onclick = (e) => {
        e.stopPropagation();
        msStates[filterKey].selected = new Set(msStates[filterKey].allOptions);
        renderMsOpts(id, filterKey);
        updateChart();
    };

    const clearAll = document.createElement('span');
    clearAll.className = 'lk-ms-act-btn';
    clearAll.innerText = '全不选';
    clearAll.onclick = (e) => {
        e.stopPropagation();
        msStates[filterKey].selected.clear();
        renderMsOpts(id, filterKey);
        updateChart();
    };

    actions.appendChild(selAll);
    actions.appendChild(clearAll);
    dropdown.appendChild(actions);

    const optsCont = document.createElement('div');
    optsCont.id = `ms-options-${id}`;
    dropdown.appendChild(optsCont);

    container.appendChild(header);
    container.appendChild(dropdown);

    header.onclick = (e) => {
        e.stopPropagation();
        const isShow = dropdown.classList.contains('show');
        document.querySelectorAll('.lk-ms-dropdown').forEach(d => d.classList.remove('show'));
        if (!isShow) dropdown.classList.add('show');
    };

    document.addEventListener('click', (e) => { if (!container.contains(e.target)) dropdown.classList.remove('show'); });
    return container;
}

function renderMsOpts(id, filterKey) {
    const cont = document.getElementById(`ms-options-${id}`);
    const hdr = document.getElementById(`ms-header-${id}`);
    if (!cont || !hdr) return;

    cont.innerHTML = '';
    const st = msStates[filterKey];
    const opts = Array.from(st.allOptions).sort();

    if (st.selected.size === st.allOptions.size && st.allOptions.size > 0) hdr.innerText = `全部 ${id.replace('sel-', '')}`;
    else if (st.selected.size === 1) hdr.innerText = Array.from(st.selected)[0];
    else if (st.selected.size === 0) hdr.innerText = '未选择';
    else hdr.innerText = `已选 ${st.selected.size} 项`;

    opts.forEach(o => {
        const div = document.createElement('div');
        div.className = 'lk-ms-option';
        const chk = document.createElement('input');
        chk.type = 'checkbox';
        chk.checked = st.selected.has(o);
        chk.onchange = (e) => {
            if (e.target.checked) st.selected.add(o);
            else st.selected.delete(o);
            renderMsOpts(id, filterKey);
            updateChart();
        };
        const lbl = document.createElement('span'); lbl.innerText = o;
        div.onclick = (e) => { if(e.target !== chk) chk.click(); };
        div.append(chk, lbl);
        cont.append(div);
    });
}

function updateMsData(data) {
    let changed = false;
    const process = (k) => {
        const st = msStates[k];
        const prevSize = st.allOptions.size;
        data.forEach(d => { if(d[k]) st.allOptions.add(d[k]); });
        if(st.allOptions.size > prevSize) {
            changed = true;
            data.forEach(d => { if(d[k]) st.selected.add(d[k]); });
        }
    };
    ['group', 'type', 'model', 'token_name'].forEach(process);

    if (changed) {
        renderMsOpts('sel-group', 'group');
        renderMsOpts('sel-type', 'type');
        renderMsOpts('sel-model', 'model');
        renderMsOpts('sel-token', 'token_name');
    }
}

// --- 控制器功能 ---
async function startCrawling() {
    const btn = document.getElementById('lk-btn-crawl');
    if (isCrawling) { isCrawling = false; btn.innerHTML = "📥 抓取历史"; btn.classList.remove('pulse-anim'); return; }

    isCrawling = true;
    btn.innerHTML = "🛑 停止抓取";
    btn.classList.add('pulse-anim');
    for (let i = 0; i < 500; i++) {
        if (!isCrawling) break;
        if(await scrapeData()) updateChart();
        const nextBtn = document.querySelector('.semi-page-next:not(.semi-page-disabled)');
        if (!nextBtn) break;
        nextBtn.click();
        await new Promise(r => setTimeout(r, 1200));
    }
    isCrawling = false;
    btn.innerHTML = "✅ 完成";
    btn.classList.remove('pulse-anim');
    setTimeout(() => btn.innerHTML = "📥 抓取历史", 3000);
}

function toggleMonitor() {
    const btn = document.getElementById('lk-btn-monitor');
    if (autoMonitorTimer) {
        clearInterval(autoMonitorTimer);
        autoMonitorTimer = null;
        btn.innerHTML = "🚀 自动监控";
        btn.classList.remove('lk-btn-primary', 'pulse-anim');
    } else {
        if(!confirm('【重要】请将网页右上方日期范围的“结束时间”设为未来某个时间。\n否则可能无法获取最新数据！\n继续?')) return;
        btn.innerHTML = "🛑 停止监控";
        btn.classList.add('lk-btn-primary', 'pulse-anim');

        const triggerSearch = () => {
            let qBtn = Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes('查询') || b.innerText.includes('Search'));
            if (!qBtn) qBtn = document.querySelector('.semi-icon-search')?.closest('button');
            if (qBtn) {
                qBtn.click();
                setTimeout(async () => { if(await scrapeData()) updateChart(); }, 2000);
            }
        };
        triggerSearch();
        autoMonitorTimer = setInterval(triggerSearch, 8000);
    }
}

function toggleRecording() {
    isRecording = !isRecording;
    const btn = document.getElementById('lk-btn-rec');
    const panel = document.getElementById('lk-rec-panel');
    if (isRecording) {
        recordingStartTime = Date.now();
        btn.innerText = "⏹ 停止录制";
        btn.classList.add('lk-btn-danger');
        panel.classList.add('active');
        updateChart();
    } else {
        btn.innerText = "⏺ 开始录制";
        btn.classList.remove('lk-btn-danger');
        panel.classList.remove('active');
    }
}

// --- 渲染图表 ---
function updateChart() {
    if (!mainChartInstance) return;
    document.getElementById('lk-data-count').innerText = allStoredData.length.toLocaleString();

    // 1. 获取配置
    const aggLevel = document.getElementById('lk-sel-agg').value;
    const chartType = document.getElementById('lk-sel-chart').value;
    const yScale = document.getElementById('lk-sel-scale').value;
    const isFollow = document.getElementById('lk-chk-follow').checked;
    const pieMetric = document.getElementById('lk-pie-metric-sel').value;

    const startTs = new Date(document.getElementById('lk-sel-start').value || 0).getTime() || 0;
    const endTs = new Date(document.getElementById('lk-sel-end').value || 8640000000000000).getTime() || Infinity;

    // 2. 初始时间过滤 & 多选数据更新
    const timeFiltered = allStoredData.filter(d => d.ts >= startTs && d.ts <= endTs);
    updateMsData(timeFiltered);

    const isSel = (k, v) => msStates[k].selected.has(v);

    // 3. 属性过滤
    const filtered = timeFiltered.filter(d => isSel('token_name',d.token_name) && isSel('model',d.model) && isSel('group',d.group) && isSel('type',d.type));

    // 4. 数据聚合 (主图)
    let chartData = [];
    if (aggLevel === 'raw') {
        chartData = filtered.map(d => [d.ts, d.cost]);
    } else {
        const gap = parseInt(aggLevel);
        const buckets = {};
        filtered.forEach(d => {
            const k = Math.floor(d.ts / gap) * gap;
            buckets[k] = (buckets[k] || 0) + d.cost;
        });
        chartData = Object.entries(buckets).map(([t,v]) => [parseInt(t), v]).sort((a,b)=>a[0]-b[0]);
    }
    if (chartType === 'line') {
        let sum = 0; chartData = chartData.map(i => [i[0], sum+=i[1]]);
    }

    // 5. 设置主图 Option
    const mainOpt = {
        animation: false,
        tooltip: { trigger: 'axis', formatter: p => { const d=new Date(p[0].value[0]); return `${d.getHours()}:${String(d.getMinutes()).padStart(2,'0')}<br/>$${p[0].value[1].toFixed(6)}`; } },
        grid: { left: 50, right: 20, top: 20, bottom: 40 },
        xAxis: { type: 'time', splitLine: { show: false }, axisLabel: { formatter: '{MM}-{dd} {HH}:{mm}' } },
        yAxis: { type: yScale, name: 'Cost($)', splitLine: { lineStyle:{type:'dashed'} } },
        dataZoom: [ { type: 'inside' }, { type: 'slider', bottom: 0 } ],
        series: [{ type: chartType, data: chartData, itemStyle: { color: '#1890ff' }, areaStyle: chartType==='line'?{opacity:0.15}:null }]
    };

    const oldZoom = mainChartInstance.getOption()?.dataZoom;
    if (isRecording && isFollow && recordingStartTime > 0) {
        mainOpt.dataZoom[0].startValue = recordingStartTime; mainOpt.dataZoom[0].end = 100;
        mainOpt.dataZoom[1].startValue = recordingStartTime; mainOpt.dataZoom[1].end = 100;
    } else if (oldZoom) mainOpt.dataZoom = oldZoom;

    mainChartInstance.setOption(mainOpt, { notMerge: true });

    // 6. 渲染饼图 (副图)
    const renderPie = (targetInstance, title, key) => {
        if (!targetInstance) return;
        const stats = {};
        filtered.forEach(d => {
            let v = 0;
            if(pieMetric === 'cost') v = d.cost;
            else if(pieMetric === 'tokens') v = d.tokens;
            else v = 1;
            stats[d[key]] = (stats[d[key]] || 0) + v;
        });
        const pieData = Object.entries(stats).map(([name, value]) => ({name, value})).sort((a,b)=>b.value-a.value).slice(0, 8);

        targetInstance.setOption({
            animation: false,
            title: { text: title, left: 'center', top: 5, textStyle: {fontSize: 12, fontWeight: 'normal', color: '#666'} },
            tooltip: { trigger: 'item', formatter: '{b}: {c} ({d}%)' },
            series: [{ type: 'pie', radius: ['40%', '70%'], center: ['50%','55%'], data: pieData, label:{show:false} }]
        });
    };

    renderPie(pieChartInstances.model, "模型占比", 'model');
    renderPie(pieChartInstances.token, "令牌占比", 'token_name');
    renderPie(pieChartInstances.group, "分组占比", 'group');


    // 7. 更新统计
    if (isRecording) {
        const recD = filtered.filter(d => d.ts >= recordingStartTime);
        const cost = recD.reduce((a,b)=>a+b.cost,0);
        const min = Math.max((Date.now()-recordingStartTime)/60000, 0.01);
        document.getElementById('lk-r-cost').innerText = `$${cost.toFixed(5)}`;
        document.getElementById('lk-r-avg-c').innerText = `$${(cost/min).toFixed(4)}/m`;
        document.getElementById('lk-r-avg-r').innerText = `${(recD.length/min).toFixed(1)}/m`;
        document.getElementById('lk-r-peak').innerText = `$${Math.max(...recD.map(d=>d.cost),0).toFixed(5)}`;
    }

    updateViewStats(filtered);
    mainChartInstance.off('datazoom');
    mainChartInstance.on('datazoom', () => updateViewStats(filtered));
}

function updateViewStats(filtered) {
    const opt = mainChartInstance.getOption();
    if(!opt.dataZoom) return;
    const sv = opt.dataZoom[0].startValue || 0;
    const ev = opt.dataZoom[0].endValue || Date.now();

    let sum = 0, reqs = 0, toks = 0;
    const buckets = {};

    filtered.forEach(d => {
        if(d.ts>=sv && d.ts<=ev) {
            sum+=d.cost; reqs++; toks+=d.tokens;
            const m = Math.floor(d.ts / 60000) * 60000;
            if (!buckets[m]) buckets[m] = { reqs: 0, toks: 0 };
            buckets[m].reqs++;
            buckets[m].toks += d.tokens;
        }
    });

    const spanMs = Math.max(ev - sv, 1000);
    const min = spanMs / 60000;
    const hrs = spanMs / 3600000;
    const days = spanMs / 86400000;

    let peakRpm = 0, peakTpm = 0;
    for (const b of Object.values(buckets)) {
        if (b.reqs > peakRpm) peakRpm = b.reqs;
        if (b.toks > peakTpm) peakTpm = b.toks;
    }

    document.getElementById('lk-v-total').innerText = `$${sum.toFixed(5)}`;
    document.getElementById('lk-v-reqs').innerText = reqs.toLocaleString();
    document.getElementById('lk-v-tokens').innerText = toks.toLocaleString();
    document.getElementById('lk-v-avg-h').innerText = `$${(sum/hrs).toFixed(4)}`;
    document.getElementById('lk-v-rpm').innerText = (reqs/min).toFixed(1);
    document.getElementById('lk-v-tpm').innerText = (toks/min).toFixed(0);
    document.getElementById('lk-v-daily-r').innerText = (reqs/days).toFixed(0);
    document.getElementById('lk-v-daily-t').innerText = (toks/days).toFixed(0);
    document.getElementById('lk-v-peak-rpm').innerText = peakRpm.toLocaleString();
    document.getElementById('lk-v-peak-tpm').innerText = peakTpm.toLocaleString();
}


// --- DOM 生成与初始化 ---
async function initExtensionUI() {
    if (document.getElementById('lk-ai-dashboard-wrapper')) return;

    try { allStoredData = await loadLogsFromDB(); } catch(e) { console.warn(e); }

    const wrapper = document.createElement('div');
    wrapper.id = 'lk-ai-dashboard-wrapper';

    // 面板HTML
    const panel = document.createElement('div');
    panel.id = 'lk-panel-container';
    panel.innerHTML = `
        <div class="lk-header">
            <div class="lk-title-area">
                <h3 class="lk-title">💎 灵客API旗舰分析台 (V10)</h3>
                <span class="lk-badge lk-badge-gray" id="lk-data-count">0</span>
            </div>
            <button class="lk-close-btn" id="lk-btn-close">×</button>
        </div>

        <div class="lk-ctrl-bar" id="lk-ctrl-main">
            <button class="lk-btn" id="lk-btn-monitor">🚀 自动监控</button>
            <button class="lk-btn" id="lk-btn-crawl">📥 抓取历史</button>
            <div class="lk-divider"></div>

            <div class="lk-input-group">
                <label>外层范围:</label>
                <input type="datetime-local" class="lk-input" id="lk-sel-start"> -
                <input type="datetime-local" class="lk-input" id="lk-sel-end">
                <button class="lk-btn" id="lk-btn-reset-time">重置</button>
            </div>
            <div class="lk-divider"></div>

            <select class="lk-select" id="lk-sel-scale"><option value="value">线性Y轴</option><option value="log">对数Y轴</option></select>
            <select class="lk-select" id="lk-sel-agg"><option value="raw" selected>原始点</option><option value="60000">1分钟</option><option value="3600000">1小时</option></select>
            <select class="lk-select" id="lk-sel-chart"><option value="line" selected>累计(线)</option><option value="bar">分段(柱)</option></select>

            <div class="lk-divider"></div>
            <button class="lk-btn lk-btn-danger" id="lk-btn-clear" style="margin-left:auto;">🗑️ 清空库</button>
        </div>

        <div class="lk-ctrl-bar" id="lk-ctrl-filters" style="margin-top: -5px; background:transparent; padding-top:0;">
            <span style="font-size:12px; color:#666; font-weight:bold;">筛选器:</span>
        </div>

        <div class="lk-content-layout">
            <div class="lk-charts-col">
                <div class="lk-chart-main" id="lk-echarts-main"></div>
                <div class="lk-chart-sub">
                    <div style="flex:1; border:1px solid #f0f0f0; border-radius:8px; position:relative; background:#fafafa;">
                        <select id="lk-pie-metric-sel" class="lk-select" style="position:absolute; top:5px; left:5px; z-index:10; border:none; background:transparent; padding:2px;">
                            <option value="cost" selected>按消费金额</option>
                            <option value="tokens">按Tokens消耗</option>
                            <option value="reqs">按请求次数</option>
                        </select>
                        <div id="lk-echarts-pie" style="width:100%; height:100%;"></div>
                    </div>
                    <div class="lk-chart-box" id="lk-echarts-token"></div>
                    <div class="lk-chart-box" id="lk-echarts-group"></div>
                </div>
            </div>

            <div class="lk-side-col">
                <div class="lk-card lk-card-rec" id="lk-rec-panel">
                    <div class="lk-card-title">
                        <span>⏱️ 实时压测录制</span>
                        <button class="lk-btn" id="lk-btn-rec" style="padding: 2px 8px;">⏺ 开始</button>
                    </div>
                    <label class="chk-label" style="margin-bottom:10px;"><input type="checkbox" id="lk-chk-follow" checked> 自动跟随最新点</label>
                    <div class="lk-card-stat"><span>录制总额</span><span class="lk-stat-val" id="lk-r-cost">$0.00</span></div>
                    <div class="lk-card-stat"><span>平均消耗</span><span class="lk-stat-val" id="lk-r-avg-c">$0.00/m</span></div>
                    <div class="lk-card-stat"><span>平均请求</span><span class="lk-stat-val" id="lk-r-avg-r">0.0/m</span></div>
                    <div class="lk-card-stat"><span>单次峰值</span><span class="lk-stat-val" id="lk-r-peak">$0.00</span></div>
                </div>

                <div class="lk-card">
                    <div class="lk-card-title">视口数据指标 (Inner View)</div>
                    <div class="lk-stat-val lk-stat-highlight" id="lk-v-total">$0.000</div>
                    <div class="lk-card-stat" style="margin-top:10px;"><span>总请求</span><span class="lk-stat-val" id="lk-v-reqs">0</span></div>
                    <div class="lk-card-stat"><span>总Token</span><span class="lk-stat-val" id="lk-v-tokens">0</span></div>
                    <div class="lk-card-stat"><span>Avg / Hour</span><span class="lk-stat-val" id="lk-v-avg-h">$0.00</span></div>
                    <div class="lk-card-stat"><span>RPM (每分钟请求)</span><span class="lk-stat-val" id="lk-v-rpm">0.0</span></div>
                    <div class="lk-card-stat"><span>TPM (每分钟Token)</span><span class="lk-stat-val" id="lk-v-tpm">0</span></div>
                    <div class="lk-card-stat"><span>日均请求预估</span><span class="lk-stat-val" id="lk-v-daily-r">0</span></div>
                    <div class="lk-card-stat"><span>日均Token预估</span><span class="lk-stat-val" id="lk-v-daily-t">0</span></div>
                    <div class="lk-card-stat"><span>单分峰值 RPM</span><span class="lk-stat-val" style="color:#e11d48;" id="lk-v-peak-rpm">0</span></div>
                    <div class="lk-card-stat"><span>单分峰值 TPM</span><span class="lk-stat-val" style="color:#e11d48;" id="lk-v-peak-tpm">0</span></div>
                </div>
            </div>
        </div>
    `;

    // 唤醒按钮 FAB
    const fab = document.createElement('div');
    fab.id = 'lk-fab';
    fab.innerHTML = '📊';
    fab.title = '打开 API 看板';

    wrapper.appendChild(panel);
    wrapper.appendChild(fab);
    document.body.appendChild(wrapper);

    // 绑定多选组件
    const filterBar = document.getElementById('lk-ctrl-filters');
    filterBar.appendChild(createMsUI('sel-token', '令牌名称', 'token_name'));
    filterBar.appendChild(createMsUI('sel-group', '分组', 'group'));
    filterBar.appendChild(createMsUI('sel-type', '类型', 'type'));
    filterBar.appendChild(createMsUI('sel-model', '模型', 'model'));

    // 初始化 Echarts
    mainChartInstance = echarts.init(document.getElementById('lk-echarts-main'));
    pieChartInstances.model = echarts.init(document.getElementById('lk-echarts-pie'));
    pieChartInstances.token = echarts.init(document.getElementById('lk-echarts-token'));
    pieChartInstances.group = echarts.init(document.getElementById('lk-echarts-group'));

    // 绑定基础事件
    fab.onclick = () => {
        panel.classList.toggle('show');
        if (panel.classList.contains('show')) {
            mainChartInstance.resize();
            pieChartInstances.model.resize();
            pieChartInstances.token.resize();
            pieChartInstances.group.resize();
            updateChart();
        }
    };
    document.getElementById('lk-btn-close').onclick = () => panel.classList.remove('show');
    document.getElementById('lk-btn-monitor').onclick = toggleMonitor;
    document.getElementById('lk-btn-crawl').onclick = startCrawling;
    document.getElementById('lk-btn-rec').onclick = toggleRecording;

    document.getElementById('lk-btn-reset-time').onclick = () => {
        document.getElementById('lk-sel-start').value = '';
        document.getElementById('lk-sel-end').value = '';
        updateChart();
    };

    document.getElementById('lk-btn-clear').onclick = async () => {
        if(confirm('警告：将清空本地 IndexedDB 中的所有历史数据，且无法恢复！确认继续？')) {
            allStoredData = [];
            await clearLogsDB();
            ['token_name', 'group', 'type', 'model'].forEach(k => {
                msStates[k].allOptions.clear(); msStates[k].selected.clear();
            });
            updateMsData([]);
            updateChart();
        }
    };

    ['lk-sel-scale', 'lk-sel-agg', 'lk-sel-chart', 'lk-sel-start', 'lk-sel-end', 'lk-pie-metric-sel'].forEach(id => {
        document.getElementById(id).onchange = updateChart;
    });

    window.addEventListener('resize', () => {
        if(panel.classList.contains('show')) {
            mainChartInstance.resize();
            pieChartInstances.model.resize();
            pieChartInstances.token.resize();
            pieChartInstances.group.resize();
        }
    });

    // 初始抓取并渲染
    await scrapeData();
    updateMsData(allStoredData);
    updateChart();

    if (allStoredData.length > 0) fab.classList.add('pulse-anim');
}

// 延迟启动，等待 React 和 Table 加载
setTimeout(() => {
    const obs = new MutationObserver(() => {
        if (document.querySelector('.semi-table-tbody') && !document.getElementById('lk-ai-dashboard-wrapper')) {
            initExtensionUI();
        }
    });
    obs.observe(document.body, { childList: true, subtree: true });
}, 1500);
