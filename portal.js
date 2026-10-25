(() => {
const normalize = value => String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLocaleLowerCase();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const report = text => chrome.runtime.sendMessage({ to: 'worker', type: 'automation-status', text }).catch(() => {});
const DEFAULT_AUTOMATION_BATCH_SIZE=20;
const MAX_AUTOMATION_BATCH_SIZE=100;

function rowsOnPage() {
  return [...document.querySelectorAll('table tr,[role="row"]')].map(row => {
    const checkbox = row.querySelector('input[type="checkbox"]');
    const firstCell = row.querySelector('td,[role="cell"]') || row.cells?.[0];
    if (!checkbox || !firstCell) return null;
    const title = firstCell.innerText.replace(/^\s*Selecteer\s+rij\s+\d+\s*/i, '').trim();
    const typeCell = row.querySelectorAll('td,[role="cell"]')[1];
    const rowKey=checkbox.getAttribute('data-id')||checkbox.getAttribute('data-key')||row.getAttribute('data-id')||row.getAttribute('data-key')||checkbox.value||'';
    return title ? {
      title,
      checkbox,
      element:row,
      rowKey,
      kind:String(typeCell?.innerText || '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLocaleLowerCase()
    } : null;
  }).filter(Boolean);
}

async function waitForRows(timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const rows = rowsOnPage();
    if (rows.length) return rows;
    await delay(200);
  }
  throw Error('在题目选择页等待列表超时；请确认项目/题型筛选可用。');
}
async function waitForFilteredRows(kind, timeout = 20000) {
  const deadline = Date.now() + timeout;
  let previous = '', stableSince = 0;
  while (Date.now() < deadline) {
    const rows = rowsOnPage();
    const expectedKind = String(kind).normalize('NFKC').replace(/\s+/g, ' ').trim().toLocaleLowerCase();
    const typesMatch = rows.length && (kind === 'default' || rows.every(row => row.kind === expectedKind));
    const signature = rows.map(row => `${normalize(row.title)}:${row.kind}`).join('|');
    if (typesMatch && signature === previous) {
      if (!stableSince) stableSince = Date.now();
      if (Date.now() - stableSince >= 600) return rows;
    } else {
      stableSince = 0;
      previous = signature;
    }
    await delay(150);
  }
  const actual=[...new Set(rowsOnPage().map(row=>row.kind).filter(Boolean))];
  throw Error(`官网题目列表未稳定到所选题型“${kind}”；当前页类型：${actual.join(', ')||'无题目行'}。为避免选错题，已停止。`);
}

async function setSelect(select, value) {
  const response=await chrome.runtime.sendMessage({to:'worker',type:'portal-set-filter',field:select.id,value});
  if(!response?.ok)throw Error(response?.error||`无法设置官网筛选器“${select.id}”。`);
  return response.value;
}
async function clickSearch(){
  const response=await chrome.runtime.sendMessage({to:'worker',type:'portal-search'});
  if(!response?.ok)throw Error(response?.error||'无法点击官网“Zoek”按钮。');
}
async function waitForPortalControls(timeout = 60000) {
  const deadline = Date.now() + timeout;
  let lastProgress = 0;
  while (Date.now() < deadline) {
    const pageRoot=document.querySelector('facet-openbaar-portaal');
    const program = pageRoot?.querySelector('[formcontrolname="filter_programma"]')||document.querySelector('#filter-programma');
    const kind = pageRoot?.querySelector('[formcontrolname="filter_soort_opdracht"]')||document.querySelector('#filter-soort-opdracht');
    const hasProgramOptions=program?.options?.length>=5;
    if (pageRoot&&program?.tagName==='SELECT'&&kind?.tagName==='SELECT'&&
      hasProgramOptions) return { program, kind };
    const elapsed=Date.now()-(deadline-timeout);
    if(elapsed-lastProgress>=5000){
      lastProgress=elapsed;
      report(`正在等待官方筛选器加载（项目选项 ${program?.options?.length||0}/5，题型控件 ${Boolean(kind)}，当前题型可用 ${Boolean(kind&&!kind.disabled)}）……`);
    }
    await delay(250);
  }
  const controls = [...document.querySelectorAll('select,[formcontrolname]')].map(control =>
    `${control.tagName.toLowerCase()}#${control.id||''}[${control.getAttribute('formcontrolname')||''}]=${control.value??''}`
  ).join(', ') || 'none';
  const formControls=[...document.querySelectorAll('[formcontrolname]')].map(element=>`${element.tagName.toLowerCase()}[${element.getAttribute('formcontrolname')}]`).join(', ')||'none';
  throw Error(`官网筛选控件在 60 秒内未完成加载（URL: ${location.href}; root: ${Boolean(document.querySelector('facet-openbaar-portaal'))}; controls: ${controls}; formcontrols: ${formControls}; buttons: ${[...document.querySelectorAll('button')].map(button=>`${button.id}:${normalize(button.innerText)}`).join('|')}）。当前仍是页面外壳或加载失败；请刷新官网页面后重试。`);
}
async function waitForSearchButton(timeout=15000){
  const deadline=Date.now()+timeout;
  while(Date.now()<deadline){
    const root=document.querySelector('facet-openbaar-portaal');
    const button=root?.querySelector('#zoeken-knop')||document.querySelector('#zoeken-knop')||
      [...document.querySelectorAll('button,[role="button"]')].find(candidate=>normalize(candidate.innerText||candidate.getAttribute('aria-label')||candidate.title)==='zoek');
    if(button&&!button.disabled)return button;
    await delay(150);
  }
  throw Error(`官网筛选条件已设置，但没有找到可用的“Zoek”按钮（URL: ${location.href}）。`);
}
async function waitUntilEnabled(element, label, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (!element.disabled) return;
    await delay(100);
  }
  throw Error(`等待官网“${label}”筛选器启用超时。`);
}
async function waitForStableOptions(select, label, expectedValue, timeout = 15000) {
  const deadline = Date.now() + timeout;
  let prior = '', stableSince = 0;
  while (Date.now() < deadline) {
    const signature = [...select.options].map(option => `${option.value}:${normalize(option.textContent)}`).join('|');
    const expectedExists=[...select.options].some(option=>option.value===expectedValue||normalize(option.textContent)===normalize(expectedValue));
    if (!select.disabled && expectedExists && signature && signature === prior) {
      if (!stableSince) stableSince = Date.now();
      if (Date.now() - stableSince >= 500) return;
    } else {
      prior = signature;
      stableSince = 0;
    }
    await delay(100);
  }
  throw Error(`官网“${label}”没有加载所需选项“${expectedValue}”（当前选项：${[...select.options].map(option=>option.textContent.trim()).join('、')||'无'}）。`);
}
async function waitForStableValue(select, value, label, timeout = 8000, stableDuration = 700) {
  const deadline = Date.now() + timeout;
  let stableSince = 0;
  while (Date.now() < deadline) {
    if (select.value === value && !select.disabled) {
      if (!stableSince) stableSince = Date.now();
      if (Date.now() - stableSince >= stableDuration) return;
    } else stableSince = 0;
    await delay(100);
  }
  throw Error(`官网筛选器“${label}”未能保持所选值“${value}”；未开始考试。`);
}

function findNextPageButton() {
  return [...document.querySelectorAll('button')].find(button => {
    const text = normalize(button.innerText || button.getAttribute('aria-label') || button.title);
    const rect = button.getBoundingClientRect(), style = getComputedStyle(button);
    return text.replace(/\s+/g, ' ') === 'volgende pagina' && !button.disabled &&
      rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
  });
}
function pageSignature(rows=rowsOnPage()) {
  return JSON.stringify(rows.map((row,rowIndex)=>[
    rowIndex,
    normalize(row.title),
    row.kind,
    row.rowKey
  ]));
}
async function waitForPageSignature(signature, previousRows=null, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const rows=rowsOnPage();
    const rerendered=!previousRows||rows.length!==previousRows.length||rows.some((row,index)=>row.element!==previousRows[index]?.element);
    if (pageSignature(rows) === signature&&rerendered) return;
    await delay(150);
  }
  throw Error('官网重新搜索后没有返回题目列表首页。');
}

async function advancePage() {
  const next = findNextPageButton();
  if (!next) return false;
  const beforeRows=rowsOnPage();
  const before=pageSignature(beforeRows);
  next.click();
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    await delay(150);
    const afterRows=rowsOnPage();
    const after=pageSignature(afterRows);
    const rerendered=afterRows.length!==beforeRows.length||afterRows.some((row,index)=>row.element!==beforeRows[index]?.element);
    if (afterRows.length&&(after!==before||rerendered)) return true;
  }
  throw Error('点击“Volgende Pagina”后列表没有更新。');
}

async function prepare(message) {
  const config = message.config;
  const batchSize=Number(config.batchSize??DEFAULT_AUTOMATION_BATCH_SIZE);
  if(!Number.isInteger(batchSize)||batchSize<1||batchSize>MAX_AUTOMATION_BATCH_SIZE)throw Error(`每场题目数必须是 1–${MAX_AUTOMATION_BATCH_SIZE} 之间的整数。`);
  await report('等待官方项目/题型筛选器可用……');
  const {program,kind}=await waitForPortalControls();
  await report(`正在设置项目/考试部分：${config.program}……`);
  const programValue=await setSelect(program, config.program);
  await waitForStableValue(program,programValue,'项目/考试部分');
  await waitUntilEnabled(kind, '题型');
  // Wait for the configured option after Programma triggers Angular's dependent refresh.
  await waitForStableOptions(kind, '题型', config.kind);
  await report(`正在设置题型：${config.kind==='default'?'Alle soorten':config.kind}……`);
  const kindValue=await setSelect(kind, config.kind);
  const selectedKind = [...kind.options].find(item => item.value === config.kind || normalize(item.textContent) === normalize(config.kind));
  if (!selectedKind) throw Error(`官网没有题型选项“${config.kind}”。`);
  await waitForStableValue(kind, selectedKind.value, '题型',8000,1000);
  const expectedKind = config.kind === 'default' ? 'default' : normalize(selectedKind.textContent);
  if(program.value!==programValue||kind.value!==kindValue)throw Error(`官网筛选值未保留（项目=${program.value}，题型=${kind.value}）；未执行搜索。`);
  await report(`已按顺序设置 Programma/onderdeel=${program.options[program.selectedIndex]?.textContent.trim()} → Soort opdracht=${kind.options[kind.selectedIndex]?.textContent.trim()}；现在点击 Zoek 查询……`);
  const search=await waitForSearchButton();
  await clickSearch();
  await report('已点击 Zoek，正在统计此项目和题型下的全部匹配题目……');
  await waitForFilteredRows(expectedKind);
  const firstPageSignature = pageSignature();

  const allQuestions=[];
  const pageSignatures=[];
  let page = 1;
  while (page <= 100) {
    const rows=rowsOnPage();
    pageSignatures[page-1]=pageSignature(rows);
    rows.forEach((row,rowIndex)=>allQuestions.push({page,rowIndex,title:row.title,kind:row.kind,rowKey:row.rowKey}));
    if (!(await advancePage())) break;
    page++;
    await waitForFilteredRows(expectedKind);
    await report(`正在统计匹配题目：第 ${page} 页，已找到 ${allQuestions.length} 道……`);
  }

  if (!allQuestions.length) throw Error('此项目和题型下没有找到可选题目。');
  const requestedQuestions=Array.isArray(config.selectionQuestions)?config.selectionQuestions:allQuestions.slice(0,batchSize);
  if(!requestedQuestions.length)throw Error('没有待选择的匹配题目。');
  if(requestedQuestions.length>batchSize)throw Error(`每场最多选择 ${batchSize} 道题。`);
  const requestedIdentities=new Set();
  const selectedQuestions=requestedQuestions.map(requested=>{
    if(!requested||!Number.isInteger(requested.page)||!Number.isInteger(requested.rowIndex))throw Error('题目批次缺少有效的页码/行位置；未启动。');
    const identity=`${requested.page}:${requested.rowIndex}`;
    if(requestedIdentities.has(identity))throw Error(`批次重复包含第 ${requested.page} 页第 ${requested.rowIndex+1} 行；未启动。`);
    requestedIdentities.add(identity);
    const actual=allQuestions.find(question=>question.page===requested.page&&question.rowIndex===requested.rowIndex);
    if(!actual||normalize(actual.title)!==normalize(requested.title)||actual.kind!==requested.kind||actual.rowKey!==String(requested.rowKey||'')){
      throw Error(`第 ${requested.page} 页第 ${requested.rowIndex+1} 行与已核对题目不一致（${requested.title||'标题未知'}）；未启动。`);
    }
    return actual;
  });

  // Run the same official search again to reset pagination, then select every verified row.
  if(page>1){
    const previousRows=rowsOnPage();
    search.click();
    await waitForPageSignature(firstPageSignature,previousRows);
    await waitForFilteredRows(expectedKind);
  }else if(pageSignature()!==firstPageSignature){
    throw Error('题目列表在核对后发生变化；没有启动考试。');
  }
  const byPage = new Map();
  for (const question of selectedQuestions) {
    const item=question;
    if (!byPage.has(item.page)) byPage.set(item.page, []);
    byPage.get(item.page).push(item);
  }
  for (let currentPage = 1; currentPage <= Math.max(...byPage.keys()); currentPage++) {
    const rows=rowsOnPage();
    if(pageSignature(rows)!==pageSignatures[currentPage-1])throw Error(`第 ${currentPage} 页题目列表与初次核对不一致；没有启动考试。`);
    for (const item of byPage.get(currentPage) || []) {
      const row=rows[item.rowIndex];
      if(!row||normalize(row.title)!==normalize(item.title)||row.kind!==item.kind||row.rowKey!==item.rowKey){
        throw Error(`第 ${currentPage} 页第 ${item.rowIndex+1} 行与已核对题目不一致（${item.title}）；没有启动考试。`);
      }
      if (!row.checkbox.checked) row.checkbox.click();
    }
    if (currentPage < Math.max(...byPage.keys()) && !(await advancePage())) {
      throw Error('选择题目时官网分页提前结束；没有启动考试。');
    }
  }

  const summaryText = normalize(document.body.innerText);
  const selectedCount = Number(summaryText.match(/aantal geselecteerde opgave\(n\):\s*(\d+)/)?.[1]);
  if (selectedCount !== selectedQuestions.length) throw Error(`官网显示已选 ${Number.isFinite(selectedCount) ? selectedCount : '未知'} 道，当前批次应为 ${selectedQuestions.length} 道；没有启动。`);
  await report(`已按项目和题型选择本批 ${selectedQuestions.length} 道，共 ${allQuestions.length} 道匹配题目。`);
  return { count: selectedQuestions.length, questions:selectedQuestions, allQuestions };
}

// Expose a harmless, read-only readiness response for the worker's startup check.
function portalReady() {
  const root=document.querySelector('facet-openbaar-portaal');
  const program=root?.querySelector('[formcontrolname="filter_programma"]')||document.querySelector('#filter-programma');
  const kind=root?.querySelector('[formcontrolname="filter_soort_opdracht"]')||document.querySelector('#filter-soort-opdracht');
  return Boolean(root&&program?.tagName==='SELECT'&&kind?.tagName==='SELECT');
}

if (globalThis.__nt2PortalMessageListener) {
  chrome.runtime.onMessage.removeListener(globalThis.__nt2PortalMessageListener);
}
globalThis.__nt2PortalMessageListener = (message, sender, reply) => {
    if (message?.to !== 'portal') return;
    if(message.type==='ready'){
      reply({ok:portalReady(),url:location.href,program:document.querySelector('facet-openbaar-portaal [formcontrolname="filter_programma"]')?.value,kind:document.querySelector('facet-openbaar-portaal [formcontrolname="filter_soort_opdracht"]')?.value});
      return;
    }
    if (message.type === 'prepare') {
      prepare(message).then(result => reply({ ok: true, ...result }))
        .catch(error => reply({ ok: false, error: error.message || String(error) }));
      return true;
    }
    if (message.type === 'start') {
      const buttons = [...document.querySelectorAll('button')].filter(button => normalize(button.innerText) === 'start' && !button.disabled);
      if (buttons.length !== 1) {
        reply({ ok: false, error: `官网 Start 按钮匹配数为 ${buttons.length}，未启动。` });
        return;
      }
      buttons[0].click();
      reply({ ok: true });
    }
};
chrome.runtime.onMessage.addListener(globalThis.__nt2PortalMessageListener);
})();
