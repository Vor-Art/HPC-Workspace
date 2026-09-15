const $ = (s) => document.querySelector(s),
  esc = (v) =>
    String(v ?? "").replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
let agentFilter = "main",
  archiveChanging = false;
let state = null,
  tab = "overview",
  selectedAgent = null,
  selectedPane = null,
  agentData = null,
  agentLoading = false,
  terminalLoading = false,
  events,
  modalAction,
  detailsTimer;
const titles = {
  overview: [
    "Обзор",
    "ВАШ РАБОЧИЙ КЛАСТЕР",
    "Всё под контролем.",
    "Агенты, терминалы и вычисления — в одном месте.",
  ],
  agents: [
    "Агенты",
    "CODEX · ОБЩИЕ СЕССИИ",
    "От идеи к результату.",
    "Запускайте задачи, следите за работой и отвечайте агентам.",
  ],
  terminal: [
    "Терминалы",
    "ПЕРСИСТЕНТНЫЕ СЕССИИ",
    "Ваши рабочие места.",
    "Терминалы tmux продолжают жить после закрытия браузера.",
  ],
  resources: [
    "Ресурсы",
    "SLURM · РАСПРЕДЕЛЕНИЕ",
    "Каждый ресурс на виду.",
    "Выделенные узлы, очередь заданий и доступные лимиты.",
  ],
};
async function api(url, body) {
  const r = await fetch(url, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}
function toast(text) {
  $("#toast").textContent = text;
  $("#toast").hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => ($("#toast").hidden = true), 6500);
}
function status(t) {
  const s = t.status || {},
    flags = s.activeFlags || [];
  if (
    flags.includes("waitingOnUserInput") ||
    flags.includes("waitingOnApproval") ||
    (state?.requests || []).some((r) => r.params?.threadId === t.id)
  )
    return ["waiting", "Ждёт ответа"];
  if (s.type === "active") return ["running", "Выполняется"];
  if (s.type === "idle") return ["done", "Закончил · готов"];
  if (s.type === "systemError") return ["error", "Ошибка"];
  return ["none", "Нет активной сессии"];
}
function badge(t) {
  const [c, label] = status(t);
  return `<span class="tag ${c}">${label}</span>`;
}
const empty = (title, body = "", symbol = "✳") =>
  `<div class="empty"><div class="empty-symbol">${symbol}</div><strong>${esc(title)}</strong>${esc(body)}</div>`;
function memoryMiB(value, cpus = 1, nodes = 1) {
  const m = String(value).match(/^([\d.]+)([KMGT]?)([cn]?)$/i);
  if (!m) return 0;
  const factor = { K: 1 / 1024, M: 1, G: 1024, T: 1024 ** 2, "": 1 }[
    m[2].toUpperCase()
  ];
  return (
    Number(m[1]) * factor * (m[3] === "c" ? cpus : m[3] === "n" ? nodes : 1)
  );
}
function isArchived(id) {
  return (state?.archivedAgentIds || []).includes(id);
}
function clearAgent() {
  selectedAgent = null;
  agentData = null;
  const el = $("#agent-detail");
  el.dataset.thread = "";
  el.className = "empty tall";
  el.textContent =
    agentFilter === "archive"
      ? "Выберите сессию, чтобы посмотреть историю или вернуть её."
      : "Выберите агента, чтобы открыть диалог.";
}
function agentRow(t, controls = false) {
  const name = t.name || t.preview || "Новый агент",
    archived = isArchived(t.id);
  return `<div class="row clickable ${selectedAgent === t.id ? "selected" : ""}" data-agent="${esc(t.id)}"><div class="row-icon">✳</div><div class="row-main"><div class="row-title">${esc(name)}</div><div class="row-sub">${esc(t.cwd || "")} · ${esc(t.id.slice(-8))}</div></div>${controls ? `<div class="agent-row-actions">${badge(t)}<button class="text-button" data-${archived ? "restore" : "archive"}-agent="${esc(t.id)}" aria-label="${archived ? "Вернуть" : "В архив"}: ${esc(name)}" ${archiveChanging ? "disabled" : ""}>${archived ? "↩ Вернуть" : "В архив"}</button></div>` : badge(t)}</div>`;
}
function jobsTable(jobs, actions = false) {
  if (!jobs.length)
    return empty(
      "Нет выделенных ресурсов",
      "Здесь появятся ваши задания Slurm.",
      "▤",
    );
  return `<div class="table-wrap"><table><thead><tr><th>ЗАДАНИЕ / УЗЕЛ</th><th>СТАТУС</th><th>ПАРТИЦИЯ</th><th>CPU</th><th>RAM</th><th>GPU</th><th>ВРЕМЯ / ЛИМИТ</th>${actions ? "<th></th>" : ""}</tr></thead><tbody>${jobs.map((j) => `<tr><td><strong class="id">#${esc(j.id)}</strong><small>${esc(j.nodeList || j.name)}</small></td><td><span class="tag ${j.allocated ? "running" : "waiting"}">${j.state === "RUNNING" ? "Работает" : esc(j.state)}</span>${j.state === "PENDING" ? `<small>${esc(j.reason)}</small>` : ""}</td><td>${esc(j.partition)}</td><td>${j.cpus}</td><td>${(memoryMiB(j.memory, j.cpus, j.nodes) / 1024).toFixed(1)} GiB</td><td>${j.gpus}</td><td>${esc(j.elapsed)}<small>из ${esc(j.timeLimit)}</small></td>${actions ? `<td><button class="text-button danger" data-cancel-job="${esc(j.id)}">Отменить</button></td>` : ""}</tr>`).join("")}</tbody></table></div>`;
}
function render() {
  if (!state) return;
  $(".workspace-label").textContent = state.clusterLabel || "HPC Workspace";
  $("footer span").textContent = state.clusterLabel || "HPC Workspace";
  $(".footnote").textContent = state.limitsNote || "";
  const allocated = state.jobs.filter((j) => j.allocated),
    cpu = allocated.reduce((a, j) => a + j.cpus, 0),
    ram =
      allocated.reduce((a, j) => a + memoryMiB(j.memory, j.cpus, j.nodes), 0) /
      1024,
    gpu = allocated.reduce((a, j) => a + j.gpus, 0);
  const active = state.agents.filter((t) => status(t)[0] === "running").length,
    waiting = state.agents.filter((t) => status(t)[0] === "waiting").length,
    nodes = new Set(
      allocated.flatMap((j) => (j.nodeList || "").split(",")).filter(Boolean),
    );
  $("#metrics").innerHTML = [
    ["Агенты в работе", active, `${waiting} ждут ответа`, "✳", ""],
    ["Выделено GPU", gpu, `${allocated.length} активных заданий`, "▧", "GPU"],
    ["Процессор", cpu, `${nodes.size} узлов выделено`, "⌘", "CPU"],
    [
      "Оперативная память",
      ram.toFixed(1),
      "Суммарно в ваших заданиях",
      "▥",
      "GiB",
    ],
  ]
    .map(
      ([label, value, caption, icon, unit]) =>
        `<div class="metric"><div class="metric-label">${label}<span class="metric-icon">${icon}</span></div><div class="metric-value">${value}<small>${unit}</small></div><div class="metric-caption">${caption}</div></div>`,
    )
    .join("");
  const mainAgents = state.agents.filter((t) => !isArchived(t.id)),
    archivedAgents = state.agents.filter((t) => isArchived(t.id)),
    visibleAgents = agentFilter === "archive" ? archivedAgents : mainAgents;
  $("#nav-agent-count").textContent = mainAgents.length;
  $("#agents-count").textContent =
    `${visibleAgents.length}${state.moreAgents && agentFilter === "main" ? "+" : ""}`;
  $("#main-agent-count").textContent = mainAgents.length;
  $("#archived-agent-count").textContent = archivedAgents.length;
  document.querySelectorAll("[data-agent-filter]").forEach((b) => {
    const selected = b.dataset.agentFilter === agentFilter;
    b.classList.toggle("active", selected);
    b.setAttribute("aria-pressed", String(selected));
  });
  $("#overview-agents").innerHTML = mainAgents.length
    ? mainAgents
        .slice(0, 4)
        .map((t) => agentRow(t))
        .join("")
    : empty(
        archivedAgents.length
          ? "Все сессии в архиве"
          : "Первый агент — с вашей задачи",
        archivedAgents.length
          ? "Верните нужную сессию во вкладке «Агенты → Архив»."
          : "Нажмите «Новый агент», укажите проект и опишите задачу.",
      );
  $("#agent-list").innerHTML = visibleAgents.length
    ? visibleAgents.map((t) => agentRow(t, true)).join("")
    : empty(
        agentFilter === "archive"
          ? "Архив пока пуст"
          : "В основном списке нет сессий",
        agentFilter === "archive"
          ? "Скрытые сессии будут появляться здесь."
          : "Создайте нового агента или верните сессию из архива.",
      );
  if (
    selectedAgent &&
    isArchived(selectedAgent) !== (agentFilter === "archive")
  )
    clearAgent();
  $("#overview-tmux").innerHTML = state.tmux.length
    ? state.tmux
        .slice(0, 4)
        .map(
          (s) =>
            `<div class="row clickable" data-pane="${esc(s.panes[0]?.id)}"><div class="row-icon purple">›_</div><div class="row-main"><div class="row-title">${esc(s.name)}</div><div class="row-sub">${s.panes.length} панелей · ${esc(s.panes[0]?.cwd)}</div></div><span class="tag ${s.attached ? "running" : ""}">${s.attached ? "Подключена" : "В фоне"}</span></div>`,
        )
        .join("")
    : empty("Нет tmux-сессий", "Создайте постоянный терминал.", "›_");
  $("#overview-jobs").innerHTML = jobsTable(state.jobs);
  $("#jobs-table").innerHTML = jobsTable(state.jobs, true);
  $("#tmux-list").innerHTML =
    state.tmux
      .map(
        (s) =>
          `<div class="session-head"><strong>${esc(s.name)}</strong><small>${s.attached ? "attached" : "detached"}</small>${s.name !== state.serviceSessionName ? `<button title="Закрыть сессию" data-kill-session="${esc(s.id)}">×</button>` : ""}</div>${s.panes.map((p) => `<button class="pane-button ${p.id === selectedPane ? "selected" : ""}" data-pane="${esc(p.id)}">${esc(p.window)}:${esc(p.windowName)} &nbsp; <span>${esc(p.command)}</span> <small>${esc(p.id)}</small></button>`).join("")}`,
      )
      .join("") || empty("Сессий пока нет");
  $("#partition-cards").innerHTML = state.partitions
    .map((p) => {
      const l = state.limits[p.name] || {},
        jobs = allocated.filter((j) => j.partition === p.name),
        usedCpu = jobs.reduce((sum, j) => sum + j.cpus, 0),
        usedMem = jobs.reduce(
          (sum, j) => sum + memoryMiB(j.memory, j.cpus, j.nodes),
          0,
        );
      const cap = (used, max, unit = "") =>
        `${used}${max ? " / " + max : ""}${unit}`;
      return `<div class="card partition"><div class="partition-meta"><div><h2>${esc(p.name)}</h2><span class="muted small">${p.nodes} узлов · ${l.hours ? "до " + l.hours + " ч на задание" : "лимит партиции " + esc(p.timeLimit)}</span></div><span class="tag running">${esc(p.available)}</span></div><div class="progress-label"><span>Ваши CPU</span><span>${cap(usedCpu, l.cpu)}</span></div>${l.cpu ? `<progress value="${usedCpu}" max="${l.cpu}"></progress>` : ""}<div class="progress-label"><span>Ваша память</span><span>${cap((usedMem / 1024).toFixed(1), l.memMiB ? (l.memMiB / 1024).toFixed(1) : null, " GiB")}</span></div>${l.memMiB ? `<progress value="${usedMem}" max="${l.memMiB}"></progress>` : ""}<div class="progress-label"><span>Лимит заданий</span><span>${l.jobs ?? "Не указан"}</span></div><div class="progress-label"><span>Лимит GPU пользователя</span><span>${l.gpu ?? "Не указан"}</span></div><p class="small">CPU партиции: ${esc(p.cpus)}<br><span class="muted">заняты / свободны / прочие / всего</span></p></div>`;
    })
    .join("");
  const c = state.config;
  $("#config-badges").innerHTML = c
    ? `<span class="tag ${c.approval === "never" && c.sandbox === "danger-full-access" ? "running" : "waiting"}">${c.approval === "never" && c.sandbox === "danger-full-access" ? "YOLO" : esc(c.sandbox || "Настройки")}</span><span class="tag">${c.tier === "fast" ? "⚡ Fast" : esc(c.tier || "Standard")}</span><span class="tag">${c.effort === "xhigh" ? "Extra High" : esc(c.effort || "Default")}</span>`
    : '<span class="tag">Настройки загружаются…</span>';
  $("#identity").textContent = `${state.user}@${state.host}`;
  $("#last-update").textContent =
    `Обновлено ${new Date(state.updated).toLocaleTimeString("ru-RU")}`;
  $("#errors").innerHTML = Object.entries(state.errors)
    .map(
      ([k, v]) =>
        `<div class="notice error">${esc(k)}: ${esc(v)}. Последние данные могут быть устаревшими.</div>`,
    )
    .join("");
  if (state.codexEnabled === false) {
    $("#notice").hidden = true;
  } else if (!state.account) {
    $("#notice").hidden = false;
    $("#notice").textContent =
      "Codex не авторизован. Для запуска агентов выполните codex login на сервере. Терминалы и Slurm доступны.";
  } else $("#notice").hidden = true;
  $("#new-agent").disabled = !state.account || !state.codexConnected;
  const selected = state.agents.find((t) => t.id === selectedAgent);
  if (selected && $("#agent-status"))
    $("#agent-status").innerHTML = badge(selected);
  const archiveButton = $("#archive-agent-detail");
  if (archiveButton) {
    archiveButton.textContent = isArchived(selectedAgent)
      ? "↩ Вернуть и продолжить"
      : "В архив";
    archiveButton.disabled = archiveChanging;
  }
}
function switchTab(next) {
  tab = next;
  const [name, eyebrow, title, subtitle] = titles[next];
  $("#page-name").textContent = name;
  $("#page-eyebrow").textContent = eyebrow;
  $("#page-title").textContent = title;
  $("#page-subtitle").textContent = subtitle;
  document
    .querySelectorAll(".tab-page")
    .forEach((e) => (e.hidden = e.id !== next));
  document
    .querySelectorAll(".nav")
    .forEach((e) => e.classList.toggle("active", e.dataset.tab === next));
  if (next === "terminal") capture();
  if (next === "agents" && selectedAgent) readAgent();
}
function showModal(title, html, submit, fn) {
  $("#modal-title").textContent = title;
  $("#modal-body").innerHTML = html;
  $("#modal-submit").textContent = submit;
  modalAction = fn;
  $("#modal").showModal();
}
function newAgent() {
  if (!state?.account) return toast("Сначала войдите в Codex на сервере");
  const models = state.models.filter(
    (m) =>
      !state.config?.effort ||
      m.supportedReasoningEfforts?.some(
        (e) => e.reasoningEffort === state.config.effort,
      ),
  );
  showModal(
    "Новый агент",
    `<label>Название<input name="name" placeholder="Например, обучение VLA" maxlength="120"></label><label>Каталог проекта на сервере<input name="cwd" required value="${esc(state.home)}"></label><label>Модель<select name="model">${models.map((m) => `<option value="${esc(m.model)}" ${m.isDefault ? "selected" : ""}>${esc(m.displayName || m.model)}</option>`).join("")}</select></label><label>Задача<textarea name="text" required rows="5" placeholder="Что нужно сделать?"></textarea></label><p>${esc(state.config?.sandbox || "Настройки Codex")} · ${esc(state.config?.tier || "standard")} · ${esc(state.config?.effort || "default")}. Агент работает через общий Codex на ${esc(state.host)}. Опишите правила работы со Slurm в AGENTS.md своего проекта.</p>`,
    "Запустить",
    async (b) => {
      const r = await api("/api/agents/new", b);
      agentFilter = "main";
      selectedAgent = r.id;
      switchTab("agents");
      await refreshState();
      await readAgent();
    },
  );
}
async function refreshState() {
  state = await api("/api/state");
  render();
}
async function refreshNow() {
  const button = $("#refresh-panel");
  button.disabled = true;
  button.textContent = "↻ Обновление…";
  button.setAttribute("aria-busy", "true");
  try {
    state = await api("/api/refresh", {});
    render();
    if (tab === "agents") await readAgent();
    if (tab === "terminal") await capture();
    toast(
      Object.keys(state.errors).length
        ? "Часть данных не удалось обновить — подробности показаны выше."
        : "Данные обновлены",
    );
  } catch (e) {
    toast(e.message);
  } finally {
    button.disabled = false;
    button.textContent = "↻ Обновить";
    button.setAttribute("aria-busy", "false");
  }
}
async function changeArchive(id, archived) {
  if (archiveChanging) return;
  archiveChanging = true;
  render();
  try {
    state = await api(
      archived ? "/api/agents/archive" : "/api/agents/restore",
      { id },
    );
    if (archived) {
      if (selectedAgent === id) clearAgent();
      render();
      toast("Сессия перемещена в архив");
    } else {
      agentFilter = "main";
      await selectAgent(id);
      toast("Сессия возвращена — можно продолжить диалог");
    }
  } catch (e) {
    toast(e.message);
  } finally {
    archiveChanging = false;
    render();
  }
}
async function selectAgent(id) {
  agentFilter = isArchived(id) ? "archive" : "main";
  selectedAgent = id;
  agentData = null;
  switchTab("agents");
  render();
  await readAgent();
}
function itemText(item) {
  if (item.type === "userMessage")
    return (item.content || []).map((c) => c.text || "").join("\n");
  if (item.type === "agentMessage") return item.text || "";
  if (item.type === "commandExecution")
    return `${item.command || ""}\n${item.aggregatedOutput || ""}`;
  if (item.type === "fileChange")
    return (item.changes || [])
      .map((c) => `${c.path}\n${c.diff || ""}`)
      .join("\n");
  if (item.type === "reasoning") return (item.summary || []).join("\n");
  return "";
}
function transcriptHtml(thread) {
  const turns = thread.turns || [];
  if (!turns.length) return empty("Готов к работе", "Напишите агенту задачу.");
  return turns
    .map((turn) => {
      const items = (turn.items || [])
        .map((item) => {
          const text = itemText(item);
          if (!text) return "";
          const label =
            {
              userMessage: "ВЫ",
              agentMessage: "CODEX",
              commandExecution: "КОМАНДА",
              fileChange: "ИЗМЕНЕНИЯ",
              reasoning: "РАССУЖДЕНИЕ",
            }[item.type] || item.type;
          return item.type === "commandExecution" || item.type === "fileChange"
            ? `<details class="message commandExecution"><summary>${esc(label)} · ${esc((item.command || text).slice(0, 120))}</summary>${esc(text)}</details>`
            : `<div class="message ${esc(item.type)}"><div class="role">${esc(label)}</div>${esc(text)}</div>`;
        })
        .join("");
      return (
        items +
        (turn.error
          ? `<div class="message error">${esc(turn.error.message || JSON.stringify(turn.error))}</div>`
          : "") +
        (turn.status === "interrupted"
          ? '<div class="message">Задача остановлена.</div>'
          : "")
      );
    })
    .join("");
}
function requestsHtml(id) {
  return (state.requests || [])
    .filter((r) => r.params?.threadId === id)
    .map((r) => {
      if (r.method === "item/tool/requestUserInput")
        return `<form class="request-box" data-question="${esc(r.id)}"><h3>Агент ждёт вашего ответа</h3>${r.params.questions.map((q) => `<label>${esc(q.question)}${q.options?.length ? `<select name="choice-${esc(q.id)}"><option value="">Выберите вариант или напишите свой ответ</option>${q.options.map((o) => `<option value="${esc(o.label)}">${esc(o.label)}${o.description ? " — " + esc(o.description) : ""}</option>`).join("")}</select>` : ""}<input name="${esc(q.id)}" placeholder="Ваш ответ" ${q.isSecret ? 'type="password"' : ""}></label>`).join("")}<button class="primary">Ответить</button></form>`;
      if (
        [
          "item/commandExecution/requestApproval",
          "item/fileChange/requestApproval",
        ].includes(r.method)
      )
        return `<div class="request-box"><h3>Запрос подтверждения</h3><p>${esc(r.params.reason || r.params.command || r.method)}</p><button data-approval="${esc(r.id)}" data-decision="accept">Разрешить</button><button data-approval="${esc(r.id)}" data-decision="decline">Отклонить</button></div>`;
      return `<div class="request-box"><h3>Нужен ответ в Codex CLI</h3><p>${esc(r.method)}</p><button data-agent-terminal="${esc(id)}">Открыть терминал агента</button></div>`;
    })
    .join("");
}
async function readAgent() {
  if (!selectedAgent || agentLoading) return;
  agentLoading = true;
  const id = selectedAgent;
  try {
    const data = await api(`/api/agents/read?id=${encodeURIComponent(id)}`);
    if (id !== selectedAgent) return;
    agentData = data;
    const t = data.thread;
    if ($("#agent-detail").dataset.thread !== id) {
      $("#agent-detail").className = "";
      $("#agent-detail").dataset.thread = id;
      $("#agent-detail").innerHTML =
        `<div class="detail-header"><div><h2 id="agent-title"></h2><span id="agent-status"></span></div><button data-agent-terminal="${esc(id)}">›_ tmux</button><button id="interrupt-agent">Остановить</button><button id="archive-agent-detail"></button></div><div id="transcript" class="transcript"></div><div id="pending-questions"></div><form id="agent-form" class="composer"><textarea id="agent-input" placeholder="Следующая задача или сообщение агенту…" required></textarea><button type="submit" class="primary">Отправить ↑</button></form>`;
    }
    $("#agent-title").textContent = t.name || t.preview || id;
    $("#agent-status").innerHTML = badge(t);
    const transcript = $("#transcript"),
      nearBottom =
        transcript.scrollHeight -
          transcript.scrollTop -
          transcript.clientHeight <
        70,
      old = transcript.innerHTML;
    const html =
      transcriptHtml(t) +
      (data.moreHistory
        ? '<p class="small muted">Показаны последние 20 обращений. Полная история доступна в Codex CLI.</p>'
        : "");
    if (old !== html) {
      transcript.innerHTML = html;
      if (nearBottom || !old) transcript.scrollTop = transcript.scrollHeight;
    }
    const questions = requestsHtml(id);
    if ($("#pending-questions").dataset.rendered !== questions) {
      $("#pending-questions").innerHTML = questions;
      $("#pending-questions").dataset.rendered = questions;
    }
    $("#interrupt-agent").disabled = t.status?.type !== "active";
    const archiveButton = $("#archive-agent-detail");
    archiveButton.textContent = isArchived(id)
      ? "↩ Вернуть и продолжить"
      : "В архив";
    archiveButton.disabled = archiveChanging;
  } catch (e) {
    toast(e.message);
  } finally {
    agentLoading = false;
    if (id !== selectedAgent) readAgent();
  }
}
async function capture() {
  if (!selectedPane || tab !== "terminal" || terminalLoading) return;
  terminalLoading = true;
  const id = selectedPane;
  try {
    const r = await api(`/api/tmux/capture?pane=${encodeURIComponent(id)}`);
    if (id !== selectedPane) return;
    const p = state.tmux
      .flatMap((s) => s.panes.map((p) => ({ ...p, session: s.name })))
      .find((p) => p.id === id);
    $("#terminal-title").textContent = p
      ? `${p.session} / ${p.windowName}`
      : id;
    $("#terminal-path").textContent = p?.cwd || "";
    const out = $("#terminal-output"),
      bottom = out.scrollHeight - out.scrollTop - out.clientHeight < 70;
    if (out.textContent !== r.text) {
      out.textContent = r.text;
      if (bottom) out.scrollTop = out.scrollHeight;
    }
  } catch (e) {
    $("#terminal-output").textContent = e.message;
  } finally {
    terminalLoading = false;
  }
}
document.addEventListener("click", async (event) => {
  const b = event.target.closest("button,[data-agent],[data-pane]");
  if (!b) return;
  try {
    if (b.id === "refresh-panel") return await refreshNow();
    if (b.dataset.agentFilter) {
      agentFilter = b.dataset.agentFilter;
      render();
      return;
    }
    if (b.dataset.archiveAgent)
      return await changeArchive(b.dataset.archiveAgent, true);
    if (b.dataset.restoreAgent)
      return await changeArchive(b.dataset.restoreAgent, false);
    if (b.id === "archive-agent-detail")
      return await changeArchive(selectedAgent, !isArchived(selectedAgent));
    if (b.dataset.tab) return switchTab(b.dataset.tab);
    if (b.dataset.agent) return await selectAgent(b.dataset.agent);
    if (b.dataset.pane) {
      selectedPane = b.dataset.pane;
      switchTab("terminal");
      render();
      return;
    }
    if (b.dataset.key) {
      if (!selectedPane) return toast("Сначала выберите панель tmux");
      await api("/api/tmux/key", { pane: selectedPane, key: b.dataset.key });
      setTimeout(capture, 200);
      return;
    }
    if (b.dataset.killSession) {
      const s = state.tmux.find((s) => s.id === b.dataset.killSession);
      return showModal(
        "Закрыть tmux-сессию",
        `<p>Все панели и процессы сессии «${esc(s.name)}» будут закрыты. Если внутри запущен srun, его выделение может завершиться.</p><label>Для подтверждения введите ${esc(s.name)}<input name="confirm" required autocomplete="off"></label>`,
        "Закрыть сессию",
        async (data) => {
          await api("/api/tmux/kill", { ...data, id: s.id });
          await refreshState();
        },
      );
    }
    if (b.dataset.cancelJob)
      return showModal(
        "Отменить задание",
        `<p>Задание #${esc(b.dataset.cancelJob)} будет остановлено, ресурсы освобождены.</p><label>Введите ID задания<input name="confirm" required autocomplete="off"></label>`,
        "Остановить",
        async (data) => {
          await api("/api/jobs/cancel", { ...data, id: b.dataset.cancelJob });
          await refreshState();
        },
      );
    if (b.dataset.agentTerminal) {
      await api("/api/agents/terminal", { id: b.dataset.agentTerminal });
      await refreshState();
      const s = state.tmux.find(
        (s) => s.name === `agent-${b.dataset.agentTerminal.slice(-8)}`,
      );
      if (s) selectedPane = s.panes[0].id;
      switchTab("terminal");
      render();
      return;
    }
    if (b.dataset.approval) {
      await api("/api/agents/answer", {
        requestId: b.dataset.approval,
        decision: b.dataset.decision,
      });
      await refreshState();
      return await readAgent();
    }
    if (b.id === "interrupt-agent") {
      await api("/api/agents/interrupt", { id: selectedAgent });
      toast("Запрос на остановку отправлен");
      return await readAgent();
    }
  } catch (e) {
    toast(e.message);
  }
});
document.addEventListener("submit", async (event) => {
  const f = event.target;
  if (
    f.id === "modal-form" ||
    (!["terminal-form", "agent-form"].includes(f.id) && !f.dataset.question)
  )
    return;
  event.preventDefault();
  const button = f.querySelector("button[type=submit],button.primary");
  if (button) button.disabled = true;
  try {
    if (f.id === "terminal-form") {
      if (!selectedPane) throw new Error("Выберите терминал");
      await api("/api/tmux/send", {
        pane: selectedPane,
        text: $("#terminal-input").value,
      });
      $("#terminal-input").value = "";
      setTimeout(capture, 300);
    }
    if (f.id === "agent-form") {
      const id = selectedAgent,
        text = $("#agent-input").value;
      if (isArchived(id)) {
        state = await api("/api/agents/restore", { id });
        agentFilter = "main";
        selectedAgent = id;
        render();
      }
      await api("/api/agents/send", { id, text });
      if (selectedAgent === id) {
        await readAgent();
        if ($("#agent-input")) $("#agent-input").value = "";
      }
    }
    if (f.dataset.question) {
      const r = state.requests.find((r) => String(r.id) === f.dataset.question),
        d = new FormData(f),
        answers = {};
      for (const q of r.params.questions)
        answers[q.id] = d.get(q.id) || d.get("choice-" + q.id);
      await api("/api/agents/answer", { requestId: r.id, answers });
      await refreshState();
      await readAgent();
    }
  } catch (e) {
    toast(e.message);
  } finally {
    if (button) button.disabled = false;
  }
});
$("#new-agent").onclick = newAgent;
$("#new-tmux").onclick = () =>
  showModal(
    "Новая tmux-сессия",
    `<label>Имя<input name="name" required pattern="[a-zA-Z0-9_-]+" placeholder="project-dev"></label><label>Каталог<input name="cwd" required value="${esc(state.home)}"></label><p>Сессия создаётся на login node. Вычисления запускайте внутри выделения Slurm.</p>`,
    "Создать",
    async (b) => {
      await api("/api/tmux/new", b);
      await refreshState();
      selectedPane = state.tmux.find((s) => s.name === b.name)?.panes[0]?.id;
      render();
      capture();
    },
  );
$("#modal-close").onclick = $("#modal-cancel").onclick = () =>
  $("#modal").close();
$("#modal-form").onsubmit = async (e) => {
  e.preventDefault();
  $("#modal-submit").disabled = true;
  try {
    await modalAction(Object.fromEntries(new FormData(e.target)));
    $("#modal").close();
  } catch (e) {
    toast(e.message);
  } finally {
    $("#modal-submit").disabled = false;
  }
};
function scheduleDetails() {
  if (detailsTimer) return;
  detailsTimer = setTimeout(() => {
    detailsTimer = null;
    if (tab === "agents") readAgent();
  }, 1200);
}
async function init() {
  try {
    const fragment = new URLSearchParams(location.hash.slice(1));
    if (fragment.has("token")) {
      await api("/api/login", { token: fragment.get("token") });
      history.replaceState(null, "", location.pathname);
    }
    await refreshState();
    events = new EventSource("/api/events");
    events.onopen = () => {
      $("#connection").textContent = "Туннель подключён";
      $("#connection-dot").classList.remove("off");
    };
    events.onerror = () => {
      $("#connection").textContent = "Переподключение…";
      $("#connection-dot").classList.add("off");
    };
    events.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.method === "panel/state") {
        state = m.params;
        render();
        if (tab === "agents") scheduleDetails();
      } else if (m.method === "thread/status/changed") {
        const t = state.agents.find((t) => t.id === m.params.threadId);
        if (t) t.status = m.params.status;
        render();
        scheduleDetails();
      } else {
        if (m.id !== undefined) {
          state.requests = state.requests.filter(
            (r) => String(r.id) !== String(m.id),
          );
          state.requests.push(m);
          render();
        }
        if (m.method === "serverRequest/resolved") {
          state.requests = state.requests.filter(
            (r) => String(r.id) !== String(m.params.requestId),
          );
          render();
        }
        if (
          m.params?.threadId === selectedAgent ||
          m.method === "thread/started"
        )
          scheduleDetails();
      }
    };
  } catch (e) {
    $("#notice").hidden = false;
    $("#notice").textContent = e.message;
    $("#connection").textContent = "Нет доступа";
    $("#connection-dot").classList.add("off");
  }
}
setInterval(() => {
  $("#clock").textContent = new Date().toLocaleTimeString("ru-RU", {
    hour: "2-digit",
    minute: "2-digit",
  });
}, 1000);
setInterval(capture, 2000);
init();
