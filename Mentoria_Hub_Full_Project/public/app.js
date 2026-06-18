const state = { user: null, opportunities: [], courses: [], chatTimer: null, chatRoom: "general", lastMessageAt: null };
const page = document.body.dataset.page;
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

document.addEventListener("DOMContentLoaded", async () => {
  initReveal();
  initPasswordToggles();
  try { state.user = (await api("/api/auth/me")).user; } catch { state.user = null; }
  renderShell();
  document.addEventListener("click", globalClickHandler);

  const initializers = {
    auth: initAuth,
    dashboard: initDashboard,
    opportunities: initOpportunities,
    opportunity: initOpportunity,
    courses: initCourses,
    course: initCourse,
    chat: initChat,
    profile: initProfile,
    admin: initAdmin
  };
  if (initializers[page]) await initializers[page]();
});

async function api(url, options = {}) {
  const config = { credentials: "same-origin", ...options, headers: { ...(options.body ? { "Content-Type": "application/json" } : {}), ...(options.headers || {}) } };
  const response = await fetch(url, config);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data.error || "Что-то пошло не так"), { status: response.status, data });
  return data;
}

function renderShell() {
  const header = $("#siteHeader");
  if (header) {
    const navItems = [
      ["opportunities", "/opportunities.html", "Возможности"],
      ["courses", "/courses.html", "Курсы"],
      ["chat", "/chat.html", "Сообщество"],
      ["dashboard", "/dashboard.html", "Кабинет"]
    ];
    header.innerHTML = `<a class="skip-link" href="#main">К содержанию</a><nav class="site-nav"><div class="page-wrap nav-inner"><a class="brand" href="/"><span class="brand-mark">M</span><span>Mentoria<small>hub</small></span></a><button class="menu-toggle" type="button" aria-label="Открыть меню" aria-expanded="false">☰</button><div class="nav-links">${navItems.map(([key, href, label]) => `<a class="${page === key || (key === "opportunities" && page === "opportunity") || (key === "courses" && page === "course") ? "active" : ""}" href="${href}">${label}</a>`).join("")}${state.user?.role === "admin" ? `<a class="${page === "admin" ? "active" : ""}" href="/admin.html">Админ</a>` : ""}</div><div class="nav-actions">${state.user ? `<a class="nav-profile" href="/profile.html"><span class="avatar">${esc(initials(state.user.name))}</span><span>${esc(state.user.name.split(" ")[0])}</span></a>` : `<a class="button soft" href="/auth.html">Войти</a><a class="button primary" href="/auth.html?mode=register">Начать</a>`}</div></div></nav>`;
  }
  const footer = $("#siteFooter");
  if (footer) footer.innerHTML = `<div class="site-footer"><div class="page-wrap"><div class="footer-grid"><div class="footer-intro"><a class="brand" href="/"><span class="brand-mark">M</span><span>Mentoria<small>hub</small></span></a><p>Образовательные возможности и обучение для учеников, которые хотят большего.</p></div><div class="footer-col"><h3>Платформа</h3><a href="/opportunities.html">Возможности</a><a href="/courses.html">Курсы</a><a href="/dashboard.html">Личный кабинет</a></div><div class="footer-col"><h3>Сообщество</h3><a href="/chat.html">Чаты</a><a href="/profile.html">Профиль</a><a href="mailto:mentoriaorganization@gmail.com">Связаться</a></div><div class="footer-col"><h3>Важно</h3><a href="/opportunities.html">Источники</a><a href="/#about">О проекте</a></div></div><div class="footer-bottom"><span>© 2026 Mentoria Hub. MVP для хакатона.</span><span>Дедлайны всегда перепроверяйте на сайте организатора.</span></div></div></div>`;
}

function globalClickHandler(event) {
  const menu = event.target.closest(".menu-toggle");
  if (menu) {
    const links = $(".nav-links");
    links.classList.toggle("open");
    menu.setAttribute("aria-expanded", String(links.classList.contains("open")));
  }
  if (event.target.closest("[data-logout]")) logout();
}

function initReveal() {
  const elements = $$(".reveal");
  if (!elements.length) return;
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return elements.forEach((item) => item.classList.add("visible"));
  const observer = new IntersectionObserver((entries) => entries.forEach((entry) => {
    if (entry.isIntersecting) { entry.target.classList.add("visible"); observer.unobserve(entry.target); }
  }), { threshold: .12 });
  elements.forEach((item) => observer.observe(item));
}

function initPasswordToggles() {
  $$('[data-toggle-password]').forEach((button) => button.addEventListener("click", () => {
    const input = button.parentElement.querySelector("input");
    input.type = input.type === "password" ? "text" : "password";
    button.textContent = input.type === "password" ? "⌁" : "◉";
  }));
}

async function initAuth() {
  if (state.user) return location.replace(nextUrl("/dashboard.html"));
  const mode = new URLSearchParams(location.search).get("mode") === "register" ? "register" : "login";
  setAuthMode(mode);
  $$('[data-auth-tab]').forEach((button) => button.addEventListener("click", () => setAuthMode(button.dataset.authTab)));
  $("#loginForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const submit = event.submitter;
    setBusy(submit, true, "Входим…");
    const values = Object.fromEntries(new FormData(event.currentTarget));
    try {
      const data = await api("/api/auth/login", { method: "POST", body: JSON.stringify(values) });
      state.user = data.user;
      toast("Вход выполнен. С возвращением!");
      setTimeout(() => location.assign(nextUrl(data.user.role === "admin" ? "/admin.html" : "/dashboard.html")), 450);
    } catch (error) { toast(error.message, true); setBusy(submit, false, "Войти →"); }
  });
  $("#registerForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const submit = event.submitter;
    setBusy(submit, true, "Создаём профиль…");
    const form = event.currentTarget;
    const values = Object.fromEntries(new FormData(form));
    values.interests = $$('[data-interest-picker] input:checked', form).map((input) => input.value);
    values.goals = values.interests.includes("Поступление") ? ["Поступить в университет"] : ["Сильное портфолио"];
    try {
      const data = await api("/api/auth/register", { method: "POST", body: JSON.stringify(values) });
      state.user = data.user;
      toast("Готово! Ваш профиль создан.");
      setTimeout(() => location.assign(nextUrl("/dashboard.html")), 450);
    } catch (error) { toast(error.message, true); setBusy(submit, false, "Создать аккаунт →"); }
  });
}

function setAuthMode(mode) {
  $$('[data-auth-tab]').forEach((button) => button.classList.toggle("active", button.dataset.authTab === mode));
  $("#loginForm").classList.toggle("hidden", mode !== "login");
  $("#registerForm").classList.toggle("hidden", mode !== "register");
  history.replaceState(null, "", `/auth.html?mode=${mode}${new URLSearchParams(location.search).get("next") ? `&next=${encodeURIComponent(new URLSearchParams(location.search).get("next"))}` : ""}`);
}

async function initDashboard() {
  if (!requireAuth()) return;
  try {
    const data = await api("/api/dashboard");
    $("#welcomeTitle").textContent = `Привет, ${data.user.name.split(" ")[0]}!`;
    $("#welcomeCopy").textContent = data.stats.nextDeadline ? `До ближайшего дедлайна — ${daysLeft(data.stats.nextDeadline.deadline)} дн. Держим курс.` : "Сохраните первую возможность — и здесь появится ваш план.";
    $("#statsGrid").innerHTML = [
      [data.stats.saved, "Сохранено", "возможностей"],
      [data.stats.activeCourses, "В обучении", "курсов"],
      [data.stats.completedLessons, "Завершено", "уроков"],
      [data.stats.nextDeadline ? daysLeft(data.stats.nextDeadline.deadline) : "—", "До дедлайна", data.stats.nextDeadline?.title || "нет выбранных"]
    ].map(([value, label, note]) => `<article class="stat-card"><small>${esc(label)}</small><strong>${esc(value)}</strong><span>${esc(note)}</span></article>`).join("");
    $("#deadlineList").innerHTML = data.saved.length ? data.saved.slice(0, 5).map(deadlineRow).join("") : emptyBlock("Пока ничего не сохранено", "Откройте каталог и нажмите на закладку у подходящей возможности.", "/opportunities.html", "Перейти в каталог");
    $("#dashboardCourses").innerHTML = data.courses.length ? data.courses.map((course) => `<article class="dashboard-course"><span class="eyebrow"><i></i>${esc(course.direction)}</span><h3>${esc(course.title)}</h3><p>${course.completed} из ${course.total} уроков</p><div class="progress"><i style="width:${course.progress}%"></i></div><a href="/course.html?id=${encodeURIComponent(course.id)}">Продолжить →</a></article>`).join("") : emptyBlock("Курс ещё не выбран", "Добавьте курс, чтобы видеть прогресс.", "/courses.html", "Выбрать курс");
    $("#recommendations").innerHTML = data.recommendations.map((item, index) => `<a class="recommendation" href="/opportunity.html?id=${encodeURIComponent(item.id)}"><span>${index + 1}</span><span><strong>${esc(item.title)}</strong><small>${esc(item.direction)} · ${shortDate(item.deadline)}</small></span><b>→</b></a>`).join("");
  } catch (error) { handleProtectedError(error); }
  $("#mentorForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = event.submitter;
    const message = new FormData(event.currentTarget).get("message");
    if (!String(message).trim()) return;
    setBusy(button, true, "Думаю…");
    try {
      const data = await api("/api/mentor-ai", { method: "POST", body: JSON.stringify({ message }) });
      const answer = $("#mentorAnswer"); answer.textContent = data.text; answer.classList.remove("hidden");
    } catch (error) { toast(error.message, true); }
    setBusy(button, false, "Спросить →");
  });
}

async function initOpportunities() {
  const form = $("#opportunityFilters");
  let debounce;
  const load = async () => {
    const params = new URLSearchParams(new FormData(form));
    [...params].forEach(([key, value]) => { if (!value) params.delete(key); });
    const data = await api(`/api/opportunities?${params}`);
    state.opportunities = data.opportunities;
    state.savedIds = data.savedIds;
    const directionSelect = form.elements.direction;
    if (directionSelect.options.length === 1) {
      const all = await api("/api/opportunities");
      [...new Set(all.opportunities.map((item) => item.direction))].sort().forEach((direction) => directionSelect.add(new Option(direction, direction)));
    }
    $("#catalogCount").textContent = `${data.opportunities.length} ${plural(data.opportunities.length, ["возможность", "возможности", "возможностей"])}`;
    $("#opportunityGrid").innerHTML = data.opportunities.length ? data.opportunities.map((item) => opportunityCard(item, data.savedIds.includes(item.id))).join("") : `<div class="empty-state"><h2>Ничего не нашли</h2><p>Попробуйте изменить фильтры или сбросить поиск.</p></div>`;
    bindSaveButtons();
  };
  form.addEventListener("input", () => { clearTimeout(debounce); debounce = setTimeout(load, 220); });
  form.addEventListener("change", load);
  form.addEventListener("reset", () => setTimeout(load));
  await load();
}

async function initOpportunity() {
  const itemId = new URLSearchParams(location.search).get("id");
  if (!itemId) return renderErrorPage("Возможность не выбрана");
  try {
    const { opportunity: item, saved } = await api(`/api/opportunities/${encodeURIComponent(itemId)}`);
    document.title = `${item.title} — Mentoria Hub`;
    const open = isOpen(item.deadline);
    $("#opportunityDetail").innerHTML = `<section class="detail-hero"><div class="page-wrap"><a class="back-link" href="/opportunities.html">← Назад в каталог</a><div class="detail-heading"><div><span class="status-pill ${open ? "" : "closed"}">${open ? "● Приём открыт" : "● Приём завершён"}</span><h1>${esc(item.title)}</h1><p>${esc(item.description)}</p><div class="meta-row"><span class="tag">${esc(item.direction)}</span><span class="tag">${esc(item.format)}</span><span class="tag">${esc(item.location)}</span></div></div><div class="detail-deadline"><small>${open ? "Дедлайн заявки" : "Приём завершён"}</small><strong>${longDate(item.deadline)}</strong><span>${open ? `Осталось ${daysLeft(item.deadline)} дней` : "Следите за следующим сезоном"}</span></div></div></div></section><section class="page-wrap detail-layout"><div class="detail-main"><article class="content-panel"><span class="eyebrow"><i></i> Основное</span><h2>О возможности</h2><p>${esc(item.description)}</p><div class="detail-facts"><div><small>Организатор</small><strong>${esc(item.organizer)}</strong></div><div><small>Возраст</small><strong>${esc(item.ages)}</strong></div><div><small>Язык</small><strong>${esc(item.language)}</strong></div><div><small>Стоимость</small><strong>${esc(item.fee)}</strong></div></div></article><article class="content-panel"><span class="eyebrow"><i></i> Перед заявкой</span><h2>Требования</h2><ul class="clean-list">${item.requirements.map((entry) => `<li>${esc(entry)}</li>`).join("")}</ul></article><article class="content-panel"><span class="eyebrow"><i></i> План</span><h2>Как податься</h2><ol class="number-list">${item.steps.map((entry) => `<li>${esc(entry)}</li>`).join("")}</ol></article></div><aside class="detail-aside"><article class="content-panel apply-card"><span class="eyebrow light"><i></i> Следующий шаг</span><h2>${open ? "Готовы податься?" : "Сезон завершён"}</h2><p>${open ? `Проверьте правила на сайте ${esc(item.organizer)} — организатор может уточнять детали.` : "Изучите требования сейчас и подготовьтесь к следующему набору."}</p><a class="button white full" href="${safeUrl(item.url)}" target="_blank" rel="noopener">Официальный сайт ↗</a><button class="button soft full save-detail" data-save-id="${esc(item.id)}">${saved ? "✓ Сохранено" : "♡ Сохранить"}</button><a class="source-link" href="${safeUrl(item.url)}" target="_blank" rel="noopener">Источник: ${esc(item.organizer)}</a></article><article class="content-panel verified-card"><strong>✓ Дата проверена ${formatVerified(item.verifiedAt)}</strong><p>Mentoria не является организатором. Перепроверьте дедлайн и часовой пояс перед отправкой.</p></article></aside></section>`;
    bindSaveButtons();
  } catch (error) { renderErrorPage(error.message); }
}

function opportunityCard(item, saved) {
  const open = isOpen(item.deadline);
  const colors = { "STEM": ["#7057e8", "#eeeafd"], "Математика": ["#5f9cf5", "#e7f0ff"], "Литература": ["#ee765f", "#ffebe7"], "Международные отношения": ["#23384c", "#e5edf3"], "Академическое письмо": ["#e79b3e", "#fff0dc"], "Социальное влияние": ["#38a87e", "#e1f7ee"] };
  const [color, soft] = colors[item.direction] || colors.STEM;
  return `<article class="opportunity-card" style="--card:${color};--card-soft:${soft}"><div class="card-top"><span class="status-pill ${open ? "" : "closed"}">${open ? "● Открыто" : "● Завершено"}</span><button class="save-button ${saved ? "saved" : ""}" data-save-id="${esc(item.id)}" aria-label="${saved ? "Удалить из сохранённых" : "Сохранить"}">${saved ? "♥" : "♡"}</button></div><h3>${esc(item.title)}</h3><p class="organizer">${esc(item.organizer)}</p><div class="meta-row"><span class="tag">${esc(item.direction)}</span><span class="tag">${esc(item.category)}</span><span class="tag">${esc(item.ages)}</span></div><div class="deadline-box"><span class="date-block"><b>${dayNumber(item.deadline)}</b><span>${monthShort(item.deadline)}</span></span><span><small>${open ? "Дедлайн" : "Завершено"}</small><strong>${open ? `${daysLeft(item.deadline)} дней · ${esc(item.format)}` : longDate(item.deadline)}</strong></span></div><div class="card-actions"><a class="button soft" href="/opportunity.html?id=${encodeURIComponent(item.id)}">Подробнее</a><a class="button primary" href="${safeUrl(item.url)}" target="_blank" rel="noopener">Податься ↗</a></div></article>`;
}

function bindSaveButtons() {
  $$('[data-save-id]').forEach((button) => button.addEventListener("click", async () => {
    if (!state.user) return location.assign(`/auth.html?mode=login&next=${encodeURIComponent(location.pathname + location.search)}`);
    try {
      const result = await api(`/api/opportunities/${encodeURIComponent(button.dataset.saveId)}/save`, { method: "POST", body: "{}" });
      $$(`[data-save-id="${CSS.escape(button.dataset.saveId)}"]`).forEach((target) => {
        target.classList.toggle("saved", result.saved);
        target.textContent = target.classList.contains("save-detail") ? (result.saved ? "✓ Сохранено" : "♡ Сохранить") : (result.saved ? "♥" : "♡");
      });
      toast(result.saved ? "Сохранено в личный кабинет" : "Удалено из сохранённых");
    } catch (error) { toast(error.message, true); }
  }));
}

async function initCourses() {
  const data = await api("/api/courses");
  state.courses = data.courses;
  $("#courseGrid").innerHTML = data.courses.map((course, index) => courseCard(course, data.enrolledIds.includes(course.id), index)).join("");
}

function courseCard(course, enrolled, index) {
  const palette = { violet: "#7057e8", blue: "#4d8adf", orange: "#e79b3e" };
  return `<article class="course-card reveal visible"><div class="course-card-art" style="--course:${palette[course.color] || palette.violet}"><span>0${index + 1}</span></div><span class="eyebrow"><i></i>${esc(course.direction)}</span><h3>${esc(course.title)}</h3><p>${esc(course.description)}</p><div class="meta-row"><span class="tag">${esc(course.level)}</span><span class="tag">${esc(course.duration)}</span><span class="tag">${course.lessonsCount} уроков</span></div><a class="button ${enrolled ? "soft" : "primary"}" href="/course.html?id=${encodeURIComponent(course.id)}">${enrolled ? "Продолжить курс" : "Посмотреть программу"} →</a></article>`;
}

async function initCourse() {
  const itemId = new URLSearchParams(location.search).get("id");
  if (!itemId) return renderErrorPage("Курс не выбран", "#courseDetail");
  try {
    const data = await api(`/api/courses/${encodeURIComponent(itemId)}`);
    renderCourse(data);
  } catch (error) { renderErrorPage(error.message, "#courseDetail"); }
}

function renderCourse(data) {
  const { course, enrolled, completedLessons } = data;
  document.title = `${course.title} — Mentoria Hub`;
  const progress = Math.round(completedLessons.length / course.lessons.length * 100);
  $("#courseDetail").innerHTML = `<section class="course-detail-hero"><div class="page-wrap"><div><a class="back-link" href="/courses.html">← Все курсы</a><span class="eyebrow light"><i></i>${esc(course.direction)} · ${esc(course.level)}</span><h1>${esc(course.title)}</h1><p>${esc(course.description)}</p></div><div class="course-progress-card"><small>Ваш прогресс</small><strong>${progress}%</strong><div class="progress"><i style="width:${progress}%"></i></div><span>${completedLessons.length} из ${course.lessons.length} уроков</span>${!enrolled ? `<button class="button primary full" id="enrollCourse">Записаться бесплатно</button>` : ""}</div></div></section><section class="page-wrap course-layout"><div><div class="panel-title"><div><span class="eyebrow"><i></i> Программа</span><h2>${course.lessons.length} уроков</h2></div><span>${esc(course.duration)}</span></div><div class="lesson-list">${course.lessons.map((lesson, index) => `<article class="lesson-row ${completedLessons.includes(lesson.id) ? "done" : ""}"><span class="lesson-check">✓</span><div><h3>${index + 1}. ${esc(lesson.title)}</h3><p>${esc(lesson.type)} · ${esc(lesson.duration)} · Задание: ${esc(lesson.task)}</p></div><button class="lesson-toggle" data-lesson-id="${esc(lesson.id)}" ${!enrolled ? "disabled" : ""}>${completedLessons.includes(lesson.id) ? "Готово" : "Отметить"}</button></article>`).join("")}</div></div><aside><article class="content-panel outcomes-card"><span class="eyebrow"><i></i> Результат</span><h2>После курса вы</h2><ul class="clean-list">${course.outcomes.map((item) => `<li>${esc(item)}</li>`).join("")}</ul><p>Материалы курса — демонстрационный учебный контент Mentoria. Прогресс сохраняется на сервере.</p></article></aside></section>`;
  $("#enrollCourse")?.addEventListener("click", async () => {
    if (!state.user) return location.assign(`/auth.html?mode=login&next=${encodeURIComponent(location.pathname + location.search)}`);
    try { await api(`/api/courses/${encodeURIComponent(course.id)}/enroll`, { method: "POST", body: "{}" }); toast("Вы записаны на курс"); renderCourse({ ...data, enrolled: true }); }
    catch (error) { toast(error.message, true); }
  });
  $$('[data-lesson-id]').forEach((button) => button.addEventListener("click", async () => {
    try {
      const result = await api(`/api/courses/${encodeURIComponent(course.id)}/lessons/${encodeURIComponent(button.dataset.lessonId)}/complete`, { method: "POST", body: "{}" });
      renderCourse({ ...data, enrolled: true, completedLessons: result.completedLessons });
      toast(result.completed ? "Урок отмечен как завершённый" : "Отметка снята");
    } catch (error) { toast(error.message, true); }
  }));
}

async function initChat() {
  if (!requireAuth()) return;
  const rooms = { general: ["#", "Общий чат", "violet"], stem: ["∑", "STEM & олимпиады", "blue"], admissions: ["↗", "Поступление", "orange"] };
  const activateRoom = async (room) => {
    state.chatRoom = room; state.lastMessageAt = null;
    $$('[data-room]').forEach((button) => button.classList.toggle("active", button.dataset.room === room));
    const [glyph, title, color] = rooms[room];
    $("#roomGlyph").textContent = glyph; $("#roomGlyph").className = `room-icon ${color}`; $("#roomTitle").textContent = title;
    $("#chatMessages").innerHTML = `<div class="skeleton"></div>`;
    await loadMessages(false);
  };
  $$('[data-room]').forEach((button) => button.addEventListener("click", () => activateRoom(button.dataset.room)));
  $("#chatMessageForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget; const text = new FormData(form).get("text");
    if (!String(text).trim()) return;
    try {
      await api("/api/chat/messages", { method: "POST", body: JSON.stringify({ room: state.chatRoom, text }) });
      form.reset(); await loadMessages(false);
    } catch (error) { toast(error.message, true); }
  });
  await activateRoom("general");
  state.chatTimer = setInterval(() => { if (!document.hidden) loadMessages(true); }, 2500);
}

async function loadMessages(incremental) {
  try {
    const suffix = incremental && state.lastMessageAt ? `&since=${encodeURIComponent(state.lastMessageAt)}` : "";
    const data = await api(`/api/chat/messages?room=${encodeURIComponent(state.chatRoom)}${suffix}`);
    if (state.chatRoom !== data.room) return;
    const box = $("#chatMessages");
    if (!incremental) box.innerHTML = "";
    data.messages.forEach((message) => {
      if ($(`[data-message-id="${CSS.escape(message.id)}"]`, box)) return;
      box.insertAdjacentHTML("beforeend", chatMessage(message));
    });
    if (data.messages.length) state.lastMessageAt = data.messages.at(-1).createdAt;
    if (!box.children.length) box.innerHTML = `<div class="empty-state"><h2>Начните разговор</h2><p>В этой комнате пока тихо.</p></div>`;
    if (!incremental || data.messages.length) box.scrollTop = box.scrollHeight;
  } catch (error) { if (error.status === 401) handleProtectedError(error); }
}

function chatMessage(message) {
  const own = message.userId === state.user.id;
  return `<article class="chat-message ${own ? "own" : ""}" data-message-id="${esc(message.id)}">${own ? "" : `<span class="message-avatar">${esc(initials(message.name))}</span>`}<div class="message-bubble"><header><strong>${own ? "Вы" : esc(message.name)}${message.role === "admin" ? " · mentor" : ""}</strong><time datetime="${esc(message.createdAt)}">${messageTime(message.createdAt)}</time></header><p>${esc(message.text)}</p></div></article>`;
}

async function initProfile() {
  if (!requireAuth()) return;
  const user = state.user; const form = $("#profileForm");
  form.elements.name.value = user.name; form.elements.grade.value = user.grade; form.elements.country.value = user.country || "";
  $$('[data-interest-picker] input').forEach((input) => input.checked = user.interests.includes(input.value));
  $$('[data-goal-picker] input').forEach((input) => input.checked = user.goals.includes(input.value));
  $("#profileSummary").innerHTML = `<div class="profile-avatar">${esc(initials(user.name))}</div><h2>${esc(user.name)}</h2><p>${esc(user.email)}</p><div class="profile-meta"><div><span>Роль</span><strong>${user.role === "admin" ? "Администратор" : "Ученик"}</strong></div><div><span>Класс</span><strong>${esc(user.grade)}</strong></div><div><span>Сохранено</span><strong>${user.savedOpportunityIds.length}</strong></div><div><span>Курсы</span><strong>${user.enrolledCourseIds.length}</strong></div></div>`;
  form.addEventListener("submit", async (event) => {
    event.preventDefault(); const button = event.submitter; setBusy(button, true, "Сохраняем…");
    const values = Object.fromEntries(new FormData(form));
    values.interests = $$('[data-interest-picker] input:checked').map((input) => input.value);
    values.goals = $$('[data-goal-picker] input:checked').map((input) => input.value);
    try { const data = await api("/api/profile", { method: "PATCH", body: JSON.stringify(values) }); state.user = data.user; toast("Профиль обновлён"); renderShell(); }
    catch (error) { toast(error.message, true); }
    setBusy(button, false, "Сохранить изменения");
  });
}

async function initAdmin() {
  if (!requireAuth(true)) return;
  const dialog = $("#opportunityDialog"); const form = $("#adminOpportunityForm");
  const openForm = (item = null) => {
    form.reset(); form.dataset.editId = item?.id || "";
    if (item) {
      ["title", "organizer", "category", "direction", "ages", "fee", "language", "prize", "url", "description"].forEach((key) => form.elements[key].value = item[key] || "");
      form.elements.deadline.value = new Date(item.deadline).toISOString().slice(0, 16);
      form.elements.grades.value = item.grades.join(",");
      form.elements.requirements.value = item.requirements.join("\n");
      $("h2", form).textContent = "Редактировать возможность";
    } else $("h2", form).textContent = "Добавить в каталог";
    dialog.showModal();
  };
  $("#openOpportunityForm").addEventListener("click", () => openForm());
  $("[data-close-dialog]").addEventListener("click", () => dialog.close());
  form.addEventListener("submit", async (event) => {
    event.preventDefault(); const button = event.submitter; setBusy(button, true, "Сохраняем…");
    const values = Object.fromEntries(new FormData(form));
    values.grades = values.grades.split(",").map((item) => item.trim());
    values.requirements = values.requirements.split("\n").map((item) => item.trim()).filter(Boolean);
    values.steps = ["Изучить официальные правила", "Подготовить материалы", "Отправить заявку до дедлайна"];
    values.format = "Онлайн"; values.location = "Международный";
    try {
      const editId = form.dataset.editId;
      await api(editId ? `/api/admin/opportunities/${encodeURIComponent(editId)}` : "/api/admin/opportunities", { method: editId ? "PUT" : "POST", body: JSON.stringify(values) });
      dialog.close(); toast(editId ? "Изменения сохранены" : "Возможность опубликована"); await loadAdmin();
    } catch (error) { toast(error.message, true); }
    setBusy(button, false, form.dataset.editId ? "Сохранить" : "Опубликовать");
  });
  $("#adminOpportunityList").addEventListener("click", async (event) => {
    const edit = event.target.closest("[data-admin-edit]");
    const remove = event.target.closest("[data-admin-delete]");
    if (edit) openForm(state.opportunities.find((item) => item.id === edit.dataset.adminEdit));
    if (remove && confirm("Удалить возможность из каталога?")) {
      try { await api(`/api/admin/opportunities/${encodeURIComponent(remove.dataset.adminDelete)}`, { method: "DELETE", body: "{}" }); toast("Удалено"); await loadAdmin(); }
      catch (error) { toast(error.message, true); }
    }
  });
  $("#adminUserList").addEventListener("click", async (event) => {
    const roleButton = event.target.closest("[data-admin-role]");
    if (!roleButton) return;
    const role = roleButton.dataset.adminRole;
    const action = role === "admin" ? "выдать права администратора" : "снять права администратора";
    if (!confirm(`Вы уверены, что хотите ${action}?`)) return;
    try {
      await api(`/api/admin/users/${encodeURIComponent(roleButton.dataset.userId)}/role`, { method: "PATCH", body: JSON.stringify({ role }) });
      toast(role === "admin" ? "Администратор добавлен" : "Права администратора сняты");
      await loadAdmin();
    } catch (error) { toast(error.message, true); }
  });
  await loadAdmin();
}

async function loadAdmin() {
  const [{ opportunities }, admin] = await Promise.all([api("/api/opportunities"), api("/api/admin/stats")]);
  state.opportunities = opportunities;
  $("#adminStats").innerHTML = [[admin.stats.users, "Ученики", "аккаунтов"], [admin.stats.saved, "Сохранения", "в каталоге"], [admin.stats.enrollments, "Записи", "на курсы"], [admin.stats.messages, "Сообщения", "в чатах"]].map(([value, label, note]) => `<article class="stat-card"><small>${label}</small><strong>${value}</strong><span>${note}</span></article>`).join("");
  $("#adminOpportunityList").innerHTML = opportunities.map((item) => `<div class="admin-row"><span><strong>${esc(item.title)}</strong><small>${esc(item.direction)} · ${shortDate(item.deadline)}</small></span><span><button data-admin-edit="${esc(item.id)}">Изменить</button><button data-admin-delete="${esc(item.id)}">Удалить</button></span></div>`).join("");
  $("#adminUserList").innerHTML = admin.users.map((user) => `<div class="admin-row"><span><strong>${esc(user.name)}</strong><small>${esc(user.email)} · ${esc(user.grade)} класс</small></span><span>${user.id === state.user.id ? `<span class="tag">Вы · admin</span>` : `<span class="tag">${user.role}</span><button data-user-id="${esc(user.id)}" data-admin-role="${user.role === "admin" ? "student" : "admin"}">${user.role === "admin" ? "Снять права" : "Сделать админом"}</button>`}</span></div>`).join("");
}

function requireAuth(admin = false) {
  if (!state.user) { location.replace(`/auth.html?mode=login&next=${encodeURIComponent(location.pathname + location.search)}`); return false; }
  if (admin && state.user.role !== "admin") { location.replace("/dashboard.html"); return false; }
  return true;
}

async function logout() {
  try { await api("/api/auth/logout", { method: "POST", body: "{}" }); } catch {}
  state.user = null; location.assign("/");
}

function handleProtectedError(error) { if (error.status === 401) location.replace(`/auth.html?mode=login&next=${encodeURIComponent(location.pathname + location.search)}`); else toast(error.message, true); }
function renderErrorPage(message, selector = "#opportunityDetail") { const root = $(selector); if (root) root.innerHTML = `<section class="not-found page-wrap"><span>!</span><h1>${esc(message)}</h1><p>Вернитесь в каталог и попробуйте ещё раз.</p><a class="button primary" href="/">На главную</a></section>`; }
function emptyBlock(title, copy, href, label) { return `<div class="empty-state"><h3>${esc(title)}</h3><p>${esc(copy)}</p><a class="button soft" href="${href}">${esc(label)} →</a></div>`; }
function deadlineRow(item) { return `<article class="deadline-item"><span class="date-block"><b>${dayNumber(item.deadline)}</b><span>${monthShort(item.deadline)}</span></span><div><h3>${esc(item.title)}</h3><p>${esc(item.direction)} · осталось ${daysLeft(item.deadline)} дней</p></div><a href="/opportunity.html?id=${encodeURIComponent(item.id)}">→</a></article>`; }
function setBusy(button, busy, text) { if (!button) return; button.disabled = busy; button.textContent = text; }
function toast(message, error = false) { const box = $("#toast"); if (!box) return; box.textContent = message; box.classList.toggle("error", error); box.classList.add("show"); clearTimeout(toast.timer); toast.timer = setTimeout(() => box.classList.remove("show"), 3200); }
function nextUrl(fallback) { const next = new URLSearchParams(location.search).get("next"); return next && next.startsWith("/") && !next.startsWith("//") ? next : fallback; }
function initials(name) { return String(name || "M").split(/\s+/).slice(0, 2).map((word) => word[0]).join("").toUpperCase(); }
function esc(value) { return String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]); }
function safeUrl(value) { try { const url = new URL(value); return url.protocol === "https:" ? esc(url.href) : "#"; } catch { return "#"; } }
function isOpen(value) { return new Date(value) > new Date(); }
function daysLeft(value) { return Math.max(0, Math.ceil((new Date(value) - new Date()) / 86400000)); }
function dayNumber(value) { return new Intl.DateTimeFormat("ru-RU", { day: "2-digit" }).format(new Date(value)); }
function monthShort(value) { return new Intl.DateTimeFormat("ru-RU", { month: "short" }).format(new Date(value)).replace(".", ""); }
function shortDate(value) { return new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short", year: "numeric" }).format(new Date(value)); }
function longDate(value) { return new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", year: "numeric" }).format(new Date(value)); }
function formatVerified(value) { return new Intl.DateTimeFormat("ru-RU").format(new Date(`${value}T12:00:00`)); }
function messageTime(value) { return new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit" }).format(new Date(value)); }
function plural(number, forms) { const n = Math.abs(number) % 100, n1 = n % 10; return n > 10 && n < 20 ? forms[2] : n1 > 1 && n1 < 5 ? forms[1] : n1 === 1 ? forms[0] : forms[2]; }
